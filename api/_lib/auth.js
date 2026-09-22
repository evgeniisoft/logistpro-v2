const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-vercel-env';

function generateToken(user) {
    return jwt.sign(
        { id: user.id, login: user.login, role: user.role, name: user.full_name },
        JWT_SECRET,
        { expiresIn: '7d' }
    );
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

function getTokenFromRequest(req) {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
        return auth.substring(7);
    }
    return null;
}

function requireAuth(handler) {
    return async (req, res) => {
        const token = getTokenFromRequest(req);
        const user = verifyToken(token);
        if (!user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        req.user = user;
        return handler(req, res);
    };
}

module.exports = { generateToken, verifyToken, getTokenFromRequest, requireAuth };
