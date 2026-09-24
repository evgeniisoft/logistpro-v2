const { query } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { logChange } = require('./_lib/journal');

const VALID_CATEGORIES = ['fuel', 'toll', 'repair', 'fine', 'other', 'hired'];

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const action = req.query.action || 'create';
    const id = req.query.id;

    // ============ CREATE ============
    if (action === 'create') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        const { trip_id, category, amount, note } = req.body;

        if (!trip_id) return res.status(400).json({ error: 'Не указан trip_id' });
        if (!category || !VALID_CATEGORIES.includes(category)) {
            return res.status(400).json({ error: 'Недопустимая категория затраты' });
        }
        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ error: 'Сумма должна быть положительной' });
        }

        try {
            const tripCheck = await query('SELECT id, trip_number FROM trips WHERE id = $1', [trip_id]);
            if (tripCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Рейс не найден' });
            }

            const result = await query(
                `INSERT INTO costs (trip_id, category, amount, note, created_by)
                 VALUES ($1, $2, $3, $4, $5)
                 RETURNING *`,
                [trip_id, category, Number(amount), note || null, req.user.id]
            );

            await logChange(req.user.id, 'costs', result.rows[0].id, 'Создание',
                '', category + ': ' + amount, ip);

            return res.status(201).json({ success: true, cost: result.rows[0] });

        } catch (e) {
            console.error('POST cost create error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ UPDATE ============
    if (action === 'update') {
        if (req.method !== 'PUT') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID затраты не указан' });

        const { category, amount, note } = req.body;

        if (category && !VALID_CATEGORIES.includes(category)) {
            return res.status(400).json({ error: 'Недопустимая категория' });
        }
        if (amount !== undefined && Number(amount) <= 0) {
            return res.status(400).json({ error: 'Сумма должна быть положительной' });
        }

        try {
            const current = await query('SELECT * FROM costs WHERE id = $1', [id]);
            if (current.rows.length === 0) return res.status(404).json({ error: 'Затрата не найдена' });

            const cost = current.rows[0];
            const updates = [];
            const params = [];
            let paramIndex = 1;

            if (category !== undefined) {
                updates.push(`category = $${paramIndex++}`);
                params.push(category);
                if (cost.category !== category) {
                    await logChange(req.user.id, 'costs', id, 'category', cost.category, category, ip);
                }
            }
            if (amount !== undefined) {
                updates.push(`amount = $${paramIndex++}`);
                params.push(Number(amount));
                if (Number(cost.amount) !== Number(amount)) {
                    await logChange(req.user.id, 'costs', id, 'amount', cost.amount, amount, ip);
                }
            }
            if (note !== undefined) {
                updates.push(`note = $${paramIndex++}`);
                params.push(note || null);
                if (cost.note !== note) {
                    await logChange(req.user.id, 'costs', id, 'note', cost.note, note, ip);
                }
            }

            if (updates.length === 0) {
                return res.json({ success: true, message: 'Нет изменений' });
            }

            params.push(id);
            const sql = `UPDATE costs SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`;
            const result = await query(sql, params);

            return res.json({ success: true, cost: result.rows[0] });

        } catch (e) {
            console.error('PUT cost error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ DELETE ============
    if (action === 'delete') {
        if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
        if (!id) return res.status(400).json({ error: 'ID затраты не указан' });

        try {
            const current = await query('SELECT * FROM costs WHERE id = $1', [id]);
            if (current.rows.length === 0) return res.status(404).json({ error: 'Затрата не найдена' });

            const cost = current.rows[0];
            await query('DELETE FROM costs WHERE id = $1', [id]);
            await logChange(req.user.id, 'costs', id, 'Удаление',
                cost.category + ': ' + cost.amount, '', ip);

            return res.json({ success: true });

        } catch (e) {
            console.error('DELETE cost error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
}

module.exports = requireAuth(handler);
