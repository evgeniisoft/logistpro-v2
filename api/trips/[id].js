const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');
const { validateTrip } = require('../_lib/validation');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const tripId = req.query.id;

    if (!tripId) {
        return res.status(400).json({ error: 'ID рейса не указан' });
    }

    // ============ GET: один рейс с заказами и затратами ============
    if (req.method === 'GET') {
        try {
            const tripResult = await query(
                `SELECT 
                    t.*,
                    v.plate AS vehicle_plate, v.model AS vehicle_model,
                    v.type AS vehicle_type, v.volume AS vehicle_volume,
                    d.full_name AS driver_name, d.phone AS driver_phone,
                    r.name AS route_name
                FROM trips t
                LEFT JOIN vehicles v ON v.id = t.vehicle_id
                LEFT JOIN drivers d ON d.id = t.driver_id
                LEFT JOIN routes r ON r.id = t.route_id
                WHERE t.id = $1`,
                [tripId]
            );

            if (tripResult.rows.length === 0) {
                return res.status(404).json({ error: 'Рейс не найден' });
            }

            const ordersResult = await query(
                'SELECT * FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC',
                [tripId]
            );

            const costsResult = await query(
                'SELECT * FROM costs WHERE trip_id = $1 ORDER BY created_at DESC',
                [tripId]
            );

            res.json({
                trip: tripResult.rows[0],
                orders: ordersResult.rows,
                costs: costsResult.rows
            });

        } catch (e) {
            console.error('GET /api/trips/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    // ============ PUT: обновить рейс ============
    if (req.method === 'PUT') {
        const { version, ...fields } = req.body;

        const errors = validateTrip(fields, true);
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }

        try {
            // Получаем текущий рейс
            const current = await query('SELECT * FROM trips WHERE id = $1', [tripId]);
            if (current.rows.length === 0) {
                return res.status(404).json({ error: 'Рейс не найден' });
            }

            const trip = current.rows[0];

            // Оптимистичная блокировка
            if (version !== undefined && trip.version !== version) {
                return res.status(409).json({
                    error: 'Рейс был изменён другим пользователем',
                    current_version: trip.version
                });
            }

            // Разрешённые поля для обновления
            const allowedFields = [
                'trip_date', 'trip_type', 'vehicle_id', 'driver_id', 'route_id',
                'route_text', 'plan_km', 'fact_km', 'status', 'revenue', 'comment'
            ];

            const updates = [];
            const params = [];
            let paramIndex = 1;

            for (const field of allowedFields) {
                if (fields[field] !== undefined) {
                    updates.push(`${field} = $${paramIndex++}`);
                    params.push(fields[field]);

                    // Логируем изменение
                    if (trip[field] !== fields[field]) {
                        await logChange(
                            req.user.id, 'trips', tripId,
                            field, trip[field], fields[field], ip
                        );
                    }
                }
            }

            if (updates.length === 0) {
                return res.json({ success: true, message: 'Нет изменений' });
            }

            // Увеличиваем version
            updates.push(`version = version + 1`);
            updates.push(`updated_at = NOW()`);

            params.push(tripId);
            const sql = `UPDATE trips SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;

            const result = await query(sql, params);

            res.json({
                success: true,
                trip: result.rows[0]
            });

        } catch (e) {
            console.error('PUT /api/trips/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    // ============ DELETE: удалить рейс ============
    if (req.method === 'DELETE') {
        if (req.user.role !== 'admin' && req.user.role !== 'senior_logist') {
            return res.status(403).json({ error: 'Недостаточно прав для удаления' });
        }

        try {
            const check = await query(
                'SELECT trip_number FROM trips WHERE id = $1',
                [tripId]
            );
            if (check.rows.length === 0) {
                return res.status(404).json({ error: 'Рейс не найден' });
            }

            const tripNumber = check.rows[0].trip_number;

            // Каскадное удаление через ON DELETE CASCADE в БД
            await query('DELETE FROM trips WHERE id = $1', [tripId]);

            await logChange(
                req.user.id, 'trips', tripId, 'Удаление', tripNumber, '', ip
            );

            res.json({ success: true });

        } catch (e) {
            console.error('DELETE /api/trips/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
