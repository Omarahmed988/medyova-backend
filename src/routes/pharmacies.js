'use strict';
const express = require('express');
const router = express.Router();
const InventoryNormalizationService = require('../services/inventoryNormalizationService');
const MedicineService = require('../services/medicineService');

// Simple in-memory rate limiter for MVP (10 uploads per hour per pharmacy)
const uploadRateLimits = new Map();

function checkRateLimit(pharmacyId) {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    if (!uploadRateLimits.has(pharmacyId)) {
        uploadRateLimits.set(pharmacyId, []);
    }

    const timestamps = uploadRateLimits.get(pharmacyId);
    // filter out timestamps older than 1 hour
    const recent = timestamps.filter(t => now - t < oneHour);
    if (recent.length >= 10) return false;

    recent.push(now);
    uploadRateLimits.set(pharmacyId, recent);
    return true;
}

/**
 * GET /pharmacies/:id/inventory
 * Retrieves current inventory for a pharmacy
 */
router.get('/:id/inventory', async (req, res, next) => {
    try {
        const inventory = await MedicineService.getInventoryForPharmacy(req.params.id);
        res.status(200).json({ data: inventory });
    } catch (err) {
        next(err);
    }
});

/**
 * PUT /pharmacies/:id/inventory
 * Legacy JSON upsert
 */
router.put('/:id/inventory', async (req, res, next) => {
    try {
        const { items } = req.body;
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Body must contain items array' });
        }

        const result = await MedicineService.upsertInventory(req.params.id, items);
        res.status(200).json({ data: result });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /pharmacies/:id/inventory/upload
 * Excel Upload endpoint
 * Expects the binary file in the request body, or a base64 encoded string if sent as JSON.
 * Query param: ?replace_all=true & token=1234
 */
router.post('/:id/inventory/upload', express.raw({ type: '*/*', limit: '10mb' }), async (req, res, next) => {
    try {
        const pharmacyId = req.params.id;

        // Rate limit check
        if (!checkRateLimit(pharmacyId)) {
            return res.status(429).json({ error: 'Upload rate limit exceeded (max 10 per hour)' });
        }

        let buffer = req.body;

        // Handle case where body might be empty or string if misconfigured
        if (!Buffer.isBuffer(buffer)) {
            // fallback: check if it's base64 in json
            if (req.is('application/json') && req.body.file) {
                buffer = Buffer.from(req.body.file, 'base64');
            } else {
                return res.status(400).json({ error: 'File buffer missing. Send as binary body.' });
            }
        }

        const replaceAll = req.query.replace_all === 'true';
        const confirmationToken = req.query.token;

        if (replaceAll && confirmationToken !== 'CONFIRM_REPLACE') {
            return res.status(400).json({
                error: 'Replacing entire inventory requires explicit confirmation.',
                required_query: '?replace_all=true&token=CONFIRM_REPLACE'
            });
        }

        const report = await InventoryNormalizationService.processInventoryUpload(pharmacyId, buffer, replaceAll);

        res.status(200).json({ data: report });
    } catch (err) {
        if (err.message.includes('Excel parse failed') || err.message.includes('Invalid layout')) {
            return res.status(400).json({ error: err.message });
        }
        next(err);
    }
});

// ─── Phase 17: Pharmacy Insurance Management ──────────────────────────

/**
 * GET /pharmacies/:id/insurance
 * Lists all active insurance contracts for the pharmacy
 */
router.get('/:id/insurance', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const { query } = require('../config/db');
        const result = await query(`
            SELECT ic.id, ic.name, pic.contract_active, pic.created_at
            FROM pharmacy_insurance_contracts pic
            JOIN insurance_companies ic ON ic.id = pic.insurance_company_id
            WHERE pic.pharmacy_id = $1 AND pic.contract_active = true
            ORDER BY ic.name ASC
        `, [req.params.id]);

        return res.status(200).json({ data: result.rows });
    } catch (err) {
        next(err);
    }
});

/**
 * POST /pharmacies/:id/insurance
 * Creates or reactivates a contract
 */
router.post('/:id/insurance', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const pharmacyId = req.params.id;
        const { insurance_company_id } = req.body;

        if (!insurance_company_id) {
            return res.status(400).json({ error: 'insurance_company_id is required' });
        }

        const { query } = require('../config/db');

        // Upsert contract
        await query(`
            INSERT INTO pharmacy_insurance_contracts (pharmacy_id, insurance_company_id, contract_active)
            VALUES ($1, $2, true)
            ON CONFLICT (pharmacy_id, insurance_company_id)
            DO UPDATE SET contract_active = true, created_at = NOW()
        `, [pharmacyId, insurance_company_id]);

        return res.status(201).json({ status: 'active' });
    } catch (err) {
        next(err);
    }
});

/**
 * DELETE /pharmacies/:id/insurance/:insuranceId
 * Soft-deletes (deactivates) a contract
 */
router.delete('/:id/insurance/:insuranceId', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const { id: pharmacyId, insuranceId } = req.params;
        const { query } = require('../config/db');

        await query(`
            UPDATE pharmacy_insurance_contracts 
            SET contract_active = false 
            WHERE pharmacy_id = $1 AND insurance_company_id = $2
        `, [pharmacyId, insuranceId]);

        return res.status(200).json({ status: 'deactivated' });
    } catch (err) {
        next(err);
    }
});

// ─── Phase 19: Pharmacy Loyalty System ───────────────────────────────

/**
 * GET /pharmacies/:id/performance
 * Returns the 5-factor performance score, tier, and 30-day metrics.
 */
router.get('/:id/performance', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const { id: pharmacyId } = req.params;
        const { query } = require('../config/db'); // or '../db' depending on what is used, looking at above it's '../config/db' but wait, line 172 uses '../config/db'

        // Ownership/Access check - usually handled via auth/middlewares, assuming user can view their pharmacy
        const result = await query(`
            SELECT 
                total_score, tier, response_time_score, availability_score, 
                rating_score, freshness_score, cancellation_rate, last_calculated_at
            FROM pharmacy_scores
            WHERE pharmacy_id = $1
        `, [pharmacyId]);

        if (result.rowCount === 0) {
            // If worker hasn't run yet, return the default 50 bronze baseline
            return res.status(200).json({
                data: {
                    total_score: 50.00,
                    tier: 'bronze',
                    response_time_score: 0,
                    availability_score: 0,
                    rating_score: 0,
                    freshness_score: 0,
                    cancellation_rate: 0,
                    last_calculated_at: null
                }
            });
        }

        return res.status(200).json({ data: result.rows[0] });
    } catch (err) {
        next(err);
    }
});

/**
 * GET /pharmacies/:id/demand
 * Phase 20: Top demanded medicines in this pharmacy's delivery areas
 */
router.get('/:id/demand', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        
        const { query } = require('../config/db');
        const pharmacyId = req.params.id;

        const result = await query(`
            SELECT m.id AS medicine_id, m.name, m.generic_name, 
                   h.demand_score, h.search_miss_count, h.order_failure_count
            FROM medicine_demand_heatmap h
            JOIN medicines m ON m.id = h.medicine_id
            WHERE h.area_id IN (
                SELECT area_id FROM pharmacy_delivery_areas WHERE pharmacy_id = $1
            )
            ORDER BY h.demand_score DESC
            LIMIT 20
        `, [pharmacyId]);

        return res.status(200).json({ data: result.rows });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
