const { query } = require('../../_lib/db');
const { requireAuth } = require('../../_lib/auth');
const { logChange } = require('../../_lib/journal');

async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const orderId = req.query.id;
    const { to_trip_id, reason, position } = req.body;

    if (!orderId) {
        return res.status(400).json({ error: 'ID заказа не указан' });
    }

    if (!to_trip_id) {
        return res.status(400).json({ error: 'Не указан целевой рейс' });
    }

    try {
        // Получаем заказ
        const orderResult = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
        if (orderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Заказ не найден' });
        }

        const order = orderResult.rows[0];
        const fromTripId = order.trip_id;

        if (fromTripId === parseInt(to_trip_id)) {
            return res.status(400).json({ error: 'Заказ уже в этом рейсе' });
        }

        // Проверяем существование целевого рейса
        const targetTrip = await query(
            'SELECT id, trip_number, status FROM trips WHERE id = $1',
            [to_trip_id]
        );
        if (targetTrip.rows.length === 0) {
            return res.status(404).json({ error: 'Целевой рейс не найден' });
        }

        // Определяем позицию
        let newSequence = position;
        if (!newSequence) {
            const maxSeq = await query(
                'SELECT COALESCE(MAX(sequence_num), 0) as max FROM orders WHERE trip_id = $1',
                [to_trip_id]
            );
            newSequence = maxSeq.rows[0].max + 1;
        }

        // Обновляем заказ
        await query(
            `UPDATE orders 
             SET trip_id = $1, sequence_num = $2, updated_at = NOW() 
             WHERE id = $3`,
            [to_trip_id, newSequence, orderId]
        );

        // Записываем в историю
        await query(
            `INSERT INTO order_history (order_id, from_trip_id, to_trip_id, reason, moved_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [orderId, fromTripId, to_trip_id, reason || null, req.user.id]
        );

        // Логируем
        await logChange(
            req.user.id, 'orders', orderId,
            'Перенос', 'Рейс ' + (fromTripId || 'нет'), 'Рейс ' + to_trip_id, ip
        );

        // Пересчитываем очерёдность в исходном и целевом рейсах
        if (fromTripId) await renumberOrders(fromTripId);
        await renumberOrders(to_trip_id);

        res.json({
            success: true,
            message: 'Заказ перенесён в рейс ' + targetTrip.rows[0].trip_number
        });

    } catch (e) {
        console.error('POST /api/orders/[id]/move error:', e);
        res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
}

// Перенумерация заказов рейса
async function renumberOrders(tripId) {
    const orders = await query(
        'SELECT id FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC NULLS LAST, id ASC',
        [tripId]
    );

    for (let i = 0; i < orders.rows.length; i++) {
        await query(
            'UPDATE orders SET sequence_num = $1 WHERE id = $2',
            [i + 1, orders.rows[i].id]
        );
    }
}

module.exports = requireAuth(handler);
