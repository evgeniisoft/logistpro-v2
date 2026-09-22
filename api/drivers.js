const { query } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { logChange } = require('./_lib/journal');

function validateDriver(data, isUpdate = false) {
    const errors = [];
    if (!isUpdate || data.full_name !== undefined) {
        if (!data.full_name || !String(data.full_name).trim()) {
            errors.push('ФИО обязательно');
        }
    }
    if (data.default_rate !== undefined && data.default_rate !== null && data.default_rate < 0) {
        errors.push('Ставка не может быть отрицательной');
    }
    return errors;
}

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const action = req.query.action || 'index';
    const id = req.query.id;

    // ============ GET ONE ============
    if (action === 'get') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID не указан' });
        try {
            const result = await query('SELECT * FROM drivers WHERE id = $1', [id]);
            if (result.rows.length === 0) return res.status(404).json({ error: 'Водитель не найден' });
            return res.json({ driver: result.rows[0] });
        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ UPDATE ============
    if (action === 'update') {
        if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID не указан' });

        const fields = req.body;
        const allowedFields = ['full_name', 'phone', 'license', 'default_rate', 'is_archived'];

        try {
            const current = await query('SELECT * FROM drivers WHERE id = $1', [id]);
            if (current.rows.length === 0) return res.status(404).json({ error: 'Водитель не найден' });

            const driver = current.rows[0];
            const updates = [];
            const params = [];
            let paramIndex = 1;

            for (const field of allowedFields) {
                if (fields[field] !== undefined) {
                    updates.push(`${field} = $${paramIndex++}`);
                    params.push(fields[field]);
                    if (String(driver[field]) !== String(fields[field])) {
                        await logChange(req.user.id, 'drivers', id, field, driver[field], fields[field], ip);
                    }
                }
            }

            if (updates.length === 0) return res.json({ success: true, message: 'Нет изменений' });

            params.push(id);
            const sql = `UPDATE drivers SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            return res.json({ success: true, driver: result.rows[0] });
        } catch (e) {
            console.error('PUT driver error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ DELETE ============
    if (action === 'delete') {
        if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID не указан' });

        if (req.user.role !== 'admin' && req.user.role !== 'senior_logist') {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }

        try {
            const check = await query('SELECT * FROM drivers WHERE id = $1', [id]);
            if (check.rows.length === 0) return res.status(404).json({ error: 'Водитель не найден' });

            const used = await query('SELECT COUNT(*) as cnt FROM trips WHERE driver_id = $1', [id]);

            if (parseInt(used.rows[0].cnt) > 0) {
                await query('UPDATE drivers SET is_archived = true WHERE id = $1', [id]);
                await logChange(req.user.id, 'drivers', id, 'Архивация', 'Активен', 'Архив', ip);
                return res.json({ success: true, message: 'Водитель использовался в рейсах, поэтому перемещён в архив' });
            }

            await query('DELETE FROM drivers WHERE id = $1', [id]);
            await logChange(req.user.id, 'drivers', id, 'Удаление', check.rows[0].full_name, '', ip);

            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ INDEX ============
    if (req.method === 'GET') {
        try {
            const { include_archived } = req.query;
            let sql = `SELECT id, full_name, phone, license, default_rate, is_archived, created_at FROM drivers`;
            if (include_archived !== 'true') sql += ' WHERE is_archived = false';
            sql += ' ORDER BY is_archived ASC, full_name ASC';

            const result = await query(sql);
            return res.json({ drivers: result.rows });
        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    if (req.method === 'POST') {
        const { full_name, phone, license, default_rate } = req.body;

        const errors = validateDriver(req.body, false);
        if (errors.length > 0) return res.status(400).json({ error: errors.join(', ') });

        try {
            const result = await query(
                `INSERT INTO drivers (full_name, phone, license, default_rate)
                 VALUES ($1, $2, $3, $4) RETURNING *`,
                [full_name.trim(), phone || null, license || null, default_rate || 0]
            );

            await logChange(req.user.id, 'drivers', result.rows[0].id, 'Создание', '', result.rows[0].full_name, ip);
            return res.status(201).json({ success: true, driver: result.rows[0] });
        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
