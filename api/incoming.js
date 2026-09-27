const { query } = require("./_lib/db");
const { requireAuth } = require("./_lib/auth");
const { logChange } = require("./_lib/journal");

const BULK_LIMIT = 100;

function parseIds(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = raw
    .map((x) => parseInt(x, 10))
    .filter((x) => Number.isInteger(x) && x > 0);
  if (ids.length === 0) return null;
  if (ids.length > BULK_LIMIT) return null;
  return ids;
}

async function getFieldMapping() {
  const result = await query(
    "SELECT value FROM settings WHERE key = 'bitrix_field_mapping'"
  );
  if (result.rows.length === 0 || !result.rows[0].value) return null;
  try {
    return JSON.parse(result.rows[0].value);
  } catch (e) {
    console.error("Ошибка парсинга bitrix_field_mapping:", e);
    return null;
  }
}

async function getCancelStages() {
  const result = await query(
    "SELECT value FROM settings WHERE key = 'bitrix_cancel_stages'"
  );
  if (result.rows.length === 0 || !result.rows[0].value) {
    return ["LOSE", "CANCELLED"];
  }
  return String(result.rows[0].value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractField(fields, mappingKey, mapping) {
  const bitrixKey = mapping[mappingKey];
  if (!bitrixKey) return null;
  const value = fields[bitrixKey];
  if (value === undefined || value === null) return null;
  return String(value);
}

// Нормализуем дату из Битрикса в формат YYYY-MM-DD
function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;

  // Формат ISO или YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  // Формат DD.MM.YYYY
  const dotMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, d, m, y] = dotMatch;
    return y + "-" + m.padStart(2, "0") + "-" + d.padStart(2, "0");
  }

  // Формат DD/MM/YYYY
  const slashMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const [, d, m, y] = slashMatch;
    return y + "-" + m.padStart(2, "0") + "-" + d.padStart(2, "0");
  }

  // Пробуем через Date
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  return null;
}

function parseBitrixPayload(payload, mapping) {
  const event = payload.event || null;
  const fields = payload.data?.FIELDS || payload.data || {};
  const auth = payload.auth || {};

  if (!mapping) {
    return { error: "Маппинг полей не настроен", event, fields, auth };
  }

  const parsed = {
    event,
    auth,
    raw_fields: fields,
    external_id: extractField(fields, "external_id", mapping),
    address: extractField(fields, "address", mapping),
    contact_name: extractField(fields, "contact_name", mapping),
    phone: extractField(fields, "phone", mapping),
    volume: extractField(fields, "volume", mapping),
    delivery_date: normalizeDate(extractField(fields, "delivery_date", mapping)),
    note: extractField(fields, "note", mapping),
    title: extractField(fields, "title", mapping),
    stage: extractField(fields, "stage", mapping),
  };

  return parsed;
}

