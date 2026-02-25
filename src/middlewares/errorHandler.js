'use strict';

/**
 * Centralized Express error handler.
 * Must be registered as the LAST middleware in app.js.
 * Catches all errors passed via next(err).
 *
 * @param {Error} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
    const statusCode = err.status || err.statusCode || 500;

    // Log server errors (5xx) but not client errors (4xx)
    if (statusCode >= 500) {
        console.error('[ERROR]', err.message, err.stack);
    }

    res.status(statusCode).json({
        error: err.name || 'Internal Server Error',
        message: err.message || 'An unexpected error occurred.',
        statusCode,
    });
}

module.exports = errorHandler;
