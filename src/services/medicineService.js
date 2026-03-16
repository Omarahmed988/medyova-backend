'use strict';
const { query } = require('../config/db');

class MedicineService {

    /**
     * Checks if an area is selectable based on the Area Activation Rule.
     */
    static async validateAreaActivation(areaId) {
        const res = await query(`
            SELECT a.id AS area_id, a.name, a.founder_override,
                   COUNT(DISTINCT pda.pharmacy_id) AS pharmacy_count,
                   (a.founder_override OR COUNT(DISTINCT pda.pharmacy_id) >= 2) AS area_selectable
            FROM areas a
            LEFT JOIN pharmacy_delivery_areas pda ON pda.area_id = a.id
            LEFT JOIN pharmacies p ON p.id = pda.pharmacy_id AND p.is_active = true
            WHERE a.id = $1 AND a.is_active = true AND a.is_legacy = false
            GROUP BY a.id, a.name, a.founder_override
        `, [areaId]);

        if (res.rowCount === 0) return { valid: false, reason: 'Area not found or inactive' };

        const area = res.rows[0];
        if (!area.area_selectable) {
            return { valid: false, reason: 'This area is not currently active' };
        }

        return { valid: true };
    }

    /**
     * Search medicines filtered by delivery area and inventory freshness.
     * Reuses the trigram % similarity operator for exact/fuzzy searches.
     */
    static async searchMedicines(searchQuery, areaId, insuranceCompanyId = null) {
        // First check area activation rule
        const activationCheck = await this.validateAreaActivation(areaId);
        if (!activationCheck.valid) {
            const err = new Error(activationCheck.reason);
            err.statusCode = 400;
            throw err;
        }

        const params = [searchQuery, areaId];
        let insuranceFilter = '';
        if (insuranceCompanyId) {
            params.push(insuranceCompanyId);
            insuranceFilter = `
              AND EXISTS (
                  SELECT 1 FROM pharmacy_insurance_contracts pic
                  WHERE pic.pharmacy_id = p.id
                    AND pic.insurance_company_id = $3
                    AND pic.contract_active = true
              )
            `;
        }

        const res = await query(`
            SELECT m.id, m.name, m.generic_name, m.brand_name, m.form, m.strength,
                   m.is_shortage, m.max_order_qty,
                   p.id AS pharmacy_id, p.name AS pharmacy_name,
                   pi.price, pi.stock_status,
                   p.rating_avg, p.rating_count
            FROM medicines m
            JOIN pharmacy_inventory pi ON pi.medicine_id = m.id
            JOIN pharmacies p ON p.id = pi.pharmacy_id
            JOIN pharmacy_delivery_areas pda ON pda.pharmacy_id = p.id
            WHERE m.is_active = true
              AND p.is_active = true
              AND pda.area_id = $2
              AND pi.updated_at > NOW() - INTERVAL '48 hours'
              ${insuranceFilter}
              AND (
                   m.name        % $1
                OR m.generic_name % $1
                OR m.brand_name   % $1
              )
            ORDER BY similarity(m.name, $1) DESC, pi.price ASC
            LIMIT 10
        `, params);

        // Group by medicine
        const medicinesMap = {};
        for (const row of res.rows) {
            if (!medicinesMap[row.id]) {
                medicinesMap[row.id] = {
                    id: row.id,
                    name: row.name,
                    generic_name: row.generic_name,
                    brand_name: row.brand_name,
                    form: row.form,
                    strength: row.strength,
                    is_shortage: row.is_shortage,
                    max_order_qty: row.max_order_qty,
                    pharmacies: []
                };
            }

            // Limit 5 pharmacies per medicine
            if (medicinesMap[row.id].pharmacies.length < 5) {
                medicinesMap[row.id].pharmacies.push({
                    pharmacy_id: row.pharmacy_id,
                    pharmacy_name: row.pharmacy_name,
                    price: parseFloat(row.price),
                    stock_status: row.stock_status,
                    rating_avg: parseFloat(row.rating_avg),
                    rating_count: parseInt(row.rating_count, 10)
                });
            }
        }

        return Object.values(medicinesMap);
    }

    static async getMedicine(id) {
        const res = await query(`
            SELECT * FROM medicines WHERE id = $1 AND is_active = true
        `, [id]);
        if (res.rowCount === 0) return null;
        return res.rows[0];
    }

    static async getInventoryForPharmacy(pharmacyId) {
        const res = await query(`
            SELECT m.id AS medicine_id, m.name, pi.price, pi.stock_status, pi.updated_at
            FROM pharmacy_inventory pi
            JOIN medicines m ON m.id = pi.medicine_id
            WHERE pi.pharmacy_id = $1
            ORDER BY m.name ASC
        `, [pharmacyId]);
        return res.rows;
    }

    /**
     * Bulk JSON upsert flow (legacy/alternative to Excel pipeline)
     */
    static async upsertInventory(pharmacyId, items) {
        let inserted = 0;
        let updated = 0;

        for (const item of items) {
            const res = await query(`
                INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status, updated_at)
                VALUES ($1, $2, $3, $4, NOW())
                ON CONFLICT (pharmacy_id, medicine_id)
                DO UPDATE SET price = EXCLUDED.price,
                              stock_status = EXCLUDED.stock_status,
                              updated_at = NOW()
                RETURNING (xmax = 0) AS is_insert
            `, [pharmacyId, item.medicine_id, item.price, item.stock_status]);

            if (res.rows[0].is_insert) inserted++;
            else updated++;
        }

        return { inserted, updated };
    }
}

module.exports = MedicineService;
