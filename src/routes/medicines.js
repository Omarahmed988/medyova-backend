'use strict';
const express = require('express');
const router = express.Router();
const MedicineService = require('../services/medicineService');

/**
 * GET /medicines/search
 * Query params: q (string), area_id (uuid)
 */
router.get('/search', async (req, res, next) => {
    try {
        const { q, area_id, insurance_company_id } = req.query;

        if (!q || typeof q !== 'string') {
            return res.status(400).json({ error: 'Missing or invalid search query "q"' });
        }
        if (!area_id) {
            return res.status(400).json({ error: 'Missing mandatory parameter "area_id"' });
        }
        if (insurance_company_id) {
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(insurance_company_id)) {
                return res.status(400).json({ error: 'insurance_company_id must be a valid UUID' });
            }
        }

        const results = await MedicineService.searchMedicines(q, area_id, insurance_company_id);
        res.status(200).json({ data: results });

        // Phase 20 Strategy: search_miss
        setImmediate(async () => {
            try {
                const { query } = require('../config/db');
                const catalogMatch = await query(`
                    SELECT id FROM medicines
                    WHERE is_active = true
                      AND (name % $1 OR generic_name % $1 OR brand_name % $1)
                    ORDER BY similarity(name, $1) DESC
                    LIMIT 1
                `, [q]);

                if (catalogMatch.rows.length > 0) {
                    const medicineId = catalogMatch.rows[0].id;
                    const stockCheck = await query(`
                        SELECT 1 FROM pharmacy_inventory pi
                        JOIN pharmacy_delivery_areas pda ON pda.pharmacy_id = pi.pharmacy_id
                        WHERE pi.medicine_id = $1
                          AND pda.area_id    = $2
                          AND pi.stock_status = 'available'
                        LIMIT 1
                    `, [medicineId, area_id]);

                    if (stockCheck.rows.length === 0) {
                        const DemandSignalService = require('../services/demandSignalService');
                        DemandSignalService.emit('search_miss', 'medicine_search', medicineId, area_id, req.user?.id);
                    }
                }
            } catch (err) {
                console.warn('[Search Miss Hook] Error:', err.message);
            }
        });

    } catch (err) {
        next(err);
    }
});

/**
 * GET /medicines/:id
 */
router.get('/:id', async (req, res, next) => {
    try {
        const medicine = await MedicineService.getMedicine(req.params.id);
        if (!medicine) {
            return res.status(404).json({ error: 'Medicine not found' });
        }
        res.status(200).json({ data: medicine });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
