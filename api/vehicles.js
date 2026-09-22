const { query } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { logChange } = require('./_lib/journal');

function validateVehicle(data, isUpdate = false) {
    const errors = [];

    if (!isUpdate || data.plate !== undefined) {
        if (!data.plate || !String(data.plate).trim()) {
            errors.push('Госномер обязателен');
        }
    }

    if (data.volume !== undefined && data.volume !== null && data.volume < 0) {
        errors.push('Объём не может быть отрицательным');
    }

    if (data.fuel_rate !== undefined && data.fuel_rate !== null && data.fuel_rate < 0) {
        errors.push('Норма расхода не может быть отрицательной');
    }

    if (data.amort_rate !== undefined && data.amort_rate !== null && data.amort_rate < 0) {
        errors.push('Ставка амортизации не может быть отрицательной');
    }

    const validTypes = ['own', 'hired'];
    if (data.type && !validTypes.includes(data.type)) {
        errors.push('Недопустимый тип машины');
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
        if (!id) return res.status(400).json({ error: 'ID машины не указан' });

        try {
            const result = await query('SELECT * FROM vehicles WHERE id = $1', [id]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Машина не найдена' });
            }
            return res.json({ vehicle: result.rows[0] });
        } catch (e) {
            console.error('GET vehicle error:', e);
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ UPDATE ============
    if (action === 'update') {
        if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID машины не указан' });

        const fields = req.body;
        const allowedFields = ['plate', 'model', 'type', 'volume', 'fuel_rate', 'amort_rate', 'is_archived'];

        try {
            const current = await query('SELECT * FROM vehicles WHERE id = $1', [id]);
            if (current.rows.length === 0) {
                return res.status(404).json({ error: 'Машина не найдена' });
            }

            const vehicle = current.rows[0];
            const updates = [];
            const params = [];
            let paramIndex = 1;

            for (const field of allowedFields) {
                if (fields[field] !== undefined) {
                    if (field === 'plate') {
                        const newPlate = String(fields[field]).trim().toUpperCase();
                        const dup = await query(
                            'SELECT id FROM vehicles WHERE UPPER(plate) = UPPER($1) AND id != $2',
                            [newPlate, id]
                        );
                        if (dup.rows.length > 0) {
                            return res.status(400).json({ error: 'Машина с таким госномером уже существует' });
                        }
                        updates.push(`${field} = $${paramIndex++}`);
                        params.push(newPlate);
                    } else {
                        updates.push(`${field} = $${paramIndex++}`);
                        params.push(fields[field]);
                    }

                    if (String(vehicle[field]) !== String(fields[field])) {
                        await logChange(req.user.id, 'vehicles', id, field, vehicle[field], fields[field], ip);
                    }
                }
            }

            if (updates.length === 0) {
                return res.json({ success: true, message: 'Нет изменений' });
            }

            params.push(id);
            const sql = `UPDATE vehicles SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            return res.json({ success: true, vehicle: result.rows[0] });

        } catch (e) {
            console.error('PUT vehicle error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ DELETE (archive or delete) ============
    if (action === 'delete') {
        if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID машины не указан' });

        if (req.user.role !== 'admin' && req.user.role !== 'senior_logist') {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }

        try {
            const check = await query('SELECT * FROM vehicles WHERE id = $1', [id]);
            if (check.rows.length === 0) {
                return res.status(404).json({ error: 'Машина не найдена' });
            }

            const used = await query('SELECT COUNT(*) as cnt FROM trips WHERE vehicle_id = $1', [id]);

            if (parseInt(used.rows[0].cnt) > 0) {
                await query('UPDATE vehicles SET is_archived = true WHERE id = $1', [id]);
                await logChange(req.user.id, 'vehicles', id, 'Архивация', 'Активна', 'Архив', ip);
                return res.json({
                    success: true,
                    message: 'Машина использовалась в рейсах, поэтому перемещена в архив'
                });
            }

            await query('DELETE FROM vehicles WHERE id = $1', [id]);
            await logChange(req.user.id, 'vehicles', id, 'Удаление', check.rows[0].plate, '', ip);

            return res.json({ success: true });

        } catch (e) {
            console.error('DELETE vehicle error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ INDEX: список / создание ============
    if (req.method === 'GET') {
        try {
            const { include_archived } = req.query;
            let sql = `
                SELECT id, plate, model, type, volume, fuel_rate, amort_rate,
                       is_archived, created_at
                FROM vehicles
            `;
            if (include_archived !== 'true') {
                sql += ' WHERE is_archived = false';
            }
            sql += ' ORDER BY is_archived ASC, plate ASC';

            const result = await query(sql);
            return res.json({ vehicles: result.rows });
        } catch (e) {
            console.error('GET vehicles error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    if (req.method === 'POST') {
        const { plate, model, type, volume, fuel_rate, amort_rate } = req.body;

        const errors = validateVehicle(req.body, false);
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }

        try {
            const existing = await query(
                'SELECT id FROM vehicles WHERE UPPER(plate) = UPPER($1)',
                [plate.trim()]
            );
            if (existing.rows.length > 0) {
                return res.status(400).json({ error: 'Машина с таким госномером уже существует' });
            }

            const result = await query(
                `INSERT INTO vehicles (plate, model, type, volume, fuel_rate, amort_rate)
                 VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
                [plate.trim().toUpperCase(), model || null, type || 'own',
                 volume || 0, fuel_rate || 0, amort_rate || 0]
            );

            await logChange(req.user.id, 'vehicles', result.rows[0].id, 'Создание', '', result.rows[0].plate, ip);

            return res.status(201).json({ success: true, vehicle: result.rows[0] });

        } catch (e) {
            console.error('POST vehicle error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
