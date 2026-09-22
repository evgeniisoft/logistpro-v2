const { query } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { logChange } = require('./_lib/journal');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const action = req.query.action || 'get';
    const id = req.query.id;

    if (!id) {
        return res.status(400).json({ error: 'ID заказа не указан' });
    }

    // ============ GET ============
    if (action === 'get') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

        try {
            const result = await query(
                `SELECT o.*, t.trip_number 
                 FROM orders o
                 LEFT JOIN trips t ON t.id = o.trip_id
                 WHERE o.id = $1`,
                [id]
            );

            if (result.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });
            return res.json({ order: result.rows[0] });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ UPDATE ============
    if (action === 'update') {
        if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });

        const fields = req.body;
        const allowedFields = ['address', 'contact_name', 'phone', 'volume', 'note', 'sequence_num', 'status'];

        try {
            const current = await query('SELECT * FROM orders WHERE id = $1', [id]);
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
                        await logChange(req.user.id, 'orders', id, field, order[field], fields[field], ip);
                    }
                }
            }

            if (updates.length === 0) return res.json({ success: true, message: 'Нет изменений' });

            updates.push('updated_at = NOW()');
            params.push(id);
            const sql = `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            return res.json({ success: true, order: result.rows[0] });

        } catch (e) {
            console.error('PUT order error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ DELETE ============
    if (action === 'delete') {
        if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });

        try {
            const current = await query('SELECT * FROM orders WHERE id = $1', [id]);
            if (current.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });

            const order = current.rows[0];
            await query('DELETE FROM orders WHERE id = $1', [id]);
            await logChange(req.user.id, 'orders', id, 'Удаление', order.address, '', ip);

            return res.json({ success: true });

        } catch (e) {
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ MOVE ============
    if (action === 'move') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const { to_trip_id, reason, position } = req.body;
        if (!to_trip_id) return res.status(400).json({ error: 'Не указан целевой рейс' });

        try {
            const orderResult = await query('SELECT * FROM orders WHERE id = $1', [id]);
            if (orderResult.rows.length === 0) return res.status(404).json({ error: 'Заказ не найден' });

            const order = orderResult.rows[0];
            const fromTripId = order.trip_id;

            if (fromTripId === parseInt(to_trip_id)) {
                return res.status(400).json({ error: 'Заказ уже в этом рейсе' });
            }

            const targetTrip = await query('SELECT id, trip_number FROM trips WHERE id = $1', [to_trip_id]);
            if (targetTrip.rows.length === 0) return res.status(404).json({ error: 'Целевой рейс не найден' });

            let newSequence = position;
            if (!newSequence) {
                const maxSeq = await query(
                    'SELECT COALESCE(MAX(sequence_num), 0) as max FROM orders WHERE trip_id = $1',
                    [to_trip_id]
                );
                newSequence = maxSeq.rows[0].max + 1;
            }

            await query(
                'UPDATE orders SET trip_id = $1, sequence_num = $2, updated_at = NOW() WHERE id = $3',
                [to_trip_id, newSequence, id]
            );

            await query(
                `INSERT INTO order_history (order_id, from_trip_id, to_trip_id, reason, moved_by)
                 VALUES ($1, $2, $3, $4, $5)`,
                [id, fromTripId, to_trip_id, reason || null, req.user.id]
            );

            await logChange(req.user.id, 'orders', id, 'Перенос',
                'Рейс ' + (fromTripId || 'нет'), 'Рейс ' + to_trip_id, ip);

            // Пересчитываем очерёдность
            if (fromTripId) await renumberOrders(fromTripId);
            await renumberOrders(to_trip_id);

            return res.json({
                success: true,
                message: 'Заказ перенесён в рейс ' + targetTrip.rows[0].trip_number
            });

        } catch (e) {
            console.error('POST order move error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    return res.status(405).json({ error: 'Unknown action: ' + action });
}

async function renumberOrders(tripId) {
    const orders = await query(
        'SELECT id FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC NULLS LAST, id ASC',
        [tripId]
    );
    for (let i = 0; i < orders.rows.length; i++) {
        await query('UPDATE orders SET sequence_num = $1 WHERE id = $2', [i + 1, orders.rows[i].id]);
    }
}

module.exports = requireAuth(handler);
