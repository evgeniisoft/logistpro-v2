const { query } = require('./_lib/db');
const { requireAuth } = require('./_lib/auth');
const { logChange } = require('./_lib/journal');

// Ключи, которые можно читать/писать
const ALLOWED_KEYS = [
    'bitrix_secret_key',
    'bitrix_webhook_url',
    'bitrix_active',
    'company_name',
    'company_phone'
];

// Ключи, которые НИКОГДА не возвращаем на фронт (только маскируем)
const SECRET_KEYS = ['bitrix_secret_key'];

async function handler(req, res) {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const action = req.query.action || 'index';

    // ============ INDEX: получить все настройки ============
    if (action === 'index') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

        try {
            const result = await query(
                `SELECT key, value, description, updated_at 
                 FROM settings 
                 WHERE key = ANY($1)
                 ORDER BY key ASC`,
                [ALLOWED_KEYS]
            );

            // Маскируем секретные ключи
            const settings = result.rows.map(row => {
                if (SECRET_KEYS.includes(row.key) && row.value) {
                    return {
                        ...row,
                        value: '••••••••',
                        has_value: true
                    };
                }
                return {
                    ...row,
                    has_value: !!row.value
                };
            });

            return res.json({ settings });

        } catch (e) {
            console.error('GET settings error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ UPDATE: обновить настройки ============
    if (action === 'update') {
        if (req.method !== 'POST' && req.method !== 'PUT') {
            return res.status(405).json({ error: 'Method not allowed' });
        }

        // Только admin может менять настройки
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Только администратор может менять настройки' });
        }

        const updates = req.body;

        if (!updates || typeof updates !== 'object') {
            return res.status(400).json({ error: 'Неверный формат данных' });
        }

        const results = [];

        try {
            for (const [key, value] of Object.entries(updates)) {
                if (!ALLOWED_KEYS.includes(key)) continue;

                // Получаем текущее значение
                const current = await query(
                    'SELECT value FROM settings WHERE key = $1',
                    [key]
                );

                if (current.rows.length === 0) {
                    // Вставляем новое
                    await query(
                        `INSERT INTO settings (key, value, description, updated_at)
                         VALUES ($1, $2, '', NOW())`,
                        [key, String(value)]
                    );
                } else {
                    // Обновляем только если изменилось
                    if (String(current.rows[0].value) !== String(value)) {
                        await query(
                            'UPDATE settings SET value = $1, updated_at = NOW() WHERE key = $2',
                            [String(value), key]
                        );
                        await logChange(req.user.id, 'settings', key, key,
                            current.rows[0].value, value, ip);
                    }
                }

                results.push(key);
            }

            return res.json({ success: true, updated: results });

        } catch (e) {
            console.error('PUT settings error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ GENERATE SECRET: сгенерировать новый секретный ключ ============
    if (action === 'generate-secret') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Только администратор' });
        }

        try {
            // Генерируем случайную строку 32 символа
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            let secret = '';
            for (let i = 0; i < 32; i++) {
                secret += chars.charAt(Math.floor(Math.random() * chars.length));
            }

            // Обновляем в настройках
            await query(
                `INSERT INTO settings (key, value, updated_at) 
                 VALUES ('bitrix_secret_key', $1, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
                [secret]
            );

            await logChange(req.user.id, 'settings', 'bitrix_secret_key',
                'Регенерация', '', 'Секрет обновлён', ip);

            // Возвращаем ОДИН РАЗ в открытом виде
            return res.json({ success: true, secret });

        } catch (e) {
            console.error('Generate secret error:', e);
            return res.status(500).json({ error: 'Ошибка сервера', details: e.message });
        }
    }

    // ============ LOG: журнал webhook'ов Битрикса ============
    if (action === 'bitrix-log') {
        if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

        try {
            const { limit } = req.query;
            const limitNum = parseInt(limit) || 50;

            const result = await query(
                `SELECT id, direction, external_id, status, error_message, created_at
                 FROM bitrix_log
                 ORDER BY created_at DESC
                 LIMIT $1`,
                [limitNum]
            );

            return res.json({ log: result.rows });

        } catch (e) {
            console.error('GET bitrix-log error:', e);
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ TEST BITRIX: тест подключения к Битрикс24 ============
    if (action === 'test-bitrix') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Только администратор' });
        }

        try {
            const urlResult = await query(
                "SELECT value FROM settings WHERE key = 'bitrix_webhook_url'"
            );
            const webhookUrl = urlResult.rows[0]?.value;

            if (!webhookUrl) {
                return res.status(400).json({ 
                    error: 'Не указан URL webhook Битрикс24' 
                });
            }

            // Отправляем тестовый запрос
            const testResponse = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    test: true,
                    message: 'Тестовое сообщение из ЛогистПро',
                    timestamp: new Date().toISOString()
                })
            });

            await query(
                `INSERT INTO bitrix_log (direction, payload, status, error_message)
                 VALUES ('out', $1, $2, $3)`,
                [
                    JSON.stringify({ test: true }),
                    testResponse.ok ? 'success' : 'failed',
                    testResponse.ok ? null : 'HTTP ' + testResponse.status
                ]
            );

            if (!testResponse.ok) {
                return res.status(400).json({
                    error: 'Битрикс24 вернул ошибку: ' + testResponse.status
                });
            }

            return res.json({ 
                success: true, 
                message: 'Соединение с Битрикс24 установлено' 
            });

        } catch (e) {
            console.error('Test bitrix error:', e);
            
            await query(
                `INSERT INTO bitrix_log (direction, payload, status, error_message)
                 VALUES ('out', $1, 'failed', $2)`,
                [JSON.stringify({ test: true }), e.message]
            );

            return res.status(500).json({ 
                error: 'Ошибка подключения: ' + e.message 
            });
        }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
}

module.exports = requireAuth(handler);
