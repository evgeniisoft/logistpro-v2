const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const orderId = req.query.id;

    if (!orderId) {
        return res.status(400).json({ error: 'ID заказа не указан' });
    }

    // ============ GET: один заказ ============
    if (req.method === 'GET') {
        try {
            const result = await query(
                `SELECT o.*, t.trip_number 
                 FROM orders o
                 LEFT JOIN trips t ON t.id = o.trip_id
                 WHERE o.id = $1`,
                [orderId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Заказ не найден' });
            }

            res.json({ order: result.rows[0] });

        } catch (e) {
            console.error('GET /api/orders/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
        return;
    }

    // ============ PUT: обновить заказ ============
    if (req.method === 'PUT') {
        const fields = req.body;
        const allowedFields = [
            'address', 'contact_name', 'phone', 'volume', 'note',
            'sequence_num', 'status'
        ];

        try {
            const current = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
            if (current.rows.length === 0) {
                return res.status(404).json({ error: 'Заказ не найден' });
            }

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
                            req.user.id, 'orders', orderId,
                            field, order[field], fields[field], ip
                        );
                    }
                }
            }

            if (updates.length === 0) {
                return res.json({ success: true, message: 'Нет изменений' });
            }

            updates.push(`updated_at = NOW()`);

            // Если изменился объём — пересчитываем load_volume рейса
            if (fields.volume !== undefined && order.trip_id) {
                params.push(orderId);
                const sql = `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
                const result = await query(sql, params);

                // Пересчёт объёма рейса
                await recalcTripVolume(order.trip_id);

                return res.json({ success: true, order: result.rows[0] });
            }

            params.push(orderId);
            const sql = `UPDATE orders SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            res.json({ success: true, order: result.rows[0] });

        } catch (e) {
            console.error('PUT /api/orders/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    // ============ DELETE: удалить заказ ============
    if (req.method === 'DELETE') {
        try {
            const current = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
            if (current.rows.length === 0) {
                return res.status(404).json({ error: 'Заказ не найден' });
            }

            const order = current.rows[0];
            const tripId = order.trip_id;

            await query('DELETE FROM orders WHERE id = $1', [orderId]);
            await logChange(
                req.user.id, 'orders', orderId,
                'Удаление', order.address, '', ip
            );

            // Пересчёт объёма рейса
            if (tripId) {
                await recalcTripVolume(tripId);
            }

            res.json({ success: true });

        } catch (e) {
            console.error('DELETE /api/orders/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера' });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}

// Пересчёт load_volume рейса
async function recalcTripVolume(tripId) {
    const result = await query(
        'SELECT COALESCE(SUM(volume), 0) as total FROM orders WHERE trip_id = $1',
        [tripId]
    );
    const total = result.rows[0].total;
    await query(
        'UPDATE trips SET updated_at = NOW() WHERE id = $1',
        [tripId]
    );
    return total;
}

module.exports = requireAuth(handler);
