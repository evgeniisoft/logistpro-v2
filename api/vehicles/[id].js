const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const vehicleId = req.query.id;

    if (!vehicleId) {
        return res.status(400).json({ error: 'ID машины не указан' });
    }

    // ============ GET: одна машина ============
    if (req.method === 'GET') {
        try {
            const result = await query(
                'SELECT * FROM vehicles WHERE id = $1',
                [vehicleId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Машина не найдена' });
            }

            res.json({ vehicle: result.rows[0] });

        } catch (e) {
            console.error('GET /api/vehicles/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
        return;
    }

    // ============ PUT: обновить машину ============
    if (req.method === 'PUT') {
        const fields = req.body;
        const allowedFields = ['plate', 'model', 'type', 'volume', 'fuel_rate', 'amort_rate', 'is_archived'];

        try {
            const current = await query('SELECT * FROM vehicles WHERE id = $1', [vehicleId]);
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
                            [newPlate, vehicleId]
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
                        await logChange(
                            req.user.id, 'vehicles', vehicleId,
                            field, vehicle[field], fields[field], ip
                        );
                    }
                }
            }

            if (updates.length === 0) {
                return res.json({ success: true, message: 'Нет изменений' });
            }

            params.push(vehicleId);
            const sql = `UPDATE vehicles SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            res.json({ success: true, vehicle: result.rows[0] });

        } catch (e) {
            console.error('PUT /api/vehicles/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    // ============ DELETE: архивировать или удалить ============
    if (req.method === 'DELETE') {
        if (req.user.role !== 'admin' && req.user.role !== 'senior_logist') {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }

        try {
            const check = await query('SELECT * FROM vehicles WHERE id = $1', [vehicleId]);
            if (check.rows.length === 0) {
                return res.status(404).json({ error: 'Машина не найдена' });
            }

            // Проверяем, используется ли машина в рейсах
            const used = await query(
                'SELECT COUNT(*) as cnt FROM trips WHERE vehicle_id = $1',
                [vehicleId]
            );

            if (parseInt(used.rows[0].cnt) > 0) {
                // Мягкое удаление — архивация
                await query('UPDATE vehicles SET is_archived = true WHERE id = $1', [vehicleId]);
                await logChange(
                    req.user.id, 'vehicles', vehicleId,
                    'Архивация', 'Активна', 'Архив', ip
                );
                return res.json({
                    success: true,
                    message: 'Машина использовалась в рейсах, поэтому перемещена в архив'
                });
            }

            // Полное удаление, если не используется
            await query('DELETE FROM vehicles WHERE id = $1', [vehicleId]);
            await logChange(
                req.user.id, 'vehicles', vehicleId,
                'Удаление', check.rows[0].plate, '', ip
            );

            res.json({ success: true });

        } catch (e) {
            console.error('DELETE /api/vehicles/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
