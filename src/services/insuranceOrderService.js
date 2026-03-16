'use strict';
const { query } = require('../config/db');
const settingsCache = require('../config/settingsCache');
const MedicineService = require('./medicineService');

/**
 * InsuranceOrderService
 *
 * Handles insurance order creation (Flow C).
 * Mirrors DirectOrderService structure but enforces mandatory insurance context.
 * Does NOT extend or modify DirectOrderService.
 */
class InsuranceOrderService {

    /**
     * Creates a Flow C Insurance Order.
     * @param {string} userId - Account owner
     * @param {string} pharmacyId - Target pharmacy
     * @param {string} areaId - Delivery area
     * @param {string} patientProfileId - Patient identity
     * @param {Array} items - Array of { medicine_id, quantity }
     * @param {Object} docUrls - { prescription_image_url, insurance_approval_image_url }
     */
    static async createInsuranceOrder(userId, pharmacyId, areaId, patientProfileId, items, docUrls = {}) {
        // 0. Feature flag gate
        const enabled = settingsCache.getFlag('insurance_orders_enabled', 'global');
        if (!enabled) {
            const err = new Error('Insurance orders are currently unavailable');
            err.statusCode = 503;
            throw err;
        }

        if (!items || items.length === 0) {
            const err = new Error('Order must contain at least one item');
            err.statusCode = 400;
            throw err;
        }

        // 1. Resolve patient context
        const patientRes = await query(
            `SELECT pp.id, pp.insurance_profile_id, pp.user_id
             FROM patient_profiles pp
             WHERE pp.id = $1 AND pp.user_id = $2 AND pp.is_active = true`,
            [patientProfileId, userId]
        );
        if (patientRes.rowCount === 0) {
            const err = new Error('Patient profile not found or not owned');
            err.statusCode = 404;
            throw err;
        }

        const patient = patientRes.rows[0];
        if (!patient.insurance_profile_id) {
            const err = new Error('Patient profile has no linked insurance');
            err.statusCode = 422;
            throw err;
        }

        // 2. Resolve insurance context
        const insProfileRes = await query(
            `SELECT id, insurance_company_id FROM user_insurance_profiles WHERE id = $1 AND user_id = $2`,
            [patient.insurance_profile_id, userId]
        );
        if (insProfileRes.rowCount === 0) {
            const err = new Error('Insurance profile not found');
            err.statusCode = 422;
            throw err;
        }

        const insuranceProfileId = insProfileRes.rows[0].id;
        const insuranceCompanyId = insProfileRes.rows[0].insurance_company_id;

        // 3. Pharmacy + Area check
        const pharmacyCheck = await query(`
            SELECT p.id, p.is_active
            FROM pharmacies p
            JOIN pharmacy_delivery_areas pda ON pda.pharmacy_id = p.id
            WHERE p.id = $1 AND pda.area_id = $2
        `, [pharmacyId, areaId]);

        if (pharmacyCheck.rowCount === 0) {
            const err = new Error('Pharmacy does not serve this delivery area');
            err.statusCode = 422;
            throw err;
        }
        if (!pharmacyCheck.rows[0].is_active) {
            const err = new Error('Pharmacy is temporarily inactive');
            err.statusCode = 422;
            throw err;
        }

        // 4. Insurance contract check (mandatory)
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

        // 5. Item validation loop
        let totalPrice = 0;
        const resolvedItems = [];

        for (const reqItem of items) {
            const medicine = await MedicineService.getMedicine(reqItem.medicine_id);
            if (!medicine) {
                const err = new Error(`Item ${reqItem.medicine_id} is invalid or inactive`);
                err.statusCode = 422;
                throw err;
            }

            if (reqItem.quantity > medicine.max_order_qty) {
                const err = new Error(`Requested quantity for ${medicine.name} exceeds allowed limit of ${medicine.max_order_qty}`);
                err.statusCode = 422;
                throw err;
            }

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
                throw err;
            }

            totalPrice += parseFloat(inv.price) * reqItem.quantity;
            resolvedItems.push({
                medicine_id: reqItem.medicine_id,
                quantity: reqItem.quantity,
                price_snapshot: inv.price
            });
        }

        // 6. Insert order
        const commissionRate = settingsCache.getSetting('commission_rate_percent');
        const commissionAmount = (totalPrice * parseFloat(commissionRate)) / 100;

        const orderInsert = await query(`
            INSERT INTO orders (
                type, pharmacy_id, user_id, patient_profile_id,
                insurance_company_id, insurance_profile_id,
                total_price, delivery_fee,
                commission_rate, commission_amount,
                status
            ) VALUES (
                'insurance', $1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending'
            ) RETURNING id, created_at
        `, [
            pharmacyId, userId, patientProfileId,
            insuranceCompanyId, insuranceProfileId,
            totalPrice, 0,
            commissionRate, commissionAmount
        ]);

        const orderId = orderInsert.rows[0].id;
        const createdAt = orderInsert.rows[0].created_at;

        // 7. Insert order items
        for (const item of resolvedItems) {
            await query(`
                INSERT INTO order_items (order_id, medicine_id, quantity, price_snapshot)
                VALUES ($1, $2, $3, $4)
            `, [orderId, item.medicine_id, item.quantity, item.price_snapshot]);
        }

        // 8. Insert insurance documents (if any)
        if (docUrls.prescription_image_url || docUrls.insurance_approval_image_url) {
            await query(`
                INSERT INTO insurance_documents (order_id, prescription_image_url, insurance_approval_image_url)
                VALUES ($1, $2, $3)
            `, [orderId, docUrls.prescription_image_url || null, docUrls.insurance_approval_image_url || null]);
        }

        return {
            id: orderId,
            type: 'insurance',
            status: 'pending',
            total_price: totalPrice,
            items: resolvedItems,
            created_at: createdAt
        };
    }
}

module.exports = InsuranceOrderService;
