const bcrypt = require('bcryptjs');
const { query } = require('./_lib/db');
const { generateToken, verifyToken, getTokenFromRequest } = require('./_lib/auth');

module.exports = async (req, res) => {
    const action = req.query.action || req.body?.action || 'login';
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    // ============ LOGIN ============
    if (action === 'login') {
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Method not allowed' });
        }

        const { login, password } = req.body;

        if (!login || !password) {
            return res.status(400).json({ error: 'Введите логин и пароль' });
        }

        try {
            const result = await query(
                'SELECT id, login, password_hash, full_name, role, is_active FROM users WHERE login = $1',
                [login]
            );

            if (result.rows.length === 0) {
                await query(
                    'INSERT INTO login_history (login, ip, status) VALUES ($1, $2, $3)',
                    [login, ip, 'failed']
                );
                return res.status(401).json({ error: 'Неверный логин или пароль' });
            }

            const user = result.rows[0];

            if (!user.is_active) {
                return res.status(403).json({ error: 'Учётная запись заблокирована' });
            }

            const passwordMatch = await bcrypt.compare(password, user.password_hash);

            if (!passwordMatch) {
                await query(
                    'INSERT INTO login_history (user_id, login, ip, status) VALUES ($1, $2, $3, $4)',
                    [user.id, login, ip, 'failed']
                );
                return res.status(401).json({ error: 'Неверный логин или пароль' });
            }

            await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);
            await query(
                'INSERT INTO login_history (user_id, login, ip, status) VALUES ($1, $2, $3, $4)',
                [user.id, login, ip, 'success']
            );

            const token = generateToken(user);

            return res.json({
                success: true,
                token,
                user: {
                    id: user.id,
                    login: user.login,
                    full_name: user.full_name,
                    role: user.role
                }
            });

        } catch (e) {
            console.error('Login error:', e);
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
    }

    // ============ ME (информация о пользователе) ============
    if (action === 'me') {
        const token = getTokenFromRequest(req);
        const user = verifyToken(token);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        return res.json({
            user: {
                id: user.id,
                login: user.login,
                full_name: user.name,
                role: user.role
            }
        });
    }

    // ============ LOGOUT ============
    if (action === 'logout') {
        return res.json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
};
