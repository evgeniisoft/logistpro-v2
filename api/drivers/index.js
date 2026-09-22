const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');

function validateDriver(data, isUpdate = false) {
    const errors = [];

    if (!isUpdate || data.full_name !== undefined) {
        if (!data.full_name || !String(data.full_name).trim()) {
            errors.push('ФИО обязательно');
        }
    }

    if (data.default_rate !== undefined && data.default_rate !== null && data.default_rate < 0) {
        errors.push('Ставка не может быть отрицательной');
    }

    return errors;
}

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // ============ GET: список водителей ============
    if (req.method === 'GET') {
        try {
            const { include_archived } = req.query;

            let sql = `
                SELECT 
                    id, full_name, phone, license, default_rate,
                    is_archived, created_at
                FROM drivers
            `;

            if (include_archived !== 'true') {
                sql += ' WHERE is_archived = false';
            }

            sql += ' ORDER BY is_archived ASC, full_name ASC';

            const result = await query(sql);
            res.json({ drivers: result.rows });

        } catch (e) {
            console.error('GET /api/drivers error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    // ============ POST: создать водителя ============
    if (req.method === 'POST') {
        const { full_name, phone, license, default_rate } = req.body;

        const errors = validateDriver(req.body, false);
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }

        try {
            const result = await query(
                `INSERT INTO drivers (full_name, phone, license, default_rate)
                 VALUES ($1, $2, $3, $4)
                 RETURNING *`,
                [
                    full_name.trim(),
                    phone || null,
                    license || null,
                    default_rate || 0
                ]
            );

            await logChange(
                req.user.id, 'drivers', result.rows[0].id,
                'Создание', '', result.rows[0].full_name, ip
            );

            res.status(201).json({
                success: true,
                driver: result.rows[0]
            });

        } catch (e) {
            console.error('POST /api/drivers error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
