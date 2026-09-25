const { query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");
const { logChange } = require("./_lib/journal");

async function handler(req, res) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const action = req.query.action || "get";
  const id = req.query.id;

  // ============ ALL: список всех заказов (для поиска на доске) ============
  if (action === "all") {
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method not allowed" });

    try {
      const result = await query(
        `SELECT 
                    o.id, o.trip_id, o.external_id, o.address, 
                    o.contact_name, o.phone, o.volume, o.sequence_num, 
                    o.note, o.status,
                    o.delivery_status, o.delivery_note
                 FROM orders o
                 WHERE o.trip_id IS NOT NULL
                 ORDER BY o.trip_id, o.sequence_num ASC NULLS LAST, o.id ASC`,
      );

      return res.json({ orders: result.rows });
    } catch (e) {
      console.error("GET /api/orders?action=all error:", e);
      return res.status(500).json({ error: "Ошибка сервера" });
    }
  }

  // ============ LIST-FAILED: список неудавшихся доставок ============
  if (action === "list-failed") {
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method not allowed" });

    try {
      // Заказы с delivery_status = 'failed', которые:
      //   - либо вне рейса (trip_id IS NULL)
      //   - либо в закрытом рейсе (done)
      const result = await query(
        `SELECT 
                    o.id, o.trip_id, o.external_id, o.address,
                    o.contact_name, o.phone, o.volume, o.sequence_num,
                    o.note, o.status,
                    o.delivery_status, o.delivery_note,
                    o.updated_at,
                    t.trip_number,
                    t.trip_date,
                    t.status AS trip_status,
                    v.plate AS vehicle_plate,
                    d.full_name AS driver_name
                 FROM orders o
                 LEFT JOIN trips t ON t.id = o.trip_id
                 LEFT JOIN vehicles v ON v.id = t.vehicle_id
                 LEFT JOIN drivers d ON d.id = t.driver_id
                 WHERE o.delivery_status = 'failed'
                   AND (
                     o.trip_id IS NULL
                     OR t.status = 'done'
                     OR t.status = 'cancelled'
                   )
                 ORDER BY o.updated_at DESC NULLS LAST, o.id DESC`,
      );

      return res.json({ orders: result.rows });
    } catch (e) {
      console.error("GET /api/orders?action=list-failed error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ CREATE (добавить заказ в рейс) ============
  if (action === "create") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { trip_id, external_id, address, contact_name, phone, volume, note } =
      req.body;

    if (!trip_id) return res.status(400).json({ error: "Не указан trip_id" });
    if (!address || !address.trim())
      return res.status(400).json({ error: "Адрес обязателен" });

    try {
      const tripCheck = await query(
        "SELECT id, trip_number FROM trips WHERE id = $1",
        [trip_id],
      );
      if (tripCheck.rows.length === 0) {
        return res.status(404).json({ error: "Рейс не найден" });
      }

      const maxSeqResult = await query(
        "SELECT COALESCE(MAX(sequence_num), 0) as max FROM orders WHERE trip_id = $1",
        [trip_id],
      );
      const nextSeq = maxSeqResult.rows[0].max + 1;

      const result = await query(
        `INSERT INTO orders (
                    trip_id, external_id, address, contact_name, phone, volume, sequence_num, note, source, delivery_status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', 'pending')
                RETURNING *`,
        [
          trip_id,
          external_id || null,
          address.trim(),
          contact_name || null,
          phone || null,
          volume || 0,
          nextSeq,
          note || null,
        ],
      );

      await logChange(
        req.user.id,
        "orders",
        result.rows[0].id,
        "Добавлен",
        "",
        "Рейс " + tripCheck.rows[0].trip_number,
        ip,
      );

      return res.status(201).json({ success: true, order: result.rows[0] });
    } catch (e) {
      console.error("POST order create error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // Для всех остальных actions нужен id
  if (!id) {
    return res.status(400).json({ error: "ID заказа не указан" });
  }

  // ============ GET ============
  if (action === "get") {
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method not allowed" });

    try {
      const result = await query(
        `SELECT o.*, t.trip_number 
                 FROM orders o
                 LEFT JOIN trips t ON t.id = o.trip_id
                 WHERE o.id = $1`,
        [id],
      );

      if (result.rows.length === 0)
        return res.status(404).json({ error: "Заказ не найден" });
      return res.json({ order: result.rows[0] });
    } catch (e) {
      return res.status(500).json({ error: "Ошибка сервера" });
    }
  }

  // ============ UPDATE ============
  if (action === "update") {
    if (req.method !== "PUT")
      return res.status(405).json({ error: "Method not allowed" });

    const fields = req.body;
    const allowedFields = [
      "address",
      "contact_name",
      "phone",
      "volume",
      "note",
      "sequence_num",
      "status",
    ];

    try {
      const current = await query("SELECT * FROM orders WHERE id = $1", [id]);
      if (current.rows.length === 0)
        return res.status(404).json({ error: "Заказ не найден" });

      const order = current.rows[0];
      const updates = [];
      const params = [];
      let paramIndex = 1;

      for (const field of allowedFields) {
        if (fields[field] !== undefined) {
          updates.push(`${field} = $${paramIndex++}`);
          params.push(fields[field]);

          if (String(order[field]) !== String(fields[field])) {
            await logChange(
              req.user.id,
              "orders",
              id,
              field,
              order[field],
              fields[field],
              ip,
            );
          }
        }
      }

      if (updates.length === 0)
        return res.json({ success: true, message: "Нет изменений" });

      updates.push("updated_at = NOW()");
      params.push(id);
      const sql = `UPDATE orders SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`;
      const result = await query(sql, params);

      return res.json({ success: true, order: result.rows[0] });
    } catch (e) {
      console.error("PUT order error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ UPDATE-DELIVERY-STATUS (смена статуса доставки) ============
  if (action === "update-delivery-status") {
    if (req.method !== "POST" && req.method !== "PUT") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { delivery_status, delivery_note } = req.body || {};

    const ALLOWED_STATUSES = ["pending", "delivered", "failed", "cancelled"];
    if (!delivery_status || !ALLOWED_STATUSES.includes(delivery_status)) {
      return res.status(400).json({ error: "Неверный статус доставки" });
    }

    try {
      const current = await query("SELECT * FROM orders WHERE id = $1", [id]);
      if (current.rows.length === 0)
        return res.status(404).json({ error: "Заказ не найден" });

      const order = current.rows[0];

      const updates = [];
      const params = [];
      let paramIndex = 1;

      if (String(order.delivery_status) !== String(delivery_status)) {
        updates.push(`delivery_status = $${paramIndex++}`);
        params.push(delivery_status);

        await logChange(
          req.user.id,
          "orders",
          id,
          "delivery_status",
          order.delivery_status || "",
          delivery_status,
          ip,
        );
      }

      // delivery_note — сохраняем только если передан (даже пустой)
      if (delivery_note !== undefined) {
        const newNote = delivery_note ? String(delivery_note) : null;
        if (String(order.delivery_note || "") !== String(newNote || "")) {
          updates.push(`delivery_note = $${paramIndex++}`);
          params.push(newNote);

          await logChange(
            req.user.id,
            "orders",
            id,
            "delivery_note",
            order.delivery_note || "",
            newNote || "",
            ip,
          );
        }
      }

      if (updates.length === 0) {
        return res.json({ success: true, order, message: "Нет изменений" });
      }

      updates.push("updated_at = NOW()");
      params.push(id);
      const sql = `UPDATE orders SET ${updates.join(", ")} WHERE id = $${paramIndex} RETURNING *`;
      const result = await query(sql, params);

      return res.json({ success: true, order: result.rows[0] });
    } catch (e) {
      console.error("update-delivery-status error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ RETURN-TO-POOL (вернуть в пул) ============
  if (action === "return-to-pool") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    try {
      const current = await query(
        `SELECT o.*, t.trip_number
         FROM orders o
         LEFT JOIN trips t ON t.id = o.trip_id
         WHERE o.id = $1`,
        [id],
      );
      if (current.rows.length === 0)
        return res.status(404).json({ error: "Заказ не найден" });

      const order = current.rows[0];

      if (!order.trip_id) {
        return res.status(400).json({ error: "Заказ уже вне рейса" });
      }

      // Очищаем trip_id и sequence_num
      await query(
        `UPDATE orders 
         SET trip_id = NULL, sequence_num = NULL, updated_at = NOW() 
         WHERE id = $1`,
        [id],
      );

      // Пересчитываем очерёдность в исходном рейсе
      await renumberOrders(order.trip_id);

      await logChange(
        req.user.id,
        "orders",
        id,
        "Возврат в пул",
        "Рейс " + (order.trip_number || order.trip_id),
        "вне рейса",
        ip,
      );

      return res.json({ success: true, message: "Заказ возвращён в пул" });
    } catch (e) {
      console.error("return-to-pool error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ CANCEL (отменить заказ) ============
  if (action === "cancel") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    try {
      const current = await query("SELECT * FROM orders WHERE id = $1", [id]);
      if (current.rows.length === 0)
        return res.status(404).json({ error: "Заказ не найден" });

      const order = current.rows[0];

      await query(
        `UPDATE orders 
         SET delivery_status = 'cancelled', updated_at = NOW() 
         WHERE id = $1`,
        [id],
      );

      await logChange(
        req.user.id,
        "orders",
        id,
        "delivery_status",
        order.delivery_status || "",
        "cancelled",
        ip,
      );

      return res.json({ success: true, message: "Заказ отменён" });
    } catch (e) {
      console.error("cancel order error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ DELETE ============
  if (action === "delete") {
    if (req.method !== "DELETE")
      return res.status(405).json({ error: "Method not allowed" });

    try {
      const current = await query("SELECT * FROM orders WHERE id = $1", [id]);
      if (current.rows.length === 0)
        return res.status(404).json({ error: "Заказ не найден" });

      const order = current.rows[0];
      const oldTripId = order.trip_id;

      await query("DELETE FROM orders WHERE id = $1", [id]);
      await logChange(
        req.user.id,
        "orders",
        id,
        "Удаление",
        order.address,
        "",
        ip,
      );

      // Пересчёт очерёдности в исходном рейсе
      if (oldTripId) await renumberOrders(oldTripId);

      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ error: "Ошибка сервера" });
    }
  }

  // ============ MOVE ============
  if (action === "move") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { to_trip_id, reason, position } = req.body;
    if (!to_trip_id)
      return res.status(400).json({ error: "Не указан целевой рейс" });

    try {
      const orderResult = await query("SELECT * FROM orders WHERE id = $1", [
        id,
      ]);
      if (orderResult.rows.length === 0)
        return res.status(404).json({ error: "Заказ не найден" });

      const order = orderResult.rows[0];
      const fromTripId = order.trip_id;

      if (fromTripId === parseInt(to_trip_id)) {
        return res.status(400).json({ error: "Заказ уже в этом рейсе" });
      }

      const targetTrip = await query(
        "SELECT id, trip_number FROM trips WHERE id = $1",
        [to_trip_id],
      );
      if (targetTrip.rows.length === 0)
        return res.status(404).json({ error: "Целевой рейс не найден" });

      let newSequence = position;
      if (!newSequence) {
        const maxSeq = await query(
          "SELECT COALESCE(MAX(sequence_num), 0) as max FROM orders WHERE trip_id = $1",
          [to_trip_id],
        );
        newSequence = maxSeq.rows[0].max + 1;
      }

      // Сбрасываем delivery_status в pending и delivery_note в NULL
      await query(
        `UPDATE orders 
         SET trip_id = $1, sequence_num = $2, 
             delivery_status = 'pending', delivery_note = NULL,
             updated_at = NOW() 
         WHERE id = $3`,
        [to_trip_id, newSequence, id],
      );

      await query(
        `INSERT INTO order_history (order_id, from_trip_id, to_trip_id, reason, moved_by)
                 VALUES ($1, $2, $3, $4, $5)`,
        [id, fromTripId, to_trip_id, reason || null, req.user.id],
      );

      await logChange(
        req.user.id,
        "orders",
        id,
        "Перенос",
        "Рейс " + (fromTripId || "нет"),
        "Рейс " + to_trip_id,
        ip,
      );

      if (fromTripId) await renumberOrders(fromTripId);
      await renumberOrders(to_trip_id);

      return res.json({
        success: true,
        message: "Заказ перенесён в рейс " + targetTrip.rows[0].trip_number,
      });
    } catch (e) {
      console.error("POST order move error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  return res.status(405).json({ error: "Unknown action: " + action });
}

async function renumberOrders(tripId) {
  const orders = await query(
    "SELECT id FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC NULLS LAST, id ASC",
    [tripId],
  );
  for (let i = 0; i < orders.rows.length; i++) {
    await query("UPDATE orders SET sequence_num = $1 WHERE id = $2", [
      i + 1,
      orders.rows[i].id,
    ]);
  }
}

module.exports = requireAuth(handler);
