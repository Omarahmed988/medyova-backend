'use strict';
const { query } = require('../config/db');

class MarketplaceMonitorService {

    /**
     * Stale Inventory (> X hours)
     */
    static async getStaleInventory(thresholdHours = 48) {
        const res = await query(`
            SELECT p.id, p.name, MAX(pi.updated_at) AS last_sync
            FROM pharmacies p
            JOIN pharmacy_inventory pi ON pi.pharmacy_id = p.id
            WHERE p.is_active = true
            GROUP BY p.id, p.name
            HAVING MAX(pi.updated_at) < NOW() - INTERVAL '${thresholdHours} hours'
        `);
        return res.rows;
    }

    /**
     * Low Pharmacy Density Areas (< X active pharmacies)
     */
    static async getLowDensityAreas(minPharmacies = 2) {
        const res = await query(`
            SELECT a.name, a.id, COUNT(pda.pharmacy_id) AS active_pharmacies
            FROM areas a
            LEFT JOIN pharmacy_delivery_areas pda ON pda.area_id = a.id
            LEFT JOIN pharmacies p ON pda.pharmacy_id = p.id AND p.is_active = true
            WHERE a.is_active = true AND a.founder_override = false
            GROUP BY a.id, a.name
            HAVING COUNT(pda.pharmacy_id) < $1
        `, [minPharmacies]);
        return res.rows;
    }

    /**
     * Fragile Medicine Supply (Coverage < X pharmacies)
     */
    static async getFragileMedicines(minCoverage = 2) {
        const res = await query(`
            SELECT
                m.id,
                m.name,
                COUNT(DISTINCT pi.pharmacy_id) AS pharmacies_with_medicine
            FROM medicines m
            JOIN pharmacy_inventory pi ON pi.medicine_id = m.id
            JOIN pharmacies p ON p.id = pi.pharmacy_id
            WHERE p.is_active = true
            GROUP BY m.id, m.name
            HAVING COUNT(DISTINCT pi.pharmacy_id) < $1
        `, [minCoverage]);
        return res.rows;
    }

    /**
     * Pharmacy Inventory Health Scores
     */
    static async getPharmacyInventoryHealthScores() {
        // Mock query calculating the components of the health score.
        // A full implementation would use a materialized view or complex windowed query.
        const res = await query(`
            WITH upload_stats AS (
                SELECT 
                    pharmacy_id,
                    COUNT(*) as uploads_last_7d
                FROM inventory_upload_logs
                WHERE created_at > NOW() - INTERVAL '7 days'
                GROUP BY pharmacy_id
            ),
            catalog_stats AS (
                SELECT
                    pharmacy_id,
                    COUNT(medicine_id) as catalog_size,
                    MAX(updated_at) as last_sync
                FROM pharmacy_inventory
                GROUP BY pharmacy_id
            )
            SELECT 
                p.id, p.name,
                COALESCE(u.uploads_last_7d, 0) as weekly_uploads,
                COALESCE(c.catalog_size, 0) as catalog_size,
                c.last_sync,
                -- Example Scoring Logic (0-100)
                LEAST(100, (
                    (COALESCE(u.uploads_last_7d, 0) * 10) +
                    (CASE WHEN c.last_sync > NOW() - INTERVAL '48 hours' THEN 40 ELSE 0 END) +
                    (LEAST(COALESCE(c.catalog_size, 0) / 10.0, 50))
                ))::integer AS health_score
            FROM pharmacies p
            LEFT JOIN upload_stats u ON u.pharmacy_id = p.id
            LEFT JOIN catalog_stats c ON c.pharmacy_id = p.id
            WHERE p.is_active = true
            ORDER BY health_score ASC;
        `);
        return res.rows;
    }

    /**
     * Unmatched Medicines Log for Dashboard
     */
    static async getUnmatchedMedicinesLog(limit = 50, offset = 0) {
        const res = await query(`
            SELECT id, raw_name, frequency_count, pharmacy_id, updated_at
            FROM unmatched_medicines_log
            ORDER BY frequency_count DESC, updated_at DESC
            LIMIT $1 OFFSET $2
        `, [limit, offset]);
        return res.rows;
    }

    /**
     * Delete an unmatched medicine log (after it's mapped)
     */
    static async clearUnmatchedLog(rawName) {
        await query(`DELETE FROM unmatched_medicines_log WHERE raw_name = $1`, [rawName]);
    }
}

module.exports = MarketplaceMonitorService;
