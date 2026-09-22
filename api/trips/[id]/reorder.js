const { query } = require('../../_lib/db');
const { requireAuth } = require('../../_lib/auth');
const { logChange } = require('../../_lib/journal');

async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const tripId = req.query.id;
    const { order_ids } = req.body;

    if (!tripId) {
        return res.status(400).json({ error: 'ID рейса не указан' });
    }

    if (!Array.isArray(order_ids) || order_ids.length === 0) {
        return res.status(400).json({ error: 'Не передан список order_ids' });
    }

    try {
        // Проверяем, что все заказы принадлежат этому рейсу
        const orders = await query(
            'SELECT id FROM orders WHERE trip_id = $1',
            [tripId]
        );

        const existingIds = orders.rows.map(r => r.id);
        const invalidIds = order_ids.filter(id => !existingIds.includes(id));

        if (invalidIds.length > 0) {
            return res.status(400).json({
                error: 'Некоторые заказы не принадлежат этому рейсу',
                invalid: invalidIds
            });
        }

        // Обновляем sequence_num по порядку массива
        for (let i = 0; i < order_ids.length; i++) {
            await query(
                'UPDATE orders SET sequence_num = $1, updated_at = NOW() WHERE id = $2',
                [i + 1, order_ids[i]]
            );
        }

        await logChange(
            req.user.id, 'trips', tripId,
            'Пересортировка', '', 'Изменён порядок адресов', ip
        );

        res.json({ success: true });

    } catch (e) {
        console.error('POST /api/trips/[id]/reorder error:', e);
        res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
}

module.exports = requireAuth(handler);
