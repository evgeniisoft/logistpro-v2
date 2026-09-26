const { query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");
const { logChange } = require("./_lib/journal");
const { validateTrip } = require("./_lib/validation");
const { generateTripNumber } = require("./_lib/numbers");

async function handler(req, res) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const action = req.query.action || "index";
  const id = req.query.id;

  // ============ GET ONE (карточка рейса) ============
  if (action === "get") {
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID рейса не указан" });

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
        [id],
      );

      if (tripResult.rows.length === 0) {
        return res.status(404).json({ error: "Рейс не найден" });
      }

      const ordersResult = await query(
        "SELECT * FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC NULLS LAST, id ASC",
        [id],
      );

      // Загружаем pending-изменения из Битрикса для заказов этого рейса
      const changesResult = await query(
        `SELECT 
           ic.id, ic.external_id, ic.change_type, ic.field_name,
           ic.old_value, ic.new_value, ic.order_id, ic.created_at
         FROM incoming_changes ic
         WHERE ic.order_id = ANY($1) AND ic.status = 'pending'
         ORDER BY ic.created_at DESC`,
        [ordersResult.rows.map((o) => o.id)],
      );

      // Группируем изменения по order_id
      const changesByOrder = {};
      changesResult.rows.forEach((c) => {
        if (!changesByOrder[c.order_id]) changesByOrder[c.order_id] = [];
        changesByOrder[c.order_id].push(c);
      });

      // Прикрепляем changes к каждому order
      const ordersWithChanges = ordersResult.rows.map((o) => ({
        ...o,
        pending_changes: changesByOrder[o.id] || [],
      }));

      const costsResult = await query(
        "SELECT * FROM costs WHERE trip_id = $1 ORDER BY created_at DESC",
        [id],
      );

      const trip = tripResult.rows[0];
      const costs = costsResult.rows;

      // Автоматические затраты
      const autoCosts = [];

      // Зарплата — из driver_rate_at_time (если не добавлена вручную)
      const salaryExists = costs.some((c) => c.category === "salary");
      if (!salaryExists && Number(trip.driver_rate_at_time) > 0) {
        autoCosts.push({
          id: null,
          category: "salary",
          amount: Number(trip.driver_rate_at_time),
          note: "Автоматически из ставки водителя",
          is_auto: true,
        });
      }

      // Амортизация — пробег факт × ставка (для своих машин)
      if (trip.vehicle_type === "own" && Number(trip.fact_km) > 0) {
        const vehicleRes = await query(
          "SELECT amort_rate FROM vehicles WHERE id = $1",
          [trip.vehicle_id],
        );
        if (vehicleRes.rows.length > 0) {
          const amortRate = Number(vehicleRes.rows[0].amort_rate) || 0;
          if (amortRate > 0) {
            const amortExists = costs.some((c) => c.category === "amort");
            if (!amortExists) {
              autoCosts.push({
                id: null,
                category: "amort",
                amount: Math.round(Number(trip.fact_km) * amortRate),
                note:
                  "Автоматически: " +
                  trip.fact_km +
                  " км × " +
                  amortRate +
                  " ₽/км",
                is_auto: true,
              });
            }
          }
        }
      }

      return res.json({
        trip: trip,
        orders: ordersWithChanges,
        costs: costs,
        auto_costs: autoCosts,
      });
    } catch (e) {
      console.error("GET trip error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ UPDATE (обновить рейс) ============
  if (action === "update") {
    if (req.method !== "PUT")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID рейса не указан" });

    const { version, ...fields } = req.body;

    try {
      const current = await query("SELECT * FROM trips WHERE id = $1", [id]);
      if (current.rows.length === 0)
        return res.status(404).json({ error: "Рейс не найден" });

      const trip = current.rows[0];

      if (version !== undefined && trip.version !== version) {
        return res.status(409).json({
          error: "Рейс был изменён другим пользователем",
          current_version: trip.version,
        });
      }

      const allowedFields = [
        "trip_date",
        "trip_type",
        "route_id",
        "route_text",
        "plan_km",
        "fact_km",
        "status",
        "revenue",
        "comment",
        "cancel_reason",
        "problem_comment",
        "vehicle_id",
        "hired_vehicle_info",
        "driver_id",
        "hired_driver_info",
      ];

      const updates = [];
      const params = [];
      let paramIndex = 1;

      // Флаги: колонки, которые уже добавлены в updates отдельно
      let vehicleVolumeSet = false;
      let driverRateSet = false;

      // Специальная обработка смены машины
      if (fields.vehicle_id !== undefined) {
        if (fields.vehicle_id === null) {
          updates.push(`vehicle_id = NULL`);
          updates.push(`hired_vehicle_info = $${paramIndex++}`);
          params.push(fields.hired_vehicle_info || "Наёмная");
          if (fields.vehicle_volume_at_time !== undefined) {
            updates.push(`vehicle_volume_at_time = $${paramIndex++}`);
            params.push(fields.vehicle_volume_at_time);
          } else {
            updates.push(`vehicle_volume_at_time = 0`);
          }
          vehicleVolumeSet = true;
          await logChange(
            req.user.id,
            "trips",
            id,
            "vehicle_id",
            trip.vehicle_id || "наёмная",
            "наёмная",
            ip,
          );
        } else {
          const v = await query("SELECT volume FROM vehicles WHERE id = $1", [
            fields.vehicle_id,
          ]);
          if (v.rows.length > 0) {
            updates.push(`vehicle_id = $${paramIndex++}`);
            params.push(fields.vehicle_id);
            updates.push(`vehicle_volume_at_time = $${paramIndex++}`);
            params.push(Number(v.rows[0].volume) || 0);
            updates.push(`hired_vehicle_info = NULL`);
            vehicleVolumeSet = true;
            if (String(trip.vehicle_id) !== String(fields.vehicle_id)) {
              await logChange(
                req.user.id,
                "trips",
                id,
                "vehicle_id",
                trip.vehicle_id,
                fields.vehicle_id,
                ip,
              );
            }
          }
        }
      }

      // Специальная обработка смены водителя
      if (fields.driver_id !== undefined) {
        if (fields.driver_id === null) {
          updates.push(`driver_id = NULL`);
          updates.push(`hired_driver_info = $${paramIndex++}`);
          params.push(fields.hired_driver_info || "Наёмный");
          if (fields.driver_rate_at_time !== undefined) {
            updates.push(`driver_rate_at_time = $${paramIndex++}`);
            params.push(fields.driver_rate_at_time);
          }
          driverRateSet = true;
          await logChange(
            req.user.id,
            "trips",
            id,
            "driver_id",
            trip.driver_id || "наёмный",
            "наёмный",
            ip,
          );
        } else {
          const d = await query(
            "SELECT default_rate FROM drivers WHERE id = $1",
            [fields.driver_id],
          );
          if (d.rows.length > 0) {
            updates.push(`driver_id = $${paramIndex++}`);
            params.push(fields.driver_id);
            updates.push(`driver_rate_at_time = $${paramIndex++}`);
            params.push(Number(d.rows[0].default_rate) || 0);
            updates.push(`hired_driver_info = NULL`);
            driverRateSet = true;
            if (String(trip.driver_id) !== String(fields.driver_id)) {
              await logChange(
                req.user.id,
                "trips",
                id,
                "driver_id",
                trip.driver_id,
                fields.driver_id,
                ip,
              );
            }
          }
        }
      }

      // Остальные поля
      for (const field of allowedFields) {
        if (field === "vehicle_id" || field === "driver_id") continue;
        if (field === "hired_vehicle_info" && fields.vehicle_id !== undefined)
          continue;
        if (field === "hired_driver_info" && fields.driver_id !== undefined)
          continue;
        if (field === "vehicle_volume_at_time" && vehicleVolumeSet) continue;
        if (field === "driver_rate_at_time" && driverRateSet) continue;

        if (fields[field] !== undefined) {
          updates.push(`${field} = $${paramIndex++}`);
          params.push(fields[field]);

          if (String(trip[field]) !== String(fields[field])) {
            await logChange(
              req.user.id,
              "trips",
              id,
              field,
              trip[field],
              fields[field],
              ip,
            );
          }
        }
      }

      // Отдельная обработка vehicle_volume_at_time / driver_rate_at_time
      if (
        !vehicleVolumeSet &&
        fields.vehicle_volume_at_time !== undefined
      ) {
        updates.push(`vehicle_volume_at_time = $${paramIndex++}`);
        params.push(fields.vehicle_volume_at_time);
        if (String(trip.vehicle_volume_at_time) !== String(fields.vehicle_volume_at_time)) {
          await logChange(
            req.user.id,
            "trips",
            id,
            "vehicle_volume_at_time",
            trip.vehicle_volume_at_time,
            fields.vehicle_volume_at_time,
            ip,
          );
        }
      }

      if (!driverRateSet && fields.driver_rate_at_time !== undefined) {
        updates.push(`driver_rate_at_time = $${paramIndex++}`);
        params.push(fields.driver_rate_at_time);
        if (String(trip.driver_rate_at_time) !== String(fields.driver_rate_at_time)) {
          await logChange(
            req.user.id,
            "trips",
            id,
            "driver_rate_at_time",
            trip.driver_rate_at_time,
            fields.driver_rate_at_time,
            ip,
          );
        }
      }

      if (updates.length === 0) {
        return res.json({ success: true, message: "Нет изменений" });
      }

      updates.push("version = version + 1");
      updates.push("updated_at = NOW()");

      params.push(id);
      const sql = `UPDATE trips SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`;
      const result = await query(sql, params);

      // Автоматически проставляем delivered для pending-заказов
      // при переходе рейса в статус done
      if (
        fields.status === "done" &&
        trip.status !== "done" &&
        result.rows[0].status === "done"
      ) {
        await query(
          `UPDATE orders 
           SET delivery_status = 'delivered', updated_at = NOW()
           WHERE trip_id = $1 
             AND (delivery_status IS NULL OR delivery_status = 'pending')`,
          [id],
        );
      }

      return res.json({ success: true, trip: result.rows[0] });
    } catch (e) {
      console.error("PUT trip error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ DELETE ============
  if (action === "delete") {
    if (req.method !== "DELETE")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID рейса не указан" });

    if (req.user.role !== "admin" && req.user.role !== "senior_logist") {
      return res.status(403).json({ error: "Недостаточно прав для удаления" });
    }

    try {
      const check = await query(
        "SELECT trip_number, status FROM trips WHERE id = $1",
        [id],
      );
      if (check.rows.length === 0)
        return res.status(404).json({ error: "Рейс не найден" });

      if (["transit", "done"].includes(check.rows[0].status)) {
        return res.status(400).json({
          error: 'Нельзя удалить рейс в статусе "' + check.rows[0].status + '"',
        });
      }

      await query("DELETE FROM trips WHERE id = $1", [id]);
      await logChange(
        req.user.id,
        "trips",
        id,
        "Удаление",
        check.rows[0].trip_number,
        "",
        ip,
      );

      return res.json({ success: true });
    } catch (e) {
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ REORDER ============
  if (action === "reorder") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID рейса не указан" });

    const { order_ids } = req.body;
    if (!Array.isArray(order_ids) || order_ids.length === 0) {
      return res.status(400).json({ error: "Не передан список order_ids" });
    }

    try {
      const orders = await query("SELECT id FROM orders WHERE trip_id = $1", [
        id,
      ]);
      const existingIds = orders.rows.map((r) => r.id);
      const invalidIds = order_ids.filter((oid) => !existingIds.includes(oid));

      if (invalidIds.length > 0) {
        return res.status(400).json({
          error: "Некоторые заказы не принадлежат этому рейсу",
          invalid: invalidIds,
        });
      }

      for (let i = 0; i < order_ids.length; i++) {
        await query(
          "UPDATE orders SET sequence_num = $1, updated_at = NOW() WHERE id = $2",
          [i + 1, order_ids[i]],
        );
      }

      await logChange(
        req.user.id,
        "trips",
        id,
        "Пересортировка",
        "",
        "Изменён порядок адресов",
        ip,
      );

      return res.json({ success: true });
    } catch (e) {
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ MOVE ALL ORDERS ============
  if (action === "move-all-orders") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID рейса не указан" });

    const { to_trip_id, reason } = req.body;
    if (!to_trip_id)
      return res.status(400).json({ error: "Не указан целевой рейс" });
    if (id === String(to_trip_id))
      return res
        .status(400)
        .json({ error: "Исходный и целевой рейс совпадают" });

    try {
      const targetTrip = await query(
        "SELECT id, trip_number FROM trips WHERE id = $1",
        [to_trip_id],
      );
      if (targetTrip.rows.length === 0)
        return res.status(404).json({ error: "Целевой рейс не найден" });

      const orders = await query(
        "SELECT id FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC NULLS LAST, id ASC",
        [id],
      );

      if (orders.rows.length === 0) {
        return res
          .status(400)
          .json({ error: "В рейсе нет заказов для переноса" });
      }

      const maxSeqResult = await query(
        "SELECT COALESCE(MAX(sequence_num), 0) as max FROM orders WHERE trip_id = $1",
        [to_trip_id],
      );
      let nextSeq = maxSeqResult.rows[0].max + 1;

      for (const order of orders.rows) {
        // Сбрасываем delivery_status в pending и delivery_note в NULL
        await query(
          `UPDATE orders 
           SET trip_id = $1, sequence_num = $2, 
               delivery_status = 'pending', delivery_note = NULL,
               updated_at = NOW() 
           WHERE id = $3`,
          [to_trip_id, nextSeq, order.id],
        );
        await query(
          `INSERT INTO order_history (order_id, from_trip_id, to_trip_id, reason, moved_by)
                     VALUES ($1, $2, $3, $4, $5)`,
          [
            order.id,
            id,
            to_trip_id,
            reason || "Перенос всех заказов",
            req.user.id,
          ],
        );
        nextSeq++;
      }

      await logChange(
        req.user.id,
        "trips",
        id,
        "Перенос всех заказов",
        "Рейс " + id,
        "Рейс " + to_trip_id,
        ip,
      );

      return res.json({
        success: true,
        moved_count: orders.rows.length,
        message:
          "Перенесено " +
          orders.rows.length +
          " заказов в рейс " +
          targetTrip.rows[0].trip_number,
      });
    } catch (e) {
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ CANCEL ============
  if (action === "cancel") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID рейса не указан" });

    const { reason, orders_action } = req.body;
    if (!reason || !reason.trim())
      return res.status(400).json({ error: "Укажите причину отмены" });
    if (!["return_to_incoming", "mark_cancelled"].includes(orders_action)) {
      return res.status(400).json({ error: "Укажите действие с заказами" });
    }

    try {
      const tripResult = await query(
        "SELECT trip_number, status FROM trips WHERE id = $1",
        [id],
      );
      if (tripResult.rows.length === 0)
        return res.status(404).json({ error: "Рейс не найден" });

      const trip = tripResult.rows[0];
      if (trip.status === "done")
        return res
          .status(400)
          .json({ error: "Нельзя отменить завершённый рейс" });
      if (trip.status === "cancelled")
        return res.status(400).json({ error: "Рейс уже отменён" });

      if (orders_action === "return_to_incoming") {
        // Заказы уходят в пул. delivery_status не трогаем.
        await query(
          `UPDATE orders 
           SET trip_id = NULL, sequence_num = NULL, status = 'new', updated_at = NOW()
           WHERE trip_id = $1`,
          [id],
        );
      } else {
        // Заказы помечаются отменёнными.
        await query(
          `UPDATE orders 
           SET status = 'cancelled', delivery_status = 'cancelled', updated_at = NOW() 
           WHERE trip_id = $1`,
          [id],
        );
      }

      await query(
        `UPDATE trips SET status = 'cancelled', cancel_reason = $1, updated_at = NOW(), version = version + 1
                 WHERE id = $2`,
        [reason.trim(), id],
      );

      await logChange(
        req.user.id,
        "trips",
        id,
        "Отмена",
        trip.status,
        "cancelled. " + reason,
        ip,
      );

      return res.json({
        success: true,
        message: "Рейс " + trip.trip_number + " отменён",
      });
    } catch (e) {
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ PROBLEM ============
  if (action === "problem") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID рейса не указан" });

    const { comment } = req.body;
    if (!comment || !comment.trim())
      return res.status(400).json({ error: "Укажите комментарий" });

    try {
      const tripResult = await query(
        "SELECT trip_number, status FROM trips WHERE id = $1",
        [id],
      );
      if (tripResult.rows.length === 0)
        return res.status(404).json({ error: "Рейс не найден" });

      const trip = tripResult.rows[0];
      if (["done", "cancelled"].includes(trip.status)) {
        return res.status(400).json({
          error: "Нельзя отметить проблему у завершённого/отменённого рейса",
        });
      }

      await query(
        `UPDATE trips SET status = 'problem', problem_comment = $1, updated_at = NOW(), version = version + 1
                 WHERE id = $2`,
        [comment.trim(), id],
      );

      await logChange(
        req.user.id,
        "trips",
        id,
        "Проблема",
        trip.status,
        "problem. " + comment,
        ip,
      );

      return res.json({
        success: true,
        message: "Рейс " + trip.trip_number + " помечен как проблемный",
      });
    } catch (e) {
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ INDEX: список / создание ============
  if (req.method === "GET") {
    try {
      const { status, month, driver_id, vehicle_id, limit, include_overdue_count } = req.query;

      let sql = `
          SELECT 
              t.id, t.trip_number, t.trip_date, t.trip_type, t.status,
              t.plan_km, t.fact_km, t.revenue, t.comment, t.version,
              t.driver_rate_at_time, t.vehicle_volume_at_time,
              t.vehicle_id, t.hired_vehicle_info,
              t.driver_id, t.hired_driver_info,
              t.route_text,
              t.created_at, t.updated_at,
              v.plate AS vehicle_plate, v.model AS vehicle_model, v.type AS vehicle_type,
              d.full_name AS driver_name,
              r.name AS route_name,
              (SELECT COUNT(*) FROM orders WHERE trip_id = t.id) AS orders_count,
              (SELECT COALESCE(SUM(volume), 0) FROM orders WHERE trip_id = t.id) AS total_volume,
              (SELECT COALESCE(SUM(amount), 0) FROM costs WHERE trip_id = t.id) AS total_costs,
              CASE 
                  WHEN t.trip_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date
                   AND t.status NOT IN ('done', 'cancelled')
                  THEN true 
                  ELSE false 
              END AS is_overdue,
              CASE 
                  WHEN t.trip_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date
                   AND t.status NOT IN ('done', 'cancelled')
                  THEN ((CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date - t.trip_date)
                  ELSE 0 
              END AS days_overdue,
              CASE 
                  WHEN t.trip_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date
                   AND t.status NOT IN ('done', 'cancelled')
                  THEN true 
                  ELSE false 
              END AS is_today
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

      if (include_overdue_count === "true") {
        const overdueRes = await query(`
          SELECT COUNT(*)::int AS cnt
          FROM trips
          WHERE trip_date < (CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow')::date
            AND status NOT IN ('done', 'cancelled')
        `);
        return res.json({
          trips: result.rows,
          overdue_outside_count: overdueRes.rows[0].cnt,
        });
      }

      return res.json({ trips: result.rows });
    } catch (e) {
      console.error("GET trips error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  if (req.method === "POST") {
    const {
      trip_date,
      trip_type,
      vehicle_id,
      driver_id,
      route_id,
      route_text,
      plan_km,
      fact_km,
      revenue,
      comment,
      addresses,
      hired_vehicle_info,
      hired_driver_info,
      vehicle_volume,
    } = req.body;

    if (!trip_date)
      return res.status(400).json({ error: "Укажите дату рейса" });
    if (!vehicle_id && !hired_vehicle_info) {
      return res
        .status(400)
        .json({ error: "Укажите машину (свою или наёмную)" });
    }
    if (!driver_id && !hired_driver_info) {
      return res
        .status(400)
        .json({ error: "Укажите водителя (своего или наёмного)" });
    }

    try {
      let finalVehicleId = null;
      let finalVehicleVolume = 0;
      let finalHiredVehicleInfo = null;

      if (vehicle_id) {
        const v = await query(
          "SELECT volume FROM vehicles WHERE id = $1 AND is_archived = false",
          [vehicle_id],
        );
        if (v.rows.length === 0)
          return res
            .status(400)
            .json({ error: "Машина не найдена или архивирована" });
        finalVehicleId = vehicle_id;
        finalVehicleVolume = Number(v.rows[0].volume) || 0;
      } else if (hired_vehicle_info && hired_vehicle_info.trim()) {
        finalHiredVehicleInfo = hired_vehicle_info.trim();
        finalVehicleVolume = Number(vehicle_volume) || 0;
      }

      let finalDriverId = null;
      let finalDriverRate = 0;
      let finalHiredDriverInfo = null;

      if (driver_id) {
        const d = await query(
          "SELECT default_rate FROM drivers WHERE id = $1 AND is_archived = false",
          [driver_id],
        );
        if (d.rows.length === 0)
          return res
            .status(400)
            .json({ error: "Водитель не найден или архивирован" });
        finalDriverId = driver_id;
        finalDriverRate = Number(d.rows[0].default_rate) || 0;
      } else if (hired_driver_info && hired_driver_info.trim()) {
        finalHiredDriverInfo = hired_driver_info.trim();
        finalDriverRate = Number(req.body.driver_rate) || 0;
      }

      const tripNumber = await generateTripNumber();

      const tripResult = await query(
        `INSERT INTO trips (
                    trip_number, trip_date, trip_type, 
                    vehicle_id, vehicle_volume_at_time, hired_vehicle_info,
                    driver_id, driver_rate_at_time, hired_driver_info,
                    route_id, route_text, plan_km, fact_km,
                    revenue, comment, created_by
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
                RETURNING id, trip_number`,
        [
          tripNumber,
          trip_date,
          trip_type || "city",
          finalVehicleId,
          finalVehicleVolume,
          finalHiredVehicleInfo,
          finalDriverId,
          finalDriverRate,
          finalHiredDriverInfo,
          route_id || null,
          route_text || null,
          plan_km || 0,
          fact_km || 0,
          revenue || 0,
          comment || null,
          req.user.id,
        ],
      );

      const tripId = tripResult.rows[0].id;

      if (addresses && Array.isArray(addresses) && addresses.length > 0) {
        for (let i = 0; i < addresses.length; i++) {
          const addr = addresses[i];
          if (!addr.address) continue;

          await query(
            `INSERT INTO orders (trip_id, external_id, address, contact_name, phone, volume, sequence_num, note, source, delivery_status)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', 'pending')`,
            [
              tripId,
              addr.external_id || null,
              addr.address,
              addr.contact_name || null,
              addr.phone || null,
              addr.volume || 0,
              i + 1,
              addr.note || null,
            ],
          );
        }
      }

      await logChange(
        req.user.id,
        "trips",
        tripId,
        "Создание",
        "",
        tripNumber,
        ip,
      );

      return res.status(201).json({
        success: true,
        trip: { id: tripId, trip_number: tripNumber },
      });
    } catch (e) {
      console.error("POST trips error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

module.exports = requireAuth(handler);