async function handler(req, res) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const action = req.query.action || "index";
  const id = req.query.id;

  // ============ WEBHOOK ============
  if (action === "webhook") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const payload = req.body || {};
    const secret = req.headers["x-bitrix-secret"];

    const secretResult = await query(
      "SELECT value FROM settings WHERE key = 'bitrix_secret_key'"
    );
    const expectedSecret = secretResult.rows[0]?.value;

    if (expectedSecret && secret !== expectedSecret) {
      await query(
        `INSERT INTO bitrix_log (direction, payload, status, error_message)
         VALUES ('in', $1, 'failed', 'Неверный секретный ключ')`,
        [JSON.stringify(payload)]
      );
      return res.status(403).json({ error: "Forbidden" });
    }

    try {
      const mapping = await getFieldMapping();
      if (!mapping) {
        await query(
          `INSERT INTO bitrix_log (direction, payload, status, error_message)
           VALUES ('in', $1, 'failed', 'Маппинг полей не настроен')`,
          [JSON.stringify(payload)]
        );
        return res.json({ success: false, message: "Маппинг полей не настроен" });
      }

      const parsed = parseBitrixPayload(payload, mapping);
      const { event, external_id, address, stage } = parsed;

      if (!external_id) {
        await query(
          `INSERT INTO bitrix_log (direction, payload, status, error_message)
           VALUES ('in', $1, 'failed', 'Не получен external_id')`,
          [JSON.stringify(payload)]
        );
        return res.json({ success: false, message: "Нет external_id" });
      }

      await query(
        `INSERT INTO bitrix_log (direction, payload, status, external_id)
         VALUES ('in', $1, 'received', $2)`,
        [JSON.stringify(payload), external_id]
      );

      // === ONCRMDEALADD: новый заказ ===
      if (event === "ONCRMDEALADD") {
        const existing = await query(
          `SELECT id FROM incoming_orders WHERE external_id = $1
           UNION
           SELECT id FROM orders WHERE external_id = $1
           LIMIT 1`,
          [external_id]
        );
        if (existing.rows.length > 0) {
          return res.json({ success: true, message: "Дубль, пропущен" });
        }

        await query(
          `INSERT INTO incoming_orders 
             (external_id, address, contact_name, phone, volume, note, delivery_date, status, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'bitrix')`,
          [
            external_id,
            address || "",
            parsed.contact_name,
            parsed.phone,
            Number(parsed.volume) || 0,
            parsed.note,
            parsed.delivery_date,
          ]
        );

        return res.json({ success: true, message: "Новый заказ принят" });
      }

      // === ONCRMDEALUPDATE: изменение ===
      if (event === "ONCRMDEALUPDATE") {
        const cancelStages = await getCancelStages();
        const isCancelled = stage && cancelStages.includes(stage);

        const orderResult = await query(
          "SELECT id, trip_id, address, contact_name, phone, volume, delivery_date, delivery_status FROM orders WHERE external_id = $1 LIMIT 1",
          [external_id]
        );
        const incomingResult = await query(
          "SELECT id, address, contact_name, phone, volume, delivery_date FROM incoming_orders WHERE external_id = $1 LIMIT 1",
          [external_id]
        );

        const order = orderResult.rows[0] || null;
        const incoming = incomingResult.rows[0] || null;

        if (!order && !incoming) {
          return res.json({ success: true, message: "Заказ не найден, пропущен" });
        }

        // === Отмена ===
        if (isCancelled) {
          const dedupKey = external_id + "|cancelled|" + stage;
          const dup = await query(
            `SELECT id FROM incoming_changes 
             WHERE dedup_key = $1 AND status = 'pending' LIMIT 1`,
            [dedupKey]
          );
          if (dup.rows.length > 0) {
            return res.json({ success: true, message: "Дубль отмены, пропущен" });
          }

          if (incoming) {
            await query(
              `UPDATE incoming_orders 
               SET status = 'rejected', processed_at = NOW() 
               WHERE id = $1`,
              [incoming.id]
            );
            return res.json({ success: true, message: "Заказ отменён в пуле" });
          }

          if (order) {
            await query(
              `INSERT INTO incoming_changes 
                 (external_id, change_type, field_name, old_value, new_value,
                  trip_id, order_id, incoming_id, status, dedup_key)
               VALUES ($1, 'cancelled', NULL, NULL, NULL, $2, $3, NULL, 'pending', $4)`,
              [external_id, order.trip_id, order.id, dedupKey]
            );
            return res.json({ success: true, message: "Задача отмены создана" });
          }
        }

        // === Обычное изменение ===
        const fieldMap = {
          address: order ? order.address : incoming.address,
          contact_name: order ? order.contact_name : incoming.contact_name,
          phone: order ? order.phone : incoming.phone,
          volume: order ? order.volume : incoming.volume,
          delivery_date: order
            ? (order.delivery_date ? String(order.delivery_date).slice(0, 10) : null)
            : (incoming.delivery_date ? String(incoming.delivery_date).slice(0, 10) : null),
        };

        const newValues = {
          address: parsed.address,
          contact_name: parsed.contact_name,
          phone: parsed.phone,
          volume: parsed.volume ? String(Number(parsed.volume)) : null,
          delivery_date: parsed.delivery_date,
        };

        const changes = [];

        for (const [field, oldVal] of Object.entries(fieldMap)) {
          const newVal = newValues[field];
          if (newVal === null || newVal === undefined) continue;
          const oldStr = String(oldVal || "").trim();
          const newStr = String(newVal || "").trim();
          if (oldStr !== newStr) {
            changes.push({ field, old_value: oldStr, new_value: newStr });
          }
        }

        if (changes.length === 0) {
          return res.json({ success: true, message: "Изменений нет" });
        }

        // Если в пуле — обновляем сразу
        if (incoming) {
          for (const ch of changes) {
            if (ch.field === "volume") {
              await query(
                `UPDATE incoming_orders SET volume = $1 WHERE id = $2`,
                [Number(ch.new_value) || 0, incoming.id]
              );
            } else if (ch.field === "delivery_date") {
              await query(
                `UPDATE incoming_orders SET delivery_date = $1 WHERE id = $2`,
                [ch.new_value, incoming.id]
              );
            } else {
              await query(
                `UPDATE incoming_orders SET ${ch.field} = $1 WHERE id = $2`,
                [ch.new_value, incoming.id]
              );
            }
          }
          return res.json({ success: true, message: "Входящий обновлён" });
        }

        // Если в рейсе — создаём задачи
        for (const ch of changes) {
          const dedupKey = external_id + "|updated|" + ch.field + "|" + ch.new_value;
          const dup = await query(
            `SELECT id FROM incoming_changes 
             WHERE dedup_key = $1 AND status = 'pending' LIMIT 1`,
            [dedupKey]
          );
          if (dup.rows.length > 0) continue;

          await query(
            `INSERT INTO incoming_changes 
               (external_id, change_type, field_name, old_value, new_value,
                trip_id, order_id, incoming_id, status, dedup_key)
             VALUES ($1, 'updated', $2, $3, $4, $5, $6, NULL, 'pending', $7)`,
            [
              external_id,
              ch.field,
              ch.old_value,
              ch.new_value,
              order.trip_id,
              order.id,
              dedupKey,
            ]
          );
        }

        return res.json({
          success: true,
          message: "Создано задач: " + changes.length,
        });
      }

      // === ONCRMDEALDELETE ===
      if (event === "ONCRMDEALDELETE") {
        const dedupKey = external_id + "|deleted";
        const dup = await query(
          `SELECT id FROM incoming_changes 
           WHERE dedup_key = $1 AND status = 'pending' LIMIT 1`,
          [dedupKey]
        );
        if (dup.rows.length > 0) {
          return res.json({ success: true, message: "Дубль удаления, пропущен" });
        }

        const orderResult = await query(
          "SELECT id, trip_id FROM orders WHERE external_id = $1 LIMIT 1",
          [external_id]
        );
        const incomingResult = await query(
          "SELECT id FROM incoming_orders WHERE external_id = $1 LIMIT 1",
          [external_id]
        );

        if (incomingResult.rows.length > 0) {
          await query("DELETE FROM incoming_orders WHERE id = $1", [
            incomingResult.rows[0].id,
          ]);
          return res.json({ success: true, message: "Входящий удалён" });
        }

        if (orderResult.rows.length > 0) {
          const order = orderResult.rows[0];
          await query(
            `INSERT INTO incoming_changes 
               (external_id, change_type, field_name, old_value, new_value,
                trip_id, order_id, incoming_id, status, dedup_key)
             VALUES ($1, 'deleted', NULL, NULL, NULL, $2, $3, NULL, 'pending', $4)`,
            [external_id, order.trip_id, order.id, dedupKey]
          );
          return res.json({ success: true, message: "Задача удаления создана" });
        }

        return res.json({ success: true, message: "Заказ не найден" });
      }

      return res.json({ success: true, message: "Событие " + event + " не обработано" });

    } catch (e) {
      console.error("webhook error:", e);
      await query(
        `INSERT INTO bitrix_log (direction, payload, status, error_message)
         VALUES ('in', $1, 'failed', $2)`,
        [JSON.stringify(req.body || {}), e.message]
      ).catch(() => {});
      return res.json({ success: false, message: e.message });
    }
  }

  // ============ TEST-WEBHOOK ============
  if (action === "test-webhook") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { payload } = req.body || {};
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Не передан payload" });
    }

    try {
      const mapping = await getFieldMapping();
      if (!mapping) {
        return res.json({
          success: false,
          error: "Маппинг полей не настроен. Заполните его в разделе «Интеграции».",
        });
      }

      const parsed = parseBitrixPayload(payload, mapping);
      const cancelStages = await getCancelStages();
      const isCancelled = parsed.stage && cancelStages.includes(parsed.stage);

      const recognized = {};
      for (const key of ["external_id", "address", "contact_name", "phone", "volume", "delivery_date", "note", "title", "stage"]) {
        if (parsed[key] !== null && parsed[key] !== undefined && parsed[key] !== "") {
          recognized[key] = parsed[key];
        }
      }

      return res.json({
        success: true,
        event: parsed.event,
        recognized,
        is_cancelled: isCancelled,
        raw_fields: parsed.raw_fields,
      });
    } catch (e) {
      console.error("test-webhook error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ TASKS-COUNT ============
  if (action === "tasks-count") {
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method not allowed" });

    try {
      const pendingOrders = await query(
        "SELECT COUNT(*)::int AS cnt FROM incoming_orders WHERE status = 'pending'"
      );
      const changes = await query(
        "SELECT COUNT(*)::int AS cnt FROM incoming_changes WHERE status = 'pending'"
      );

      const newOrders = pendingOrders.rows[0].cnt || 0;
      const changesCount = changes.rows[0].cnt || 0;

      return res.json({
        new_orders: newOrders,
        changes: changesCount,
        total: newOrders + changesCount,
      });
    } catch (e) {
      console.error("tasks-count error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ TASKS-LIST ============
  if (action === "tasks-list") {
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method not allowed" });

    try {
      const newOrders = await query(
        `SELECT id, external_id, address, contact_name, phone, volume, note, delivery_date, source, created_at
         FROM incoming_orders
         WHERE status = 'pending'
         ORDER BY delivery_date ASC NULLS LAST, created_at DESC
         LIMIT 200`
      );

      const changes = await query(
        `SELECT 
           ic.id, ic.external_id, ic.change_type, ic.field_name,
           ic.old_value, ic.new_value, ic.status,
           ic.created_at,
           ic.trip_id, ic.order_id, ic.incoming_id,
           t.trip_number,
           t.trip_date,
           o.address AS order_address,
           o.contact_name AS order_contact,
           o.phone AS order_phone,
           o.volume AS order_volume,
           o.delivery_date AS order_delivery_date
         FROM incoming_changes ic
         LEFT JOIN trips t ON t.id = ic.trip_id
         LEFT JOIN orders o ON o.id = ic.order_id
         WHERE ic.status = 'pending'
         ORDER BY 
           CASE ic.change_type 
             WHEN 'cancelled' THEN 1
             WHEN 'deleted' THEN 2
             WHEN 'updated' THEN 3
             ELSE 4
           END,
           CASE WHEN ic.field_name IN ('address', 'volume', 'delivery_date') THEN 1 ELSE 2 END,
           ic.created_at DESC
         LIMIT 200`
      );

      return res.json({
        new_orders: newOrders.rows,
        changes: changes.rows,
      });
    } catch (e) {
      console.error("tasks-list error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ CHANGE-APPLY ============
  if (action === "change-apply") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    try {
      const changeResult = await query(
        "SELECT * FROM incoming_changes WHERE id = $1",
        [id]
      );
      if (changeResult.rows.length === 0) {
        return res.status(404).json({ error: "Изменение не найдено" });
      }
      const change = changeResult.rows[0];

      if (change.status !== "pending") {
        return res.status(400).json({ error: "Изменение уже обработано" });
      }

      if (change.change_type === "cancelled") {
        if (change.order_id) {
          await query(
            `UPDATE orders 
             SET delivery_status = 'cancelled', delivery_note = 'Отменён в Битриксе', 
                 updated_at = NOW()
             WHERE id = $1`,
            [change.order_id]
          );
          await logChange(req.user.id, "orders", change.order_id,
            "delivery_status", "", "cancelled (Битрикс)", ip);
        }
      }

      if (change.change_type === "deleted") {
        if (change.order_id) {
          await query("DELETE FROM orders WHERE id = $1", [change.order_id]);
          await logChange(req.user.id, "orders", change.order_id,
            "Удаление", change.old_value || "", "удалён в Битриксе", ip);

          if (change.trip_id) {
            const orders = await query(
              "SELECT id FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC NULLS LAST, id ASC",
              [change.trip_id]
            );
            for (let i = 0; i < orders.rows.length; i++) {
              await query("UPDATE orders SET sequence_num = $1 WHERE id = $2", [
                i + 1,
                orders.rows[i].id,
              ]);
            }
          }
        }
      }

      if (change.change_type === "updated") {
        if (change.order_id && change.field_name) {
          const allowedFields = ["address", "contact_name", "phone", "volume", "note", "delivery_date"];
          if (allowedFields.includes(change.field_name)) {
            let val;
            if (change.field_name === "volume") {
              val = Number(change.new_value) || 0;
            } else if (change.field_name === "delivery_date") {
              val = change.new_value || null;
            } else {
              val = change.new_value;
            }

            await query(
              `UPDATE orders SET ${change.field_name} = $1, updated_at = NOW() WHERE id = $2`,
              [val, change.order_id]
            );
            await logChange(req.user.id, "orders", change.order_id,
              change.field_name, change.old_value, change.new_value, ip);
          }
        }
      }

      await query(
        `UPDATE incoming_changes 
         SET status = 'applied', processed_at = NOW(), processed_by = $1 
         WHERE id = $2`,
        [req.user.id, id]
      );

      return res.json({ success: true, message: "Изменение применено" });
    } catch (e) {
      console.error("change-apply error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ CHANGE-IGNORE ============
  if (action === "change-ignore") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    try {
      const changeResult = await query(
        "SELECT * FROM incoming_changes WHERE id = $1",
        [id]
      );
      if (changeResult.rows.length === 0) {
        return res.status(404).json({ error: "Изменение не найдено" });
      }

      await query(
        `UPDATE incoming_changes 
         SET status = 'ignored', processed_at = NOW(), processed_by = $1 
         WHERE id = $2`,
        [req.user.id, id]
      );

      await logChange(req.user.id, "incoming_changes", id,
        "Отклонено логистом", changeResult.rows[0].change_type, "", ip);

      return res.json({ success: true, message: "Изменение отклонено" });
    } catch (e) {
      console.error("change-ignore error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ BULK-CHANGES ============
  if (action === "bulk-changes") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { ids, operation } = req.body || {};
    const parsedIds = parseIds(ids);

    if (!parsedIds) {
      return res.status(400).json({
        error: "Передайте массив ids (1–" + BULK_LIMIT + " элементов)",
      });
    }
    if (!["apply", "ignore"].includes(operation)) {
      return res.status(400).json({ error: "operation: apply | ignore" });
    }

    try {
      const newStatus = operation === "apply" ? "applied" : "ignored";
      let processedCount = 0;

      for (const changeId of parsedIds) {
        try {
          if (operation === "apply") {
            const changeResult = await query(
              "SELECT * FROM incoming_changes WHERE id = $1 AND status = 'pending'",
              [changeId]
            );
            if (changeResult.rows.length === 0) continue;
            const change = changeResult.rows[0];

            if (change.change_type === "cancelled" && change.order_id) {
              await query(
                `UPDATE orders SET delivery_status = 'cancelled', 
                 delivery_note = 'Отменён в Битриксе', updated_at = NOW()
                 WHERE id = $1`,
                [change.order_id]
              );
            }
            if (change.change_type === "deleted" && change.order_id) {
              await query("DELETE FROM orders WHERE id = $1", [change.order_id]);
            }
            if (change.change_type === "updated" && change.order_id && change.field_name) {
              const allowedFields = ["address", "contact_name", "phone", "volume", "note", "delivery_date"];
              if (allowedFields.includes(change.field_name)) {
                let val;
                if (change.field_name === "volume") {
                  val = Number(change.new_value) || 0;
                } else if (change.field_name === "delivery_date") {
                  val = change.new_value || null;
                } else {
                  val = change.new_value;
                }
                await query(
                  `UPDATE orders SET ${change.field_name} = $1, updated_at = NOW() WHERE id = $2`,
                  [val, change.order_id]
                );
              }
            }
          }

          await query(
            `UPDATE incoming_changes 
             SET status = $1, processed_at = NOW(), processed_by = $2 
             WHERE id = $3`,
            [newStatus, req.user.id, changeId]
          );
          processedCount++;
        } catch (e) {
          console.error("bulk-changes item error:", changeId, e);
        }
      }

      await logChange(req.user.id, "incoming_changes",
        parsedIds.join(","), "Массовая обработка",
        parsedIds.length + " задач", operation, ip);

      return res.json({
        success: true,
        processed_count: processedCount,
        message: (operation === "apply" ? "Применено" : "Отклонено") + ": " + processedCount,
      });
    } catch (e) {
      console.error("bulk-changes error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ INDEX ============
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

      sql += ` ORDER BY delivery_date ASC NULLS LAST, created_at DESC LIMIT 500`;

      const result = await query(sql, params);

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
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ CREATE ============
  if (action === "create") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { external_id, address, contact_name, phone, volume, note, delivery_date } = req.body || {};

    if (!address || !address.trim()) {
      return res.status(400).json({ error: "Адрес обязателен" });
    }

    try {
      const result = await query(
        `INSERT INTO incoming_orders 
           (external_id, address, contact_name, phone, volume, note, delivery_date, status, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'manual')
         RETURNING *`,
        [
          external_id || null,
          address.trim(),
          contact_name || null,
          phone || null,
          Number(volume) || 0,
          note || null,
          delivery_date || null,
        ]
      );

      await logChange(req.user.id, "incoming_orders", result.rows[0].id,
        "Создание", "", address.trim(), ip);

      return res.json({ success: true, incoming: result.rows[0] });
    } catch (e) {
      console.error("POST incoming create error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ ASSIGN (один) ============
  if (action === "assign") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    const { trip_id } = req.body || {};
    if (!trip_id) return res.status(400).json({ error: "Не указан trip_id" });

    try {
      const incomingResult = await query(
        "SELECT * FROM incoming_orders WHERE id = $1",
        [id]
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
        [trip_id]
      );
      if (tripCheck.rows.length === 0) {
        return res.status(404).json({ error: "Рейс не найден" });
      }

      const maxSeq = await query(
        "SELECT COALESCE(MAX(sequence_num), 0) AS max FROM orders WHERE trip_id = $1",
        [trip_id]
      );
      const nextSeq = maxSeq.rows[0].max + 1;

      const orderResult = await query(
        `INSERT INTO orders 
           (trip_id, external_id, address, contact_name, phone, volume, sequence_num, note, delivery_date, source, delivery_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')
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
          item.delivery_date,
          item.source,
        ]
      );

      await query(
        `UPDATE incoming_orders 
         SET status = 'assigned', processed_at = NOW() 
         WHERE id = $1`,
        [id]
      );

      await logChange(req.user.id, "incoming_orders", id,
        "Назначен", item.status, "assigned → рейс " + tripCheck.rows[0].trip_number, ip);

      return res.json({ success: true, order: orderResult.rows[0] });
    } catch (e) {
      console.error("POST incoming assign error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ REJECT (один) ============
  if (action === "reject") {
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    try {
      const current = await query(
        "SELECT * FROM incoming_orders WHERE id = $1",
        [id]
      );
      if (current.rows.length === 0) {
        return res.status(404).json({ error: "Заказ не найден" });
      }

      await query(
        `UPDATE incoming_orders 
         SET status = 'rejected', processed_at = NOW() 
         WHERE id = $1`,
        [id]
      );

      await logChange(req.user.id, "incoming_orders", id,
        "Отклонён", current.rows[0].status, "rejected", ip);

      return res.json({ success: true });
    } catch (e) {
      console.error("POST incoming reject error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ BULK-ASSIGN ============
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
      const tripCheck = await query(
        "SELECT id, trip_number FROM trips WHERE id = $1",
        [trip_id]
      );
      if (tripCheck.rows.length === 0) {
        return res.status(404).json({ error: "Рейс не найден" });
      }

      const itemsResult = await query(
        `SELECT * FROM incoming_orders 
         WHERE id = ANY($1) AND status = 'pending'`,
        [parsedIds]
      );

      if (itemsResult.rows.length === 0) {
        return res.status(400).json({
          error: "Нет подходящих заказов (все назначены или отклонены)",
        });
      }

      const items = itemsResult.rows;
      const skipped = parsedIds.length - items.length;

      const maxSeq = await query(
        "SELECT COALESCE(MAX(sequence_num), 0) AS max FROM orders WHERE trip_id = $1",
        [trip_id]
      );
      let nextSeq = maxSeq.rows[0].max + 1;

      for (const item of items) {
        await query(
          `INSERT INTO orders 
             (trip_id, external_id, address, contact_name, phone, volume, sequence_num, note, delivery_date, source, delivery_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending')`,
          [
            trip_id, item.external_id, item.address, item.contact_name,
            item.phone, item.volume, nextSeq, item.note, item.delivery_date, item.source,
          ]
        );
        nextSeq++;
      }

      await query(
        `UPDATE incoming_orders 
         SET status = 'assigned', processed_at = NOW() 
         WHERE id = ANY($1)`,
        [items.map((i) => i.id)]
      );

      await logChange(req.user.id, "incoming_orders",
        items.map((i) => i.id).join(","), "Массовое назначение",
        items.length + " заказов", "Рейс " + tripCheck.rows[0].trip_number, ip);

      return res.json({
        success: true,
        assigned_count: items.length,
        skipped_count: skipped,
        trip_number: tripCheck.rows[0].trip_number,
        message: "Назначено " + items.length + " заказов в рейс " + tripCheck.rows[0].trip_number +
          (skipped > 0 ? ". Пропущено: " + skipped : ""),
      });
    } catch (e) {
      console.error("POST incoming bulk-assign error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ BULK-REJECT ============
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
        [parsedIds]
      );

      const rejectedCount = result.rows.length;

      if (rejectedCount > 0) {
        await logChange(req.user.id, "incoming_orders",
          result.rows.map((r) => r.id).join(","), "Массовое отклонение",
          rejectedCount + " заказов", "rejected", ip);
      }

      return res.json({
        success: true,
        rejected_count: rejectedCount,
        message: "Отклонено " + rejectedCount + " заказов",
      });
    } catch (e) {
      console.error("POST incoming bulk-reject error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ BULK-DELETE ============
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
         RETURNING id`,
        [parsedIds]
      );

      const deletedCount = result.rows.length;

      if (deletedCount > 0) {
        await logChange(req.user.id, "incoming_orders",
          result.rows.map((r) => r.id).join(","), "Массовое удаление",
          deletedCount + " заказов", "", ip);
      }

      return res.json({
        success: true,
        deleted_count: deletedCount,
        message: "Удалено " + deletedCount + " заказов",
      });
    } catch (e) {
      console.error("POST incoming bulk-delete error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ UPDATE ============
  if (action === "update") {
    if (req.method !== "PUT")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    const { external_id, address, contact_name, phone, volume, note, delivery_date } = req.body || {};

    try {
      const current = await query(
        "SELECT * FROM incoming_orders WHERE id = $1",
        [id]
      );
      if (current.rows.length === 0) {
        return res.status(404).json({ error: "Заказ не найден" });
      }

      await query(
        `UPDATE incoming_orders 
         SET external_id = $1, address = $2, contact_name = $3, 
             phone = $4, volume = $5, note = $6, delivery_date = $7
         WHERE id = $8`,
        [
          external_id || current.rows[0].external_id,
          address || current.rows[0].address,
          contact_name || current.rows[0].contact_name,
          phone || current.rows[0].phone,
          volume !== undefined ? volume : current.rows[0].volume,
          note !== undefined ? note : current.rows[0].note,
          delivery_date !== undefined ? delivery_date : current.rows[0].delivery_date,
          id,
        ]
      );

      return res.json({ success: true });
    } catch (e) {
      console.error("PUT incoming error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  // ============ DELETE ============
  if (action === "delete") {
    if (req.method !== "DELETE")
      return res.status(405).json({ error: "Method not allowed" });
    if (!id) return res.status(400).json({ error: "ID не указан" });

    try {
      const current = await query(
        "SELECT * FROM incoming_orders WHERE id = $1",
        [id]
      );
      if (current.rows.length === 0) {
        return res.status(404).json({ error: "Заказ не найден" });
      }

      await query("DELETE FROM incoming_orders WHERE id = $1", [id]);
      await logChange(req.user.id, "incoming_orders", id,
        "Удаление", current.rows[0].address, "", ip);

      return res.json({ success: true });
    } catch (e) {
      console.error("DELETE incoming error:", e);
      return res.status(500).json({ error: "Ошибка сервера", details: e.message });
    }
  }

  return res.status(400).json({ error: "Unknown action: " + action });
}

module.exports = requireAuth(handler);
