const { query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");

// ============ УТИЛИТЫ ДЛЯ ПЕРИОДА ============

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// Приводит trip_date (Date-объект или строку) к формату "YYYY-MM-DD"
function toLocalDateStr(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

// Возвращает { start, end, days } — календарный период с ограничением "не позже сегодня"
function resolvePeriod(from, to) {
  const today = todayStr();
  let start = from || null;
  let end = to && to < today ? to : today;

  // Если start в будущем — периода нет
  if (start && start > end) {
    return { start: null, end: null, days: 0, valid: false };
  }
  if (!start) {
    // При отсутствии from — не считаем дни (метрика простоя неприменима)
    return { start: null, end: null, days: 0, valid: false };
  }

  const sd = new Date(start + "T00:00:00");
  const ed = new Date(end + "T00:00:00");
  const days = Math.round((ed - sd) / (1000 * 60 * 60 * 24)) + 1;

  return { start, end, days, valid: days > 0 };
}

// Метрика "простой" осмысленна только для коротких периодов
function idleMetricsAllowed(periodDays) {
  return periodDays > 0 && periodDays <= 92;
}

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

  // Период для метрик простоя
  const period = resolvePeriod(from, to);
  const idleAllowed = idleMetricsAllowed(period.days);

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

      // Общая средняя загрузка парка (взвешенная по объёму)
      const loadResult = await query(
        `SELECT 
                    COALESCE(SUM(t.vehicle_volume_at_time), 0) AS total_capacity,
                    COALESCE(SUM((SELECT COALESCE(SUM(o.volume), 0) FROM orders o WHERE o.trip_id = t.id)), 0) AS total_load
                 FROM trips t
                 ${whereClause}`,
        periodParams,
      );
      const totalCapacity = Number(loadResult.rows[0].total_capacity) || 0;
      const totalLoad = Number(loadResult.rows[0].total_load) || 0;
      const weightedLoadPercent =
        totalCapacity > 0 ? Math.round((totalLoad / totalCapacity) * 100) : 0;

      // Топ-5 водителей (свои + наёмные) — с метриками для переключателя
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
                    COALESCE(SUM(t.fact_km), 0) AS total_km,
                    COALESCE(SUM(t.revenue), 0) AS total_revenue
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
          weighted_load_percent: weightedLoadPercent,
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
                    t.trip_date,
                    t.driver_id,
                    t.hired_driver_info,
                    t.vehicle_id,
                    t.hired_vehicle_info,
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
                 ${whereClause}
                 ORDER BY t.trip_date ASC`,
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
            total_capacity: 0,
            total_costs: 0,
            load_sum: 0,
            load_count: 0,
            empty_trips: 0,
            underload_trips: 0,
            trip_dates: [],
            dates_set: new Set(),
          };
        }

        const d = driversMap[key];
        d.trips_count++;
        if (t.status === "done") d.trips_done++;
        d.total_km += Number(t.fact_km) || 0;
        d.total_revenue += Number(t.revenue) || 0;
        d.total_volume += Number(t.load_volume) || 0;
        d.total_capacity += Number(t.vehicle_volume_at_time) || 0;

        const cap = Number(t.vehicle_volume_at_time) || 0;
        const load = Number(t.load_volume) || 0;
        if (cap > 0 && load > 0) {
          d.load_sum += (load / cap) * 100;
          d.load_count++;
          if (load < cap * 0.5) d.underload_trips++;
        } else if (load === 0) {
          d.empty_trips++;
        }

        // Для простоя — только не отменённые
        if (t.status !== "cancelled") {
          const day = toLocalDateStr(t.trip_date);
          if (day && !d.dates_set.has(day)) {
            d.dates_set.add(day);
            d.trip_dates.push(day);
          }
        }

        const tripCosts = costsResult.rows.filter(
          (c) => c.trip_id === t.trip_id,
        );
        tripCosts.forEach((c) => {
          d.total_costs += Number(c.costs);
        });

        // Зарплата
        const hasSalaryInCosts = tripCosts.some((c) => c.category === "salary");
        const hasHiredInCosts = tripCosts.some((c) => c.category === "hired");
        if (!hasSalaryInCosts && !hasHiredInCosts && Number(t.driver_rate_at_time) > 0) {
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
        .map((d) => {
          const margin = d.total_revenue - d.total_costs;
          const marginPercent =
            d.total_revenue > 0
              ? Math.round((margin / d.total_revenue) * 100)
              : 0;

          // Метрики простоя — только для своих и только для коротких периодов
          let duty_days = null;
          let idle_days = null;
          let utilization_days_percent = null;
          let avg_trips_per_week = null;
          let max_gap_days = null;

          if (!d.is_hired && idleAllowed && period.valid) {
            duty_days = d.trip_dates.length;
            idle_days = Math.max(0, period.days - duty_days);
            utilization_days_percent = Math.round(
              (duty_days / period.days) * 100,
            );
            avg_trips_per_week =
              Math.round((d.trips_count / (period.days / 7)) * 10) / 10;

            // Максимальный разрыв между рейсами
            if (d.trip_dates.length > 1) {
              const sorted = [...d.trip_dates].sort();
              let maxGap = 0;
              for (let i = 1; i < sorted.length; i++) {
                const prev = new Date(sorted[i - 1] + "T00:00:00");
                const cur = new Date(sorted[i] + "T00:00:00");
                const gap = Math.round((cur - prev) / (1000 * 60 * 60 * 24)) - 1;
                if (gap > maxGap) maxGap = gap;
              }
              max_gap_days = maxGap;
            } else {
              max_gap_days = 0;
            }
          }

          return {
            driver_id: d.driver_id,
            driver_name: d.driver_name,
            driver_phone: d.driver_phone,
            is_hired: d.is_hired,
            trips_count: d.trips_count,
            trips_done: d.trips_done,
            total_km: d.total_km,
            total_revenue: d.total_revenue,
            total_volume: d.total_volume,
            total_capacity: d.total_capacity,
            avg_load_percent:
              d.load_count > 0 ? Math.round(d.load_sum / d.load_count) : 0,
            weighted_load_percent:
              d.total_capacity > 0
                ? Math.round((d.total_volume / d.total_capacity) * 100)
                : 0,
            empty_trips: d.empty_trips,
            underload_trips: d.underload_trips,
            costs: d.total_costs,
            cost_per_trip:
              d.trips_count > 0 ? Math.round(d.total_costs / d.trips_count) : 0,
            cost_per_km:
              d.total_km > 0
                ? Math.round((d.total_costs / d.total_km) * 10) / 10
                : 0,
            cost_per_m3:
              d.total_volume > 0
                ? Math.round(d.total_costs / d.total_volume)
                : 0,
            margin: margin,
            margin_percent: marginPercent,
            duty_days: duty_days,
            idle_days: idle_days,
            utilization_days_percent: utilization_days_percent,
            avg_trips_per_week: avg_trips_per_week,
            max_gap_days: max_gap_days,
          };
        })
        .sort((a, b) => b.trips_count - a.trips_count);

      return res.json({
        data: allData,
        own: allData.filter((d) => !d.is_hired),
        hired: allData.filter((d) => d.is_hired),
        idle_allowed: idleAllowed && period.valid,
        period_days: period.days,
      });
    }

    // ============ BY VEHICLES ============
    if (action === "by-vehicles") {
      const tripsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    t.trip_date,
                    t.vehicle_id,
                    t.hired_vehicle_info,
                    t.fact_km,
                    t.revenue,
                    t.vehicle_volume_at_time,
                    t.driver_rate_at_time,
                    t.status,
                    v.plate AS vehicle_plate,
                    v.model AS vehicle_model,
                    v.type AS vehicle_type,
                    v.amort_rate AS vehicle_amort_rate,
                    (SELECT COALESCE(SUM(o.volume), 0) FROM orders o WHERE o.trip_id = t.id) AS load_volume
                 FROM trips t
                 LEFT JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause}
                 ORDER BY t.trip_date ASC`,
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
            total_volume: 0,
            total_capacity: 0,
            total_costs: 0,
            total_repairs: 0,
            total_amort: 0,
            load_sum: 0,
            load_count: 0,
            empty_trips: 0,
            underload_trips: 0,
            trip_dates: [],
            dates_set: new Set(),
          };
        }

        const v = vehiclesMap[key];
        v.trips_count++;
        v.total_km += Number(t.fact_km) || 0;
        v.total_revenue += Number(t.revenue) || 0;
        v.total_volume += Number(t.load_volume) || 0;
        v.total_capacity += Number(t.vehicle_volume_at_time) || 0;

        const cap = Number(t.vehicle_volume_at_time) || 0;
        const load = Number(t.load_volume) || 0;
        if (cap > 0 && load > 0) {
          v.load_sum += (load / cap) * 100;
          v.load_count++;
          if (load < cap * 0.5) v.underload_trips++;
        } else if (load === 0) {
          v.empty_trips++;
        }

        // Для простоя — только не отменённые
        if (t.status !== "cancelled") {
          const day = toLocalDateStr(t.trip_date);
          if (day && !v.dates_set.has(day)) {
            v.dates_set.add(day);
            v.trip_dates.push(day);
          }
        }

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
        const hasHiredInCosts = tripCosts.some((c) => c.category === "hired");
        if (!hasSalaryInCosts && !hasHiredInCosts && Number(t.driver_rate_at_time) > 0) {
          v.total_costs += Number(t.driver_rate_at_time);
        }
      });

      const allData = Object.values(vehiclesMap)
        .map((v) => {
          const margin = v.total_revenue - v.total_costs;
          const marginPercent =
            v.total_revenue > 0
              ? Math.round((margin / v.total_revenue) * 100)
              : 0;

          let duty_days = null;
          let idle_days = null;
          let utilization_days_percent = null;
          let avg_trips_per_week = null;
          let max_gap_days = null;

          if (!v.is_hired && idleAllowed && period.valid) {
            duty_days = v.trip_dates.length;
            idle_days = Math.max(0, period.days - duty_days);
            utilization_days_percent = Math.round(
              (duty_days / period.days) * 100,
            );
            avg_trips_per_week =
              Math.round((v.trips_count / (period.days / 7)) * 10) / 10;

            if (v.trip_dates.length > 1) {
              const sorted = [...v.trip_dates].sort();
              let maxGap = 0;
              for (let i = 1; i < sorted.length; i++) {
                const prev = new Date(sorted[i - 1] + "T00:00:00");
                const cur = new Date(sorted[i] + "T00:00:00");
                const gap = Math.round((cur - prev) / (1000 * 60 * 60 * 24)) - 1;
                if (gap > maxGap) maxGap = gap;
              }
              max_gap_days = maxGap;
            } else {
              max_gap_days = 0;
            }
          }

          return {
            vehicle_id: v.vehicle_id,
            vehicle_plate: v.vehicle_plate,
            vehicle_model: v.vehicle_model,
            vehicle_type: v.vehicle_type,
            is_hired: v.is_hired,
            trips_count: v.trips_count,
            total_km: v.total_km,
            total_revenue: v.total_revenue,
            total_volume: v.total_volume,
            total_capacity: v.total_capacity,
            avg_load_percent:
              v.load_count > 0 ? Math.round(v.load_sum / v.load_count) : 0,
            weighted_load_percent:
              v.total_capacity > 0
                ? Math.round((v.total_volume / v.total_capacity) * 100)
                : 0,
            empty_trips: v.empty_trips,
            underload_trips: v.underload_trips,
            costs: v.total_costs,
            repairs: v.total_repairs,
            cost_per_km:
              v.total_km > 0
                ? Math.round((v.total_costs / v.total_km) * 10) / 10
                : 0,
            cost_per_m3:
              v.total_volume > 0
                ? Math.round(v.total_costs / v.total_volume)
                : 0,
            margin: margin,
            margin_percent: marginPercent,
            duty_days: duty_days,
            idle_days: idle_days,
            utilization_days_percent: utilization_days_percent,
            avg_trips_per_week: avg_trips_per_week,
            max_gap_days: max_gap_days,
          };
        })
        .sort((a, b) => b.total_km - a.total_km);

      return res.json({
        data: allData,
        own: allData.filter((v) => !v.is_hired),
        hired: allData.filter((v) => v.is_hired),
        idle_allowed: idleAllowed && period.valid,
        period_days: period.days,
      });
    }

    // ============ BY MONTHS ============
    if (action === "by-months") {
      const tripsResult = await query(
        `SELECT 
                    t.id AS trip_id,
                    TO_CHAR(t.trip_date, 'YYYY-MM') AS month,
                    TO_CHAR(t.trip_date, 'TMMonth YYYY') AS month_label,
                    t.trip_date,
                    t.fact_km,
                    t.revenue,
                    t.status,
                    t.driver_rate_at_time,
                    t.vehicle_volume_at_time,
                    v.type AS vehicle_type,
                    v.amort_rate AS vehicle_amort_rate,
                    (SELECT COALESCE(SUM(o.volume), 0) FROM orders o WHERE o.trip_id = t.id) AS load_volume
                 FROM trips t
                 LEFT JOIN vehicles v ON v.id = t.vehicle_id
                 ${whereClause}`,
        periodParams,
      );

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
            total_volume: 0,
            total_capacity: 0,
            load_sum: 0,
            load_count: 0,
            empty_trips: 0,
          };
        }
        const row = monthsMap[m];
        row.trips_count++;
        if (t.status === "done") row.trips_done++;
        row.total_km += Number(t.fact_km) || 0;
        row.revenue += Number(t.revenue) || 0;
        row.total_volume += Number(t.load_volume) || 0;
        row.total_capacity += Number(t.vehicle_volume_at_time) || 0;

        const cap = Number(t.vehicle_volume_at_time) || 0;
        const load = Number(t.load_volume) || 0;
        if (cap > 0 && load > 0) {
          row.load_sum += (load / cap) * 100;
          row.load_count++;
        } else if (load === 0) {
          row.empty_trips++;
        }

        // Зарплата водителя
        const salaryInCosts = costsResult.rows.find(
          (c) => c.trip_id === t.trip_id && c.category === "salary",
        );
        const hiredInCosts = costsResult.rows.find(
          (c) => c.trip_id === t.trip_id && c.category === "hired",
        );
        if (salaryInCosts) {
          row.costs += Number(salaryInCosts.costs);
        } else if (hiredInCosts) {
          row.costs += Number(hiredInCosts.costs);
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
            !["salary", "amort", "hired"].includes(c.category),
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
          avg_load_percent:
            row.load_count > 0 ? Math.round(row.load_sum / row.load_count) : 0,
          weighted_load_percent:
            row.total_capacity > 0
              ? Math.round((row.total_volume / row.total_capacity) * 100)
              : 0,
          empty_trips: row.empty_trips,
          cost_per_km:
            row.total_km > 0
              ? Math.round((row.costs / row.total_km) * 10) / 10
              : 0,
          cost_per_m3:
            row.total_volume > 0
              ? Math.round(row.costs / row.total_volume)
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
            total_volume: 0,
            total_capacity: 0,
            load_sum: 0,
            load_count: 0,
            empty_trips: 0,
            underload_trips: 0,
          };
        }
        const r = routesMap[rid];
        r.trips_count++;
        r.total_km += Number(t.fact_km) || 0;
        r.total_revenue += Number(t.revenue) || 0;
        r.total_volume += Number(t.load_volume) || 0;
        r.total_capacity += Number(t.vehicle_volume_at_time) || 0;

        const cap = Number(t.vehicle_volume_at_time) || 0;
        const load = Number(t.load_volume) || 0;
        if (cap > 0 && load > 0) {
          r.load_sum += (load / cap) * 100;
          r.load_count++;
          if (load < cap * 0.5) r.underload_trips++;
        } else if (load === 0) {
          r.empty_trips++;
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
          weighted_load_percent:
            r.total_capacity > 0
              ? Math.round((r.total_volume / r.total_capacity) * 100)
              : 0,
          empty_trips: r.empty_trips,
          underload_trips: r.underload_trips,
          total_revenue: r.total_revenue,
          costs: r.total_costs,
          cost_per_km:
            r.total_km > 0
              ? Math.round((r.total_costs / r.total_km) * 10) / 10
              : 0,
          cost_per_m3:
            r.total_volume > 0
              ? Math.round(r.total_costs / r.total_volume)
              : 0,
          margin: r.total_revenue - r.total_costs,
          margin_percent:
            r.total_revenue > 0
              ? Math.round(
                  ((r.total_revenue - r.total_costs) / r.total_revenue) * 100,
                )
              : 0,
        }))
        .sort((a, b) => b.trips_count - a.trips_count);

      return res.json({ data });
    }

    // ============ COSTS BREAKDOWN ============
    if (action === "costs-breakdown") {
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

      data.sort((a, b) => b.total - a.total);

      return res.json({ data });
    }

    // ============ IDLE (простой транспорт) ============
    if (action === "idle") {
      const { type } = req.query; // vehicles | drivers

      if (!["vehicles", "drivers"].includes(type)) {
        return res.status(400).json({ error: "type must be vehicles or drivers" });
      }

      if (!idleAllowed || !period.valid) {
        return res.json({
          data: [],
          idle_allowed: false,
          period_days: period.days,
        });
      }

      if (type === "vehicles") {
        const result = await query(
          `SELECT v.id, v.plate, v.model, v.type
           FROM vehicles v
           WHERE v.is_archived = false
             AND v.type = 'own'
             AND NOT EXISTS (
               SELECT 1 FROM trips t
               WHERE t.vehicle_id = v.id
                 AND t.trip_date >= $1 AND t.trip_date <= $2
                 AND t.status != 'cancelled'
             )
           ORDER BY v.plate`,
          [period.start, period.end],
        );

        const data = result.rows.map((v) => ({
          vehicle_id: v.id,
          vehicle_plate: v.plate,
          vehicle_model: v.model,
          idle_days: period.days,
          period_days: period.days,
        }));

        return res.json({
          data,
          idle_allowed: true,
          period_days: period.days,
        });
      } else {
        const result = await query(
          `SELECT d.id, d.full_name, d.phone
           FROM drivers d
           WHERE d.is_archived = false
             AND NOT EXISTS (
               SELECT 1 FROM trips t
               WHERE t.driver_id = d.id
                 AND t.trip_date >= $1 AND t.trip_date <= $2
                 AND t.status != 'cancelled'
             )
           ORDER BY d.full_name`,
          [period.start, period.end],
        );

        const data = result.rows.map((d) => ({
          driver_id: d.id,
          driver_name: d.full_name,
          driver_phone: d.phone,
          idle_days: period.days,
          period_days: period.days,
        }));

        return res.json({
          data,
          idle_allowed: true,
          period_days: period.days,
        });
      }
    }

    // ============ DRILL-DOWN ============
    if (action === "drill-down") {
      const { type, route_id, month, hired_label } = req.query;

      if (!["vehicles", "drivers", "routes", "months"].includes(type)) {
        return res.status(400).json({ error: "Invalid drill-down type" });
      }

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

        if (
          !salaryInCosts &&
          !hiredInCosts &&
          Number(t.driver_rate_at_time) > 0
        ) {
          costs += Number(t.driver_rate_at_time);
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

      const tripsCount = trips.length;
      const tripsDone = trips.filter((x) => x.status === "done").length;
      const totalKm = trips.reduce((s, x) => s + x.fact_km, 0);
      const totalRevenue = trips.reduce((s, x) => s + x.revenue, 0);
      const totalCosts = trips.reduce((s, x) => s + x.costs, 0);
      const totalVolume = trips.reduce((s, x) => s + x.load_volume, 0);
      const totalCapacity = trips.reduce((s, x) => s + x.vehicle_volume, 0);
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
        weighted_load_percent:
          totalCapacity > 0 ? Math.round((totalVolume / totalCapacity) * 100) : 0,
        cost_per_km:
          totalKm > 0 ? Math.round((totalCosts / totalKm) * 10) / 10 : 0,
        cost_per_m3:
          totalVolume > 0 ? Math.round(totalCosts / totalVolume) : 0,
      };

      // Специфичные KPI
      if (type === "vehicles") {
        let repairsTotal = 0;
        let amortTotal = 0;
        costsRes.rows.forEach((r) => {
          if (r.category === "repair") repairsTotal += Number(r.amount);
          if (r.category === "amort") amortTotal += Number(r.amount);
        });
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

        // Простой — только для своих и коротких периодов
        const first = tripsRes.rows[0];
        const isHired = first ? !!first.hired_vehicle_info : false;
        if (!isHired && idleAllowed && period.valid) {
          const dutySet = new Set();
          trips.forEach((x) => {
            if (x.status !== "cancelled" && x.trip_date) {
              dutySet.add(toLocalDateStr(x.trip_date));
            }
          });
          kpi.duty_days = dutySet.size;
          kpi.idle_days = Math.max(0, period.days - dutySet.size);
          kpi.utilization_days_percent = Math.round(
            (dutySet.size / period.days) * 100,
          );
        }
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

        const first = tripsRes.rows[0];
        const isHired = first ? !!first.hired_driver_info : false;
        if (!isHired && idleAllowed && period.valid) {
          const dutySet = new Set();
          trips.forEach((x) => {
            if (x.status !== "cancelled" && x.trip_date) {
              dutySet.add(toLocalDateStr(x.trip_date));
            }
          });
          kpi.duty_days = dutySet.size;
          kpi.idle_days = Math.max(0, period.days - dutySet.size);
          kpi.utilization_days_percent = Math.round(
            (dutySet.size / period.days) * 100,
          );
        }
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

      // Календарь по дням — только для vehicles/drivers и только для своих
      let dayStatus = null;
      let periodDays = null;
      if (
        (type === "vehicles" || type === "drivers") &&
        idleAllowed &&
        period.valid
      ) {
        const first = tripsRes.rows[0];
        const isHired =
          type === "vehicles"
            ? first && !!first.hired_vehicle_info
            : first && !!first.hired_driver_info;

        if (!isHired) {
          periodDays = period.days;
          const dutySet = new Set();
          trips.forEach((x) => {
            if (x.status !== "cancelled" && x.trip_date) {
              dutySet.add(toLocalDateStr(x.trip_date));
            }
          });

          dayStatus = [];
          const startD = new Date(period.start + "T00:00:00");
          for (let i = 0; i < period.days; i++) {
            const d = new Date(startD);
            d.setDate(d.getDate() + i);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, "0");
            const day = String(d.getDate()).padStart(2, "0");
            const iso = y + "-" + m + "-" + day;
            dayStatus.push({
              date: iso,
              day: d.getDate(),
              has_trip: dutySet.has(iso),
            });
          }
        }
      }

      // Разбивка затрат (только для месяцев)
      let categories = null;
      if (type === "months") {
        const catMap = {};
        costsRes.rows.forEach((r) => {
          const cat = r.category;
          if (!catMap[cat]) catMap[cat] = { category: cat, count: 0, total: 0 };
          catMap[cat].count++;
          catMap[cat].total += Number(r.amount);
        });

        const hasSalary = catMap["salary"];
        const hasHired = catMap["hired"];
        if (!hasSalary || !hasHired) {
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

      let title = "";
      if (type === "vehicles") title = hired_label || "Машина";
      else if (type === "drivers") title = hired_label || "Водитель";
      else if (type === "routes") {
        const first = tripsRes.rows[0];
        title = first
          ? first.route_text || first.route_name || "Маршрут"
          : "Маршрут";
      } else if (type === "months") {
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
        period_days: periodDays,
        day_status: dayStatus,
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
