const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const routeId = req.query.id;

    if (!routeId) {
        return res.status(400).json({ error: 'ID маршрута не указан' });
    }

    if (req.method === 'GET') {
        try {
            const result = await query('SELECT * FROM routes WHERE id = $1', [routeId]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Маршрут не найден' });
            }
            res.json({ route: result.rows[0] });
        } catch (e) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
        return;
    }

    if (req.method === 'PUT') {
        const fields = req.body;
        const allowedFields = ['name', 'from_point', 'to_point', 'distance_km', 'estimated_time', 'toll_cost', 'is_archived'];

        try {
            const current = await query('SELECT * FROM routes WHERE id = $1', [routeId]);
            if (current.rows.length === 0) {
                return res.status(404).json({ error: 'Маршрут не найден' });
            }

            const route = current.rows[0];
            const updates = [];
            const params = [];
            let paramIndex = 1;

            for (const field of allowedFields) {
                if (fields[field] !== undefined) {
                    updates.push(`${field} = $${paramIndex++}`);
                    params.push(fields[field]);
                    if (String(route[field]) !== String(fields[field])) {
                        await logChange(
                            req.user.id, 'routes', routeId,
                            field, route[field], fields[field], ip
                        );
                    }
                }
            }

            if (updates.length === 0) {
                return res.json({ success: true, message: 'Нет изменений' });
            }

            params.push(routeId);
            const sql = `UPDATE routes SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            res.json({ success: true, route: result.rows[0] });

        } catch (e) {
            console.error('PUT /api/routes/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
        return;
    }

    if (req.method === 'DELETE') {
        if (req.user.role !== 'admin' && req.user.role !== 'senior_logist') {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }

        try {
            const check = await query('SELECT * FROM routes WHERE id = $1', [routeId]);
            if (check.rows.length === 0) {
                return res.status(404).json({ error: 'Маршрут не найден' });
            }

            const used = await query(
                'SELECT COUNT(*) as cnt FROM trips WHERE route_id = $1',
                [routeId]
            );

            if (parseInt(used.rows[0].cnt) > 0) {
                await query('UPDATE routes SET is_archived = true WHERE id = $1', [routeId]);
                await logChange(req.user.id, 'routes', routeId, 'Архивация', 'Активен', 'Архив', ip);
                return res.json({ success: true, message: 'Маршрут использовался в рейсах, поэтому перемещён в архив' });
            }

            await query('DELETE FROM routes WHERE id = $1', [routeId]);
            await logChange(req.user.id, 'routes', routeId, 'Удаление', check.rows[0].name, '', ip);

            res.json({ success: true });

        } catch (e) {
            console.error('DELETE /api/routes/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
