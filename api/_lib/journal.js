const { query } = require('./db');

async function logChange(userId, table, recordId, field, oldValue, newValue, ip) {
    try {
        await query(
            `INSERT INTO journal (user_id, table_name, record_id, field_name, old_value, new_value, ip)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [userId, table, String(recordId), field, String(oldValue), String(newValue), ip]
        );
    } catch (e) {
        console.error('Journal error:', e);
    }
}

module.exports = { logChange };
