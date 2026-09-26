const { query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");
const { logChange } = require("./_lib/journal");

// Максимум элементов в bulk-операции
const BULK_LIMIT = 100;

// Утилита: разобрать и провалидировать массив ID
function parseIds(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = raw
    .map((x) => parseInt(x, 10))
    .filter((x) => Number.isInteger(x) && x > 0);
  if (ids.length === 0) return null;
  if (ids.length > BULK_LIMIT) return null;
  return ids;
}

async function handler(req, res) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const action = req.query.action || "index";
  const id = req.query.id;

  // ============ INDEX: список ============
  if (action === "index") {
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method not allowed" });

    try {
      const { status } = req.query;

      let sql = `SELECT * FROM incoming_orders`;
      const params = [];

      if (status && status !== "all") {
        sql += ` WHERE status = $1`;
        params.push(status);
      }

      sql += ` ORDER BY created_at DESC LIMIT 500`;

      const result = await query(sql, params);

      // Статистика (всегда по всем статусам)
      const statsResult = await query(`
        SELECT 
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'assigned')::int AS assigned,
          COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
        FROM incoming_orders
      `);

      return res.json({
        incoming: result.rows,
        stats: statsResult.rows[0] || { pending: 0, assigned: 0, rejected: 0 },
      });
    } catch (e) {
      console.error("GET incoming error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ CREATE: создать входящий вручную ============
  if (action === "create") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { external_id, address, contact_name, phone, volume, note } =
      req.body || {};

    if (!address || !address.trim()) {
      return res.status(400).json({ error: "Адрес обязателен" });
    }

    try {
      const result = await query(
        `INSERT INTO incoming_orders 
           (external_id, address, contact_name, phone, volume, note, status, source)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'manual')
         RETURNING *`,
        [
          external_id || null,
          address.trim(),
          contact_name || null,
          phone || null,
          Number(volume) || 0,
          note || null,
        ],
      );

      await logChange(
        req.user.id,
        "incoming_orders",
        result.rows[0].id,
        "Создание",
        "",
        address.trim(),
        ip,
      );

      return res.json({ success: true, incoming: result.rows[0] });
    } catch (e) {
      console.error("POST incoming create error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ WEBHOOK: приём из Битрикс24 ============
  if (action === "webhook") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    // Проверка секретного ключа
    const secret = req.headers["x-bitrix-secret"];
    const secretResult = await query(
      "SELECT value FROM settings WHERE key = 'bitrix_secret_key'",
    );
    const expectedSecret = secretResult.rows[0]?.value;

    if (expectedSecret && secret !== expectedSecret) {
      await query(
        `INSERT INTO bitrix_log (direction, payload, status, error_message)
         VALUES ('in', $1, 'failed', 'Неверный секретный ключ')`,
        [JSON.stringify(req.body)],
      );
      return res.status(403).json({ error: "Forbidden" });
    }

    try {
      // Простейший парсинг Битрикса — поля договоримся позже
      const payload = req.body || {};

      // Логируем
      await query(
        `INSERT INTO bitrix_log (direction, payload, status, external_id)
         VALUES ('in', $1, 'received', $2)`,
        [JSON.stringify(payload), payload.external_id || null],
      );

      return res.json({ success: true, message: "Принято" });
    } catch (e) {
      console.error("webhook error:", e);
      return res.status(500).json({ error: "Ошибка сервера" });
    }
  }

  // ============ ASSIGN: назначить на рейс (один) ============
  if (action === "assign") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    const { trip_id } = req.body || {};
    if (!trip_id) return res.status(400).json({ error: "Не указан trip_id" });

    try {
      const incomingResult = await query(
        "SELECT * FROM incoming_orders WHERE id = $1",
        [id],
      );
      if (incomingResult.rows.length === 0) {
        return res.status(404).json({ error: "Заказ не найден" });
      }
      const item = incomingResult.rows[0];

      if (item.status === "assigned") {
        return res.status(400).json({ error: "Заказ уже назначен" });
      }

      const tripCheck = await query(
        "SELECT id, trip_number FROM trips WHERE id = $1",
        [trip_id],
      );
      if (tripCheck.rows.length === 0) {
        return res.status(404).json({ error: "Рейс не найден" });
      }

      // Создаём заказ в рейсе
      const maxSeq = await query(
        "SELECT COALESCE(MAX(sequence_num), 0) AS max FROM orders WHERE trip_id = $1",
        [trip_id],
      );
      const nextSeq = maxSeq.rows[0].max + 1;

      const orderResult = await query(
        `INSERT INTO orders 
           (trip_id, external_id, address, contact_name, phone, volume, sequence_num, note, source, delivery_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
         RETURNING *`,
        [
          trip_id,
          item.external_id,
          item.address,
          item.contact_name,
          item.phone,
          item.volume,
          nextSeq,
          item.note,
          item.source,
        ],
      );

      // Обновляем incoming_orders
      await query(
        `UPDATE incoming_orders 
         SET status = 'assigned', processed_at = NOW() 
         WHERE id = $1`,
        [id],
      );

      await logChange(
        req.user.id,
        "incoming_orders",
        id,
        "Назначен",
        item.status,
        "assigned → рейс " + tripCheck.rows[0].trip_number,
        ip,
      );

      return res.json({ success: true, order: orderResult.rows[0] });
    } catch (e) {
      console.error("POST incoming assign error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ REJECT: отклонить (один) ============
  if (action === "reject") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    try {
      const current = await query(
        "SELECT * FROM incoming_orders WHERE id = $1",
        [id],
      );
      if (current.rows.length === 0) {
        return res.status(404).json({ error: "Заказ не найден" });
      }

      await query(
        `UPDATE incoming_orders 
         SET status = 'rejected', processed_at = NOW() 
         WHERE id = $1`,
        [id],
      );

      await logChange(
        req.user.id,
        "incoming_orders",
        id,
        "Отклонён",
        current.rows[0].status,
        "rejected",
        ip,
      );

      return res.json({ success: true });
    } catch (e) {
      console.error("POST incoming reject error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ BULK-ASSIGN: назначить N заказов на рейс ============
  if (action === "bulk-assign") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { ids, trip_id } = req.body || {};
    const parsedIds = parseIds(ids);

    if (!parsedIds) {
      return res.status(400).json({
        error: "Передайте массив ids (1–" + BULK_LIMIT + " элементов)",
      });
    }
    if (!trip_id) {
      return res.status(400).json({ error: "Не указан trip_id" });
    }

    try {
      // Проверка рейса
      const tripCheck = await query(
        "SELECT id, trip_number FROM trips WHERE id = $1",
        [trip_id],
      );
      if (tripCheck.rows.length === 0) {
        return res.status(404).json({ error: "Рейс не найден" });
      }

      // Загружаем все заказы, отсеиваем не-pending
      const itemsResult = await query(
        `SELECT * FROM incoming_orders 
         WHERE id = ANY($1) AND status = 'pending'`,
        [parsedIds],
      );

      if (itemsResult.rows.length === 0) {
        return res.status(400).json({
          error: "Нет подходящих заказов (все назначены или отклонены)",
        });
      }

      const items = itemsResult.rows;
      const skipped = parsedIds.length - items.length;

      // Определяем начальный sequence_num
      const maxSeq = await query(
        "SELECT COALESCE(MAX(sequence_num), 0) AS max FROM orders WHERE trip_id = $1",
        [trip_id],
      );
      let nextSeq = maxSeq.rows[0].max + 1;

      const createdOrders = [];

      for (const item of items) {
        const orderResult = await query(
          `INSERT INTO orders 
             (trip_id, external_id, address, contact_name, phone, volume, sequence_num, note, source, delivery_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
           RETURNING id`,
          [
            trip_id,
            item.external_id,
            item.address,
            item.contact_name,
            item.phone,
            item.volume,
            nextSeq,
            item.note,
            item.source,
          ],
        );
        createdOrders.push(orderResult.rows[0].id);
        nextSeq++;
      }

      // Обновляем статус у incoming
      await query(
        `UPDATE incoming_orders 
         SET status = 'assigned', processed_at = NOW() 
         WHERE id = ANY($1)`,
        [items.map((i) => i.id)],
      );

      await logChange(
        req.user.id,
        "incoming_orders",
        items.map((i) => i.id).join(","),
        "Массовое назначение",
        items.length + " заказов",
        "Рейс " + tripCheck.rows[0].trip_number,
        ip,
      );

      return res.json({
        success: true,
        assigned_count: items.length,
        skipped_count: skipped,
        trip_number: tripCheck.rows[0].trip_number,
        message:
          "Назначено " +
          items.length +
          " заказов в рейс " +
          tripCheck.rows[0].trip_number +
          (skipped > 0 ? ". Пропущено: " + skipped : ""),
      });
    } catch (e) {
      console.error("POST incoming bulk-assign error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ BULK-REJECT: массово отклонить ============
  if (action === "bulk-reject") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { ids } = req.body || {};
    const parsedIds = parseIds(ids);

    if (!parsedIds) {
      return res.status(400).json({
        error: "Передайте массив ids (1–" + BULK_LIMIT + " элементов)",
      });
    }

    try {
      const result = await query(
        `UPDATE incoming_orders 
         SET status = 'rejected', processed_at = NOW() 
         WHERE id = ANY($1) AND status = 'pending'
         RETURNING id`,
        [parsedIds],
      );

      const rejectedCount = result.rows.length;

      if (rejectedCount > 0) {
        await logChange(
          req.user.id,
          "incoming_orders",
          result.rows.map((r) => r.id).join(","),
          "Массовое отклонение",
          rejectedCount + " заказов",
          "rejected",
          ip,
        );
      }

      return res.json({
        success: true,
        rejected_count: rejectedCount,
        message: "Отклонено " + rejectedCount + " заказов",
      });
    } catch (e) {
      console.error("POST incoming bulk-reject error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ BULK-DELETE: массово удалить ============
  if (action === "bulk-delete") {
    if (req.method !== "POST" && req.method !== "DELETE") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { ids } = req.body || {};
    const parsedIds = parseIds(ids);

    if (!parsedIds) {
      return res.status(400).json({
        error: "Передайте массив ids (1–" + BULK_LIMIT + " элементов)",
      });
    }

    try {
      const result = await query(
        `DELETE FROM incoming_orders 
         WHERE id = ANY($1)
         RETURNING id, address`,
        [parsedIds],
      );

      const deletedCount = result.rows.length;

      if (deletedCount > 0) {
        await logChange(
          req.user.id,
          "incoming_orders",
          result.rows.map((r) => r.id).join(","),
          "Массовое удаление",
          deletedCount + " заказов",
          "",
          ip,
        );
      }

      return res.json({
        success: true,
        deleted_count: deletedCount,
        message: "Удалено " + deletedCount + " заказов",
      });
    } catch (e) {
      console.error("POST incoming bulk-delete error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ UPDATE: обновить входящий ============
  if (action === "update") {
    if (req.method !== "PUT")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    const { external_id, address, contact_name, phone, volume, note } =
      req.body || {};

    try {
      const current = await query(
        "SELECT * FROM incoming_orders WHERE id = $1",
        [id],
      );
      if (current.rows.length === 0) {
        return res.status(404).json({ error: "Заказ не найден" });
      }

      await query(
        `UPDATE incoming_orders 
         SET external_id = $1, address = $2, contact_name = $3, 
             phone = $4, volume = $5, note = $6
         WHERE id = $7`,
        [
          external_id || current.rows[0].external_id,
          address || current.rows[0].address,
          contact_name || current.rows[0].contact_name,
          phone || current.rows[0].phone,
          volume !== undefined ? volume : current.rows[0].volume,
          note !== undefined ? note : current.rows[0].note,
          id,
        ],
      );

      return res.json({ success: true });
    } catch (e) {
      console.error("PUT incoming error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ DELETE: удалить (один) ============
  if (action === "delete") {
    if (req.method !== "DELETE")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    try {
      const current = await query(
        "SELECT * FROM incoming_orders WHERE id = $1",
        [id],
      );
      if (current.rows.length === 0) {
        return res.status(404).json({ error: "Заказ не найден" });
      }

      await query("DELETE FROM incoming_orders WHERE id = $1", [id]);
      await logChange(
        req.user.id,
        "incoming_orders",
        id,
        "Удаление",
        current.rows[0].address,
        "",
        ip,
      );

      return res.json({ success: true });
    } catch (e) {
      console.error("DELETE incoming error:", e);
      return res
        .status(500)
        .json({ error: "Ошибка сервера", details: e.message });
    }
  }

  return res.status(400).json({ error: "Unknown action: " + action });
}

module.exports = requireAuth(handler);
