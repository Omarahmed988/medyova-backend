'use strict';
require('dotenv').config({ path: '.env.dev' });
const request = require('supertest');
const app = require('../src/app');
const { pool, query } = require('../src/config/db');
const SubscriptionOrderService = require('../src/services/subscriptionOrderService');

// Bypass JWT middleware
jest.mock('../src/middlewares/requireAuth', () => (req, res, next) => {
    req.user = req.headers['x-mock-user'] ? JSON.parse(req.headers['x-mock-user']) : null;
    if (!req.user) return res.status(401).json({ error: 'unauthorized mock' });
    next();
});

// Mock settingsCache to enable the feature flag
jest.mock('../src/config/settingsCache', () => ({
    getFlag: jest.fn().mockReturnValue(true),
    getSetting: jest.fn().mockReturnValue('5'),
    init: jest.fn(),
}));

const USER = JSON.stringify({ id: '00000000-0000-0000-0000-000000000016', role: 'patient', phone: '+96500000016' });

describe('Phase 16: Medicine Subscriptions', () => {

    let zoneId, areaId, tierId, pharmacyId, med1, med2, subscriptionId;

    beforeAll(async () => {
        // Test user
        await query(`INSERT INTO users (id, phone, full_name) VALUES ('00000000-0000-0000-0000-000000000016', '+96500000016', 'P16 Patient') ON CONFLICT (id) DO NOTHING`);

        // Zone & area
        const zoneRes = await query(`INSERT INTO zones (name, city) VALUES ('P16 Zone', 'P16City') RETURNING id`);
        zoneId = zoneRes.rows[0].id;

        const areaRes = await query(`INSERT INTO areas (zone_id, name, founder_override, is_active) VALUES ($1, 'P16 Area', true, true) RETURNING id`, [zoneId]);
        areaId = areaRes.rows[0].id;

        // Tier
        let tierRes = await query(`SELECT id FROM tiers LIMIT 1`);
        if (tierRes.rowCount > 0) {
            tierId = tierRes.rows[0].id;
        } else {
            tierRes = await query(`INSERT INTO tiers (name, rank) VALUES ('P16 Tier', 998) RETURNING id`);
            tierId = tierRes.rows[0].id;
        }

        // Pharmacy + area delivery mapping
        const phRes = await query(`INSERT INTO pharmacies (name, zone_id, tier_id, is_active) VALUES ('P16 Pharmacy', $1, $2, true) RETURNING id`, [zoneId, tierId]);
        pharmacyId = phRes.rows[0].id;

        await query(`INSERT INTO pharmacy_delivery_areas (pharmacy_id, area_id) VALUES ($1, $2)`, [pharmacyId, areaId]);

        // Medicines
        const m1 = await query(`INSERT INTO medicines (name, is_active, max_order_qty) VALUES ('Insulin P16 100IU', true, 3) RETURNING id`);
        med1 = m1.rows[0].id;

        const m2 = await query(`INSERT INTO medicines (name, is_active, max_order_qty) VALUES ('Metformin P16 500mg', true, 5) RETURNING id`);
        med2 = m2.rows[0].id;

        // Inventory
        await query(`INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status) VALUES ($1, $2, 25.00, 'available')`, [pharmacyId, med1]);
        await query(`INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status) VALUES ($1, $2, 10.00, 'available')`, [pharmacyId, med2]);
    });

    afterAll(async () => {
        // Cleanup in reverse dependency order
        await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = '00000000-0000-0000-0000-000000000016'))`);
        await query(`DELETE FROM orders WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = '00000000-0000-0000-0000-000000000016')`);
        await query(`DELETE FROM subscription_items WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = '00000000-0000-0000-0000-000000000016')`);
        await query(`DELETE FROM subscriptions WHERE user_id = '00000000-0000-0000-0000-000000000016'`);
        await query(`DELETE FROM pharmacy_inventory WHERE pharmacy_id = $1`, [pharmacyId]);
        await query(`DELETE FROM pharmacy_delivery_areas WHERE pharmacy_id = $1`, [pharmacyId]);
        await query(`DELETE FROM medicines WHERE id IN ($1, $2)`, [med1, med2]);
        await query(`DELETE FROM pharmacies WHERE id = $1`, [pharmacyId]);
        await query(`DELETE FROM areas WHERE id = $1`, [areaId]);
        await query(`DELETE FROM zones WHERE id = $1`, [zoneId]);
        await pool.end();
    });

    describe('POST /subscriptions', () => {
        it('creates a new medicine subscription', async () => {
            const res = await request(app)
                .post('/subscriptions')
                .set('x-mock-user', USER)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: areaId,
                    frequency_days: 30,
                    items: [
                        { medicine_id: med1, quantity: 1 },
                        { medicine_id: med2, quantity: 2 },
                    ],
                });

            if (res.status === 500) console.error('500 ERROR:', res.body);

            expect(res.status).toBe(201);
            expect(res.body.id).toBeDefined();
            expect(res.body.status).toBe('active');
            subscriptionId = res.body.id;
        });

        it('rejects if pharmacy does not serve the area', async () => {
            const fakeArea = '00000000-0000-0000-0000-000000000001';
            const res = await request(app)
                .post('/subscriptions')
                .set('x-mock-user', USER)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: fakeArea,
                    frequency_days: 30,
                    items: [{ medicine_id: med1, quantity: 1 }],
                });

            expect(res.status).toBe(422);
        });

        it('rejects quantity exceeding max_order_qty', async () => {
            const res = await request(app)
                .post('/subscriptions')
                .set('x-mock-user', USER)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: areaId,
                    frequency_days: 30,
                    items: [{ medicine_id: med1, quantity: 10 }], // max is 3
                });

            expect(res.status).toBe(422);
        });
    });

    describe('GET /subscriptions', () => {
        it('returns the user subscriptions', async () => {
            const res = await request(app)
                .get('/subscriptions')
                .set('x-mock-user', USER);

            expect(res.status).toBe(200);
            expect(res.body.subscriptions.length).toBeGreaterThan(0);

            const sub = res.body.subscriptions.find(s => s.id === subscriptionId);
            expect(sub).toBeDefined();
            expect(sub.items.length).toBe(2);
        });
    });

    describe('SubscriptionOrderService', () => {
        it('generates an order from a due subscription', async () => {
            // Force next_run_at to the past so it's "due"
            await query(`UPDATE subscriptions SET next_run_at = NOW() - INTERVAL '1 hour' WHERE id = $1`, [subscriptionId]);

            const sub = (await query(`SELECT * FROM subscriptions WHERE id = $1`, [subscriptionId])).rows[0];
            const result = await SubscriptionOrderService.processSubscription(sub);

            expect(result.status).toBe('generated');
            expect(result.order_id).toBeDefined();

            // Verify order was created
            const order = await query(`SELECT * FROM orders WHERE id = $1`, [result.order_id]);
            expect(order.rows[0].subscription_id).toBe(subscriptionId);
            expect(order.rows[0].type).toBe('direct');

            // Verify subscription advanced
            const updatedSub = await query(`SELECT * FROM subscriptions WHERE id = $1`, [subscriptionId]);
            expect(updatedSub.rows[0].last_order_id).toBe(result.order_id);
            expect(updatedSub.rows[0].last_run_at).toBeTruthy();
        });

        it('pauses the subscription when medicine is out of stock', async () => {
            // Force next_run_at to the past
            await query(`UPDATE subscriptions SET next_run_at = NOW() - INTERVAL '1 hour', is_active = true, pause_reason = NULL WHERE id = $1`, [subscriptionId]);
            // Set med1 out of stock
            await query(`UPDATE pharmacy_inventory SET stock_status = 'out_of_stock' WHERE pharmacy_id = $1 AND medicine_id = $2`, [pharmacyId, med1]);

            const sub = (await query(`SELECT * FROM subscriptions WHERE id = $1`, [subscriptionId])).rows[0];
            const result = await SubscriptionOrderService.processSubscription(sub);

            expect(result.status).toBe('paused');
            expect(result.reason).toBe('out_of_stock');

            const paused = await query(`SELECT is_active, pause_reason FROM subscriptions WHERE id = $1`, [subscriptionId]);
            expect(paused.rows[0].is_active).toBe(false);
            expect(paused.rows[0].pause_reason).toContain('out of stock');

            // Restore stock
            await query(`UPDATE pharmacy_inventory SET stock_status = 'available' WHERE pharmacy_id = $1 AND medicine_id = $2`, [pharmacyId, med1]);
        });

        it('pauses the subscription when pharmacy is inactive', async () => {
            await query(`UPDATE subscriptions SET next_run_at = NOW() - INTERVAL '1 hour', is_active = true, pause_reason = NULL WHERE id = $1`, [subscriptionId]);
            await query(`UPDATE pharmacies SET is_active = false WHERE id = $1`, [pharmacyId]);

            const sub = (await query(`SELECT * FROM subscriptions WHERE id = $1`, [subscriptionId])).rows[0];
            const result = await SubscriptionOrderService.processSubscription(sub);

            expect(result.status).toBe('paused');
            expect(result.reason).toBe('pharmacy_inactive');

            // Restore
            await query(`UPDATE pharmacies SET is_active = true WHERE id = $1`, [pharmacyId]);
        });
    });

    describe('PATCH /subscriptions/:id', () => {
        it('resumes a paused subscription', async () => {
            // Ensure it's paused first
            await query(`UPDATE subscriptions SET is_active = false, pause_reason = 'test pause' WHERE id = $1`, [subscriptionId]);

            const res = await request(app)
                .patch(`/subscriptions/${subscriptionId}`)
                .set('x-mock-user', USER)
                .send({ is_active: true });

            expect(res.status).toBe(200);

            const sub = await query(`SELECT is_active, pause_reason FROM subscriptions WHERE id = $1`, [subscriptionId]);
            expect(sub.rows[0].is_active).toBe(true);
            expect(sub.rows[0].pause_reason).toBeNull();
        });
    });

    describe('DELETE /subscriptions/:id', () => {
        it('soft-deletes (cancels) the subscription', async () => {
            const res = await request(app)
                .delete(`/subscriptions/${subscriptionId}`)
                .set('x-mock-user', USER);

            expect(res.status).toBe(200);

            const sub = await query(`SELECT is_active, pause_reason FROM subscriptions WHERE id = $1`, [subscriptionId]);
            expect(sub.rows[0].is_active).toBe(false);
            expect(sub.rows[0].pause_reason).toBe('Cancelled by user');
        });
    });
});
