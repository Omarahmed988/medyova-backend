'use strict';

/**
 * adminRateLimiter.js — Phase 11 Founder Control Layer
 *
 * A simple, zero-dependency in-memory rate limiter protecting
 * the /admin control surface from rapid mutation sequences.
 *
 * Rules:
 * - 20 requests per 1 minute window per actor (super_admin).
 * - Keyed by req.user.id (assumes mounted after requireAuth).
 */

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 20;

// Map: actorId -> { count: number, resetAt: number }
const _store = new Map();

function adminRateLimiter(req, res, next) {
    // Failsafe in case it's mounted before auth
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: 'unauthorized: requireAuth must precede adminRateLimiter' });
    }

    const actorId = req.user.id;
    const now = Date.now();
    let record = _store.get(actorId);

    if (!record || now > record.resetAt) {
        record = { count: 1, resetAt: now + WINDOW_MS };
        _store.set(actorId, record);
        return next();
    }

    record.count++;

    if (record.count > MAX_REQUESTS) {
        return res.status(429).json({
            error: 'too_many_requests',
            message: 'Admin rate limit exceeded (20 req/min). Please slow down.'
        });
    }

    next();
}

/**
 * Optional cleanup interval to prevent Map growth.
 * Runs every window cycle to evict expired records.
 */
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of _store.entries()) {
        if (now > record.resetAt) {
            _store.delete(key);
        }
    }
}, WINDOW_MS);

// Do not block process exit
if (cleanupInterval.unref) cleanupInterval.unref();

module.exports = adminRateLimiter;
