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

/**
 * GET /admin/audit/critical
 * Read-only isolated query exposing Founder Control mutations.
 */
router.get('/audit/critical', async (req, res, next) => {
    try {
        let { limit = '20', offset = '0', action, key, actor_id, start_date, end_date } = req.query;

        // 1. Pagination Validation (sane defaults, strict bounds)
        limit = parseInt(limit, 10);
        offset = parseInt(offset, 10);

        if (isNaN(limit) || limit < 1 || limit > 100) {
            limit = 20; // Silently clamp to safe bounds for admin
        }
        if (isNaN(offset) || offset < 0) {
            offset = 0;
        }

        // 2. Explicit Validation & Sanitization
        let parsedAction = null;
        let parsedKey = null;
        let parsedActorId = null;
        let parsedStartDate = null;
        let parsedEndDate = null;

        if (action && typeof action === 'string') parsedAction = action;
        if (key && typeof key === 'string') parsedKey = key;

        if (actor_id && typeof actor_id === 'string') {
            // General UUID format check (supports v1-v5)
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(actor_id)) {
                return res.status(400).json({ error: 'actor_id must be a valid UUID' });
            }
            parsedActorId = actor_id;
        }

        if (start_date) {
            const time = Date.parse(start_date);
            if (isNaN(time)) return res.status(400).json({ error: 'start_date must be a valid ISO8601 string' });
            parsedStartDate = new Date(time).toISOString();
        }

        if (end_date) {
            const time = Date.parse(end_date);
            if (isNaN(time)) return res.status(400).json({ error: 'end_date must be a valid ISO8601 string' });
            parsedEndDate = new Date(time).toISOString();
        }

        // 3. Exact Spec Shape Query
        // Binds directly map $1 through $7
        const result = await query(
            `SELECT 
                id,
                actor_id,
                ip_address,
                action,
                target_type,
                target_id,
                previous_state,
                new_state,
                created_at
             FROM system_audit_logs
             WHERE target_type IN ('system_settings', 'feature_flags')
               AND ($1::text IS NULL OR action = $1)
               AND ($2::text IS NULL OR target_id = $2)
               AND ($3::uuid IS NULL OR actor_id = $3)
               AND ($4::timestamp IS NULL OR created_at >= $4)
               AND ($5::timestamp IS NULL OR created_at <= $5)
             ORDER BY created_at DESC
             LIMIT $6 OFFSET $7`,
            [
                parsedAction,
                parsedKey,
                parsedActorId,
                parsedStartDate,
                parsedEndDate,
                limit,      // $6
                offset      // $7
            ]
        );

        return res.status(200).json({
            data: result.rows,
            meta: {
                limit,
                offset,
                count: result.rows.length
            }
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
