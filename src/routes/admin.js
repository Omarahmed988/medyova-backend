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

// ─── Phase 17: Insurance Management ──────────────────────────────────

/**
 * GET /admin/insurance-companies
 */
router.get('/insurance-companies', async (req, res, next) => {
    try {
        const result = await query(`SELECT * FROM insurance_companies ORDER BY name ASC`);
        return res.status(200).json(result.rows);
    } catch (err) {
        next(err);
    }
});

/**
 * POST /admin/insurance-companies
 */
router.post('/insurance-companies', async (req, res, next) => {
    try {
        const { name } = req.body;
        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({ error: 'name must be a non-empty string' });
        }

        const result = await query(
            `INSERT INTO insurance_companies (name) VALUES ($1) RETURNING *`,
            [name.trim()]
        );
        return res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') { // unique_violation
            return res.status(409).json({ error: 'Insurance company with this name already exists' });
        }
        next(err);
    }
});

/**
 * PATCH /admin/insurance-companies/:id
 */
router.patch('/insurance-companies/:id', async (req, res, next) => {
    try {
        const { id } = req.params;
        const { name } = req.body;

        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({ error: 'name must be a non-empty string' });
        }

        const result = await query(
            `UPDATE insurance_companies SET name = $1 WHERE id = $2 RETURNING *`,
            [name.trim(), id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Insurance company not found' });
        }

        return res.status(200).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Insurance company with this name already exists' });
        if (err.code === '22P02') return res.status(400).json({ error: 'Invalid UUID format' });
        next(err);
    }
});

// ─── Phase 13: Review Moderation ─────────────────────────────────────

const { deleteReview } = require('../services/reviewService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /admin/reviews/:id
 * Super-admin only. Deletes a review and triggers aggregate recalculation.
 */
router.delete('/reviews/:id', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { id } = req.params;
        if (!UUID_RE.test(id)) {
            return res.status(400).json({ error: 'Review ID must be a valid UUID' });
        }

        await deleteReview(id);
        return res.json({ status: 'deleted' });
    } catch (err) {
        if (err.statusCode) {
            return res.status(err.statusCode).json({ error: err.message });
        }
        next(err);
    }
});

// ─── Phase 14: Medicine Search & Discovery ─────────────────────────────

/**
 * PATH /admin/areas/:id/activate
 * Super-admin only. Activates an area manually (founder override = true)
 */
router.patch('/areas/:id/activate', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        const { id } = req.params;
        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Area ID must be a valid UUID' });

        const result = await query(
            `UPDATE areas SET founder_override = true, updated_at = NOW() WHERE id = $1 RETURNING id`,
            [id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Area not found' });

        await _logAudit(req.user.id, req.ip, 'ACTIVATE_AREA', 'areas', id, { founder_override: false }, { founder_override: true });
        return res.json({ status: 'activated', id });
    } catch (err) {
        next(err);
    }
});

/**
 * PATH /admin/areas/:id/deactivate
 * Super-admin only. Removes manual activation (founder override = false)
 */
router.patch('/areas/:id/deactivate', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        const { id } = req.params;
        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Area ID must be a valid UUID' });

        const result = await query(
            `UPDATE areas SET founder_override = false, updated_at = NOW() WHERE id = $1 RETURNING id`,
            [id]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Area not found' });

        await _logAudit(req.user.id, req.ip, 'DEACTIVATE_AREA', 'areas', id, { founder_override: true }, { founder_override: false });
        return res.json({ status: 'deactivated', id });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /admin/medicines/:id/aliases
 * Super-admin only. Adds a new alias to a medicine.
 */
router.post('/medicines/:id/aliases', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        const { id } = req.params;
        const { alias } = req.body;

        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Medicine ID must be a valid UUID' });
        if (!alias || typeof alias !== 'string') return res.status(400).json({ error: 'Alias is required' });

        const result = await query(
            `INSERT INTO medicine_aliases (medicine_id, alias) VALUES ($1, $2) RETURNING id`,
            [id, alias]
        );

        await _logAudit(req.user.id, req.ip, 'ADD_ALIAS', 'medicine_aliases', result.rows[0].id, null, { alias, medicine_id: id });
        return res.status(201).json({ status: 'created', id: result.rows[0].id, alias });
    } catch (err) {
        if (err.code === '23505') { // unique violation
            return res.status(409).json({ error: 'Alias already exists' });
        }
        next(err);
    }
});

