const { requireAuth } = require('../_lib/auth');

module.exports = requireAuth(async (req, res) => {
    res.json({
        user: {
            id: req.user.id,
            login: req.user.login,
            full_name: req.user.name,
            role: req.user.role
        }
    });
});
