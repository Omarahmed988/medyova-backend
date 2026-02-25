'use strict';

const express = require('express');

const router = express.Router();

/**
 * GET /health
 *
 * Liveness check — always returns 200 when the server is running.
 * Does NOT check database connectivity.
 *
 * Response body:
 * {
 *   status:    "ok",
 *   timestamp: "<ISO 8601 UTC string>",
 *   uptime:    <process uptime in seconds>
 * }
 */
router.get('/', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: parseFloat(process.uptime().toFixed(3)),
    });
});

module.exports = router;
