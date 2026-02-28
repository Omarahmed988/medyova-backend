'use strict';

const { Pool } = require('pg');
const { DATABASE_URL, NODE_ENV } = require('./env');

let pool = null;

if (DATABASE_URL) {
    pool = new Pool({
        connectionString: DATABASE_URL,
        max: parseInt(process.env.DB_POOL_MAX || '10', 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
        ssl:
            NODE_ENV === 'production'
                ? { rejectUnauthorized: false }
                : false,
    });

    pool.on('error', (err) => {
        console.error('[DB] Unexpected error on idle client:', err.message);
    });
}

/**
 * Execute a parameterized SQL query against the pool.
 * All database access in the application MUST go through this function.
 *
 * @param {string} text  — SQL query with $1, $2, … placeholders
 * @param {any[]}  [params] — parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
    if (!pool) {
        throw new Error('Database not configured. Set DATABASE_URL.');
    }
    return pool.query(text, params);
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
        await pool.query('SELECT 1');
        return { connected: true };
    } catch (err) {
        return { connected: false, error: err.message };
    }
}

module.exports = { pool, query, testConnection };
