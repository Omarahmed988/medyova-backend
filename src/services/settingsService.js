'use strict';

/**
 * settingsService.js — Phase 11 Founder Control Layer
 *
 * Pure DB write layer for system_settings and feature_flags.
 * Implements strict validation, confirmation protocol, and
 * safe config refresh pattern (UPDATE -> NOTIFY -> refresh).
 *
 * Constraints:
 * - Autocommit ONLY (No BEGIN/COMMIT).
 * - No direct mutation of settingsCache Maps.
 * - Zone validation ensures fail-closed on inactive zones.
 */

const { query } = require('../config/db');
const settingsCache = require('../config/settingsCache');

// ─── Critical Key Registry ───────────────────────────────────────────

const CRITICAL_KEYS = new Set([
    'commission_rate_percent',
    'pharmacy_confirm_timeout_sec',
]);

const CRITICAL_FLAGS = new Set([
    'subscription_engine_enabled',
    'insurance_routing_enabled',
    'rare_medicine_routing_enabled',
]);

// ─── Internal Validation Helpers ─────────────────────────────────────

function _validateTypeAndBounds(valueStr, meta) {
    if (meta.type === 'boolean') {
        if (valueStr !== 'true' && valueStr !== 'false') {
            throw new Error('invalid_type: expected "true" or "false"');
        }
    } else if (meta.type === 'integer') {
        const parsed = parseInt(valueStr, 10);
        if (!Number.isSafeInteger(parsed) || parsed.toString() !== valueStr) {
            throw new Error('invalid_type: expected integer');
        }
        if (meta.max_val !== null && parsed > parseInt(meta.max_val, 10)) {
            throw new Error(`exceeds_maximum: max allowed is ${meta.max_val}`);
        }
        if (meta.min_val !== null && parsed < parseInt(meta.min_val, 10)) {
            throw new Error(`below_minimum: min allowed is ${meta.min_val}`);
        }
    } else if (meta.type === 'decimal') {
        const parsed = parseFloat(valueStr);
        if (isNaN(parsed)) {
            throw new Error('invalid_type: expected decimal');
        }
        if (meta.max_val !== null && parsed > parseFloat(meta.max_val)) {
            throw new Error(`exceeds_maximum: max allowed is ${meta.max_val}`);
        }
        if (meta.min_val !== null && parsed < parseFloat(meta.min_val)) {
            throw new Error(`below_minimum: min allowed is ${meta.min_val}`);
        }
    }
}

// ─── Public Write API ────────────────────────────────────────────────

/**
 * Update a system setting.
 *
 * @param {string} key
 * @param {string} newValue
 * @param {string} actorId - UUID of super_admin making the change
 * @param {boolean} confirmFlag - `{ confirm: true }` body field for critical keys
 * @returns {Promise<{ key: string, previous_value: string, new_value: string }>}
 * @throws {Error} specific constraint violations catching (400/403/404) at router
 */
async function updateSetting(key, newValue, actorId, confirmFlag) {
    // 1. Key exists
    const meta = settingsCache.getSettingMeta(key);
    if (!meta) {
        const error = new Error('setting_not_found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    // 2. is_locked check
    if (meta.is_locked) {
        const error = new Error('setting_locked');
        error.code = 'FORBIDDEN';
        throw error;
    }

    // 3 & 4 & 5. Type and boundary validation
    try {
        _validateTypeAndBounds(newValue, meta);
    } catch (validationErr) {
        const error = new Error(validationErr.message);
        error.code = 'BAD_REQUEST';
        throw error;
    }

    // 6. Confirmation protocol for high-impact keys
    if (CRITICAL_KEYS.has(key) && confirmFlag !== true) {
        const error = new Error('confirmation_required: This is a critical setting. Include { confirm: true } to proceed.');
        error.code = 'BAD_REQUEST';
        throw error;
    }

    // 7. Read previous value (from DB to ensure latest true value for audit)
    const currentRes = await query('SELECT value FROM system_settings WHERE key = $1', [key]);
    const previous_value = currentRes.rows[0].value;

    // 8. UPDATE (autocommit)
    await query(
        `UPDATE system_settings
         SET value = $1, updated_by = $2, updated_at = now()
         WHERE key = $3`,
        [newValue, actorId, key]
    );

    // 9. NOTIFY config_changed BEFORE local refresh
    await query(`NOTIFY config_changed`);

    // 10. Local refresh
    await settingsCache.refresh();

    // Return audit format piece
    return {
        key,
        previous_value,
        new_value: newValue
    };
}

/**
 * Update a feature flag.
 *
 * @param {string} key
 * @param {boolean} isEnabled
 * @param {string} scope - 'global' or 'zone'
 * @param {string|null} scopeId
 * @param {string} actorId
 * @param {boolean} confirmFlag
 * @returns {Promise<{ key: string, scope: string, scope_id: string|null, previous_value: boolean, new_value: boolean }>}
 */
async function updateFlag(key, isEnabled, scope, scopeId, actorId, confirmFlag) {
    // 1. Scope validation
    if (scope !== 'global' && scope !== 'zone') {
        const error = new Error('invalid_scope: must be global or zone');
        error.code = 'BAD_REQUEST';
        throw error;
    }

    // 2. Scope constraints
    if (scope === 'global' && scopeId !== null) {
        const error = new Error('scope_id_not_allowed: global flags must not have a scope_id');
        error.code = 'BAD_REQUEST';
        throw error;
    }
    if (scope === 'zone' && !scopeId) {
        const error = new Error('zone_not_found: scope_id required for zone flags');
        error.code = 'BAD_REQUEST';
        throw error;
    }

    // 3. Zone existence check (if zone scope)
    if (scope === 'zone') {
        // Enforce fail-closed: is_active = true
        const zoneRes = await query('SELECT id FROM zones WHERE id = $1 AND is_active = true', [scopeId]);
        if (zoneRes.rows.length === 0) {
            const error = new Error('zone_not_found: zone does not exist or is inactive');
            error.code = 'BAD_REQUEST';
            throw error;
        }
    }

    // 4. Confirmation protocol for high-impact flags
    if (CRITICAL_FLAGS.has(key) && confirmFlag !== true) {
        const error = new Error('confirmation_required: This is a critical flag. Include { confirm: true } to proceed.');
        error.code = 'BAD_REQUEST';
        throw error;
    }

    // Fetch current state from DB
    const stateRes = await query(
        `SELECT is_enabled FROM feature_flags
         WHERE key = $1 AND scope = $2 AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($3, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [key, scope, scopeId]
    );

    if (stateRes.rows.length === 0) {
        const error = new Error('flag_not_found');
        error.code = 'NOT_FOUND';
        throw error;
    }

    const previous_value = stateRes.rows[0].is_enabled;

    // Ensure boolean
    if (typeof isEnabled !== 'boolean') {
        const error = new Error('invalid_type: isEnabled must be boolean');
        error.code = 'BAD_REQUEST';
        throw error;
    }

    // Execute Write -> Notify -> Refresh
    await query(
        `UPDATE feature_flags
         SET is_enabled = $1, updated_by = $2, updated_at = now()
         WHERE key = $3 AND scope = $4 AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE($5, '00000000-0000-0000-0000-000000000000'::uuid)`,
        [isEnabled, actorId, key, scope, scopeId]
    );

    await query(`NOTIFY config_changed`);
    await settingsCache.refresh();

    return {
        key,
        scope,
        scope_id: scopeId,
        previous_value,
        new_value: isEnabled
    };
}

module.exports = {
    updateSetting,
    updateFlag,
};
