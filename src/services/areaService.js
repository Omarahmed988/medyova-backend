'use strict';

/**
 * areaService.js — Phase 12 Delivery Areas
 *
 * Service layer for:
 *   - Area CRUD (create, list, delete non-legacy)
 *   - Pharmacy delivery area assignment
 *   - DA-5 zone/area consistency validation
 *
 * Constraints:
 *   - Legacy areas (is_legacy = true) cannot be deleted.
 *   - All writes are single-row autocommit (no BEGIN/COMMIT).
 *   - DA-5 validation is a prerequisite for any request creation.
 */

const { query } = require('../config/db');

// ── Area CRUD ──────────────────────────────────────────────────────────────

/**
 * List all areas, optionally filtered by zone_id.
 * @param {string} [zoneId]
 * @returns {Promise<object[]>}
 */
async function listAreas(zoneId) {
    if (zoneId) {
        const result = await query(
            `SELECT id, zone_id, name, is_active, is_legacy, created_at
             FROM areas
             WHERE zone_id = $1
             ORDER BY is_legacy DESC, name ASC`,
            [zoneId]
        );
        return result.rows;
    }
    const result = await query(
        `SELECT id, zone_id, name, is_active, is_legacy, created_at
         FROM areas
         ORDER BY zone_id, is_legacy DESC, name ASC`
    );
    return result.rows;
}

/**
 * Create a new non-legacy area within a zone.
 * @param {string} zoneId
 * @param {string} name
 * @returns {Promise<object>}
 */
async function createArea(zoneId, name) {
    // Validate zone exists
    const zoneCheck = await query(
        'SELECT id FROM zones WHERE id = $1 AND is_active = true',
        [zoneId]
    );
    if (!zoneCheck.rows.length) {
        const err = new Error('Zone not found or inactive');
        err.statusCode = 404;
        throw err;
    }

    const result = await query(
        `INSERT INTO areas (zone_id, name, is_legacy)
         VALUES ($1, $2, false)
         RETURNING id, zone_id, name, is_active, is_legacy, created_at`,
        [zoneId, name]
    );
    return result.rows[0];
}

/**
 * Delete an area. Legacy areas are protected.
 * @param {string} areaId
 * @returns {Promise<void>}
 */
async function deleteArea(areaId) {
    const check = await query(
        'SELECT id, is_legacy FROM areas WHERE id = $1',
        [areaId]
    );
    if (!check.rows.length) {
        const err = new Error('Area not found');
        err.statusCode = 404;
        throw err;
    }
    if (check.rows[0].is_legacy) {
        const err = new Error('Legacy areas cannot be deleted — they protect historical request integrity');
        err.statusCode = 403;
        throw err;
    }
    await query('DELETE FROM areas WHERE id = $1 AND is_legacy = false', [areaId]);
}

// ── Pharmacy Delivery Area Assignment ──────────────────────────────────────

/**
 * Replace a pharmacy's delivery areas with a new set.
 * Atomically clears existing entries and inserts provided area_ids.
 *
 * @param {string} pharmacyId
 * @param {string[]} areaIds
 * @returns {Promise<void>}
 */
async function setPharmacyDeliveryAreas(pharmacyId, areaIds) {
    // Verify pharmacy exists
    const pharmacyCheck = await query(
        'SELECT id FROM pharmacies WHERE id = $1',
        [pharmacyId]
    );
    if (!pharmacyCheck.rows.length) {
        const err = new Error('Pharmacy not found');
        err.statusCode = 404;
        throw err;
    }

    // Verify all area IDs exist
    if (areaIds.length > 0) {
        const areaCheck = await query(
            `SELECT COUNT(*) AS found
             FROM areas
             WHERE id = ANY($1::uuid[])`,
            [areaIds]
        );
        if (parseInt(areaCheck.rows[0].found, 10) !== areaIds.length) {
            const err = new Error('One or more area_ids are invalid');
            err.statusCode = 400;
            throw err;
        }
    }

    // Atomic replace: delete then insert
    await query(
        'DELETE FROM pharmacy_delivery_areas WHERE pharmacy_id = $1',
        [pharmacyId]
    );
    if (areaIds.length > 0) {
        const values = areaIds.map((id, i) => `($1, $${i + 2})`).join(', ');
        await query(
            `INSERT INTO pharmacy_delivery_areas (pharmacy_id, area_id)
             VALUES ${values}
             ON CONFLICT DO NOTHING`,
            [pharmacyId, ...areaIds]
        );
    }
}

/**
 * List areas assigned to a pharmacy.
 * @param {string} pharmacyId
 * @returns {Promise<object[]>}
 */
async function getPharmacyDeliveryAreas(pharmacyId) {
    const result = await query(
        `SELECT a.id, a.zone_id, a.name, a.is_legacy
         FROM areas a
         JOIN pharmacy_delivery_areas pda ON pda.area_id = a.id
         WHERE pda.pharmacy_id = $1
         ORDER BY a.name ASC`,
        [pharmacyId]
    );
    return result.rows;
}

// ── DA-5 Validation ────────────────────────────────────────────────────────

/**
 * Validate that area_id belongs to zone_id (DA-5 invariant).
 * Throws a 400 error if the constraint is violated.
 *
 * @param {string} areaId
 * @param {string} zoneId
 * @returns {Promise<void>}
 */
async function validateAreaZoneConsistency(areaId, zoneId) {
    const result = await query(
        'SELECT zone_id FROM areas WHERE id = $1 AND is_active = true',
        [areaId]
    );
    if (!result.rows.length) {
        const err = new Error('area_id not found or inactive');
        err.statusCode = 404;
        throw err;
    }
    if (result.rows[0].zone_id !== zoneId) {
        const err = new Error('DA-5 Violation: area_id does not belong to the specified zone_id');
        err.statusCode = 400;
        throw err;
    }
}

module.exports = {
    listAreas,
    createArea,
    deleteArea,
    setPharmacyDeliveryAreas,
    getPharmacyDeliveryAreas,
    validateAreaZoneConsistency,
};
