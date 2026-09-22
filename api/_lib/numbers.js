const { query } = require('./db');

async function generateTripNumber() {
    const result = await query(
        `SELECT trip_number FROM trips 
         WHERE trip_number ~ '^Р-[0-9]+$'
         ORDER BY CAST(SUBSTRING(trip_number FROM 3) AS INTEGER) DESC 
         LIMIT 1`
    );

    let nextNum = 1;
    if (result.rows.length > 0) {
        const lastNumber = result.rows[0].trip_number;
        const match = lastNumber.match(/\d+/);
        if (match) {
            nextNum = parseInt(match[0], 10) + 1;
        }
    }

    return 'Р-' + String(nextNum).padStart(3, '0');
}

module.exports = { generateTripNumber };
