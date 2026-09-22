const { query } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { logChange } = require('./_lib/journal');
const { validateTrip } = require('./_lib/validation');
const { generateTripNumber } = require('./_lib/numbers');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const action = req.query.action || 'index';
    const id = req.query.id;

    // ============ GET ONE (карточка рейса) ============
    if (action === 'get') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID рейса не указан' });

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
                [id]
            );

            if (tripResult.rows.length === 0) {
                return res.status(404).json({ error: 'Рейс не найден' });
            }

            const ordersResult = await query(
                'SELECT * FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC NULLS LAST, id ASC',
                [id]
            );

            const costsResult = await query(
                'SELECT * FROM costs WHERE trip_id = $1 ORDER BY created_at DESC',
                [id]
            );

            return res.json({
                trip: tripResult.rows[0],
                orders: ordersResult.rows,
                costs: costsResult.rows
            });

        } catch (e) {
            console.error('GET trip error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ UPDATE (обновить рейс) ============
    if (action === 'update') {
        if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID рейса не указан' });

        const { version, ...fields } = req.body;

        const errors = validateTrip(fields, true);
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }

        try {
            const current = await query('SELECT * FROM trips WHERE id = $1', [id]);
            if (current.rows.length === 0) {
                return res.status(404).json({ error: 'Рейс не найден' });
            }

            const trip = current.rows[0];

            if (version !== undefined && trip.version !== version) {
                return res.status(409).json({
                    error: 'Рейс был изменён другим пользователем',
                    current_version: trip.version
                });
            }

            const allowedFields = [
                'trip_date', 'trip_type', 'vehicle_id', 'driver_id', 'route_id',
                'route_text', 'plan_km', 'fact_km', 'status', 'revenue', 'comment',
                'cancel_reason', 'problem_comment',
                'vehicle_volume_at_time', 'driver_rate_at_time'
            ];

            const updates = [];
            const params = [];
            let paramIndex = 1;

            for (const field of allowedFields) {
                if (fields[field] !== undefined) {
                    if (field === 'driver_id' && fields[field] !== trip.driver_id) {
                        const newDriver = await query('SELECT default_rate FROM drivers WHERE id = $1', [fields[field]]);
                        if (newDriver.rows.length > 0) {
                            updates.push(`driver_rate_at_time = $${paramIndex++}`);
                            params.push(newDriver.rows[0].default_rate);
                        }
                    }
                    if (field === 'vehicle_id' && fields[field] !== trip.vehicle_id) {
                        const newVehicle = await query('SELECT volume FROM vehicles WHERE id = $1', [fields[field]]);
                        if (newVehicle.rows.length > 0) {
                            updates.push(`vehicle_volume_at_time = $${paramIndex++}`);
                            params.push(newVehicle.rows[0].volume);
                        }
                    }

                    updates.push(`${field} = $${paramIndex++}`);
                    params.push(fields[field]);

                    if (String(trip[field]) !== String(fields[field])) {
                        await logChange(req.user.id, 'trips', id, field, trip[field], fields[field], ip);
                    }
                }
            }

            if (updates.length === 0) {
                return res.json({ success: true, message: 'Нет изменений' });
            }

            updates.push('version = version + 1');
            updates.push('updated_at = NOW()');

            params.push(id);
            const sql = `UPDATE trips SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            return res.json({ success: true, trip: result.rows[0] });

        } catch (e) {
            console.error('PUT trip error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ DELETE ============
    if (action === 'delete') {
        if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID рейса не указан' });

        if (req.user.role !== 'admin' && req.user.role !== 'senior_logist') {
            return res.status(403).json({ error: 'Недостаточно прав для удаления' });
        }

        try {
            const check = await query('SELECT trip_number, status FROM trips WHERE id = $1', [id]);
            if (check.rows.length === 0) return res.status(404).json({ error: 'Рейс не найден' });

            if (['transit', 'done'].includes(check.rows[0].status)) {
                return res.status(400).json({ error: 'Нельзя удалить рейс в статусе "' + check.rows[0].status + '"' });
            }

            await query('DELETE FROM trips WHERE id = $1', [id]);
            await logChange(req.user.id, 'trips', id, 'Удаление', check.rows[0].trip_number, '', ip);

            return res.json({ success: true });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ REORDER ============
    if (action === 'reorder') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID рейса не указан' });

        const { order_ids } = req.body;
        if (!Array.isArray(order_ids) || order_ids.length === 0) {
            return res.status(400).json({ error: 'Не передан список order_ids' });
        }

        try {
            const orders = await query('SELECT id FROM orders WHERE trip_id = $1', [id]);
            const existingIds = orders.rows.map(r => r.id);
            const invalidIds = order_ids.filter(oid => !existingIds.includes(oid));

            if (invalidIds.length > 0) {
                return res.status(400).json({ error: 'Некоторые заказы не принадлежат этому рейсу', invalid: invalidIds });
            }

            for (let i = 0; i < order_ids.length; i++) {
                await query(
                    'UPDATE orders SET sequence_num = $1, updated_at = NOW() WHERE id = $2',
                    [i + 1, order_ids[i]]
                );
            }

            await logChange(req.user.id, 'trips', id, 'Пересортировка', '', 'Изменён порядок адресов', ip);

            return res.json({ success: true });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ MOVE ALL ORDERS ============
    if (action === 'move-all-orders') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID рейса не указан' });

        const { to_trip_id, reason } = req.body;
        if (!to_trip_id) return res.status(400).json({ error: 'Не указан целевой рейс' });
        if (id === String(to_trip_id)) return res.status(400).json({ error: 'Исходный и целевой рейс совпадают' });

        try {
            const targetTrip = await query('SELECT id, trip_number FROM trips WHERE id = $1', [to_trip_id]);
            if (targetTrip.rows.length === 0) return res.status(404).json({ error: 'Целевой рейс не найден' });

            const orders = await query(
                'SELECT id FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC NULLS LAST, id ASC',
                [id]
            );

            if (orders.rows.length === 0) {
                return res.status(400).json({ error: 'В рейсе нет заказов для переноса' });
            }

            const maxSeqResult = await query(
                'SELECT COALESCE(MAX(sequence_num), 0) as max FROM orders WHERE trip_id = $1',
                [to_trip_id]
            );
            let nextSeq = maxSeqResult.rows[0].max + 1;

            for (const order of orders.rows) {
                await query(
                    'UPDATE orders SET trip_id = $1, sequence_num = $2, updated_at = NOW() WHERE id = $3',
                    [to_trip_id, nextSeq, order.id]
                );
                await query(
                    `INSERT INTO order_history (order_id, from_trip_id, to_trip_id, reason, moved_by)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [order.id, id, to_trip_id, reason || 'Перенос всех заказов', req.user.id]
                );
                nextSeq++;
            }

            await logChange(req.user.id, 'trips', id, 'Перенос всех заказов', 'Рейс ' + id, 'Рейс ' + to_trip_id, ip);

            return res.json({
                success: true,
                moved_count: orders.rows.length,
                message: 'Перенесено ' + orders.rows.length + ' заказов в рейс ' + targetTrip.rows[0].trip_number
            });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ CANCEL ============
    if (action === 'cancel') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID рейса не указан' });

        const { reason, orders_action } = req.body;
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Укажите причину отмены' });
        if (!['return_to_incoming', 'mark_cancelled'].includes(orders_action)) {
            return res.status(400).json({ error: 'Укажите действие с заказами' });
        }

        try {
            const tripResult = await query('SELECT trip_number, status FROM trips WHERE id = $1', [id]);
            if (tripResult.rows.length === 0) return res.status(404).json({ error: 'Рейс не найден' });

            const trip = tripResult.rows[0];
            if (trip.status === 'done') return res.status(400).json({ error: 'Нельзя отменить завершённый рейс' });
            if (trip.status === 'cancelled') return res.status(400).json({ error: 'Рейс уже отменён' });

            if (orders_action === 'return_to_incoming') {
                await query(
                    `UPDATE orders SET trip_id = NULL, sequence_num = NULL, status = 'new', updated_at = NOW()
                     WHERE trip_id = $1`,
                    [id]
                );
            } else {
                await query(
                    `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE trip_id = $1`,
                    [id]
                );
            }

            await query(
                `UPDATE trips SET status = 'cancelled', cancel_reason = $1, updated_at = NOW(), version = version + 1
                 WHERE id = $2`,
                [reason.trim(), id]
            );

            await logChange(req.user.id, 'trips', id, 'Отмена', trip.status, 'cancelled. ' + reason, ip);

            return res.json({ success: true, message: 'Рейс ' + trip.trip_number + ' отменён' });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ PROBLEM ============
    if (action === 'problem') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID рейса не указан' });

        const { comment } = req.body;
        if (!comment || !comment.trim()) return res.status(400).json({ error: 'Укажите комментарий' });

        try {
            const tripResult = await query('SELECT trip_number, status FROM trips WHERE id = $1', [id]);
            if (tripResult.rows.length === 0) return res.status(404).json({ error: 'Рейс не найден' });

            const trip = tripResult.rows[0];
            if (['done', 'cancelled'].includes(trip.status)) {
                return res.status(400).json({ error: 'Нельзя отметить проблему у завершённого/отменённого рейса' });
            }

            await query(
                `UPDATE trips SET status = 'problem', problem_comment = $1, updated_at = NOW(), version = version + 1
                 WHERE id = $2`,
                [comment.trim(), id]
            );

            await logChange(req.user.id, 'trips', id, 'Проблема', trip.status, 'problem. ' + comment, ip);

            return res.json({ success: true, message: 'Рейс ' + trip.trip_number + ' помечен как проблемный' });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ INDEX: список / создание ============
    if (req.method === 'GET') {
        try {
            const { status, month, driver_id, vehicle_id, limit } = req.query;

            let sql = `
                SELECT 
                    t.id, t.trip_number, t.trip_date, t.trip_type, t.status,
                    t.plan_km, t.fact_km, t.revenue, t.comment, t.version,
                    t.driver_rate_at_time, t.vehicle_volume_at_time,
                    t.created_at, t.updated_at,
                    v.plate AS vehicle_plate, v.model AS vehicle_model, v.type AS vehicle_type,
                    d.full_name AS driver_name,
                    r.name AS route_name,
                    (SELECT COUNT(*) FROM orders WHERE trip_id = t.id) AS orders_count,
                    (SELECT COALESCE(SUM(volume), 0) FROM orders WHERE trip_id = t.id) AS total_volume,
                    (SELECT COALESCE(SUM(amount), 0) FROM costs WHERE trip_id = t.id) AS total_costs
                FROM trips t
                LEFT JOIN vehicles v ON v.id = t.vehicle_id
                LEFT JOIN drivers d ON d.id = t.driver_id
                LEFT JOIN routes r ON r.id = t.route_id
                WHERE 1=1
            `;

            const params = [];
            let paramIndex = 1;

            if (status) { sql += ` AND t.status = $${paramIndex++}`; params.push(status); }
            if (month) { sql += ` AND TO_CHAR(t.trip_date, 'YYYY-MM') = $${paramIndex++}`; params.push(month); }
            if (driver_id) { sql += ` AND t.driver_id = $${paramIndex++}`; params.push(driver_id); }
            if (vehicle_id) { sql += ` AND t.vehicle_id = $${paramIndex++}`; params.push(vehicle_id); }

            sql += ` ORDER BY t.trip_date DESC, t.id DESC`;

            const limitNum = parseInt(limit) || 500;
            sql += ` LIMIT $${paramIndex++}`;
            params.push(limitNum);

            const result = await query(sql, params);
            return res.json({ trips: result.rows });

        } catch (e) {
            console.error('GET trips error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    if (req.method === 'POST') {
        const {
            trip_date, trip_type, vehicle_id, driver_id, route_id,
            route_text, plan_km, fact_km, revenue, comment, addresses
        } = req.body;

        const errors = validateTrip(req.body, false);
        if (errors.length > 0) return res.status(400).json({ error: errors.join(', ') });

        try {
            const vehicleRes = await query('SELECT volume FROM vehicles WHERE id = $1 AND is_archived = false', [vehicle_id]);
            if (vehicleRes.rows.length === 0) return res.status(400).json({ error: 'Машина не найдена или архивирована' });

            const driverRes = await query('SELECT default_rate FROM drivers WHERE id = $1 AND is_archived = false', [driver_id]);
            if (driverRes.rows.length === 0) return res.status(400).json({ error: 'Водитель не найден или архивирован' });

            const vehicleVolume = vehicleRes.rows[0].volume;
            const driverRate = driverRes.rows[0].default_rate;

            const tripNumber = await generateTripNumber();

            const tripResult = await query(
                `INSERT INTO trips (
                    trip_number, trip_date, trip_type, vehicle_id, vehicle_volume_at_time,
                    driver_id, driver_rate_at_time, route_id, route_text, plan_km, fact_km,
                    revenue, comment, created_by
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                RETURNING id, trip_number`,
                [
                    tripNumber, trip_date, trip_type || 'city', vehicle_id, vehicleVolume,
                    driver_id, driverRate, route_id || null, route_text || null,
                    plan_km || 0, fact_km || 0, revenue || 0, comment || null, req.user.id
                ]
            );

            const tripId = tripResult.rows[0].id;

            if (addresses && Array.isArray(addresses) && addresses.length > 0) {
                for (let i = 0; i < addresses.length; i++) {
                    const addr = addresses[i];
                    if (!addr.address) continue;

                    await query(
                        `INSERT INTO orders (trip_id, address, contact_name, phone, volume, sequence_num, note, source)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')`,
                        [tripId, addr.address, addr.contact_name || null,
                         addr.phone || null, addr.volume || 0, i + 1, addr.note || null]
                    );
                }
            }

            await logChange(req.user.id, 'trips', tripId, 'Создание', '', tripNumber, ip);

            return res.status(201).json({
                success: true,
                trip: { id: tripId, trip_number: tripNumber }
            });

        } catch (e) {
            console.error('POST trips error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
