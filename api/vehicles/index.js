const { query } = require('../_lib/db');
const { requireAuth } = require('../_lib/auth');
const { logChange } = require('../_lib/journal');

function validateVehicle(data, isUpdate = false) {
    const errors = [];

    if (!isUpdate || data.plate !== undefined) {
        if (!data.plate || !String(data.plate).trim()) {
            errors.push('Госномер обязателен');
        }
    }

    if (data.volume !== undefined && data.volume !== null && data.volume < 0) {
        errors.push('Объём не может быть отрицательным');
    }

    if (data.fuel_rate !== undefined && data.fuel_rate !== null && data.fuel_rate < 0) {
        errors.push('Норма расхода не может быть отрицательной');
    }

    if (data.amort_rate !== undefined && data.amort_rate !== null && data.amort_rate < 0) {
        errors.push('Ставка амортизации не может быть отрицательной');
    }

    const validTypes = ['own', 'hired'];
    if (data.type && !validTypes.includes(data.type)) {
        errors.push('Недопустимый тип машины');
    }

    return errors;
}

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // ============ GET: список машин ============
    if (req.method === 'GET') {
        try {
            const { include_archived } = req.query;

            let sql = `
                SELECT 
                    id, plate, model, type, volume, fuel_rate, amort_rate,
                    is_archived, created_at
                FROM vehicles
            `;

            if (include_archived !== 'true') {
                sql += ' WHERE is_archived = false';
            }

            sql += ' ORDER BY is_archived ASC, plate ASC';

            const result = await query(sql);
            res.json({ vehicles: result.rows });

        } catch (e) {
            console.error('GET /api/vehicles error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    // ============ POST: создать машину ============
    if (req.method === 'POST') {
        const { plate, model, type, volume, fuel_rate, amort_rate } = req.body;

        const errors = validateVehicle(req.body, false);
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }

        try {
            // Проверка на дубликат госномера
            const existing = await query(
                'SELECT id FROM vehicles WHERE UPPER(plate) = UPPER($1)',
                [plate.trim()]
            );
            if (existing.rows.length > 0) {
                return res.status(400).json({ error: 'Машина с таким госномером уже существует' });
            }

            const result = await query(
                `INSERT INTO vehicles (plate, model, type, volume, fuel_rate, amort_rate)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *`,
                [
                    plate.trim().toUpperCase(),
                    model || null,
                    type || 'own',
                    volume || 0,
                    fuel_rate || 0,
                    amort_rate || 0
                ]
            );

            await logChange(
                req.user.id, 'vehicles', result.rows[0].id,
                'Создание', '', result.rows[0].plate, ip
            );

            res.status(201).json({
                success: true,
                vehicle: result.rows[0]
            });

        } catch (e) {
            console.error('POST /api/vehicles error:', e);
            res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
        return;
    }

    res.status(405).json({ error: 'Method not allowed' });
}

module.exports = requireAuth(handler);
