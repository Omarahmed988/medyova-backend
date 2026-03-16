'use strict';
const { query } = require('../config/db');
const settingsCache = require('../config/settingsCache');
const MedicineService = require('./medicineService');

class DirectOrderService {

    /**
     * Creates a Flow B Direct Order.
     * @param {string} userId - ID of the user creating the order
     * @param {string} pharmacyId - Target pharmacy
     * @param {string} areaId - Required context area for validation
     * @param {Array} items - Array of { medicine_id, quantity }
     * @param {string} insuranceCompanyId - Optional insurance context
     */
    static async createDirectOrder(userId, pharmacyId, areaId, items, insuranceCompanyId = null) {
        // 0. Feature flag gate
        const enabled = settingsCache.getFlag('medicine_search_enabled', 'global');
        if (!enabled) {
            const err = new Error('Medicine search and direct orders are currently unavailable');
            err.statusCode = 503;
            throw err;
        }

        if (!items || items.length === 0) {
            const err = new Error('Order must contain at least one item');
            err.statusCode = 400;
            throw err;
        }

        // 1. Validate Pharmacy & Area Routing Eligibility
        const pharmacyCheck = await query(`
            SELECT p.id, p.is_active 
            FROM pharmacies p
            JOIN pharmacy_delivery_areas pda ON pda.pharmacy_id = p.id
            WHERE p.id = $1 AND pda.area_id = $2
        `, [pharmacyId, areaId]);

        if (pharmacyCheck.rowCount === 0) {
            const err = new Error('Pharmacy does not serve this delivery area or does not exist');
            err.statusCode = 422;
            throw err;
        }
        if (!pharmacyCheck.rows[0].is_active) {
            const err = new Error('Pharmacy is temporarily inactive');
            err.statusCode = 422;
            throw err;
        }

        // 1.5 Validate Insurance Contract (If provided)
        if (insuranceCompanyId) {
            const contractCheck = await query(`
                SELECT contract_active
                FROM pharmacy_insurance_contracts
                WHERE pharmacy_id = $1 AND insurance_company_id = $2
            `, [pharmacyId, insuranceCompanyId]);

            if (contractCheck.rowCount === 0 || !contractCheck.rows[0].contract_active) {
                const err = new Error('Pharmacy does not have an active contract with the selected insurance company');
                err.statusCode = 422;
                throw err;
            }
        }

        // 2. Validate Items (Scarcity & Stock & Price Snapshot)
        // Check everything in a single loop to fail-fast the entire request
        let totalPrice = 0;
        const resolvedItems = [];

        for (const reqItem of items) {
            // Medicine metadata (for scarcity)
            const medicine = await MedicineService.getMedicine(reqItem.medicine_id);
            if (!medicine) {
                const err = new Error(`Item ${reqItem.medicine_id} is invalid or inactive`);
                err.statusCode = 422;
                throw err;
            }

            // Scarcity Enforcement
            if (reqItem.quantity > medicine.max_order_qty) {
                const err = new Error(`Requested quantity for ${medicine.name} exceeds allowed limit of ${medicine.max_order_qty}`);
                err.statusCode = 422;
                throw err;
            }

            // Inventory Check
            const invQuery = await query(`
                SELECT price, stock_status 
                FROM pharmacy_inventory 
                WHERE pharmacy_id = $1 AND medicine_id = $2
            `, [pharmacyId, reqItem.medicine_id]);

            if (invQuery.rowCount === 0) {
                const err = new Error(`${medicine.name} is not carried by this pharmacy`);
                err.statusCode = 422;
                throw err;
            }

            const inv = invQuery.rows[0];

            if (inv.stock_status === 'out_of_stock') {
                const err = new Error(`${medicine.name} is currently out of stock at this pharmacy`);
                err.statusCode = 422;
                err.code = 'STOCK_UNAVAILABLE';
                err.medicine_id = reqItem.medicine_id;
                throw err;
            }

            totalPrice += parseFloat(inv.price) * reqItem.quantity;
            resolvedItems.push({
                medicine_id: reqItem.medicine_id,
                quantity: reqItem.quantity,
                price_snapshot: inv.price
            });
        }

        // 3. Insert Order (No Transaction needed for MVP, auto-commits sequentially)
        const commissionRate = settingsCache.getSetting('commission_rate_percent');
        const commissionAmount = (totalPrice * parseFloat(commissionRate)) / 100;

        const orderInsert = await query(`
            INSERT INTO orders (
                type,
                pharmacy_id,
                user_id,
                total_price,
                delivery_fee,
                commission_rate,
                commission_amount,
                status,
                insurance_company_id
            ) VALUES (
                'direct', $1, $2, $3, $4, $5, $6, 'pending', $7
            ) RETURNING id
        `, [
            pharmacyId,
            userId || null,
            totalPrice,
            0, // MVP delivery fee is 0
            commissionRate,
            commissionAmount,
            insuranceCompanyId || null
        ]);

        const orderId = orderInsert.rows[0].id;

        // 4. Insert Order Items
        for (const item of resolvedItems) {
            await query(`
                INSERT INTO order_items (order_id, medicine_id, quantity, price_snapshot)
                VALUES ($1, $2, $3, $4)
            `, [orderId, item.medicine_id, item.quantity, item.price_snapshot]);
        }

        return {
            id: orderId,
            status: 'pending',
            total_price: totalPrice,
            items: resolvedItems
        };
    }

    /**
     * Reads a Flow B direct order with its items
     */
    static async getDirectOrder(orderId, userId) {
        const orderRes = await query(`
            SELECT id, type, pharmacy_id, user_id, total_price, status, created_at
            FROM orders
            WHERE id = $1 AND type = 'direct'
        `, [orderId]);

        if (orderRes.rowCount === 0) return null;

        const order = orderRes.rows[0];

        // Ensure user owns it
        if (order.user_id !== userId) {
            const err = new Error('Forbidden');
            err.statusCode = 403;
            throw err;
        }

        const itemsRes = await query(`
            SELECT i.id, i.medicine_id, m.name, i.quantity, i.price_snapshot
            FROM order_items i
            JOIN medicines m ON m.id = i.medicine_id
            WHERE i.order_id = $1
        `, [orderId]);

        order.items = itemsRes.rows;
        return order;
    }
}

module.exports = DirectOrderService;
