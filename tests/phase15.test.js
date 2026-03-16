'use strict';
require('dotenv').config({ path: '.env.dev' });
const request = require('supertest');
const app = require('../src/app');
const { pool, query } = require('../src/config/db');
const { scanCatalog } = require('../src/workers/catalog-duplicate-scanner');
const MarketplaceMonitorService = require('../src/services/marketplaceMonitorService');

// Bypass JWT middleware for testing admin routes
jest.mock('../src/middlewares/requireAuth', () => (req, res, next) => {
    req.user = req.headers['x-mock-user'] ? JSON.parse(req.headers['x-mock-user']) : null;
    if (!req.user) return res.status(401).json({ error: 'unauthorized mock' });
    next();
});

const SUPER_ADMIN = JSON.stringify({ id: '00000000-0000-0000-0000-000000000099', role: 'super_admin' });

describe('Phase 15: Launch Hardening Tools', () => {

    let med1, med2, med3, pharmacy1, areaId, zoneId, tierId;

    beforeAll(async () => {
        // Create a test user for audit logging (role is set via mock header, not DB)
        await query(`INSERT INTO users (id, phone, full_name) VALUES ('00000000-0000-0000-0000-000000000099', '+96599999999', 'Test Admin') ON CONFLICT (id) DO NOTHING`);

        const zoneRes = await query(`INSERT INTO zones (name, city) VALUES ('P15 Zone', 'TestCity') RETURNING id`);
        zoneId = zoneRes.rows[0].id;

        const areaRes = await query(`INSERT INTO areas (zone_id, name, founder_override, is_active) VALUES ($1, 'P15 Area', true, true) RETURNING id`, [zoneId]);
        areaId = areaRes.rows[0].id;

        let tierRes = await query(`SELECT id FROM tiers LIMIT 1`);
        if (tierRes.rowCount > 0) {
            tierId = tierRes.rows[0].id;
        } else {
            tierRes = await query(`INSERT INTO tiers (name, rank) VALUES ('P15 Tier', 999) RETURNING id`);
            tierId = tierRes.rows[0].id;
        }

        const phResult = await query(`INSERT INTO pharmacies (name, zone_id, tier_id, is_active) VALUES ('P15 Pharmacy', $1, $2, true) RETURNING id`, [zoneId, tierId]);
        pharmacy1 = phResult.rows[0].id;

        // Two extremely similar medicines for the scanner to detect (similarity ~0.93)
        const m1 = await query(`INSERT INTO medicines (name, is_active) VALUES ('Panadol Extra Strength 500mg Tablet', true) RETURNING id`);
        med1 = m1.rows[0].id;

        const m2 = await query(`INSERT INTO medicines (name, is_active) VALUES ('Panadol Extra Strength 500mg Tablets', true) RETURNING id`);
        med2 = m2.rows[0].id;

        // Distinct medicine
        const m3 = await query(`INSERT INTO medicines (name, is_active) VALUES ('Ibuprofen P15 200mg', true) RETURNING id`);
        med3 = m3.rows[0].id;
    });

    afterAll(async () => {
        // Explicit cleanup in reverse dependency order
        await query(`DELETE FROM catalog_duplicates_report WHERE medicine_a_id IN ($1, $2) OR medicine_b_id IN ($1, $2)`, [med1, med2]);
        await query(`DELETE FROM unmatched_medicines_log WHERE pharmacy_id = $1`, [pharmacy1]);
        await query(`DELETE FROM inventory_upload_logs WHERE pharmacy_id = $1`, [pharmacy1]);
        await query(`DELETE FROM medicine_aliases WHERE medicine_id IN ($1, $2, $3)`, [med1, med2, med3]);
        await query(`DELETE FROM pharmacy_inventory WHERE pharmacy_id = $1`, [pharmacy1]);
        await query(`DELETE FROM order_items WHERE medicine_id IN ($1, $2, $3)`, [med1, med2, med3]);
        await query(`DELETE FROM pharmacy_delivery_areas WHERE pharmacy_id = $1`, [pharmacy1]);
        await query(`DELETE FROM medicines WHERE id IN ($1, $2, $3)`, [med1, med2, med3]);
        await query(`DELETE FROM pharmacies WHERE id = $1`, [pharmacy1]);
        await query(`DELETE FROM areas WHERE id = $1`, [areaId]);
        await query(`DELETE FROM zones WHERE id = $1`, [zoneId]);
        await pool.end();
    });

    describe('Admin Area Mappings', () => {
        it('assigns a pharmacy to a delivery area', async () => {
            const res = await request(app)
                .post(`/admin/pharmacies/${pharmacy1}/areas`)
                .set('x-mock-user', SUPER_ADMIN)
                .send({ area_id: areaId });

            expect(res.status).toBe(201);

            const pda = await query(`SELECT * FROM pharmacy_delivery_areas WHERE pharmacy_id = $1 AND area_id = $2`, [pharmacy1, areaId]);
            expect(pda.rowCount).toBe(1);
        });

        it('removes a pharmacy from a delivery area', async () => {
            const res = await request(app)
                .delete(`/admin/pharmacies/${pharmacy1}/areas/${areaId}`)
                .set('x-mock-user', SUPER_ADMIN);

            expect(res.status).toBe(200);

            const pda = await query(`SELECT * FROM pharmacy_delivery_areas WHERE pharmacy_id = $1 AND area_id = $2`, [pharmacy1, areaId]);
            expect(pda.rowCount).toBe(0);
        });
    });

    describe('Duplicate Catalog Scanner', () => {
        it('identifies and inserts duplicates correctly (>0.85 similarity)', async () => {
            await scanCatalog();

            const report = await query(`SELECT * FROM catalog_duplicates_report WHERE (medicine_a_id = $1 AND medicine_b_id = $2) OR (medicine_a_id = $2 AND medicine_b_id = $1)`, [med1, med2]);

            expect(report.rowCount).toBe(1);
            expect(report.rows[0].is_resolved).toBe(false);
            expect(parseFloat(report.rows[0].similarity_score)).toBeGreaterThan(0.85);
        }, 30000);
    });

    describe('Admin Medicine Merge Cascade', () => {
        it('merges med2 into med1, creating an alias and deactivating med2', async () => {
            // First, bind some inventory to med2
            await query(`INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price) VALUES ($1, $2, 50.0) ON CONFLICT DO NOTHING`, [pharmacy1, med2]);

            const res = await request(app)
                .post('/admin/medicines/merge')
                .set('x-mock-user', SUPER_ADMIN)
                .send({ source_id: med2, target_id: med1 });

            expect(res.status).toBe(200);

            // 1. Inventory should be re-pointed to med1
            const inv = await query(`SELECT * FROM pharmacy_inventory WHERE pharmacy_id = $1 AND medicine_id = $2`, [pharmacy1, med1]);
            expect(inv.rowCount).toBe(1);

            // 2. Med2 should be inactive
            const m2State = await query(`SELECT is_active, name FROM medicines WHERE id = $1`, [med2]);
            expect(m2State.rows[0].is_active).toBe(false);

            // 3. An alias for med2's name should now point to med1
            const alias = await query(`SELECT * FROM medicine_aliases WHERE medicine_id = $1 AND alias = $2`, [med1, m2State.rows[0].name]);
            expect(alias.rowCount).toBe(1);

            // 4. Duplicate report should be resolved
            const report = await query(`SELECT is_resolved FROM catalog_duplicates_report WHERE (medicine_a_id = $1 AND medicine_b_id = $2) OR (medicine_a_id = $2 AND medicine_b_id = $1)`, [med1, med2]);
            expect(report.rows[0].is_resolved).toBe(true);
        });
    });

    describe('Unmatched Medicine Flow', () => {
        it('logs an unmatched medicine on explicit insert', async () => {
            await query(`INSERT INTO unmatched_medicines_log (pharmacy_id, raw_name, frequency_count) VALUES ($1, 'Mysterious Drug P15', 1)`, [pharmacy1]);

            const results = await MarketplaceMonitorService.getUnmatchedMedicinesLog();
            expect(results.length).toBeGreaterThan(0);
            expect(results.some(r => r.raw_name === 'Mysterious Drug P15')).toBe(true);
        });

        it('clears it when bulk mapped', async () => {
            const res = await request(app)
                .post(`/admin/medicines/${med3}/aliases/bulk`)
                .set('x-mock-user', SUPER_ADMIN)
                .send({ aliases: ['Mysterious Drug P15', 'Ibu P15 200'] });

            expect(res.status).toBe(201);

            // Verify unmatched log is cleared
            const cleared = await query(`SELECT * FROM unmatched_medicines_log WHERE raw_name = 'Mysterious Drug P15'`);
            expect(cleared.rowCount).toBe(0);
        });
    });
});
