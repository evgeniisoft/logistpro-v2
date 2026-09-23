const { query } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');

async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const action = req.query.action || 'dashboard';
    const { from, to, driver_id, vehicle_id } = req.query;

    // Формируем WHERE для фильтра по периоду
    const periodFilter = [];
    const periodParams = [];
    let paramIndex = 1;

    if (from) {
        periodFilter.push(`t.trip_date >= $${paramIndex++}`);
        periodParams.push(from);
    }
    if (to) {
        periodFilter.push(`t.trip_date <= $${paramIndex++}`);
        periodParams.push(to);
    }
    if (driver_id) {
        periodFilter.push(`t.driver_id = $${paramIndex++}`);
        periodParams.push(driver_id);
    }
    if (vehicle_id) {
        periodFilter.push(`t.vehicle_id = $${paramIndex++}`);
        periodParams.push(vehicle_id);
    }

    const whereClause = periodFilter.length > 0 ? 'WHERE ' + periodFilter.join(' AND ') : '';

    try {
        // ============ DASHBOARD ============
        if (action === 'dashboard') {
            // Общие KPI
            const kpiResult = await query(
                `SELECT 
                    COUNT(*) AS trips_count,
                    COUNT(*) FILTER (WHERE t.status = 'done') AS trips_done,
                    COUNT(*) FILTER (WHERE t.status = 'cancelled') AS trips_cancelled,
                    COALESCE(SUM(t.revenue), 0) AS total_revenue,
                    COALESCE(SUM(t.fact_km), 0) AS total_km
                 FROM trips t
                 ${whereClause}`,
                periodParams
            );

            const kpi = kpiResult.rows[0];

            // Затраты
            const costsResult = await query(
                `SELECT COALESCE(SUM(c.amount), 0) AS total_costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}`,
                periodParams
            );

            const totalCosts = Number(costsResult.rows[0].total_costs);

            // Автоматические затраты (зарплата + амортизация)
            const autoCostsResult = await query(
                `SELECT 
                    COALESCE(SUM(t.driver_rate_at_time), 0) AS total_salary,
                    COALESCE(SUM(CASE WHEN v.type = 'own' THEN t.fact_km * v.amort_rate ELSE 0 END), 0) AS total_amort
                 FROM trips t
                 LEFT JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause}`,
                periodParams
            );

            const autoSalary = Number(autoCostsResult.rows[0].total_salary);
            const autoAmort = Number(autoCostsResult.rows[0].total_amort);

            // Но если затраты уже включают зарплату/амортизацию — не дублируем
            const salaryInCosts = await query(
                `SELECT COALESCE(SUM(c.amount), 0) AS sum
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause ? whereClause + ' AND' : 'WHERE'} c.category = 'salary'`,
                periodParams
            );
            const amortInCosts = await query(
                `SELECT COALESCE(SUM(c.amount), 0) AS sum
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause ? whereClause + ' AND' : 'WHERE'} c.category = 'amort'`,
                periodParams
            );

            const salaryAlreadyIn = Number(salaryInCosts.rows[0].sum);
            const amortAlreadyIn = Number(amortInCosts.rows[0].sum);

            const totalCostsAll = totalCosts 
                + (salaryAlreadyIn === 0 ? autoSalary : 0) 
                + (amortAlreadyIn === 0 ? autoAmort : 0);

            const revenue = Number(kpi.total_revenue);
            const margin = revenue - totalCostsAll;
            const marginPercent = revenue > 0 ? Math.round(margin / revenue * 100) : 0;
            const avgTripCost = kpi.trips_count > 0 ? Math.round(totalCostsAll / kpi.trips_count) : 0;
            const avgRevenue = kpi.trips_count > 0 ? Math.round(revenue / kpi.trips_count) : 0;

            // Топ-5 водителей
            const topDrivers = await query(
                `SELECT 
                    d.id AS driver_id,
                    d.full_name AS driver_name,
                    COUNT(t.id) AS trips_count,
                    COALESCE(SUM(t.fact_km), 0) AS total_km,
                    COALESCE(SUM(t.revenue), 0) AS total_revenue
                 FROM trips t
                 JOIN drivers d ON d.id = t.driver_id
                 ${whereClause}
                 GROUP BY d.id, d.full_name
                 ORDER BY trips_count DESC
                 LIMIT 5`,
                periodParams
            );

            // Топ-5 машин
            const topVehicles = await query(
                `SELECT 
                    v.id AS vehicle_id,
                    v.plate AS vehicle_plate,
                    v.model AS vehicle_model,
                    COUNT(t.id) AS trips_count,
                    COALESCE(SUM(t.fact_km), 0) AS total_km
                 FROM trips t
                 JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause}
                 GROUP BY v.id, v.plate, v.model
                 ORDER BY trips_count DESC
                 LIMIT 5`,
                periodParams
            );

            // Динамика по месяцам
            const monthly = await query(
                `SELECT 
                    TO_CHAR(t.trip_date, 'YYYY-MM') AS month,
                    TO_CHAR(t.trip_date, 'TMMonth YYYY') AS month_label,
                    COUNT(*) AS trips_count,
                    COALESCE(SUM(t.revenue), 0) AS revenue,
                    COALESCE(SUM(t.fact_km), 0) AS total_km
                 FROM trips t
                 ${whereClause}
                 GROUP BY TO_CHAR(t.trip_date, 'YYYY-MM'), TO_CHAR(t.trip_date, 'TMMonth YYYY')
                 ORDER BY month DESC
                 LIMIT 12`,
                periodParams
            );

            // Затраты по месяцам
            const monthlyCosts = await query(
                `SELECT 
                    TO_CHAR(t.trip_date, 'YYYY-MM') AS month,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY TO_CHAR(t.trip_date, 'YYYY-MM')`,
                periodParams
            );

            // Объединяем месяцы с затратами
            const monthlyWithCosts = monthly.rows.map(m => {
                const costRow = monthlyCosts.rows.find(c => c.month === m.month);
                const costs = costRow ? Number(costRow.costs) : 0;
                const revenue = Number(m.revenue);
                return {
                    month: m.month,
                    month_label: m.month_label.trim(),
                    trips_count: Number(m.trips_count),
                    revenue: revenue,
                    costs: costs,
                    margin: revenue - costs,
                    total_km: Number(m.total_km)
                };
            });

            return res.json({
                kpi: {
                    trips_count: Number(kpi.trips_count),
                    trips_done: Number(kpi.trips_done),
                    trips_cancelled: Number(kpi.trips_cancelled),
                    revenue: revenue,
                    costs: totalCostsAll,
                    margin: margin,
                    margin_percent: marginPercent,
                    avg_trip_cost: avgTripCost,
                    avg_revenue: avgRevenue,
                    total_km: Number(kpi.total_km)
                },
                top_drivers: topDrivers.rows,
                top_vehicles: topVehicles.rows,
                monthly: monthlyWithCosts
            });
        }

        // ============ BY DRIVERS ============
        if (action === 'by-drivers') {
            const result = await query(
                `SELECT 
                    d.id AS driver_id,
                    d.full_name AS driver_name,
                    d.phone AS driver_phone,
                    COUNT(t.id) AS trips_count,
                    COUNT(*) FILTER (WHERE t.status = 'done') AS trips_done,
                    COALESCE(SUM(t.fact_km), 0) AS total_km,
                    COALESCE(SUM(t.revenue), 0) AS total_revenue,
                    COALESCE(SUM(t.load_volume), 0) AS total_volume,
                    COALESCE(AVG(CASE 
                        WHEN t.vehicle_volume_at_time > 0 
                        THEN (t.load_volume / t.vehicle_volume_at_time * 100) 
                        ELSE 0 
                    END), 0) AS avg_load_percent
                 FROM trips t
                 JOIN drivers d ON d.id = t.driver_id
                 ${whereClause}
                 GROUP BY d.id, d.full_name, d.phone
                 ORDER BY trips_count DESC`,
                periodParams
            );

            // Затраты по водителям
            const costsResult = await query(
                `SELECT 
                    t.driver_id,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY t.driver_id`,
                periodParams
            );

            const data = result.rows.map(r => {
                const costRow = costsResult.rows.find(c => c.driver_id === r.driver_id);
                const costs = costRow ? Number(costRow.costs) : 0;
                return {
                    ...r,
                    trips_count: Number(r.trips_count),
                    trips_done: Number(r.trips_done),
                    total_km: Number(r.total_km),
                    total_revenue: Number(r.total_revenue),
                    total_volume: Number(r.total_volume),
                    avg_load_percent: Math.round(Number(r.avg_load_percent)),
                    costs: costs,
                    cost_per_trip: r.trips_count > 0 ? Math.round(costs / Number(r.trips_count)) : 0
                };
            });

            return res.json({ data });
        }

        // ============ BY VEHICLES ============
        if (action === 'by-vehicles') {
            const result = await query(
                `SELECT 
                    v.id AS vehicle_id,
                    v.plate AS vehicle_plate,
                    v.model AS vehicle_model,
                    v.type AS vehicle_type,
                    COUNT(t.id) AS trips_count,
                    COALESCE(SUM(t.fact_km), 0) AS total_km,
                    COALESCE(SUM(t.revenue), 0) AS total_revenue
                 FROM trips t
                 JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause}
                 GROUP BY v.id, v.plate, v.model, v.type
                 ORDER BY total_km DESC`,
                periodParams
            );

            const costsResult = await query(
                `SELECT 
                    t.vehicle_id,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY t.vehicle_id`,
                periodParams
            );

            // Отдельно ремонты
            const repairResult = await query(
                `SELECT 
                    t.vehicle_id,
                    COALESCE(SUM(c.amount), 0) AS repairs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause ? whereClause + ' AND' : 'WHERE'} c.category = 'repair'
                 GROUP BY t.vehicle_id`,
                periodParams
            );

            const data = result.rows.map(r => {
                const costRow = costsResult.rows.find(c => c.vehicle_id === r.vehicle_id);
                const repairRow = repairResult.rows.find(c => c.vehicle_id === r.vehicle_id);
                const costs = costRow ? Number(costRow.costs) : 0;
                const repairs = repairRow ? Number(repairRow.repairs) : 0;
                const km = Number(r.total_km);
                return {
                    vehicle_id: r.vehicle_id,
                    vehicle_plate: r.vehicle_plate,
                    vehicle_model: r.vehicle_model,
                    vehicle_type: r.vehicle_type,
                    trips_count: Number(r.trips_count),
                    total_km: km,
                    total_revenue: Number(r.total_revenue),
                    costs: costs,
                    repairs: repairs,
                    cost_per_km: km > 0 ? Math.round(costs / km * 10) / 10 : 0,
                    margin: Number(r.total_revenue) - costs
                };
            });

            return res.json({ data });
        }

        // ============ BY MONTHS ============
        if (action === 'by-months') {
            const result = await query(
                `SELECT 
                    TO_CHAR(t.trip_date, 'YYYY-MM') AS month,
                    TO_CHAR(t.trip_date, 'TMMonth YYYY') AS month_label,
                    COUNT(*) AS trips_count,
                    COUNT(*) FILTER (WHERE t.status = 'done') AS trips_done,
                    COALESCE(SUM(t.fact_km), 0) AS total_km,
                    COALESCE(SUM(t.revenue), 0) AS revenue
                 FROM trips t
                 ${whereClause}
                 GROUP BY TO_CHAR(t.trip_date, 'YYYY-MM'), TO_CHAR(t.trip_date, 'TMMonth YYYY')
                 ORDER BY month DESC`,
                periodParams
            );

            const costsResult = await query(
                `SELECT 
                    TO_CHAR(t.trip_date, 'YYYY-MM') AS month,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY TO_CHAR(t.trip_date, 'YYYY-MM')`,
                periodParams
            );

            const data = result.rows.map(r => {
                const costRow = costsResult.rows.find(c => c.month === r.month);
                const costs = costRow ? Number(costRow.costs) : 0;
                const revenue = Number(r.revenue);
                return {
                    month: r.month,
                    month_label: r.month_label.trim(),
                    trips_count: Number(r.trips_count),
                    trips_done: Number(r.trips_done),
                    total_km: Number(r.total_km),
                    revenue: revenue,
                    costs: costs,
                    margin: revenue - costs,
                    margin_percent: revenue > 0 ? Math.round((revenue - costs) / revenue * 100) : 0
                };
            });

            return res.json({ data });
        }

        // ============ BY ROUTES ============
        if (action === 'by-routes') {
            const result = await query(
                `SELECT 
                    r.id AS route_id,
                    r.name AS route_name,
                    r.from_point,
                    r.to_point,
                    COUNT(t.id) AS trips_count,
                    COALESCE(SUM(t.fact_km), 0) AS total_km,
                    COALESCE(AVG(CASE 
                        WHEN t.vehicle_volume_at_time > 0 
                        THEN (t.load_volume / t.vehicle_volume_at_time * 100) 
                        ELSE 0 
                    END), 0) AS avg_load_percent,
                    COALESCE(SUM(t.revenue), 0) AS total_revenue
                 FROM trips t
                 JOIN routes r ON r.id = t.route_id
                 ${whereClause}
                 GROUP BY r.id, r.name, r.from_point, r.to_point
                 ORDER BY trips_count DESC`,
                periodParams
            );

            const costsResult = await query(
                `SELECT 
                    t.route_id,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause ? whereClause + ' AND' : 'WHERE'} t.route_id IS NOT NULL
                 GROUP BY t.route_id`,
                periodParams
            );

            const data = result.rows.map(r => {
                const costRow = costsResult.rows.find(c => c.route_id === r.route_id);
                const costs = costRow ? Number(costRow.costs) : 0;
                return {
                    route_id: r.route_id,
                    route_name: r.route_name,
                    from_point: r.from_point,
                    to_point: r.to_point,
                    trips_count: Number(r.trips_count),
                    total_km: Number(r.total_km),
                    avg_load_percent: Math.round(Number(r.avg_load_percent)),
                    total_revenue: Number(r.total_revenue),
                    costs: costs,
                    margin: Number(r.total_revenue) - costs
                };
            });

            return res.json({ data });
        }

        // ============ COSTS BREAKDOWN ============
        if (action === 'costs-breakdown') {
            const result = await query(
                `SELECT 
                    c.category,
                    COUNT(*) AS count,
                    COALESCE(SUM(c.amount), 0) AS total
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY c.category
                 ORDER BY total DESC`,
                periodParams
            );

            return res.json({ data: result.rows });
        }

        return res.status(400).json({ error: 'Unknown action: ' + action });

    } catch (e) {
        console.error('Reports error:', e);
        return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
}

module.exports = requireAuth(handler);
