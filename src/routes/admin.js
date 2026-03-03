'use strict';

/**
 * src/routes/admin.js
 * Phase 11 — Founder Control Layer
 *
 * Exposes PATCH /admin/settings/:key and PATCH /admin/flags/:key.
 * Enforces super-admin role, strict input validation, and separated
 * asynchronous audit logging that does not rollback on log write failure.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const settingsService = require('../services/settingsService');
const adminRateLimiter = require('../middlewares/adminRateLimiter');

// ─── Security Guards ─────────────────────────────────────────────────

// 1. Rate limiter (20/min per actor ID)
router.use(adminRateLimiter);

// 2. Strict Role guard (Must be super_admin)
const requireSuperAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'super_admin') {
        return res.status(403).json({ error: 'forbidden: requires super_admin role' });
    }
    next();
};

router.use(requireSuperAdmin);

// ─── Separated Audit Logging Handler ─────────────────────────────────

/**
 * Fire-and-forget append-only audit logger.
 * Executes AFTER the service layer successfully writes to DB.
 */
async function _logAudit(actorId, ipAddress, action, targetType, targetId, previousState, newState) {
    try {
        await query(
            `INSERT INTO system_audit_logs 
               (actor_id, ip_address, action, target_type, target_id, previous_state, new_state, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [
                actorId,
                ipAddress,
                action,
                targetType,
                targetId,
                JSON.stringify({ value: previousState }),
                JSON.stringify({ value: newState })
            ]
        );
    } catch (err) {
        console.error('[audit] Failed to write to system_audit_logs:', err.message);
        // We do NOT re-throw. The core config mutation already happened successfully.
    }
}

// ─── Routes ──────────────────────────────────────────────────────────

/**
 * PATCH /admin/settings/:key
 */
router.patch('/settings/:key', async (req, res, next) => {
    try {
        const { key } = req.params;
        const { value, confirm } = req.body;

        // Strict input validation
        if (typeof value !== 'string') {
            return res.status(400).json({ error: 'value must be a string' });
        }

        // Service executes UPDATE -> NOTIFY -> refresh (or fast-path idempotency)
        const result = await settingsService.updateSetting(
            key,
            value,
            req.user.id,
            confirm
        );

        // separated non-blocking audit write IF a change actually occurred
        if (result.status === 'updated') {
            _logAudit(
                req.user.id,
                req.ip || '0.0.0.0',
                'UPDATE_SETTING',
                'system_settings',
                key,
                result.previous_value,
                result.new_value
            );
        }

        return res.status(200).json(result);

    } catch (err) {
        // Map service errors to HTTP status natively
        if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
        if (err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message });
        if (err.code === 'BAD_REQUEST') return res.status(400).json({ error: err.message });
        next(err);
    }
});

/**
 * PATCH /admin/flags/:key
 */
router.patch('/flags/:key', async (req, res, next) => {
    try {
        const { key } = req.params;
        const { isEnabled, scope, scopeId, confirm } = req.body;

        // Strict input validation
        if (typeof isEnabled !== 'boolean') {
            return res.status(400).json({ error: 'isEnabled must be a boolean' });
        }

        // Service executes UPDATE -> NOTIFY -> refresh
        const result = await settingsService.updateFlag(
            key,
            isEnabled,
            scope,
            scopeId,
            req.user.id,
            confirm
        );

        if (result.status === 'updated') {
            _logAudit(
                req.user.id,
                req.ip || '0.0.0.0',
                'UPDATE_FLAG',
                'feature_flags',
                key,
                result.previous_value,
                result.new_value
            );
        }

        return res.status(200).json(result);

    } catch (err) {
        if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
        if (err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message });
        if (err.code === 'BAD_REQUEST') return res.status(400).json({ error: err.message });
        next(err);
    }
});

module.exports = router;
