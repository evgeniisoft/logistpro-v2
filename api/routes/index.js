const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // ============ GET: список маршрутов ============
    if (req.method === 'GET') {
        try {
            const { include_archived } = req.query;

            let sql = `
                SELECT 
                    id, name, from_point, to_point, distance_km,
                    estimated_time, toll_cost, is_archived, created_at
                FROM routes
            `;

            if (include_archived !== 'true') {
                sql += ' WHERE is_archived = false';
            }

            sql += ' ORDER BY is_archived ASC, name ASC';

            const result = await query(sql);
            res.json({ routes: result.rows });

        } catch (e) {
            console.error('GET /api/routes error:', e);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
        return;
    }

    // ============ POST: создать маршрут ============
    if (req.method === 'POST') {
        const { name, from_point, to_point, distance_km, estimated_time, toll_cost } = req.body;

        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: 'Название маршрута обязательно' });
        }

        try {
            const result = await query(
                `INSERT INTO routes (name, from_point, to_point, distance_km, estimated_time, toll_cost)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [
                    name.trim(),
                    from_point || null,
                    to_point || null,
                    distance_km || 0,
                    estimated_time || null,
                    toll_cost || 0
                ]
            );

            await logChange(
                req.user.id, 'routes', result.rows[0].id,
                'Создание', '', result.rows[0].name, ip
            );

            res.status(201).json({ success: true, route: result.rows[0] });

        } catch (e) {
            console.error('POST /api/routes error:', e);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
