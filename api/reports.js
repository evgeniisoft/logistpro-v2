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

      // Топ-5 водителей (свои + наёмные)
      const topDrivers = await query(
        `SELECT 
                    COALESCE('own_' || d.id::text, 'hired_' || t.hired_driver_info) AS driver_key,
                    COALESCE(d.full_name, t.hired_driver_info) AS driver_name,
                    CASE WHEN t.hired_driver_info IS NOT NULL THEN true ELSE false END AS is_hired,
                    COUNT(t.id) AS trips_count,
                    COALESCE(SUM(t.fact_km), 0) AS total_km,
                    COALESCE(SUM(t.revenue), 0) AS total_revenue
                 FROM trips t
                 LEFT JOIN drivers d ON d.id = t.driver_id
                 ${whereClause ? whereClause + " AND" : "WHERE"} (t.driver_id IS NOT NULL OR t.hired_driver_info IS NOT NULL)
                 GROUP BY d.id, d.full_name, t.hired_driver_info
                 ORDER BY trips_count DESC
                 LIMIT 5`,
        periodParams,
      );

      // Топ-5 машин (свои + наёмные)
      const topVehicles = await query(
        `SELECT 
                    COALESCE('own_' || v.id::text, 'hired_' || t.hired_vehicle_info) AS vehicle_key,
                    COALESCE(v.plate, t.hired_vehicle_info) AS vehicle_plate,
                    v.model AS vehicle_model,
                    CASE WHEN t.hired_vehicle_info IS NOT NULL THEN true ELSE false END AS is_hired,
                    COUNT(t.id) AS trips_count,
                    COALESCE(SUM(t.fact_km), 0) AS total_km
                 FROM trips t
                 LEFT JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause ? whereClause + " AND" : "WHERE"} (t.vehicle_id IS NOT NULL OR t.hired_vehicle_info IS NOT NULL)
                 GROUP BY v.id, v.plate, v.model, t.hired_vehicle_info
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
      const tripsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    t.driver_id,
                    t.hired_driver_info,
                    t.fact_km,
                    t.revenue,
                    t.vehicle_volume_at_time,
                    t.driver_rate_at_time,
                    t.status,
                    d.full_name AS driver_name,
                    d.phone AS driver_phone,
                    v.type AS vehicle_type,
                    v.amort_rate AS vehicle_amort_rate,
                    (SELECT COALESCE(SUM(o.volume), 0) FROM orders o WHERE o.trip_id = t.id) AS load_volume
                 FROM trips t
                 LEFT JOIN drivers d ON d.id = t.driver_id
                 LEFT JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause}`,
        periodParams,
      );

      const costsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    c.category,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY t.id, c.category`,
        periodParams,
      );

      const driversMap = {};

      tripsResult.rows.forEach((t) => {
        const isHired = !!t.hired_driver_info;
        const key = isHired
          ? "hired_" + t.hired_driver_info
          : "own_" + t.driver_id;

        if (!driversMap[key]) {
          driversMap[key] = {
            key,
            is_hired: isHired,
            driver_id: isHired ? null : t.driver_id,
            driver_name: isHired ? t.hired_driver_info : t.driver_name,
            driver_phone: isHired ? null : t.driver_phone,
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

        const d = driversMap[key];
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

        const tripCosts = costsResult.rows.filter(
          (c) => c.trip_id === t.trip_id,
        );
        tripCosts.forEach((c) => {
          d.total_costs += Number(c.costs);
        });

        // Зарплата
        const hasSalaryInCosts = tripCosts.some((c) => c.category === "salary");
        if (!hasSalaryInCosts && Number(t.driver_rate_at_time) > 0) {
          d.total_costs += Number(t.driver_rate_at_time);
        }

        // Амортизация
        const hasAmortInCosts = tripCosts.some((c) => c.category === "amort");
        if (
          !hasAmortInCosts &&
          t.vehicle_type === "own" &&
          Number(t.vehicle_amort_rate) > 0 &&
          Number(t.fact_km) > 0
        ) {
          d.total_costs += Math.round(
            Number(t.fact_km) * Number(t.vehicle_amort_rate),
          );
        }
      });

      const allData = Object.values(driversMap)
        .map((d) => ({
          driver_id: d.driver_id,
          driver_name: d.driver_name,
          driver_phone: d.driver_phone,
          is_hired: d.is_hired,
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

      return res.json({
        data: allData,
        own: allData.filter((d) => !d.is_hired),
        hired: allData.filter((d) => d.is_hired),
      });
    }

    // ============ BY VEHICLES ============
    if (action === "by-vehicles") {
      const tripsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    t.vehicle_id,
                    t.hired_vehicle_info,
                    t.fact_km,
                    t.revenue,
                    t.driver_rate_at_time,
                    v.plate AS vehicle_plate,
                    v.model AS vehicle_model,
                    v.type AS vehicle_type,
                    v.amort_rate AS vehicle_amort_rate
                 FROM trips t
                 LEFT JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause}`,
        periodParams,
      );

      const costsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    c.category,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY t.id, c.category`,
        periodParams,
      );

      const vehiclesMap = {};

      tripsResult.rows.forEach((t) => {
        // Ключ: для своих — vehicle_id, для наёмных — hired_vehicle_info
        const isHired = !!t.hired_vehicle_info;
        const key = isHired
          ? "hired_" + t.hired_vehicle_info
          : "own_" + t.vehicle_id;

        if (!vehiclesMap[key]) {
          vehiclesMap[key] = {
            key,
            is_hired: isHired,
            vehicle_id: isHired ? null : t.vehicle_id,
            vehicle_plate: isHired ? t.hired_vehicle_info : t.vehicle_plate,
            vehicle_model: isHired ? null : t.vehicle_model,
            vehicle_type: isHired ? "hired" : t.vehicle_type || "own",
            trips_count: 0,
            total_km: 0,
            total_revenue: 0,
            total_costs: 0,
            total_repairs: 0,
            total_amort: 0,
          };
        }

        const v = vehiclesMap[key];
        v.trips_count++;
        v.total_km += Number(t.fact_km) || 0;
        v.total_revenue += Number(t.revenue) || 0;

        // Ручные затраты
        const tripCosts = costsResult.rows.filter(
          (c) => c.trip_id === t.trip_id,
        );
        tripCosts.forEach((c) => {
          const amount = Number(c.costs);
          v.total_costs += amount;
          if (c.category === "repair") v.total_repairs += amount;
          if (c.category === "amort") v.total_amort += amount;
        });

        // Автоматическая амортизация (только для своих, если нет вручную)
        if (!isHired && v.vehicle_amort_rate === undefined) {
          v.vehicle_amort_rate = Number(t.vehicle_amort_rate) || 0;
        }
        const hasAmortInCosts = tripCosts.some((c) => c.category === "amort");
        if (
          !isHired &&
          !hasAmortInCosts &&
          Number(t.vehicle_amort_rate) > 0 &&
          Number(t.fact_km) > 0
        ) {
          v.total_costs += Math.round(
            Number(t.fact_km) * Number(t.vehicle_amort_rate),
          );
          v.total_amort += Math.round(
            Number(t.fact_km) * Number(t.vehicle_amort_rate),
          );
        }

        // Зарплата водителя
        const hasSalaryInCosts = tripCosts.some((c) => c.category === "salary");
        if (!hasSalaryInCosts && Number(t.driver_rate_at_time) > 0) {
          v.total_costs += Number(t.driver_rate_at_time);
        }
      });

      const allData = Object.values(vehiclesMap)
        .map((v) => ({
          vehicle_id: v.vehicle_id,
          vehicle_plate: v.vehicle_plate,
          vehicle_model: v.vehicle_model,
          vehicle_type: v.vehicle_type,
          is_hired: v.is_hired,
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

      return res.json({
        data: allData,
        own: allData.filter((v) => !v.is_hired),
        hired: allData.filter((v) => v.is_hired),
      });
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
                    t.status,
                    t.driver_rate_at_time,
                    v.type AS vehicle_type,
                    v.amort_rate AS vehicle_amort_rate
                 FROM trips t
                 LEFT JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause}`,
        periodParams,
      );

      // Ручные затраты по рейсам
      const costsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    t.trip_date,
                    c.category,
                    COALESCE(SUM(c.amount), 0) AS costs
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 ${whereClause}
                 GROUP BY t.id, t.trip_date, c.category`,
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
            costs: 0,
          };
        }
        const row = monthsMap[m];
        row.trips_count++;
        if (t.status === "done") row.trips_done++;
        row.total_km += Number(t.fact_km) || 0;
        row.revenue += Number(t.revenue) || 0;

        // Зарплата водителя
        const salaryInCosts = costsResult.rows.find(
          (c) => c.trip_id === t.trip_id && c.category === "salary",
        );
        if (salaryInCosts) {
          row.costs += Number(salaryInCosts.costs);
        } else if (Number(t.driver_rate_at_time) > 0) {
          row.costs += Number(t.driver_rate_at_time);
        }

        // Амортизация (только для своих машин)
        const amortInCosts = costsResult.rows.find(
          (c) => c.trip_id === t.trip_id && c.category === "amort",
        );
        if (amortInCosts) {
          row.costs += Number(amortInCosts.costs);
        } else if (
          t.vehicle_type === "own" &&
          Number(t.vehicle_amort_rate) > 0 &&
          Number(t.fact_km) > 0
        ) {
          row.costs += Math.round(
            Number(t.fact_km) * Number(t.vehicle_amort_rate),
          );
        }

        // Остальные ручные затраты
        const otherCosts = costsResult.rows.filter(
          (c) =>
            c.trip_id === t.trip_id &&
            !["salary", "amort"].includes(c.category),
        );
        otherCosts.forEach((c) => {
          row.costs += Number(c.costs);
        });
      });

      const data = Object.values(monthsMap)
        .map((row) => ({
          month: row.month,
          month_label: row.month_label,
          trips_count: row.trips_count,
          trips_done: row.trips_done,
          total_km: row.total_km,
          revenue: row.revenue,
          costs: row.costs,
          margin: row.revenue - row.costs,
          margin_percent:
            row.revenue > 0
              ? Math.round(((row.revenue - row.costs) / row.revenue) * 100)
              : 0,
        }))
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
            t.vehicle_volume_at_time,
            r.name AS route_name,
            r.from_point,
            r.to_point,
            (SELECT COALESCE(SUM(o.volume), 0) FROM orders o WHERE o.trip_id = t.id) AS load_volume
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
      // Ручные затраты с деталями по рейсам
      const result = await query(
        `SELECT 
                    c.category,
                    c.amount,
                    c.note,
                    c.created_at,
                    t.id AS trip_id,
                    t.trip_number,
                    t.trip_date,
                    COALESCE(v.plate, t.hired_vehicle_info, '—') AS vehicle_label,
                    COALESCE(d.full_name, t.hired_driver_info, '—') AS driver_label,
                    t.hired_vehicle_info IS NOT NULL AS is_hired_vehicle
                 FROM costs c
                 JOIN trips t ON t.id = c.trip_id
                 LEFT JOIN vehicles v ON v.id = t.vehicle_id
                 LEFT JOIN drivers d ON d.id = t.driver_id
                 ${whereClause}
                 ORDER BY c.created_at DESC`,
        periodParams,
      );

      // Группируем по категориям
      const categoriesMap = {};

      result.rows.forEach((r) => {
        const cat = r.category;
        if (!categoriesMap[cat]) {
          categoriesMap[cat] = {
            category: cat,
            count: 0,
            total: 0,
            items: [],
          };
        }
        categoriesMap[cat].count++;
        categoriesMap[cat].total += Number(r.amount);
        categoriesMap[cat].items.push({
          trip_id: r.trip_id,
          trip_number: r.trip_number,
          trip_date: r.trip_date,
          amount: Number(r.amount),
          note: r.note || "",
          vehicle_label: r.vehicle_label,
          driver_label: r.driver_label,
          is_hired_vehicle: r.is_hired_vehicle,
          created_at: r.created_at,
        });
      });

      const data = Object.values(categoriesMap);

      // Автоматическая зарплата + наёмный транспорт
      const salaryInCosts = data.find((d) => d.category === "salary");
      const hiredInCosts = data.find((d) => d.category === "hired");

      if (!salaryInCosts || !hiredInCosts) {
        const details = await query(
          `SELECT 
                        t.id AS trip_id,
                        t.trip_number,
                        t.trip_date,
                        t.driver_rate_at_time AS amount,
                        COALESCE(d.full_name, t.hired_driver_info, '—') AS driver_label,
                        COALESCE(v.plate, t.hired_vehicle_info, '—') AS vehicle_label,
                        t.hired_vehicle_info IS NOT NULL AS is_hired_vehicle
                     FROM trips t
                     LEFT JOIN drivers d ON d.id = t.driver_id
                     LEFT JOIN vehicles v ON v.id = t.vehicle_id
                     ${whereClause ? whereClause + " AND" : "WHERE"} t.driver_rate_at_time > 0
                     ORDER BY t.trip_date DESC`,
          periodParams,
        );

        // Разделяем на "Зарплата" (своя машина) и "Наёмный транспорт" (наёмная машина)
        const salaryItems = [];
        const hiredItems = [];

        details.rows.forEach((r) => {
          const item = {
            trip_id: r.trip_id,
            trip_number: r.trip_number,
            trip_date: r.trip_date,
            amount: Number(r.amount),
            note: r.is_hired_vehicle ? "Наёмный транспорт" : "Свой водитель",
            vehicle_label: r.vehicle_label,
            driver_label: r.driver_label,
          };
          if (r.is_hired_vehicle) {
            hiredItems.push(item);
          } else {
            salaryItems.push(item);
          }
        });

        if (!salaryInCosts && salaryItems.length > 0) {
          const total = salaryItems.reduce((s, i) => s + i.amount, 0);
          data.push({
            category: "salary",
            count: salaryItems.length,
            total,
            items: salaryItems,
            auto: true,
          });
        }

        if (!hiredInCosts && hiredItems.length > 0) {
          const total = hiredItems.reduce((s, i) => s + i.amount, 0);
          data.push({
            category: "hired",
            count: hiredItems.length,
            total,
            items: hiredItems,
            auto: true,
          });
        }
      }

      // Автоматическая амортизация с деталями
      const amortInCosts = data.find((d) => d.category === "amort");
      if (!amortInCosts) {
        const amortDetails = await query(
          `SELECT 
                        t.id AS trip_id,
                        t.trip_number,
                        t.trip_date,
                        t.fact_km,
                        v.amort_rate,
                        ROUND(t.fact_km * v.amort_rate) AS amount,
                        v.plate AS vehicle_label
                     FROM trips t
                     JOIN vehicles v ON v.id = t.vehicle_id
                     ${whereClause ? whereClause + " AND" : "WHERE"} v.type = 'own' AND v.amort_rate > 0 AND t.fact_km > 0
                     ORDER BY t.trip_date DESC`,
          periodParams,
        );

        if (amortDetails.rows.length > 0) {
          const items = amortDetails.rows.map((r) => ({
            trip_id: r.trip_id,
            trip_number: r.trip_number,
            trip_date: r.trip_date,
            amount: Number(r.amount),
            note: r.fact_km + " км × " + r.amort_rate + " ₽/км",
            vehicle_label: r.vehicle_label,
            driver_label: "—",
            is_hired_vehicle: false,
          }));
          const total = items.reduce((s, i) => s + i.amount, 0);
          data.push({
            category: "amort",
            count: items.length,
            total,
            items,
            auto: true,
          });
        }
      }

      // Сортируем по убыванию
      data.sort((a, b) => b.total - a.total);

      return res.json({ data });
    }

    // ============ DRILL-DOWN ============
    if (action === "drill-down") {
      const { type, route_id, month, hired_label } = req.query;

      if (!["vehicles", "drivers", "routes", "months"].includes(type)) {
        return res.status(400).json({ error: "Invalid drill-down type" });
      }

      // Собираем дополнительные условия поверх periodFilter
      const drillFilter = [...periodFilter];
      const drillParams = [...periodParams];
      let pIdx = drillParams.length + 1;

      if (type === "vehicles") {
        if (hired_label) {
          drillFilter.push(
            `t.vehicle_id IS NULL AND t.hired_vehicle_info = $${pIdx++}`,
          );
          drillParams.push(hired_label);
        } else if (vehicle_id) {
          drillFilter.push(`t.vehicle_id = $${pIdx++}`);
          drillParams.push(vehicle_id);
        } else {
          return res
            .status(400)
            .json({ error: "vehicle_id or hired_label required" });
        }
      } else if (type === "drivers") {
        if (hired_label) {
          drillFilter.push(
            `t.driver_id IS NULL AND t.hired_driver_info = $${pIdx++}`,
          );
          drillParams.push(hired_label);
        } else if (driver_id) {
          drillFilter.push(`t.driver_id = $${pIdx++}`);
          drillParams.push(driver_id);
        } else {
          return res
            .status(400)
            .json({ error: "driver_id or hired_label required" });
        }
      } else if (type === "routes") {
        if (!route_id) {
          return res.status(400).json({ error: "route_id required" });
        }
        drillFilter.push(`t.route_id = $${pIdx++}`);
        drillParams.push(route_id);
      } else if (type === "months") {
        if (!month) {
          return res.status(400).json({ error: "month required" });
        }
        drillFilter.push(`TO_CHAR(t.trip_date, 'YYYY-MM') = $${pIdx++}`);
        drillParams.push(month);
      }

      const drillWhere =
        drillFilter.length > 0 ? "WHERE " + drillFilter.join(" AND ") : "";

      // Список рейсов с джойнами
      const tripsRes = await query(
        `SELECT
            t.id,
            t.trip_number,
            t.trip_date,
            t.status,
            t.trip_type,
            t.plan_km,
            t.fact_km,
            t.revenue,
            t.vehicle_id,
            t.hired_vehicle_info,
            t.driver_id,
            t.hired_driver_info,
            t.driver_rate_at_time,
            t.vehicle_volume_at_time,
            t.route_text,
            v.plate AS vehicle_plate,
            v.model AS vehicle_model,
            v.type AS vehicle_type,
            v.amort_rate AS vehicle_amort_rate,
            d.full_name AS driver_name,
            r.name AS route_name,
            (SELECT COALESCE(SUM(o.volume), 0) FROM orders o WHERE o.trip_id = t.id) AS load_volume
         FROM trips t
         LEFT JOIN vehicles v ON v.id = t.vehicle_id
         LEFT JOIN drivers d ON d.id = t.driver_id
         LEFT JOIN routes r ON r.id = t.route_id
         ${drillWhere}
         ORDER BY t.trip_date DESC, t.id DESC`,
        drillParams,
      );

      // Затраты по рейсам с разбивкой по категориям
      const costsRes = await query(
        `SELECT
            t.id AS trip_id,
            c.category,
            COALESCE(SUM(c.amount), 0) AS amount
         FROM costs c
         JOIN trips t ON t.id = c.trip_id
         ${drillWhere}
         GROUP BY t.id, c.category`,
        drillParams,
      );

      const costsByTrip = {};
      costsRes.rows.forEach((r) => {
        if (!costsByTrip[r.trip_id]) costsByTrip[r.trip_id] = [];
        costsByTrip[r.trip_id].push({
          category: r.category,
          amount: Number(r.amount),
        });
      });

      // Формируем строки рейсов
      const trips = tripsRes.rows.map((t) => {
        const tripCosts = costsByTrip[t.id] || [];
        const isHiredVehicle = !!t.hired_vehicle_info;
        const isHiredDriver = !!t.hired_driver_info;

        let costs = 0;
        let salaryInCosts = false;
        let amortInCosts = false;
        let hiredInCosts = false;

        tripCosts.forEach((c) => {
          costs += c.amount;
          if (c.category === "salary") salaryInCosts = true;
          if (c.category === "amort") amortInCosts = true;
          if (c.category === "hired") hiredInCosts = true;
        });

        // Авто-достройка статей (как в by-vehicles / by-drivers / by-months)
        if (
          !salaryInCosts &&
          !hiredInCosts &&
          Number(t.driver_rate_at_time) > 0
        ) {
          if (isHiredVehicle) {
            // наёмный транспорт — в статью hired
            costs += Number(t.driver_rate_at_time);
          } else {
            // свой водитель — в статью salary
            costs += Number(t.driver_rate_at_time);
          }
        }

        if (
          !amortInCosts &&
          t.vehicle_type === "own" &&
          Number(t.vehicle_amort_rate) > 0 &&
          Number(t.fact_km) > 0
        ) {
          costs += Math.round(Number(t.fact_km) * Number(t.vehicle_amort_rate));
        }

        const loadVolume = Number(t.load_volume) || 0;
        const vehicleVolume = Number(t.vehicle_volume_at_time) || 0;
        const loadPercent =
          vehicleVolume > 0
            ? Math.round((loadVolume / vehicleVolume) * 100)
            : 0;

        const vehicleLabel = isHiredVehicle
          ? t.hired_vehicle_info
          : t.vehicle_plate || "—";
        const driverLabel = isHiredDriver
          ? t.hired_driver_info
          : t.driver_name || "—";

        const revenue = Number(t.revenue) || 0;

        return {
          id: t.id,
          trip_number: t.trip_number,
          trip_date: t.trip_date,
          status: t.status,
          route_label: t.route_text || t.route_name || "—",
          vehicle_label: vehicleLabel,
          vehicle_model: isHiredVehicle ? null : t.vehicle_model || null,
          is_hired_vehicle: isHiredVehicle,
          driver_label: driverLabel,
          is_hired_driver: isHiredDriver,
          plan_km: Number(t.plan_km) || 0,
          fact_km: Number(t.fact_km) || 0,
          load_volume: loadVolume,
          vehicle_volume: vehicleVolume,
          load_percent: loadPercent,
          revenue: revenue,
          costs: costs,
          margin: revenue - costs,
        };
      });

      // KPI
      const tripsCount = trips.length;
      const tripsDone = trips.filter((x) => x.status === "done").length;
      const totalKm = trips.reduce((s, x) => s + x.fact_km, 0);
      const totalRevenue = trips.reduce((s, x) => s + x.revenue, 0);
      const totalCosts = trips.reduce((s, x) => s + x.costs, 0);
      const margin = totalRevenue - totalCosts;
      const marginPercent =
        totalRevenue > 0 ? Math.round((margin / totalRevenue) * 100) : 0;

      const kpi = {
        trips_count: tripsCount,
        trips_done: tripsDone,
        total_km: totalKm,
        total_revenue: totalRevenue,
        total_costs: totalCosts,
        margin: margin,
        margin_percent: marginPercent,
      };

      // Специфичные KPI
      if (type === "vehicles") {
        let repairsTotal = 0;
        let amortTotal = 0;
        costsRes.rows.forEach((r) => {
          if (r.category === "repair") repairsTotal += Number(r.amount);
          if (r.category === "amort") amortTotal += Number(r.amount);
        });
        // авто-амортизация
        tripsRes.rows.forEach((t) => {
          const tripCosts = costsByTrip[t.id] || [];
          const hasAmort = tripCosts.some((c) => c.category === "amort");
          if (
            !hasAmort &&
            t.vehicle_type === "own" &&
            Number(t.vehicle_amort_rate) > 0 &&
            Number(t.fact_km) > 0
          ) {
            amortTotal += Math.round(
              Number(t.fact_km) * Number(t.vehicle_amort_rate),
            );
          }
        });
        kpi.repairs_total = repairsTotal;
        kpi.amort_total = amortTotal;
        kpi.cost_per_km =
          totalKm > 0 ? Math.round((totalCosts / totalKm) * 10) / 10 : 0;
      }

      if (type === "drivers") {
        let loadSum = 0;
        let loadCount = 0;
        trips.forEach((x) => {
          if (x.vehicle_volume > 0 && x.load_volume > 0) {
            loadSum += (x.load_volume / x.vehicle_volume) * 100;
            loadCount++;
          }
        });
        kpi.avg_load_percent =
          loadCount > 0 ? Math.round(loadSum / loadCount) : 0;
        kpi.cost_per_trip =
          tripsCount > 0 ? Math.round(totalCosts / tripsCount) : 0;
      }

      if (type === "routes") {
        let loadSum = 0;
        let loadCount = 0;
        trips.forEach((x) => {
          if (x.vehicle_volume > 0 && x.load_volume > 0) {
            loadSum += (x.load_volume / x.vehicle_volume) * 100;
            loadCount++;
          }
        });
        kpi.avg_load_percent =
          loadCount > 0 ? Math.round(loadSum / loadCount) : 0;
      }

      // Для months — разбивка затрат по категориям
      let categories = null;
      if (type === "months") {
        const catMap = {};
        costsRes.rows.forEach((r) => {
          const cat = r.category;
          if (!catMap[cat]) catMap[cat] = { category: cat, count: 0, total: 0 };
          catMap[cat].count++;
          catMap[cat].total += Number(r.amount);
        });

        // Авто-статьи salary / hired
        const hasSalary = catMap["salary"];
        const hasHired = catMap["hired"];
        if (!hasSalary || !hasHired) {
          // Считаем по рейсам: если своя машина → salary, если наёмная → hired
          let salaryTotal = 0;
          let salaryCount = 0;
          let hiredTotal = 0;
          let hiredCount = 0;
          tripsRes.rows.forEach((t) => {
            const tripCosts = costsByTrip[t.id] || [];
            const hasSalaryIn = tripCosts.some((c) => c.category === "salary");
            const hasHiredIn = tripCosts.some((c) => c.category === "hired");
            const rate = Number(t.driver_rate_at_time) || 0;
            if (rate > 0) {
              if (t.hired_vehicle_info) {
                if (!hasHiredIn) {
                  hiredTotal += rate;
                  hiredCount++;
                }
              } else {
                if (!hasSalaryIn) {
                  salaryTotal += rate;
                  salaryCount++;
                }
              }
            }
          });
          if (!hasSalary && salaryCount > 0) {
            catMap["salary"] = {
              category: "salary",
              count: salaryCount,
              total: salaryTotal,
              auto: true,
            };
          }
          if (!hasHired && hiredCount > 0) {
            catMap["hired"] = {
              category: "hired",
              count: hiredCount,
              total: hiredTotal,
              auto: true,
            };
          }
        }

        // Авто-амортизация
        if (!catMap["amort"]) {
          let amortTotal = 0;
          let amortCount = 0;
          tripsRes.rows.forEach((t) => {
            const tripCosts = costsByTrip[t.id] || [];
            const hasAmort = tripCosts.some((c) => c.category === "amort");
            if (
              !hasAmort &&
              t.vehicle_type === "own" &&
              Number(t.vehicle_amort_rate) > 0 &&
              Number(t.fact_km) > 0
            ) {
              amortTotal += Math.round(
                Number(t.fact_km) * Number(t.vehicle_amort_rate),
              );
              amortCount++;
            }
          });
          if (amortCount > 0) {
            catMap["amort"] = {
              category: "amort",
              count: amortCount,
              total: amortTotal,
              auto: true,
            };
          }
        }

        categories = Object.values(catMap).sort((a, b) => b.total - a.total);
      }

      // Заголовок для модалки
      let title = "";
      if (type === "vehicles") title = hired_label || "Машина";
      else if (type === "drivers") title = hired_label || "Водитель";
      else if (type === "routes") {
        const first = tripsRes.rows[0];
        title = first
          ? first.route_text || first.route_name || "Маршрут"
          : "Маршрут";
      } else if (type === "months") {
        // "2026-09" → "Сентябрь 2026"
        const [y, m] = month.split("-");
        const d = new Date(parseInt(y), parseInt(m) - 1, 1);
        title = d.toLocaleDateString("ru-RU", {
          month: "long",
          year: "numeric",
        });
      }

      return res.json({
        type: type,
        title: title,
        period: { from: from || null, to: to || null },
        kpi: kpi,
        categories: categories,
        trips: trips,
      });
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
