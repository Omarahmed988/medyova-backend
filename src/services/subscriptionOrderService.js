'use strict';
const { query } = require('../config/db');
const DirectOrderService = require('./directOrderService');
const InsuranceOrderService = require('./insuranceOrderService');

/**
 * SubscriptionOrderService
 *
 * Handles order generation from medicine subscriptions.
 * Delegates actual order creation to DirectOrderService (Flow B).
 */
class SubscriptionOrderService {

    /**
     * Process a single subscription: validate, generate order, update state.
     * @param {Object} sub - Subscription row from DB
     * @returns {Object} { status, order_id? }
     */
    static async processSubscription(sub) {
        // ────────────────────────────────────────────────
        // a. PHARMACY CHECK
        // ────────────────────────────────────────────────
        const pharmacyRes = await query(
            `SELECT is_active FROM pharmacies WHERE id = $1`,
            [sub.pharmacy_id]
        );
        if (pharmacyRes.rowCount === 0 || !pharmacyRes.rows[0].is_active) {
            await this._pauseSubscription(sub.id, 'Pharmacy is currently inactive');
            return { status: 'paused', reason: 'pharmacy_inactive' };
        }

        // ────────────────────────────────────────────────
        // b. AREA CHECK
        // ────────────────────────────────────────────────
        const areaRes = await query(
            `SELECT is_active FROM areas WHERE id = $1`,
            [sub.area_id]
        );
        if (areaRes.rowCount === 0 || !areaRes.rows[0].is_active) {
            await this._pauseSubscription(sub.id, 'Delivery area is currently inactive');
            return { status: 'paused', reason: 'area_inactive' };
        }

        // ────────────────────────────────────────────────
        // c. IDEMPOTENCY CHECK
        // ────────────────────────────────────────────────
        const existingOrder = await query(
            `SELECT id FROM orders WHERE subscription_id = $1 AND subscription_cycle_at = $2`,
            [sub.id, sub.next_run_at]
        );
        if (existingOrder.rowCount > 0) {
            // Already generated — just advance the schedule
            await this._advanceSchedule(sub);
            return { status: 'skipped', reason: 'idempotency' };
        }

        // ────────────────────────────────────────────────
        // d. LOAD ITEMS & STOCK CHECK
        // ────────────────────────────────────────────────
        const itemsRes = await query(
            `SELECT si.medicine_id, si.quantity, m.name AS medicine_name
             FROM subscription_items si
             JOIN medicines m ON m.id = si.medicine_id
             WHERE si.subscription_id = $1`,
            [sub.id]
        );

        for (const item of itemsRes.rows) {
            const inv = await query(
                `SELECT stock_status FROM pharmacy_inventory
                 WHERE pharmacy_id = $1 AND medicine_id = $2`,
                [sub.pharmacy_id, item.medicine_id]
            );
            if (inv.rowCount === 0 || inv.rows[0].stock_status === 'out_of_stock') {
                await this._pauseSubscription(sub.id, `Medicine out of stock: ${item.medicine_name}`);
                return { status: 'paused', reason: 'out_of_stock', medicine: item.medicine_name };
            }
        }

        // ────────────────────────────────────────────────
        // e. GENERATE ORDER — Branch by subscription type
        // ────────────────────────────────────────────────
        const orderItems = itemsRes.rows.map(i => ({
            medicine_id: i.medicine_id,
            quantity: i.quantity,
        }));

        let order;

        if (sub.type === 'insurance') {
            // Insurance contract check
            const contractRes = await query(
                `SELECT contract_active FROM pharmacy_insurance_contracts
                 WHERE pharmacy_id = $1 AND insurance_company_id = $2`,
                [sub.pharmacy_id, sub.insurance_company_id]
            );
            if (!contractRes.rowCount || !contractRes.rows[0].contract_active) {
                await this._pauseSubscription(sub.id, 'Pharmacy no longer accepts insurance company');
                return { status: 'paused', reason: 'insurance_contract_lost' };
            }

            order = await InsuranceOrderService.createInsuranceOrder(
                sub.user_id,
                sub.pharmacy_id,
                sub.area_id,
                sub.patient_profile_id,
                orderItems,
                {} // no documents for scheduler-generated orders
            );
        } else {
            order = await DirectOrderService.createDirectOrder(
                sub.user_id,
                sub.pharmacy_id,
                sub.area_id,
                orderItems
            );
        }

        // Stamp the idempotency columns on the generated order
        await query(
            `UPDATE orders SET subscription_id = $1, subscription_cycle_at = $2 WHERE id = $3`,
            [sub.id, sub.next_run_at, order.id]
        );

        // ────────────────────────────────────────────────
        // f. ADVANCE SCHEDULE (missed-run collapse)
        // ────────────────────────────────────────────────
        await query(
            `UPDATE subscriptions SET
                next_run_at = NOW() + (frequency_days || ' days')::INTERVAL,
                last_run_at = NOW(),
                last_order_id = $2,
                updated_at = NOW()
             WHERE id = $1`,
            [sub.id, order.id]
        );

        return { status: 'generated', order_id: order.id };
    }

    /**
     * Pause a subscription with a reason.
     */
    static async _pauseSubscription(subscriptionId, reason) {
        await query(
            `UPDATE subscriptions
             SET is_active = false,
                 pause_reason = $2,
                 updated_at = NOW()
             WHERE id = $1`,
            [subscriptionId, reason]
        );
    }

    /**
     * Advance schedule without generating an order (idempotency skip).
     */
    static async _advanceSchedule(sub) {
        await query(
            `UPDATE subscriptions SET
                next_run_at = NOW() + (frequency_days || ' days')::INTERVAL,
                updated_at = NOW()
             WHERE id = $1`,
            [sub.id]
        );
    }
}

module.exports = SubscriptionOrderService;