/**
 * DELETE /admin/medicines/aliases/:aliasId
 * Super-admin only. Removes an existing alias.
 */
router.delete('/medicines/aliases/:aliasId', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        const { aliasId } = req.params;
        if (!UUID_RE.test(aliasId)) return res.status(400).json({ error: 'Alias ID must be a valid UUID' });

        const result = await query(
            `DELETE FROM medicine_aliases WHERE id = $1 RETURNING alias, medicine_id`,
            [aliasId]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Alias not found' });

        await _logAudit(req.user.id, req.ip, 'REMOVE_ALIAS', 'medicine_aliases', aliasId, result.rows[0], null);
        return res.json({ status: 'deleted' });
    } catch (err) {
        next(err);
    }
});

// ─── Phase 15: Operational Launch Hardening ─────────────────────────────

const MarketplaceMonitorService = require('../services/marketplaceMonitorService');

/**
 * GET /admin/medicines/aliases/unmatched
 * Retrieves the unmatched medicines log for the operational dashboard.
 */
router.get('/medicines/aliases/unmatched', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        let { limit = 50, offset = 0 } = req.query;
        const results = await MarketplaceMonitorService.getUnmatchedMedicinesLog(parseInt(limit, 10), parseInt(offset, 10));
        return res.json({ data: results });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /admin/medicines/:id/aliases/bulk
 * Super-admin only. Maps an array of alias strings to a canonical medicine ID
 * and removes them from the unmatched_medicines_log.
 */
router.post('/medicines/:id/aliases/bulk', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        const { id } = req.params;
        const { aliases } = req.body; // expected to be an array of strings

        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Medicine ID must be a valid UUID' });
        if (!aliases || !Array.isArray(aliases)) return res.status(400).json({ error: 'aliases array is required' });

        const inserted = [];
        for (const alias of aliases) {
            try {
                // Check if alias already exists for any medicine
                const existing = await query(
                    `SELECT id FROM medicine_aliases WHERE LOWER(alias) = LOWER($1) LIMIT 1`,
                    [alias]
                );
                if (existing.rowCount === 0) {
                    await query(
                        `INSERT INTO medicine_aliases (medicine_id, alias) VALUES ($1, $2)`,
                        [id, alias]
                    );
                    inserted.push(alias);
                }
                // Clear from the unmatched log regardless
                await MarketplaceMonitorService.clearUnmatchedLog(alias);
            } catch (e) {
                console.error(`Failed to map alias ${alias}`, e);
            }
        }

        await _logAudit(req.user.id, req.ip, 'ADD_BULK_ALIASES', 'medicines', id, null, { aliases: inserted });
        return res.status(201).json({ status: 'created', count: inserted.length, aliases: inserted });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /admin/pharmacies/:id/areas
 * Binds a newly registered pharmacy to an operational area.
 */
router.post('/pharmacies/:id/areas', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        const { id } = req.params;
        const { area_id } = req.body;

        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Pharmacy ID must be a valid UUID' });
        if (!UUID_RE.test(area_id)) return res.status(400).json({ error: 'Area ID must be a valid UUID' });

        await query(
            `INSERT INTO pharmacy_delivery_areas (pharmacy_id, area_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [id, area_id]
        );

        await _logAudit(req.user.id, req.ip, 'ASSIGN_AREA', 'pharmacies', id, null, { area_id });
        return res.status(201).json({ status: 'assigned' });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /admin/pharmacies/:id/areas/:areaId
 * Removes a pharmacy from an operational area.
 */
router.delete('/pharmacies/:id/areas/:areaId', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        const { id, areaId } = req.params;
        if (!UUID_RE.test(id)) return res.status(400).json({ error: 'Pharmacy ID must be a valid UUID' });
        if (!UUID_RE.test(areaId)) return res.status(400).json({ error: 'Area ID must be a valid UUID' });

        await query(
            `DELETE FROM pharmacy_delivery_areas WHERE pharmacy_id = $1 AND area_id = $2`,
            [id, areaId]
        );

        await _logAudit(req.user.id, req.ip, 'REMOVE_AREA', 'pharmacies', id, { area_id: areaId }, null);
        return res.status(200).json({ status: 'removed' });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /admin/medicines/merge
 * Merges a duplicate medicine into a target medicine.
 */
router.post('/medicines/merge', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        const { source_id, target_id } = req.body;
        if (!UUID_RE.test(source_id) || !UUID_RE.test(target_id)) {
            return res.status(400).json({ error: 'IDs must be valid UUIDs' });
        }

        // 1. Transaction to guarantee merge cascade
        await query('BEGIN');

        // Transfer inventory — delete source rows that would conflict with existing target rows
        await query(`
            DELETE FROM pharmacy_inventory 
            WHERE medicine_id = $1 
            AND pharmacy_id IN (
                SELECT pharmacy_id FROM pharmacy_inventory WHERE medicine_id = $2
            )
        `, [source_id, target_id]);

        // Repoint remaining source inventory to target
        await query(`UPDATE pharmacy_inventory SET medicine_id = $2 WHERE medicine_id = $1`, [source_id, target_id]);

        // Transfer order_items
        await query(`UPDATE order_items SET medicine_id = $2 WHERE medicine_id = $1`, [source_id, target_id]);

        // Get source name to make it an alias
        const srcRes = await query(`SELECT name FROM medicines WHERE id = $1`, [source_id]);
        if (srcRes.rowCount > 0) {
            const rawName = srcRes.rows[0].name;
            const existingAlias = await query(`SELECT id FROM medicine_aliases WHERE LOWER(alias) = LOWER($1)`, [rawName]);
            if (existingAlias.rowCount === 0) {
                await query(`INSERT INTO medicine_aliases (medicine_id, alias) VALUES ($1, $2)`, [target_id, rawName]);
            }
        }

        // Soft delete the source medicine so historical orders might still resolve if needed, but it drops from search
        await query(`UPDATE medicines SET is_active = false WHERE id = $1`, [source_id]);

        // Resolve the report if it exists
        await query(`UPDATE catalog_duplicates_report SET is_resolved = true WHERE medicine_a_id = $1 AND medicine_b_id = $2 OR medicine_a_id = $2 AND medicine_b_id = $1`, [source_id, target_id]);

        await query('COMMIT');

        await _logAudit(req.user.id, req.ip, 'MERGE_MEDICINE', 'medicines', target_id, { source_id }, null);
        return res.status(200).json({ status: 'merged' });
    } catch (err) {
        await query('ROLLBACK');
        next(err);
    }
});

// ─── Phase 19: Pharmacy Loyalty System ───────────────────────────────

/**
 * GET /admin/pharmacies
 * Returns a list of all pharmacies joined with their performance scores.
 */
router.get('/pharmacies', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') return res.status(403).json({ error: 'Forbidden' });

        const result = await query(`
            SELECT 
                p.id, p.name, p.tier_id, p.is_active,
                ps.total_score, ps.tier AS performance_tier,
                ps.response_time_score, ps.availability_score, 
                ps.rating_score, ps.freshness_score,
                ps.cancellation_rate AS perf_cancellation_rate,
                ps.last_calculated_at
            FROM pharmacies p
            LEFT JOIN pharmacy_scores ps ON p.id = ps.pharmacy_id
            ORDER BY p.created_at DESC
        `);

        return res.status(200).json({ data: result.rows });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /admin/demand-gaps
 * Phase 20: Founder dashboard showing supply gaps (high demand, zero coverage)
 */
router.get('/demand-gaps', async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Forbidden' });
        }

        const { query } = require('../config/db');
        const result = await query(`
            SELECT m.id AS medicine_id, m.name, a.name AS area_name, 
                   h.demand_score, h.subscription_failure_count AS committed_demand
            FROM medicine_demand_heatmap h
            JOIN medicines m ON m.id = h.medicine_id
            JOIN areas a ON a.id = h.area_id
            WHERE h.demand_score > 10
              AND NOT EXISTS (
                SELECT 1 FROM pharmacy_inventory pi
                JOIN pharmacy_delivery_areas pda ON pda.pharmacy_id = pi.pharmacy_id
                WHERE pi.medicine_id = h.medicine_id
                  AND pda.area_id = h.area_id
                  AND pi.stock_status = 'available'
              )
            ORDER BY h.demand_score DESC
        `);

        return res.status(200).json({ data: result.rows });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
