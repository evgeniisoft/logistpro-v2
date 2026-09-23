const { query } = require('./_lib/db');
const { requireAuth, verifyToken } = require('./_lib/auth');
const { logChange } = require('./_lib/journal');

// ============ ПУБЛИЧНЫЙ WEBHOOK (без авторизации) ============
async function handleWebhook(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        // Проверяем секретный ключ
        const secretFromHeader = req.headers['x-bitrix-secret'] || req.query.secret;
        
        const settings = await query(
            "SELECT value FROM settings WHERE key = 'bitrix_secret_key'"
        );
        const expectedSecret = settings.rows[0]?.value;

        if (!expectedSecret || secretFromHeader !== expectedSecret) {
            console.warn('Webhook: invalid secret from', ip);
            return res.status(403).json({ error: 'Forbidden' });
        }

        const payload = req.body;
        
        // Логируем входящий webhook
        await query(
            `INSERT INTO bitrix_log (direction, external_id, payload, status)
             VALUES ('in', $1, $2, 'received')`,
            [payload.deal_id || payload.id || null, JSON.stringify(payload)]
        );

        // Извлекаем данные из payload
        // Формат зависит от настроек Битрикс24
        const externalId = String(payload.deal_id || payload.id || '').trim();
        if (!externalId) {
            return res.status(400).json({ error: 'Не указан ID сделки' });
        }

        // Проверяем, что такой заказ ещё не пришёл
        const existing = await query(
            'SELECT id, status FROM incoming_orders WHERE external_id = $1',
            [externalId]
        );

        if (existing.rows.length > 0) {
            // Обновляем существующий
            await query(
                `UPDATE incoming_orders 
                 SET address = COALESCE($1, address),
                     contact_name = COALESCE($2, contact_name),
                     phone = COALESCE($3, phone),
                     volume = COALESCE($4, volume),
                     note = COALESCE($5, note),
                     raw_data = $6
                 WHERE external_id = $7`,
                [
                    payload.address || null,
                    payload.contact_name || null,
                    payload.phone || null,
                    payload.volume || null,
                    payload.note || null,
                    JSON.stringify(payload),
                    externalId
                ]
            );

            await query(
                `UPDATE bitrix_log SET status = 'updated'
                 WHERE external_id = $1 AND direction = 'in'
                 ORDER BY created_at DESC LIMIT 1`,
                [externalId]
            );

            return res.json({ success: true, action: 'updated', external_id: externalId });
        }

        // Создаём новый входящий заказ
        const result = await query(
            `INSERT INTO incoming_orders 
                (external_id, address, contact_name, phone, volume, note, raw_data, status, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 'bitrix')
             RETURNING id`,
            [
                externalId,
                payload.address || null,
                payload.contact_name || null,
                payload.phone || null,
                payload.volume || null,
                payload.note || null,
                JSON.stringify(payload)
            ]
        );

        await query(
            `UPDATE bitrix_log SET status = 'processed'
             WHERE id = (SELECT id FROM bitrix_log WHERE external_id = $1 AND direction = 'in' ORDER BY created_at DESC LIMIT 1)`,
            [externalId]
        );

        return res.json({ success: true, action: 'created', id: result.rows[0].id });

    } catch (e) {
        console.error('Webhook error:', e);
        return res.status(500).json({ error: 'Ошибка обработки', details: e.message });
    }
}

