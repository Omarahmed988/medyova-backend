'use strict';

const { Pool } = require('pg');
const { DATABASE_URL } = require('./env');

let pool = null;

if (DATABASE_URL) {
    pool = new Pool({
        connectionString: DATABASE_URL,
        max: parseInt(process.env.DB_POOL_MAX || '10', 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
        console.error('[DB] Unexpected error on idle client:', err.message);
    });
}

/**
 * Test whether the database is reachable.
 * Never throws — always returns a result object.
 *
 * @returns {Promise<{ connected: boolean, error?: string }>}
 */
async function testConnection() {
    if (!pool) {
        return { connected: false, error: 'DATABASE_URL not configured' };
    }

    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        return { connected: true };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

module.exports = { pool, testConnection };
