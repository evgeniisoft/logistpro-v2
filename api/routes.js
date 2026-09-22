const { query } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { logChange } = require('./_lib/journal');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const action = req.query.action || 'index';
    const id = req.query.id;

    // ============ GET ONE ============
    if (action === 'get') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID не указан' });
        try {
            const result = await query('SELECT * FROM routes WHERE id = $1', [id]);
            if (result.rows.length === 0) return res.status(404).json({ error: 'Маршрут не найден' });
            return res.json({ route: result.rows[0] });
        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ UPDATE ============
    if (action === 'update') {
        if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID не указан' });

        const fields = req.body;
        const allowedFields = ['name', 'from_point', 'to_point', 'distance_km', 'estimated_time', 'toll_cost', 'is_archived'];

        try {
            const current = await query('SELECT * FROM routes WHERE id = $1', [id]);
            if (current.rows.length === 0) return res.status(404).json({ error: 'Маршрут не найден' });

            const route = current.rows[0];
            const updates = [];
            const params = [];
            let paramIndex = 1;

            for (const field of allowedFields) {
                if (fields[field] !== undefined) {
                    updates.push(`${field} = $${paramIndex++}`);
                    params.push(fields[field]);
                    if (String(route[field]) !== String(fields[field])) {
                        await logChange(req.user.id, 'routes', id, field, route[field], fields[field], ip);
                    }
                }
            }

            if (updates.length === 0) return res.json({ success: true, message: 'Нет изменений' });

            params.push(id);
            const sql = `UPDATE routes SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);
            return res.json({ success: true, route: result.rows[0] });
        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
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
            const check = await query('SELECT * FROM routes WHERE id = $1', [id]);
            if (check.rows.length === 0) return res.status(404).json({ error: 'Маршрут не найден' });

            const used = await query('SELECT COUNT(*) as cnt FROM trips WHERE route_id = $1', [id]);

            if (parseInt(used.rows[0].cnt) > 0) {
                await query('UPDATE routes SET is_archived = true WHERE id = $1', [id]);
                await logChange(req.user.id, 'routes', id, 'Архивация', 'Активен', 'Архив', ip);
                return res.json({ success: true, message: 'Маршрут использовался в рейсах, поэтому перемещён в архив' });
            }

            await query('DELETE FROM routes WHERE id = $1', [id]);
            await logChange(req.user.id, 'routes', id, 'Удаление', check.rows[0].name, '', ip);
            return res.json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ INDEX ============
    if (req.method === 'GET') {
        try {
            const { include_archived } = req.query;
            let sql = `SELECT id, name, from_point, to_point, distance_km, estimated_time, toll_cost, is_archived, created_at FROM routes`;
            if (include_archived !== 'true') sql += ' WHERE is_archived = false';
            sql += ' ORDER BY is_archived ASC, name ASC';

            const result = await query(sql);
            return res.json({ routes: result.rows });
        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    if (req.method === 'POST') {
        const { name, from_point, to_point, distance_km, estimated_time, toll_cost } = req.body;

        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'Название маршрута обязательно' });
        }

        try {
            const result = await query(
                `INSERT INTO routes (name, from_point, to_point, distance_km, estimated_time, toll_cost)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [name.trim(), from_point || null, to_point || null,
                 distance_km || 0, estimated_time || null, toll_cost || 0]
            );

            await logChange(req.user.id, 'routes', result.rows[0].id, 'Создание', '', result.rows[0].name, ip);
            return res.status(201).json({ success: true, route: result.rows[0] });
        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
