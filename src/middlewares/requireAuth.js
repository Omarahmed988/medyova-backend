'use strict';

/**
 * requireAuth.js
 * Minimal stub for the authentication middleware.
 * Ensures req.user is populated.
 */
function requireAuth(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}

module.exports = requireAuth;
