const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');
const { validateTrip } = require('../_lib/validation');
const { generateTripNumber } = require('../_lib/numbers');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // ============ GET: список рейсов ============
    if (req.method === 'GET') {
        try {
            const { status, month, driver_id, vehicle_id, limit } = req.query;

            let sql = `
                SELECT 
                    t.id, t.trip_number, t.trip_date, t.trip_type, t.status,
                    t.plan_km, t.fact_km, t.revenue, t.comment, t.version,
                    t.driver_rate_at_time, t.vehicle_volume_at_time,
                    t.created_at, t.updated_at,
                    v.plate AS vehicle_plate,
                    v.model AS vehicle_model,
                    v.type AS vehicle_type,
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

            if (status) {
                sql += ` AND t.status = $${paramIndex++}`;
                params.push(status);
            }

            if (month) {
                sql += ` AND TO_CHAR(t.trip_date, 'YYYY-MM') = $${paramIndex++}`;
                params.push(month);
            }

            if (driver_id) {
                sql += ` AND t.driver_id = $${paramIndex++}`;
                params.push(driver_id);
            }

            if (vehicle_id) {
                sql += ` AND t.vehicle_id = $${paramIndex++}`;
                params.push(vehicle_id);
            }

            sql += ` ORDER BY t.trip_date DESC, t.id DESC`;

            const limitNum = parseInt(limit) || 500;
            sql += ` LIMIT $${paramIndex++}`;
            params.push(limitNum);

            const result = await query(sql, params);

            res.json({ trips: result.rows });

        } catch (e) {
            console.error('GET /api/trips error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    // ============ POST: создать рейс ============
    if (req.method === 'POST') {
        const {
            trip_date, trip_type, vehicle_id, driver_id, route_id,
            route_text, plan_km, fact_km, revenue, comment,
            addresses // массив адресов доставки
        } = req.body;

        const errors = validateTrip(req.body, false);
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }

        const client = await require('../_lib/db').query('BEGIN').catch(() => null);

        try {
            // Загружаем данные машины и водителя (snapshot)
            const vehicleRes = await query(
                'SELECT volume FROM vehicles WHERE id = $1 AND is_archived = false',
                [vehicle_id]
            );
            if (vehicleRes.rows.length === 0) {
                return res.status(400).json({ error: 'Машина не найдена или архивирована' });
            }

            const driverRes = await query(
                'SELECT default_rate FROM drivers WHERE id = $1 AND is_archived = false',
                [driver_id]
            );
            if (driverRes.rows.length === 0) {
                return res.status(400).json({ error: 'Водитель не найден или архивирован' });
            }

            const vehicleVolume = vehicleRes.rows[0].volume;
            const driverRate = driverRes.rows[0].default_rate;

            // Генерируем номер рейса
            const tripNumber = await generateTripNumber();

            // Вставляем рейс
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
                    plan_km || 0, fact_km || 0, revenue || 0, comment || null,
                    req.user.id
                ]
            );

            const tripId = tripResult.rows[0].id;

            // Добавляем адреса (если есть)
            if (addresses && Array.isArray(addresses) && addresses.length > 0) {
                for (let i = 0; i < addresses.length; i++) {
                    const addr = addresses[i];
                    if (!addr.address) continue;

                    await query(
                        `INSERT INTO orders (
                            trip_id, address, contact_name, phone, volume, sequence_num, note, source
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'manual')`,
                        [
                            tripId, addr.address, addr.contact_name || null,
                            addr.phone || null, addr.volume || 0, i + 1, addr.note || null
                        ]
                    );
                }
            }

            // Логируем создание
            await logChange(
                req.user.id, 'trips', tripId, 'Создание', '', tripNumber, ip
            );

            res.status(201).json({
                success: true,
                trip: {
                    id: tripId,
                    trip_number: tripNumber
                }
            });

        } catch (e) {
            console.error('POST /api/trips error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
