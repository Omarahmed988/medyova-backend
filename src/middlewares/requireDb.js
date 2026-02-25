'use strict';

const { testConnection } = require('../config/db');

/**
 * Middleware that guards routes requiring an active database connection.
 * Apply to any router that needs DB access.
 * Returns 503 if the database is not reachable.
 *
 * Usage:
 *   router.get('/some-route', requireDb, controller.handler);
 *
 * @param {import('express').Request} _req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireDb(_req, res, next) {
    const { connected, error } = await testConnection();

    if (!connected) {
        return res.status(503).json({
            error: 'Service Unavailable',
            message: 'The database is not reachable. Please try again later.',
            statusCode: 503,
            detail: error || 'Unknown connection error',
        });
    }

    return next();
}

module.exports = requireDb;
