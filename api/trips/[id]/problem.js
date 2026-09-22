const { query } = require('../../_lib/db');
const { requireAuth } = require('../../_lib/auth');
const { logChange } = require('../../_lib/journal');

async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const tripId = req.query.id;
    const { comment } = req.body;

    if (!tripId) {
        return res.status(400).json({ error: 'ID рейса не указан' });
    }

    if (!comment || !comment.trim()) {
        return res.status(400).json({ error: 'Укажите комментарий к проблеме' });
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

        if (['done', 'cancelled'].includes(trip.status)) {
            return res.status(400).json({ error: 'Нельзя отметить проблему у завершённого/отменённого рейса' });
        }

        await query(
            `UPDATE trips 
             SET status = 'problem', problem_comment = $1, updated_at = NOW(), version = version + 1
             WHERE id = $2`,
            [comment.trim(), tripId]
        );

        await logChange(
            req.user.id, 'trips', tripId,
            'Проблема', trip.status, 'problem. ' + comment, ip
        );

        res.json({
            success: true,
            message: 'Рейс ' + trip.trip_number + ' помечен как проблемный'
        });

    } catch (e) {
        console.error('POST /api/trips/[id]/problem error:', e);
        res.status(500).json({ error: 'Ошибка сервера', details: e.message });
    }
}

module.exports = requireAuth(handler);
