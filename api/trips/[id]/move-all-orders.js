const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');

async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const tripId = req.query.id;
    const { to_trip_id, reason } = req.body;

    if (!tripId || !to_trip_id) {
        return res.status(400).json({ error: 'Не указан исходный или целевой рейс' });
    }

    if (tripId === String(to_trip_id)) {
        return res.status(400).json({ error: 'Исходный и целевой рейс совпадают' });
    }

    try {
        // Проверяем целевой рейс
        const targetTrip = await query(
            'SELECT id, trip_number, status FROM trips WHERE id = $1',
            [to_trip_id]
        );
        if (targetTrip.rows.length === 0) {
            return res.status(404).json({ error: 'Целевой рейс не найден' });
        }

        // Получаем все заказы исходного рейса
        const orders = await query(
            'SELECT id FROM orders WHERE trip_id = $1 ORDER BY sequence_num ASC NULLS LAST, id ASC',
            [tripId]
        );

        if (orders.rows.length === 0) {
            return res.status(400).json({ error: 'В рейсе нет заказов для переноса' });
        }

        // Определяем начальную позицию в целевом рейсе
        const maxSeqResult = await query(
            'SELECT COALESCE(MAX(sequence_num), 0) as max FROM orders WHERE trip_id = $1',
            [to_trip_id]
        );
        let nextSeq = maxSeqResult.rows[0].max + 1;

        // Переносим все заказы
        for (const order of orders.rows) {
            await query(
                `UPDATE orders 
                 SET trip_id = $1, sequence_num = $2, updated_at = NOW()
                 WHERE id = $3`,
                [to_trip_id, nextSeq, order.id]
            );

            await query(
                `INSERT INTO order_history (order_id, from_trip_id, to_trip_id, reason, moved_by)
                 VALUES ($1, $2, $3, $4, $5)`,
                [order.id, tripId, to_trip_id, reason || 'Перенос всех заказов', req.user.id]
            );

            nextSeq++;
        }

        await logChange(
            req.user.id, 'trips', tripId,
            'Перенос всех заказов', 'Рейс ' + tripId, 'Рейс ' + to_trip_id, ip
        );

        // Перенумерация исходного рейса (будет пустой после этого)
        await query(
            'UPDATE orders SET sequence_num = NULL WHERE trip_id = $1',
            [tripId]
        );

        res.json({
            success: true,
            moved_count: orders.rows.length,
            message: 'Перенесено ' + orders.rows.length + ' заказов в рейс ' + targetTrip.rows[0].trip_number
        });

    } catch (e) {
        console.error('POST /api/trips/[id]/move-all-orders error:', e);
        res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
}

module.exports = requireAuth(handler);
