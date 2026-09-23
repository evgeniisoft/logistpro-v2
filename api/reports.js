const { query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");

async function handler(req, res) {
  if (req.method !== "GET")
    return res.status(405).json({ error: "Method not allowed" });

  const action = req.query.action || "dashboard";
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

  const whereClause =
    periodFilter.length > 0 ? "WHERE " + periodFilter.join(" AND ") : "";

  try {
    // ============ DASHBOARD ============
    if (action === "dashboard") {
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
        periodParams,
      );

      const kpi = kpiResult.rows[0];

      // Затраты
      const costsResult = await query(
        `SELECT COALESCE(SUM(c.amount), 0) AS total_costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}`,
        periodParams,
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
        periodParams,
      );

      const autoSalary = Number(autoCostsResult.rows[0].total_salary);
      const autoAmort = Number(autoCostsResult.rows[0].total_amort);

      // Но если затраты уже включают зарплату/амортизацию — не дублируем
      const salaryInCosts = await query(
        `SELECT COALESCE(SUM(c.amount), 0) AS sum
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause ? whereClause + " AND" : "WHERE"} c.category = 'salary'`,
        periodParams,
      );
      const amortInCosts = await query(
        `SELECT COALESCE(SUM(c.amount), 0) AS sum
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause ? whereClause + " AND" : "WHERE"} c.category = 'amort'`,
        periodParams,
      );

      const salaryAlreadyIn = Number(salaryInCosts.rows[0].sum);
      const amortAlreadyIn = Number(amortInCosts.rows[0].sum);

      const totalCostsAll =
        totalCosts +
        (salaryAlreadyIn === 0 ? autoSalary : 0) +
        (amortAlreadyIn === 0 ? autoAmort : 0);

      const revenue = Number(kpi.total_revenue);
      const margin = revenue - totalCostsAll;
      const marginPercent =
        revenue > 0 ? Math.round((margin / revenue) * 100) : 0;
      const avgTripCost =
        kpi.trips_count > 0 ? Math.round(totalCostsAll / kpi.trips_count) : 0;
      const avgRevenue =
        kpi.trips_count > 0 ? Math.round(revenue / kpi.trips_count) : 0;

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
        periodParams,
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
        periodParams,
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
        periodParams,
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
        periodParams,
      );

      // Объединяем месяцы с затратами
      const monthlyWithCosts = monthly.rows.map((m) => {
        const costRow = monthlyCosts.rows.find((c) => c.month === m.month);
        const costs = costRow ? Number(costRow.costs) : 0;
        const revenue = Number(m.revenue);
        return {
          month: m.month,
          month_label: m.month_label.trim(),
          trips_count: Number(m.trips_count),
          revenue: revenue,
          costs: costs,
          margin: revenue - costs,
          total_km: Number(m.total_km),
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
          total_km: Number(kpi.total_km),
        },
        top_drivers: topDrivers.rows,
        top_vehicles: topVehicles.rows,
        monthly: monthlyWithCosts,
      });
    }

    // ============ BY DRIVERS ============
    if (action === "by-drivers") {
      // Получаем все рейсы с данными водителей
      const tripsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    t.driver_id,
                    t.fact_km,
                    t.revenue,
                    t.load_volume,
                    t.vehicle_volume_at_time,
                    t.status,
                    d.full_name AS driver_name,
                    d.phone AS driver_phone
                 FROM trips t
                 JOIN drivers d ON d.id = t.driver_id
                 ${whereClause}`,
        periodParams,
      );

      // Затраты по рейсам
      const costsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY t.id`,
        periodParams,
      );

      // Собираем по водителям
      const driversMap = {};

      tripsResult.rows.forEach((t) => {
        const did = t.driver_id;
        if (!driversMap[did]) {
          driversMap[did] = {
            driver_id: did,
            driver_name: t.driver_name,
            driver_phone: t.driver_phone,
            trips_count: 0,
            trips_done: 0,
            total_km: 0,
            total_revenue: 0,
            total_volume: 0,
            total_costs: 0,
            load_sum: 0,
            load_count: 0,
          };
        }
        const d = driversMap[did];
        d.trips_count++;
        if (t.status === "done") d.trips_done++;
        d.total_km += Number(t.fact_km) || 0;
        d.total_revenue += Number(t.revenue) || 0;
        d.total_volume += Number(t.load_volume) || 0;

        const cap = Number(t.vehicle_volume_at_time) || 0;
        const load = Number(t.load_volume) || 0;
        if (cap > 0 && load > 0) {
          d.load_sum += (load / cap) * 100;
          d.load_count++;
        }

        const costRow = costsResult.rows.find((c) => c.trip_id === t.trip_id);
        if (costRow) d.total_costs += Number(costRow.costs);
      });

      const data = Object.values(driversMap)
        .map((d) => ({
          driver_id: d.driver_id,
          driver_name: d.driver_name,
          driver_phone: d.driver_phone,
          trips_count: d.trips_count,
          trips_done: d.trips_done,
          total_km: d.total_km,
          total_revenue: d.total_revenue,
          total_volume: d.total_volume,
          avg_load_percent:
            d.load_count > 0 ? Math.round(d.load_sum / d.load_count) : 0,
          costs: d.total_costs,
          cost_per_trip:
            d.trips_count > 0 ? Math.round(d.total_costs / d.trips_count) : 0,
        }))
        .sort((a, b) => b.trips_count - a.trips_count);

      return res.json({ data });
    }

    // ============ BY VEHICLES ============
    if (action === "by-vehicles") {
      const tripsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    t.vehicle_id,
                    t.fact_km,
                    t.revenue,
                    t.status,
                    v.plate AS vehicle_plate,
                    v.model AS vehicle_model,
                    v.type AS vehicle_type
                 FROM trips t
                 JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause}`,
        periodParams,
      );

      const costsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    t.vehicle_id,
                    COALESCE(SUM(c.amount), 0) AS costs,
                    COALESCE(SUM(CASE WHEN c.category = 'repair' THEN c.amount ELSE 0 END), 0) AS repairs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY t.id, t.vehicle_id`,
        periodParams,
      );

      const vehiclesMap = {};

      tripsResult.rows.forEach((t) => {
        const vid = t.vehicle_id;
        if (!vehiclesMap[vid]) {
          vehiclesMap[vid] = {
            vehicle_id: vid,
            vehicle_plate: t.vehicle_plate,
            vehicle_model: t.vehicle_model,
            vehicle_type: t.vehicle_type,
            trips_count: 0,
            total_km: 0,
            total_revenue: 0,
            total_costs: 0,
            total_repairs: 0,
          };
        }
        const v = vehiclesMap[vid];
        v.trips_count++;
        v.total_km += Number(t.fact_km) || 0;
        v.total_revenue += Number(t.revenue) || 0;

        const costRow = costsResult.rows.find((c) => c.trip_id === t.trip_id);
        if (costRow) {
          v.total_costs += Number(costRow.costs);
          v.total_repairs += Number(costRow.repairs);
        }
      });

      const data = Object.values(vehiclesMap)
        .map((v) => ({
          vehicle_id: v.vehicle_id,
          vehicle_plate: v.vehicle_plate,
          vehicle_model: v.vehicle_model,
          vehicle_type: v.vehicle_type,
          trips_count: v.trips_count,
          total_km: v.total_km,
          total_revenue: v.total_revenue,
          costs: v.total_costs,
          repairs: v.total_repairs,
          cost_per_km:
            v.total_km > 0
              ? Math.round((v.total_costs / v.total_km) * 10) / 10
              : 0,
          margin: v.total_revenue - v.total_costs,
        }))
        .sort((a, b) => b.total_km - a.total_km);

      return res.json({ data });
    }

    // ============ BY MONTHS ============
    if (action === "by-months") {
      const tripsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    TO_CHAR(t.trip_date, 'YYYY-MM') AS month,
                    TO_CHAR(t.trip_date, 'TMMonth YYYY') AS month_label,
                    t.fact_km,
                    t.revenue,
                    t.status
                 FROM trips t
                 ${whereClause}`,
        periodParams,
      );

      const costsResult = await query(
        `SELECT 
                    TO_CHAR(t.trip_date, 'YYYY-MM') AS month,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY TO_CHAR(t.trip_date, 'YYYY-MM')`,
        periodParams,
      );

      const monthsMap = {};

      tripsResult.rows.forEach((t) => {
        const m = t.month;
        if (!monthsMap[m]) {
          monthsMap[m] = {
            month: m,
            month_label: t.month_label.trim(),
            trips_count: 0,
            trips_done: 0,
            total_km: 0,
            revenue: 0,
          };
        }
        const row = monthsMap[m];
        row.trips_count++;
        if (t.status === "done") row.trips_done++;
        row.total_km += Number(t.fact_km) || 0;
        row.revenue += Number(t.revenue) || 0;
      });

      const data = Object.values(monthsMap)
        .map((row) => {
          const costRow = costsResult.rows.find((c) => c.month === row.month);
          const costs = costRow ? Number(costRow.costs) : 0;
          return {
            month: row.month,
            month_label: row.month_label,
            trips_count: row.trips_count,
            trips_done: row.trips_done,
            total_km: row.total_km,
            revenue: row.revenue,
            costs: costs,
            margin: row.revenue - costs,
            margin_percent:
              row.revenue > 0
                ? Math.round(((row.revenue - costs) / row.revenue) * 100)
                : 0,
          };
        })
        .sort((a, b) => b.month.localeCompare(a.month));

      return res.json({ data });
    }

    // ============ BY ROUTES ============
    if (action === "by-routes") {
      const tripsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    t.route_id,
                    t.fact_km,
                    t.revenue,
                    t.load_volume,
                    t.vehicle_volume_at_time,
                    r.name AS route_name,
                    r.from_point,
                    r.to_point
                 FROM trips t
                 JOIN routes r ON r.id = t.route_id
                 ${whereClause}`,
        periodParams,
      );

      const costsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY t.id`,
        periodParams,
      );

      const routesMap = {};

      tripsResult.rows.forEach((t) => {
        const rid = t.route_id;
        if (!routesMap[rid]) {
          routesMap[rid] = {
            route_id: rid,
            route_name: t.route_name,
            from_point: t.from_point,
            to_point: t.to_point,
            trips_count: 0,
            total_km: 0,
            total_revenue: 0,
            total_costs: 0,
            load_sum: 0,
            load_count: 0,
          };
        }
        const r = routesMap[rid];
        r.trips_count++;
        r.total_km += Number(t.fact_km) || 0;
        r.total_revenue += Number(t.revenue) || 0;

        const cap = Number(t.vehicle_volume_at_time) || 0;
        const load = Number(t.load_volume) || 0;
        if (cap > 0 && load > 0) {
          r.load_sum += (load / cap) * 100;
          r.load_count++;
        }

        const costRow = costsResult.rows.find((c) => c.trip_id === t.trip_id);
        if (costRow) r.total_costs += Number(costRow.costs);
      });

      const data = Object.values(routesMap)
        .map((r) => ({
          route_id: r.route_id,
          route_name: r.route_name,
          from_point: r.from_point,
          to_point: r.to_point,
          trips_count: r.trips_count,
          total_km: r.total_km,
          avg_load_percent:
            r.load_count > 0 ? Math.round(r.load_sum / r.load_count) : 0,
          total_revenue: r.total_revenue,
          costs: r.total_costs,
          margin: r.total_revenue - r.total_costs,
        }))
        .sort((a, b) => b.trips_count - a.trips_count);

      return res.json({ data });
    }

    // ============ COSTS BREAKDOWN ============
    if (action === "costs-breakdown") {
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
        periodParams,
      );

      return res.json({ data: result.rows });
    }

    return res.status(400).json({ error: "Unknown action: " + action });
  } catch (e) {
    console.error("Reports error:", e);
    return res
      .status(500)
      .json({ error: "Ошибка сервера", details: e.message });
  }
}

module.exports = requireAuth(handler);
