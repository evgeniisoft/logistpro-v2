const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');

async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const tripId = req.query.id;
    const { reason, orders_action } = req.body;

    if (!tripId) {
        return res.status(400).json({ error: 'ID рейса не указан' });
    }

    if (!reason || !reason.trim()) {
        return res.status(400).json({ error: 'Укажите причину отмены' });
    }

    if (!['return_to_incoming', 'mark_cancelled'].includes(orders_action)) {
        return res.status(400).json({ error: 'Укажите действие с заказами' });
    }

    try {
        const tripResult = await query(
            'SELECT trip_number, status FROM trips WHERE id = $1',
            [tripId]
        );

        if (tripResult.rows.length === 0) {
            return res.status(404).json({ error: 'Рейс не найден' });
        }

        const trip = tripResult.rows[0];

        if (trip.status === 'done') {
            return res.status(400).json({ error: 'Нельзя отменить завершённый рейс' });
        }

        if (trip.status === 'cancelled') {
            return res.status(400).json({ error: 'Рейс уже отменён' });
        }

        // Обработка заказов
        if (orders_action === 'return_to_incoming') {
            // Возвращаем заказы в пул
            await query(
                `UPDATE orders 
                 SET trip_id = NULL, sequence_num = NULL, status = 'new', updated_at = NOW()
                 WHERE trip_id = $1`,
                [tripId]
            );
        } else {
            // Помечаем отменёнными
            await query(
                `UPDATE orders 
                 SET status = 'cancelled', updated_at = NOW()
                 WHERE trip_id = $1`,
                [tripId]
            );
        }

        // Обновляем рейс
        await query(
            `UPDATE trips 
             SET status = 'cancelled', cancel_reason = $1, updated_at = NOW(), version = version + 1
             WHERE id = $2`,
            [reason.trim(), tripId]
        );

        await logChange(
            req.user.id, 'trips', tripId,
            'Отмена', trip.status, 'cancelled. Причина: ' + reason, ip
        );

        res.json({
            success: true,
            message: 'Рейс ' + trip.trip_number + ' отменён'
        });

    } catch (e) {
        console.error('POST /api/trips/[id]/cancel error:', e);
        res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
}

module.exports = requireAuth(handler);
