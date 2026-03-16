'use strict';

/**
 * src/routes/subscriptions.js
 * Phase 16 — Medicine Subscription Management API
 *
 * CRUD endpoints for medicine subscriptions (Flow B recurring orders).
 * All endpoints require authentication and enforce ownership.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const settingsCache = require('../config/settingsCache');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════════════════════════════════════════════════════════════════
// POST /subscriptions — Create a new medicine subscription
// ═══════════════════════════════════════════════════════════════════════════
router.post('/', async (req, res, next) => {
    try {
        // Feature flag
        const enabled = settingsCache.getFlag('medicine_subscriptions_enabled', 'global');
        if (!enabled) {
            return res.status(503).json({ error: 'Medicine subscriptions are currently unavailable' });
        }

        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const { pharmacy_id, area_id, frequency_days, items } = req.body;

        // Validate inputs
        if (!UUID_RE.test(pharmacy_id)) return res.status(400).json({ error: 'pharmacy_id must be a valid UUID' });
        if (!UUID_RE.test(area_id)) return res.status(400).json({ error: 'area_id must be a valid UUID' });
        if (!Number.isInteger(frequency_days) || frequency_days < 7 || frequency_days > 90) {
            return res.status(400).json({ error: 'frequency_days must be an integer between 7 and 90' });
        }
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'items must be a non-empty array' });
        }

        // Validate pharmacy serves the area
        const pharmacyCheck = await query(`
            SELECT p.id, p.is_active, p.zone_id
            FROM pharmacies p
            JOIN pharmacy_delivery_areas pda ON pda.pharmacy_id = p.id
            WHERE p.id = $1 AND pda.area_id = $2
        `, [pharmacy_id, area_id]);

        if (pharmacyCheck.rowCount === 0) {
            return res.status(422).json({ error: 'Pharmacy does not serve this delivery area' });
        }
        if (!pharmacyCheck.rows[0].is_active) {
            return res.status(422).json({ error: 'Pharmacy is currently inactive' });
        }

        // Validate items
        for (const item of items) {
            if (!UUID_RE.test(item.medicine_id)) {
                return res.status(400).json({ error: `Invalid medicine_id: ${item.medicine_id}` });
            }
            if (!Number.isInteger(item.quantity) || item.quantity < 1) {
                return res.status(400).json({ error: 'Each item must have a positive integer quantity' });
            }

            // Medicine exists & active
            const med = await query(`SELECT id, max_order_qty FROM medicines WHERE id = $1 AND is_active = true`, [item.medicine_id]);
            if (med.rowCount === 0) {
                return res.status(422).json({ error: `Medicine ${item.medicine_id} is invalid or inactive` });
            }

            // Scarcity check
            if (item.quantity > med.rows[0].max_order_qty) {
                return res.status(422).json({ error: `Quantity exceeds max allowed (${med.rows[0].max_order_qty}) for this medicine` });
            }

            // Pharmacy carries this medicine
            const inv = await query(`
                SELECT id FROM pharmacy_inventory WHERE pharmacy_id = $1 AND medicine_id = $2
            `, [pharmacy_id, item.medicine_id]);
            if (inv.rowCount === 0) {
                return res.status(422).json({ error: `Pharmacy does not carry medicine ${item.medicine_id}` });
            }
        }

        const zone_id = pharmacyCheck.rows[0].zone_id;

        // Create subscription
        const subRes = await query(`
            INSERT INTO subscriptions (
                user_id, type, pharmacy_id, area_id, zone_id, frequency_days, 
                contact_phone, preferred_day_of_month,
                next_run_at, is_active
            ) VALUES (
                $1, 'medicine', $2, $3, $4, $5,
                $6, 1,
                NOW() + INTERVAL '${frequency_days} days', true
            ) RETURNING id, next_run_at, created_at
        `, [req.user.id, pharmacy_id, area_id, zone_id, frequency_days, req.user.phone || '+0000000000']);

        const subscription = subRes.rows[0];

        // Insert items
        for (const item of items) {
            await query(`
                INSERT INTO subscription_items (subscription_id, medicine_id, product_name, quantity)
                VALUES ($1, $2, (SELECT name FROM medicines WHERE id = $2), $3)
            `, [subscription.id, item.medicine_id, item.quantity]);
        }

        return res.status(201).json({
            id: subscription.id,
            status: 'active',
            next_run_at: subscription.next_run_at,
            created_at: subscription.created_at,
        });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /subscriptions — List user's medicine subscriptions
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const result = await query(`
            SELECT s.id, s.pharmacy_id, s.area_id, s.frequency_days, 
                   s.is_active, s.pause_reason, s.next_run_at, s.last_run_at,
                   s.last_order_id, s.created_at, s.updated_at,
                   json_agg(json_build_object(
                       'id', si.id,
                       'medicine_id', si.medicine_id,
                       'product_name', si.product_name,
                       'quantity', si.quantity
                   )) AS items
            FROM subscriptions s
            LEFT JOIN subscription_items si ON si.subscription_id = s.id
            WHERE s.user_id = $1 AND s.type = 'medicine'
            GROUP BY s.id
            ORDER BY s.created_at DESC
        `, [req.user.id]);

        return res.status(200).json({ subscriptions: result.rows });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// PATCH /subscriptions/:id — Update subscription
// ═══════════════════════════════════════════════════════════════════════════
router.patch('/:id', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid subscription ID' });

        // Ownership check
        const subRes = await query(
            `SELECT id, user_id, is_active, type FROM subscriptions WHERE id = $1 AND type = 'medicine'`,
            [req.params.id]
        );
        if (subRes.rowCount === 0) return res.status(404).json({ error: 'Subscription not found' });
        if (subRes.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

        const updates = [];
        const values = [];
        let paramIdx = 1;

        // frequency_days
        if (req.body.frequency_days !== undefined) {
            const fd = req.body.frequency_days;
            if (!Number.isInteger(fd) || fd < 7 || fd > 90) {
                return res.status(400).json({ error: 'frequency_days must be between 7 and 90' });
            }
            updates.push(`frequency_days = $${paramIdx++}`);
            values.push(fd);
        }

        // Resume from paused
        if (req.body.is_active === true && !subRes.rows[0].is_active) {
            updates.push(`is_active = true`);
            updates.push(`pause_reason = NULL`);
            updates.push(`next_run_at = NOW() + (frequency_days || ' days')::INTERVAL`);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        updates.push(`updated_at = NOW()`);
        values.push(req.params.id);

        await query(
            `UPDATE subscriptions SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
            values
        );

        return res.status(200).json({ status: 'updated' });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// DELETE /subscriptions/:id — Cancel subscription (soft delete)
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:id', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
        if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid subscription ID' });

        // Ownership check
        const subRes = await query(
            `SELECT id, user_id FROM subscriptions WHERE id = $1 AND type = 'medicine'`,
            [req.params.id]
        );
        if (subRes.rowCount === 0) return res.status(404).json({ error: 'Subscription not found' });
        if (subRes.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

        await query(
            `UPDATE subscriptions SET is_active = false, pause_reason = 'Cancelled by user', updated_at = NOW() WHERE id = $1`,
            [req.params.id]
        );

        return res.status(200).json({ status: 'cancelled' });
    } catch (err) {
        next(err);
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /subscriptions/from-order — Create subscription from a completed order
// ═══════════════════════════════════════════════════════════════════════════
router.post('/from-order', async (req, res, next) => {
    try {
        if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

        const { order_id, frequency_days } = req.body;

        if (!order_id || !UUID_RE.test(order_id)) {
            return res.status(400).json({ error: 'order_id must be a valid UUID' });
        }
        if (!Number.isInteger(frequency_days) || frequency_days < 7 || frequency_days > 90) {
            return res.status(400).json({ error: 'frequency_days must be an integer between 7 and 90' });
        }

        // Load order with ownership check
        const orderRes = await query(`
            SELECT o.id, o.type, o.pharmacy_id, o.user_id, o.status,
                   o.insurance_company_id, o.insurance_profile_id, o.patient_profile_id,
                   p.zone_id
            FROM orders o
            JOIN pharmacies p ON p.id = o.pharmacy_id
            WHERE o.id = $1 AND o.user_id = $2
        `, [order_id, req.user.id]);

        if (orderRes.rowCount === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }

        const order = orderRes.rows[0];

        // Guard: only completed orders
        if (order.status !== 'completed') {
            return res.status(422).json({ error: 'Subscriptions can only be created from completed orders' });
        }

        // Determine subscription type from order type
        const subType = order.type === 'insurance' ? 'insurance' : 'medicine';

        // Feature flag for insurance subscriptions
        if (subType === 'insurance') {
            const insSubEnabled = settingsCache.getFlag('insurance_subscriptions_enabled', 'global');
            if (!insSubEnabled) {
                return res.status(503).json({ error: 'Insurance subscriptions are currently unavailable' });
            }
        }

        // Load order items
        const itemsRes = await query(`
            SELECT oi.medicine_id, oi.quantity, m.name AS product_name
            FROM order_items oi
            JOIN medicines m ON m.id = oi.medicine_id
            WHERE oi.order_id = $1
        `, [order_id]);

        if (itemsRes.rowCount === 0) {
            return res.status(422).json({ error: 'Order has no items' });
        }

        // Resolve area from pharmacy delivery areas
        const areaRes = await query(
            `SELECT area_id FROM pharmacy_delivery_areas WHERE pharmacy_id = $1 LIMIT 1`,
            [order.pharmacy_id]
        );
        const areaId = areaRes.rowCount > 0 ? areaRes.rows[0].area_id : null;

        // Create subscription
        const subRes = await query(`
            INSERT INTO subscriptions (
                user_id, type, pharmacy_id, area_id, zone_id, frequency_days,
                contact_phone, preferred_day_of_month,
                insurance_company_id, insurance_profile_id, patient_profile_id,
                next_run_at, is_active
            ) VALUES (
                $1, $2, $3, $4, $5, $6,
                $7, 1,
                $8, $9, $10,
                NOW() + INTERVAL '${frequency_days} days', true
            ) RETURNING id, next_run_at, created_at
        `, [
            req.user.id, subType, order.pharmacy_id, areaId, order.zone_id, frequency_days,
            req.user.phone || '+0000000000',
            order.insurance_company_id || null,
            order.insurance_profile_id || null,
            order.patient_profile_id || null
        ]);

        const subscription = subRes.rows[0];

        // Insert subscription items
        for (const item of itemsRes.rows) {
            await query(`
                INSERT INTO subscription_items (subscription_id, medicine_id, product_name, quantity)
                VALUES ($1, $2, $3, $4)
            `, [subscription.id, item.medicine_id, item.product_name, item.quantity]);
        }

        return res.status(201).json({
            id: subscription.id,
            type: subType,
            status: 'active',
            next_run_at: subscription.next_run_at,
            created_at: subscription.created_at,
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