// ============ ОСНОВНОЙ ОБРАБОТЧИК ============
async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const action = req.query.action || 'index';
    const id = req.query.id;

    // ============ INDEX: список входящих ============
    if (action === 'index') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

        try {
            const { status = 'pending', source, limit } = req.query;

            let sql = 'SELECT * FROM incoming_orders WHERE 1=1';
            const params = [];
            let paramIndex = 1;

            if (status && status !== 'all') {
                sql += ` AND status = $${paramIndex++}`;
                params.push(status);
            }

            if (source) {
                sql += ` AND source = $${paramIndex++}`;
                params.push(source);
            }

            sql += ' ORDER BY created_at DESC';

            const limitNum = parseInt(limit) || 200;
            sql += ` LIMIT $${paramIndex++}`;
            params.push(limitNum);

            const result = await query(sql, params);

            // Считаем статистику
            const stats = await query(
                `SELECT 
                    COUNT(*) FILTER (WHERE status = 'pending') AS pending,
                    COUNT(*) FILTER (WHERE status = 'assigned') AS assigned,
                    COUNT(*) FILTER (WHERE status = 'rejected') AS rejected
                 FROM incoming_orders`
            );

            return res.json({
                incoming: result.rows,
                stats: stats.rows[0]
            });

        } catch (e) {
            console.error('GET incoming error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ CREATE: создать вручную ============
    if (action === 'create') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const { external_id, address, contact_name, phone, volume, note } = req.body;

        if (!address || !address.trim()) {
            return res.status(400).json({ error: 'Адрес обязателен' });
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
                    volume || 0,
                    note || null
                ]
            );

            await logChange(req.user.id, 'incoming_orders', result.rows[0].id, 'Создание',
                '', address.trim(), ip);

            return res.status(201).json({ success: true, incoming: result.rows[0] });

        } catch (e) {
            console.error('POST incoming error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ UPDATE ============
    if (action === 'update') {
        if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID не указан' });

        const fields = req.body;
        const allowedFields = ['external_id', 'address', 'contact_name', 'phone', 'volume', 'note', 'status'];

        try {
            const current = await query('SELECT * FROM incoming_orders WHERE id = $1', [id]);
            if (current.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });

            const order = current.rows[0];
            const updates = [];
            const params = [];
            let paramIndex = 1;

            for (const field of allowedFields) {
                if (fields[field] !== undefined) {
                    updates.push(`${field} = $${paramIndex++}`);
                    params.push(fields[field]);
                    if (String(order[field]) !== String(fields[field])) {
                        await logChange(req.user.id, 'incoming_orders', id, field, order[field], fields[field], ip);
                    }
                }
            }

            if (updates.length === 0) return res.json({ success: true, message: 'Нет изменений' });

            params.push(id);
            const sql = `UPDATE incoming_orders SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            return res.json({ success: true, incoming: result.rows[0] });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ DELETE ============
    if (action === 'delete') {
        if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID не указан' });

        try {
            const current = await query('SELECT * FROM incoming_orders WHERE id = $1', [id]);
            if (current.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });

            await query('DELETE FROM incoming_orders WHERE id = $1', [id]);
            await logChange(req.user.id, 'incoming_orders', id, 'Удаление',
                current.rows[0].address, '', ip);

            return res.json({ success: true });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ ASSIGN: назначить на рейс ============
    if (action === 'assign') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID не указан' });

        const { trip_id } = req.body;
        if (!trip_id) return res.status(400).json({ error: 'Не указан trip_id' });

        try {
            const incoming = await query('SELECT * FROM incoming_orders WHERE id = $1', [id]);
            if (incoming.rows.length === 0) return res.status(404).json({ error: 'Входящий заказ не найден' });
            if (incoming.rows[0].status !== 'pending') {
                return res.status(400).json({ error: 'Заказ уже обработан' });
            }

            const tripCheck = await query('SELECT id, trip_number FROM trips WHERE id = $1', [trip_id]);
            if (tripCheck.rows.length === 0) return res.status(404).json({ error: 'Рейс не найден' });

            // Определяем sequence_num
            const maxSeq = await query(
                'SELECT COALESCE(MAX(sequence_num), 0) as max FROM orders WHERE trip_id = $1',
                [trip_id]
            );
            const nextSeq = maxSeq.rows[0].max + 1;

            const order = incoming.rows[0];

            // Создаём order в рейсе
            const result = await query(
                `INSERT INTO orders 
                    (trip_id, external_id, address, contact_name, phone, volume, sequence_num, note, source)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'bitrix')
                 RETURNING *`,
                [
                    trip_id,
                    order.external_id,
                    order.address,
                    order.contact_name,
                    order.phone,
                    order.volume,
                    nextSeq,
                    order.note
                ]
            );

            // Помечаем входящий как назначенный
            await query(
                `UPDATE incoming_orders 
                 SET status = 'assigned', processed_at = NOW()
                 WHERE id = $1`,
                [id]
            );

            await logChange(req.user.id, 'incoming_orders', id, 'Назначен',
                '', 'Рейс ' + tripCheck.rows[0].trip_number, ip);

            return res.json({
                success: true,
                order: result.rows[0],
                message: 'Заказ назначен на рейс ' + tripCheck.rows[0].trip_number
            });

        } catch (e) {
            console.error('Assign error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ REJECT: отклонить ============
    if (action === 'reject') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID не указан' });

        try {
            const current = await query('SELECT * FROM incoming_orders WHERE id = $1', [id]);
            if (current.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });

            await query(
                `UPDATE incoming_orders 
                 SET status = 'rejected', processed_at = NOW()
                 WHERE id = $1`,
                [id]
            );

            await logChange(req.user.id, 'incoming_orders', id, 'Отклонён',
                current.rows[0].address, '', ip);

            return res.json({ success: true });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
}

// ============ ЭКСПОРТ ============
module.exports = async (req, res) => {
    const action = req.query.action || 'index';

    // Webhook — публичный
    if (action === 'webhook') {
        return handleWebhook(req, res);
    }

    // Всё остальное — требует авторизации
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = verifyToken(token);
    if (!user) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.user = user;

    return handler(req, res);
};
