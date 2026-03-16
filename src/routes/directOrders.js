'use strict';
const express = require('express');
const router = express.Router();
const DirectOrderService = require('../services/directOrderService');

/**
 * POST /orders/direct
 */
router.post('/direct', async (req, res, next) => {
    try {
        const { pharmacy_id, area_id, items, insurance_company_id } = req.body;
        const userId = req.user ? req.user.id : null; // Support anonymous or requireAuth based on mount

        // Basic validation
        if (!pharmacy_id || !area_id || !items) {
            return res.status(400).json({ error: 'Missing pharmacy_id, area_id, or items array' });
        }
        if (insurance_company_id) {
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(insurance_company_id)) {
                return res.status(400).json({ error: 'insurance_company_id must be a valid UUID' });
            }
        }

        const order = await DirectOrderService.createDirectOrder(userId, pharmacy_id, area_id, items, insurance_company_id);
        res.status(201).json({ data: order });
    } catch (err) {
        if (err.code === 'STOCK_UNAVAILABLE' && err.medicine_id) {
            const DemandSignalService = require('../services/demandSignalService');
            // Extract area_id, userId, quantity from request body/auth
            const quantity = req.body.items.find(i => i.medicine_id === err.medicine_id)?.quantity || 1;
            DemandSignalService.emit(
                'order_failure',
                'direct_order',
                err.medicine_id,
                req.body.area_id,
                req.user ? req.user.id : null,
                { quantity }
            );
        }
        next(err);
    }
});

/**
 * GET /orders/direct/:id
 */
router.get('/direct/:id', async (req, res, next) => {
    try {
        const userId = req.user ? req.user.id : null;
        const order = await DirectOrderService.getDirectOrder(req.params.id, userId);
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        res.status(200).json({ data: order });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
