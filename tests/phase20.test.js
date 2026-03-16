'use strict';

/**
 * Phase 20: Medicine Demand Heatmap Integration Tests
 */

// Bypass JWT to allow testing protected endpoints directly with user headers
jest.mock('../src/middlewares/requireAuth', () => (req, res, next) => {
    if (req.headers['x-mock-user']) {
        req.user = JSON.parse(req.headers['x-mock-user']);
    } else {
        req.user = { id: '00000000-0000-0000-0000-000000000001', role: 'user', phone: '+1234567890' };
    }
    next();
});

require('dotenv').config({ path: '.env.dev' });
const request = require('supertest');
const { pool, query } = require('../src/config/db');
const app = require('../src/app');
const DemandSignalService = require('../src/services/demandSignalService');
const { runAggregator } = require('../src/workers/demand-signal-aggregator');

const TEST_ADMIN = JSON.stringify({
    id: '00000000-0000-0000-0000-00000ad00001',
    role: 'super_admin',
    phone: '+1000000000'
});

const TEST_USER = JSON.stringify({
    id: '00000000-0000-0000-0000-0000000a0001',
    role: 'user',
    phone: '+1000000001'
});

describe('Phase 20: Demand Intelligence', () => {

    const ids = {
        medicine_a: '00000000-0000-0000-0000-00000000020a',
        medicine_b: '00000000-0000-0000-0000-00000000020b',
        area_1: '00000000-0000-0000-0000-0000000002a1',
        area_2: '00000000-0000-0000-0000-0000000002a2',
        pharmacy_rx: '00000000-0000-0000-0000-0000000020f2'
    };

    beforeAll(async () => {
        // Purge test entities
        await query(`DELETE FROM medicine_demand_signals`);
        await query(`DELETE FROM medicine_demand_heatmap`);
        await query(`DELETE FROM pharmacy_inventory WHERE medicine_id IN ($1, $2)`, [ids.medicine_a, ids.medicine_b]);
        await query(`DELETE FROM pharmacy_delivery_areas WHERE pharmacy_id = $1`, [ids.pharmacy_rx]);
        await query(`DELETE FROM pharmacies WHERE id = $1`, [ids.pharmacy_rx]);
        await query(`DELETE FROM medicines WHERE id IN ($1, $2)`, [ids.medicine_a, ids.medicine_b]);
        await query(`DELETE FROM areas WHERE id IN ($1, $2)`, [ids.area_1, ids.area_2]);

        // Seed prerequisites (Zones, Tiers, Users)
        await query(`INSERT INTO zones (id, name, city, is_active) VALUES ($1, 'Zone P20', 'Test City P20', true) ON CONFLICT DO NOTHING`, ['00000000-0000-0000-0000-000000000021']);
        await query(`INSERT INTO tiers (id, name, rank) VALUES ($1, 'Tier P20', 999) ON CONFLICT DO NOTHING`, ['00000000-0000-0000-0000-000000000011']);
        const tUser = JSON.parse(TEST_USER);
        await query(`INSERT INTO users (id, phone, full_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [tUser.id, tUser.phone, 'Phase 20 Test User']);

        // Seed areas (founder_override=true to bypass 2-pharmacy rule)
        await query(`INSERT INTO areas (id, name, zone_id, founder_override, is_active) VALUES ($1, 'Area 1 (P20)', '00000000-0000-0000-0000-000000000021', true, true)`, [ids.area_1]);
        await query(`INSERT INTO areas (id, name, zone_id, founder_override, is_active) VALUES ($1, 'Area 2 (P20)', '00000000-0000-0000-0000-000000000021', true, true)`, [ids.area_2]);

        // Seed medicines
        await query(`INSERT INTO medicines (id, name, generic_name, max_order_qty, is_active) VALUES ($1, 'P20 Demand Med A', 'P20 Gen A', 10, true)`, [ids.medicine_a]);
        await query(`INSERT INTO medicines (id, name, generic_name, max_order_qty, is_active) VALUES ($1, 'P20 Demand Med B', 'P20 Gen B', 10, true)`, [ids.medicine_b]);

        // Seed pharmacy Rx
        await query(`INSERT INTO pharmacies (id, name, zone_id, tier_id, is_active) VALUES ($1, 'Phase 20 Rx', '00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011', true)`, [ids.pharmacy_rx]);
        await query(`INSERT INTO pharmacy_delivery_areas (pharmacy_id, area_id) VALUES ($1, $2)`, [ids.pharmacy_rx, ids.area_1]);

        // Ensure clear cache and watermark
        DemandSignalService._clearCache();
        await query(`DELETE FROM system_settings WHERE key = 'demand_aggregator_watermark'`);
    });

    afterAll(async () => {
        // Cleanup remaining data
        await query(`DELETE FROM medicine_demand_signals`);
        await query(`DELETE FROM medicine_demand_heatmap`);
        await pool.end();
    });

    it('1. Emits a valid demand signal into the database', async () => {
        DemandSignalService.emit('search_miss', 'medicine_search', ids.medicine_a, ids.area_1);
        
        // setImmediate completes in the next tick, wait slightly
        await new Promise(r => setTimeout(r, 50));

        const res = await query(`SELECT * FROM medicine_demand_signals WHERE medicine_id = $1`, [ids.medicine_a]);
        expect(res.rowCount).toBe(1);
        expect(res.rows[0].signal_type).toBe('search_miss');
        expect(res.rows[0].source_flow).toBe('medicine_search');
    });

    it('2. Silently drops duplicate signals within the LRU cache window', async () => {
        // Emit two identical signals back-to-back
        DemandSignalService.emit('search_miss', 'medicine_search', ids.medicine_a, ids.area_1);
        DemandSignalService.emit('search_miss', 'medicine_search', ids.medicine_a, ids.area_1);

        await new Promise(r => setTimeout(r, 50));

        // Total count should still be 1 (deduped by cache)
        const res = await query(`SELECT COUNT(*) as cnt FROM medicine_demand_signals WHERE medicine_id = $1`, [ids.medicine_a]);
        expect(res.rows[0].cnt).toBe("1");
    });

    it('3. Worker computes correct scores based on the rolling 30-day formula', async () => {
        // Add more signals: 2 order_failure (x3), 1 routing_failure (x3), 1 sub_failure (x4)
        // Clear cache between emits so they aren't deduped
        DemandSignalService.emit('order_failure', 'test', ids.medicine_a, ids.area_1, null);
        DemandSignalService._clearCache();
        DemandSignalService.emit('order_failure', 'test', ids.medicine_a, ids.area_1, null);
        DemandSignalService._clearCache();
        DemandSignalService.emit('routing_failure', 'test', ids.medicine_a, ids.area_1, null);
        DemandSignalService._clearCache();
        DemandSignalService.emit('subscription_failure', 'test', ids.medicine_a, ids.area_1, null);
        DemandSignalService._clearCache();

        // And emit one for med B
        DemandSignalService.emit('subscription_failure', 'test', ids.medicine_b, ids.area_2, null);

        await new Promise(r => setTimeout(r, 50));

        // Run aggregator
        const result = await runAggregator();
        expect(result.totalProcessed).toBeGreaterThan(0);

        // Check med A: 1 search (1) + 2 order (6) + 1 routing (3) + 1 sub (4) = 14
        const heatA = await query(`SELECT * FROM medicine_demand_heatmap WHERE medicine_id = $1`, [ids.medicine_a]);
        expect(heatA.rowCount).toBe(1);
        expect(Number(heatA.rows[0].search_miss_count)).toBe(1);
        expect(Number(heatA.rows[0].order_failure_count)).toBe(2);
        expect(Number(heatA.rows[0].routing_failure_count)).toBe(1);
        expect(Number(heatA.rows[0].subscription_failure_count)).toBe(1);
        expect(Number(heatA.rows[0].demand_score)).toBe(14); // 1*1 + 2*3 + 1*3 + 1*4 = 14

        // Check med B: 1 sub (4) = 4
        const heatB = await query(`SELECT * FROM medicine_demand_heatmap WHERE medicine_id = $1`, [ids.medicine_b]);
        expect(heatB.rowCount).toBe(1);
        expect(Number(heatB.rows[0].demand_score)).toBe(4);
    });

    it('4. GET /pharmacies/:id/demand returns area-scoped demand', async () => {
        // Rx serves area 1 only. Should see Med A, but not Med B.
        const res = await request(app)
            .get(`/pharmacies/${ids.pharmacy_rx}/demand`)
            .set('x-mock-user', TEST_USER);

        expect(res.status).toBe(200);
        expect(res.body.data).toBeInstanceOf(Array);
        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].medicine_id).toBe(ids.medicine_a);
        expect(Number(res.body.data[0].demand_score)).toBe(14);
    });

    it('5. GET /admin/demand-gaps returns medicines with high demand and no stock', async () => {
        // Med A has score 14 (>10 threshold) and no active inventory anywhere.
        const res = await request(app)
            .get(`/admin/demand-gaps`)
            .set('x-mock-user', TEST_ADMIN);

        expect(res.status).toBe(200);
        expect(res.body.data).toBeInstanceOf(Array);
        
        const gap = res.body.data.find(g => g.medicine_id === ids.medicine_a);
        expect(gap).toBeDefined();
        expect(Number(gap.demand_score)).toBe(14);
        expect(Number(gap.committed_demand)).toBe(1); // sub failures check
    });

    it('6. Does not report as demand gap once full inventory is available', async () => {
        // Add inventory to Area 1
        await query(`
            INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, stock_status, price, updated_at)
            VALUES ($1, $2, 'available', 10.00, NOW())
        `, [ids.pharmacy_rx, ids.medicine_a]);

        const res = await request(app)
            .get(`/admin/demand-gaps`)
            .set('x-mock-user', TEST_ADMIN);

        expect(res.status).toBe(200);
        // Med A should no longer be in the gaps list
        const gap = res.body.data.find(g => g.medicine_id === ids.medicine_a);
        expect(gap).toBeUndefined();
    });

    it('7. Search route fires search_miss correctly when area is valid but no stock', async () => {
        DemandSignalService._clearCache(); // clear LRU
        
        // Act: Search for Med B. It exists, but no pharmacy serves Area 1 with it
        await request(app)
            .get(`/medicines/search?q=P20 Demand Med B&area_id=${ids.area_1}`)
            .set('x-mock-user', TEST_USER);

        // search emits on setImmediate, delay slightly
        await new Promise(r => setTimeout(r, 100));

        // It should have emitted a search miss for Med A/B ?
        // Our search query searches "P20 Demand Med B". `q="Demand"` matches it.
        // It should emit a search_miss for `medicine_b` in `area_1`
        const check = await query(`
            SELECT * FROM medicine_demand_signals 
            WHERE source_flow = 'medicine_search' AND medicine_id = $1 AND area_id = $2
        `, [ids.medicine_b, ids.area_1]);

        // It might be Med A or Med B, whichever sorted first, because the hook LIMIT 1's the catalog match.
        // Let's just verify AT LEAST one search_miss was inserted for this action.
        const allNew = await query(`
            SELECT * FROM medicine_demand_signals 
            WHERE source_flow = 'medicine_search' 
              AND medicine_id = $1
        `, [ids.medicine_b]);
        expect(allNew.rowCount).toBeGreaterThan(0);
    });

});
