'use strict';

/**
 * src/routes/insuranceOrders.js
 * Phase 18 — Insurance Order endpoint (Flow C)
 */

const express = require('express');
const router = express.Router();
const InsuranceOrderService = require('../services/insuranceOrderService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /orders/insurance
 */
router.post('/insurance', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const { pharmacy_id, area_id, patient_profile_id, items,
            prescription_image_url, insurance_approval_image_url } = req.body;

        // Input validation
        if (!pharmacy_id || !UUID_RE.test(pharmacy_id)) {
            return res.status(400).json({ error: 'pharmacy_id must be a valid UUID' });
        }
        if (!area_id || !UUID_RE.test(area_id)) {
            return res.status(400).json({ error: 'area_id must be a valid UUID' });
        }
        if (!patient_profile_id || !UUID_RE.test(patient_profile_id)) {
            return res.status(400).json({ error: 'patient_profile_id must be a valid UUID' });
        }
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items must be a non-empty array' });
        }

        const order = await InsuranceOrderService.createInsuranceOrder(
            req.user.id,
            pharmacy_id,
            area_id,
            patient_profile_id,
            items,
            { prescription_image_url, insurance_approval_image_url }
        );

        return res.status(201).json({ data: order });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
