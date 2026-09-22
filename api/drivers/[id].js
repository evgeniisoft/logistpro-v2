const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const driverId = req.query.id;

    if (!driverId) {
        return res.status(400).json({ error: 'ID водителя не указан' });
    }

    // ============ GET ============
    if (req.method === 'GET') {
        try {
            const result = await query('SELECT * FROM drivers WHERE id = $1', [driverId]);
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Водитель не найден' });
            }
            res.json({ driver: result.rows[0] });
        } catch (e) {
            res.status(500).json({ error: 'Ошибка сервера' });
        }
        return;
    }

    // ============ PUT ============
    if (req.method === 'PUT') {
        const fields = req.body;
        const allowedFields = ['full_name', 'phone', 'license', 'default_rate', 'is_archived'];

        try {
            const current = await query('SELECT * FROM drivers WHERE id = $1', [driverId]);
            if (current.rows.length === 0) {
                return res.status(404).json({ error: 'Водитель не найден' });
            }

            const driver = current.rows[0];
            const updates = [];
            const params = [];
            let paramIndex = 1;

            for (const field of allowedFields) {
                if (fields[field] !== undefined) {
                    updates.push(`${field} = $${paramIndex++}`);
                    params.push(fields[field]);

                    if (String(driver[field]) !== String(fields[field])) {
                        await logChange(
                            req.user.id, 'drivers', driverId,
                            field, driver[field], fields[field], ip
                        );
                    }
                }
            }

            if (updates.length === 0) {
                return res.json({ success: true, message: 'Нет изменений' });
            }

            params.push(driverId);
            const sql = `UPDATE drivers SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            res.json({ success: true, driver: result.rows[0] });

        } catch (e) {
            console.error('PUT /api/drivers/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    // ============ DELETE ============
    if (req.method === 'DELETE') {
        if (req.user.role !== 'admin' && req.user.role !== 'senior_logist') {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }

        try {
            const check = await query('SELECT * FROM drivers WHERE id = $1', [driverId]);
            if (check.rows.length === 0) {
                return res.status(404).json({ error: 'Водитель не найден' });
            }

            const used = await query(
                'SELECT COUNT(*) as cnt FROM trips WHERE driver_id = $1',
                [driverId]
            );

            if (parseInt(used.rows[0].cnt) > 0) {
                await query('UPDATE drivers SET is_archived = true WHERE id = $1', [driverId]);
                await logChange(
                    req.user.id, 'drivers', driverId,
                    'Архивация', 'Активен', 'Архив', ip
                );
                return res.json({
                    success: true,
                    message: 'Водитель использовался в рейсах, поэтому перемещён в архив'
                });
            }

            await query('DELETE FROM drivers WHERE id = $1', [driverId]);
            await logChange(
                req.user.id, 'drivers', driverId,
                'Удаление', check.rows[0].full_name, '', ip
            );

            res.json({ success: true });

        } catch (e) {
            console.error('DELETE /api/drivers/[id] error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
