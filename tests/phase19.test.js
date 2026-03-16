require('dotenv').config({ path: '.env.dev' });

// Mocks MUST be before requires to avoid caching issues
jest.mock('../src/middlewares/requireAuth', () => (req, res, next) => {
    req.user = req.headers['x-mock-user'] ? JSON.parse(req.headers['x-mock-user']) : null;
    if (!req.user) return res.status(401).json({ error: 'unauthorized mock' });
    next();
});
jest.mock('../src/middlewares/adminRateLimiter', () => (req, res, next) => next());

const request = require('supertest');
const app = require('../src/app');
const { query } = require('../src/config/db');
const PharmacyScoreService = require('../src/services/pharmacyScoreService');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('Phase 19: Pharmacy Performance Scoring', () => {
    jest.setTimeout(30000); // Heavy DB mock insertions
    let adminToken = 'SYSTEM_ADMIN_TOKEN'; // simplified auth mock
    const ADMIN_HDR = JSON.stringify({ id: 'admin-uuid', role: 'super_admin' });
    const PHARM_HDR = JSON.stringify({ id: 'pharmacy-owner-id', role: 'pharmacy' });

    let pAId, pBId, pCId;

    beforeAll(async () => {
        await query(`DELETE FROM pharmacy_scores`);

        // Robust cleanup of abandoned data from previous failed runs
        const oldP = await query(`SELECT id FROM pharmacies WHERE name IN ('Pharm A', 'Pharm B', 'Pharm C')`);
        if (oldP.rows.length > 0) {
            const oldIds = oldP.rows.map(r => r.id);
            await query(`DELETE FROM order_reviews WHERE pharmacy_id = ANY($1::uuid[])`, [oldIds]);
            await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE pharmacy_id = ANY($1::uuid[]))`, [oldIds]);
            await query(`DELETE FROM orders WHERE pharmacy_id = ANY($1::uuid[])`, [oldIds]);
            await query(`DELETE FROM offers WHERE pharmacy_id = ANY($1::uuid[])`, [oldIds]);
            await query(`DELETE FROM pharmacy_inventory WHERE pharmacy_id = ANY($1::uuid[])`, [oldIds]);
            await query(`DELETE FROM pharmacies WHERE id = ANY($1::uuid[])`, [oldIds]);
        }
        const tier = await query(`SELECT id FROM tiers LIMIT 1`);
        const zone = await query(`SELECT id FROM zones LIMIT 1`);
        const tierId = tier.rows[0].id;
        const zoneId = zone.rows[0].id;

        const uRes = await query(`SELECT id FROM users LIMIT 1`);
        const uId = uRes.rows[0].id;

        const area = await query(`INSERT INTO areas (name, zone_id) VALUES ('Test Area', $1) ON CONFLICT DO NOTHING RETURNING id`, [zoneId]);
        let areaId;
        if (area.rows.length > 0) {
            areaId = area.rows[0].id;
        } else {
            const extArea = await query(`SELECT id FROM areas WHERE name = 'Test Area'`);
            areaId = extArea.rows[0].id;
        }

        const rRes = await query(`INSERT INTO requests (contact_phone, state, type, zone_id, area_id) VALUES ('123', 'accepted', 'standard', $1, $2) RETURNING id`, [zoneId, areaId]);
        const rId = rRes.rows[0].id;

        const pA = await query(`INSERT INTO pharmacies (name, zone_id, tier_id) VALUES ('Pharm A', $1, $2) RETURNING id`, [zoneId, tierId]);
        const pB = await query(`INSERT INTO pharmacies (name, zone_id, tier_id) VALUES ('Pharm B', $1, $2) RETURNING id`, [zoneId, tierId]);
        const pC = await query(`INSERT INTO pharmacies (name, zone_id, tier_id) VALUES ('Pharm C', $1, $2) RETURNING id`, [zoneId, tierId]);

        pAId = pA.rows[0].id;
        pBId = pB.rows[0].id;
        pCId = pC.rows[0].id;

        const med = await query(`INSERT INTO medicines (name, generic_name, brand_name, form, strength, max_order_qty) VALUES ('TestMed', 'gen', 'brand', 'tablet', '10mg', 10) RETURNING id`);
        const medId = med.rows[0].id;

        // Seed Pharmacy A (20+ orders, perfect stats)
        for (let i = 0; i < 21; i++) {
            const o = await query(`INSERT INTO orders (pharmacy_id, total_price, delivery_fee, commission_rate, commission_amount, commission_status, status, created_at, updated_at, type) 
                VALUES ($1, 10, 0, 0, 0, 'pending', 'completed', NOW(), NOW(), 'direct') RETURNING id`, [pAId]);
            await query(`INSERT INTO order_items (order_id, medicine_id, quantity, price_snapshot) VALUES ($1, $2, 1, 10)`, [o.rows[0].id, medId]);
            await query(`INSERT INTO order_reviews (order_id, pharmacy_id, rating, user_id) VALUES ($1, $2, 5, $3)`, [o.rows[0].id, pAId, uId]);
        }
        await query(`INSERT INTO offers (request_id, pharmacy_id, status, created_at, updated_at, total_price, delivery_fee, coverage_ratio) 
            VALUES ($1, $2, 'accepted', NOW() - INTERVAL '1 minute', NOW(), 10, 0, 1)`, [rId, pAId]);
        await query(`INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status, updated_at) VALUES ($1, $2, 10, 'available', NOW()) ON CONFLICT DO NOTHING`, [pAId, medId]);

        // Seed Pharmacy B (20+ orders, 50% cancelled, meaning score is heavily penalized)
        for (let i = 0; i < 10; i++) {
            const o1 = await query(`INSERT INTO orders (pharmacy_id, total_price, delivery_fee, commission_rate, commission_amount, commission_status, status, created_at, updated_at, type) 
                VALUES ($1, 10, 0, 0, 0, 'pending', 'completed', NOW(), NOW(), 'direct') RETURNING id`, [pBId]);
            await query(`INSERT INTO order_items (order_id, medicine_id, quantity, price_snapshot) VALUES ($1, $2, 1, 10)`, [o1.rows[0].id, medId]);
            const o2 = await query(`INSERT INTO orders (pharmacy_id, total_price, delivery_fee, commission_rate, commission_amount, commission_status, status, created_at, updated_at, type) 
                VALUES ($1, 10, 0, 0, 0, 'pending', 'cancelled_by_pharmacy', NOW(), NOW(), 'direct') RETURNING id`, [pBId]);
            await query(`INSERT INTO order_items (order_id, medicine_id, quantity, price_snapshot) VALUES ($1, $2, 1, 10)`, [o2.rows[0].id, medId]);
        }
        await query(`INSERT INTO offers (request_id, pharmacy_id, status, created_at, updated_at, total_price, delivery_fee, coverage_ratio) 
            VALUES ($1, $2, 'accepted', NOW() - INTERVAL '10 minutes', NOW(), 10, 0, 1)`, [rId, pBId]);

        // Seed Pharmacy C (5 orders total, under threshold)
        for (let i = 0; i < 5; i++) {
            const o = await query(`INSERT INTO orders (pharmacy_id, total_price, delivery_fee, commission_rate, commission_amount, commission_status, status, created_at, updated_at, type) 
                VALUES ($1, 10, 0, 0, 0, 'pending', 'completed', NOW(), NOW(), 'direct') RETURNING id`, [pCId]);
            await query(`INSERT INTO order_items (order_id, medicine_id, quantity, price_snapshot) VALUES ($1, $2, 1, 10)`, [o.rows[0].id, medId]);
        }

        // Add dummy inventory for all to trigger 24h activity
        for (const pid of [pAId, pBId, pCId]) {
            await query(`INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status) VALUES ($1, $2, 10, 'available') ON CONFLICT DO NOTHING`, [pid, medId]);
        }
    });

    afterAll(async () => {
        await query(`DELETE FROM pharmacy_scores`);
        await query(`DELETE FROM order_reviews WHERE pharmacy_id IN ($1, $2, $3)`, [pAId, pBId, pCId]);
        await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE pharmacy_id IN ($1, $2, $3))`, [pAId, pBId, pCId]);
        await query(`DELETE FROM orders WHERE pharmacy_id IN ($1, $2, $3)`, [pAId, pBId, pCId]);
        await query(`DELETE FROM offers WHERE pharmacy_id IN ($1, $2, $3)`, [pAId, pBId, pCId]);
        await query(`DELETE FROM pharmacy_inventory WHERE pharmacy_id IN ($1, $2, $3)`, [pAId, pBId, pCId]);
        await query(`DELETE FROM pharmacies WHERE id IN ($1, $2, $3)`, [pAId, pBId, pCId]);
        await Object.values(require('../src/config/db').pool._clients || {}).forEach(c => c && c.end()); // Cleanup pool just in case
    });

    describe('pharmacy-score-calculator.js Logic', () => {
        it('calculates the 5-factor scores and persists into pharmacy_scores table', async () => {
            await PharmacyScoreService.calculateScores();

            const scoresA = await query(`SELECT * FROM pharmacy_scores WHERE pharmacy_id = $1`, [pAId]);
            const scoresB = await query(`SELECT * FROM pharmacy_scores WHERE pharmacy_id = $1`, [pBId]);
            const scoresC = await query(`SELECT * FROM pharmacy_scores WHERE pharmacy_id = $1`, [pCId]);

            // Pharmacy A (Perfect stats) -> Platinum
            console.log('SCORES A: ', scoresA.rows[0]);
            expect(scoresA.rows[0].total_score >= 90).toBe(true);
            expect(scoresA.rows[0].tier).toBe('platinum');
            expect(scoresA.rows[0].cancellation_rate).toBe('0.0000');

            // Pharmacy B (50% cancels -> penalized heavily comparatively)
            expect(scoresB.rows[0].cancellation_rate).toBe('0.5000');
            expect(parseFloat(scoresB.rows[0].total_score)).toBeLessThan(parseFloat(scoresA.rows[0].total_score));
            expect(scoresB.rows[0].tier !== 'platinum').toBe(true);

            // Pharmacy C (Under 20 threshold) -> Neutral Baseline (50, Bronze)
            expect(parseFloat(scoresC.rows[0].total_score)).toBe(50.00);
            expect(scoresC.rows[0].tier).toBe('bronze');
        });
    });

    describe('GET /admin/pharmacies', () => {
        it('returns pharmacies array with merged performance scores', async () => {
            const res = await request(app)
                .get('/admin/pharmacies')
                .set('x-mock-user', ADMIN_HDR);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body.data)).toBe(true);

            const pA = res.body.data.find(p => p.id === pAId);
            expect(pA).toBeDefined();
            expect(pA.performance_tier).toBe('platinum');
            expect(parseFloat(pA.total_score) >= 90).toBe(true);
            expect(pA.availability_score).toBeDefined();
        });
    });

    describe('GET /pharmacies/:id/performance', () => {
        it('returns the performance score and metrics for a pharmacy', async () => {
            const res = await request(app)
                .get(`/pharmacies/${pAId}/performance`)
                .set('x-mock-user', PHARM_HDR);

            expect(res.status).toBe(200);
            expect(res.body.data.total_score).toBeDefined();
            expect(res.body.data.tier).toBe('platinum');
            expect(res.body.data.cancellation_rate).toBe('0.0000');
        });

        it('returns default 50 score if no record exists yet', async () => {
            const dummyId = '00000000-0000-0000-0000-000000000001';
            const res = await request(app)
                .get(`/pharmacies/${dummyId}/performance`)
                .set('x-mock-user', PHARM_HDR);

            expect(res.status).toBe(200);
            expect(res.body.data.total_score).toBe(50.00);
            expect(res.body.data.tier).toBe('bronze');
        });
    });
});
