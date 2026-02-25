'use strict';

/**
 * 404 catch-all middleware.
 * Registered after all routes — returns structured JSON, never HTML.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
function notFound(req, res) {
    res.status(404).json({
        error: 'Not Found',
        message: `Route ${req.method} ${req.originalUrl} does not exist.`,
        statusCode: 404,
    });
}

module.exports = notFound;
