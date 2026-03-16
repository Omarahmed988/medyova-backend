'use strict';
require('dotenv').config({ path: '.env.dev' });
const request = require('supertest');
const app = require('../src/app');
const { pool, query } = require('../src/config/db');

// Bypass JWT
jest.mock('../src/middlewares/requireAuth', () => (req, res, next) => {
    req.user = req.headers['x-mock-user'] ? JSON.parse(req.headers['x-mock-user']) : null;
    if (!req.user) return res.status(401).json({ error: 'unauthorized mock' });
    next();
});

// Mock settingsCache
jest.mock('../src/config/settingsCache', () => ({
    getFlag: jest.fn().mockReturnValue(true),
    getSetting: jest.fn().mockReturnValue('5'),
    init: jest.fn(),
}));

const USER1 = { id: '00000000-0000-0000-0000-000000000018', role: 'super_admin' };
const USER1_HDR = JSON.stringify(USER1);

describe('Phase 18: Insurance Orders + Patient Profiles', () => {

    let zoneId, areaId, tierId;
    let pharmacyId;
    let medId;
    let insuranceCompanyId;
    let insuranceProfileId;
    let patientProfileId;

    beforeAll(async () => {
        // Seed user
        await query(`INSERT INTO users (id, phone, full_name) VALUES ($1, '+96500000018', 'P18 User') ON CONFLICT (id) DO NOTHING`, [USER1.id]);

        // Zone & area
        const zoneRes = await query(`INSERT INTO zones (name, city) VALUES ('P18 Zone', 'P18City') RETURNING id`);
        zoneId = zoneRes.rows[0].id;

        const areaRes = await query(`INSERT INTO areas (zone_id, name, founder_override, is_active) VALUES ($1, 'P18 Area', true, true) RETURNING id`, [zoneId]);
        areaId = areaRes.rows[0].id;

        // Tier
        let tierRes = await query(`SELECT id FROM tiers LIMIT 1`);
        if (tierRes.rowCount > 0) {
            tierId = tierRes.rows[0].id;
        } else {
            const t = await query(`INSERT INTO tiers (name, rank) VALUES ('P18 Tier', 998) RETURNING id`);
            tierId = t.rows[0].id;
        }

        // Pharmacy
        const phRes = await query(`INSERT INTO pharmacies (name, zone_id, tier_id, is_active) VALUES ('P18 Pharmacy', $1, $2, true) RETURNING id`, [zoneId, tierId]);
        pharmacyId = phRes.rows[0].id;
        await query(`INSERT INTO pharmacy_delivery_areas (pharmacy_id, area_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [pharmacyId, areaId]);

        // Insurance company
        const icRes = await query(`INSERT INTO insurance_companies (name) VALUES ('P18 Insurer') RETURNING id`);
        insuranceCompanyId = icRes.rows[0].id;

        // Pharmacy insurance contract
        await query(`INSERT INTO pharmacy_insurance_contracts (pharmacy_id, insurance_company_id, contract_active) VALUES ($1, $2, true)`, [pharmacyId, insuranceCompanyId]);

        // Medicine + Inventory
        const medRes = await query(`INSERT INTO medicines (name, generic_name, brand_name, form, strength, is_active, max_order_qty) VALUES ('P18 Med', 'p18gen', 'P18Brand', 'tablet', '500mg', true, 10) RETURNING id`);
        medId = medRes.rows[0].id;
        await query(`INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status) VALUES ($1, $2, 25.00, 'available')`, [pharmacyId, medId]);
    });

    afterAll(async () => {
        // Cleanup in dependency order
        await query(`DELETE FROM insurance_documents WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)`, [USER1.id]);
        await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id = $1)`, [USER1.id]);
        await query(`DELETE FROM orders WHERE user_id = $1`, [USER1.id]);
        await query(`DELETE FROM subscription_items WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = $1)`, [USER1.id]);
        await query(`DELETE FROM subscriptions WHERE user_id = $1`, [USER1.id]);
        await query(`DELETE FROM patient_profiles WHERE user_id = $1`, [USER1.id]);
        await query(`DELETE FROM user_insurance_profiles WHERE user_id = $1`, [USER1.id]);
        await query(`DELETE FROM pharmacy_inventory WHERE pharmacy_id = $1`, [pharmacyId]);
        await query(`DELETE FROM pharmacy_insurance_contracts WHERE pharmacy_id = $1`, [pharmacyId]);
        await query(`DELETE FROM pharmacy_delivery_areas WHERE pharmacy_id = $1`, [pharmacyId]);
        if (medId) await query(`DELETE FROM medicines WHERE id = $1`, [medId]);
        if (pharmacyId) await query(`DELETE FROM pharmacies WHERE id = $1`, [pharmacyId]);
        if (insuranceCompanyId) await query(`DELETE FROM insurance_companies WHERE id = $1`, [insuranceCompanyId]);
        if (areaId) await query(`DELETE FROM areas WHERE id = $1`, [areaId]);
        if (zoneId) await query(`DELETE FROM zones WHERE id = $1`, [zoneId]);
        await pool.end();
    });

    // ─── User Insurance Profiles ──────────────────────────────────────
    describe('User Insurance Profiles', () => {
        it('creates an insurance profile', async () => {
            const res = await request(app)
                .post('/user/insurance-profiles')
                .set('x-mock-user', USER1_HDR)
                .send({ insurance_company_id: insuranceCompanyId, member_id: 'CARD-001' });

            expect(res.status).toBe(201);
            expect(res.body.data.member_id).toBe('CARD-001');
            insuranceProfileId = res.body.data.id;
        });

        it('rejects duplicate insurance profile (409)', async () => {
            const res = await request(app)
                .post('/user/insurance-profiles')
                .set('x-mock-user', USER1_HDR)
                .send({ insurance_company_id: insuranceCompanyId, member_id: 'CARD-DUP' });

            expect(res.status).toBe(409);
        });

        it('lists insurance profiles', async () => {
            const res = await request(app)
                .get('/user/insurance-profiles')
                .set('x-mock-user', USER1_HDR);

            expect(res.status).toBe(200);
            expect(res.body.data.length).toBeGreaterThanOrEqual(1);
        });

        it('updates an insurance profile', async () => {
            const res = await request(app)
                .patch(`/user/insurance-profiles/${insuranceProfileId}`)
                .set('x-mock-user', USER1_HDR)
                .send({ member_id: 'CARD-002' });

            expect(res.status).toBe(200);
            expect(res.body.data.member_id).toBe('CARD-002');
        });
    });

    // ─── Patient Profiles ─────────────────────────────────────────────
    describe('Patient Profiles', () => {
        it('creates a patient profile with insurance link', async () => {
            const res = await request(app)
                .post('/patients')
                .set('x-mock-user', USER1_HDR)
                .send({ name: 'Father', insurance_profile_id: insuranceProfileId });

            expect(res.status).toBe(201);
            expect(res.body.data.name).toBe('Father');
            expect(res.body.data.insurance_profile_id).toBe(insuranceProfileId);
            patientProfileId = res.body.data.id;
        });

        it('creates a patient profile without insurance', async () => {
            const res = await request(app)
                .post('/patients')
                .set('x-mock-user', USER1_HDR)
                .send({ name: 'Self' });

            expect(res.status).toBe(201);
            expect(res.body.data.insurance_profile_id).toBeNull();
        });

        it('lists patient profiles', async () => {
            const res = await request(app)
                .get('/patients')
                .set('x-mock-user', USER1_HDR);

            expect(res.status).toBe(200);
            expect(res.body.data.length).toBeGreaterThanOrEqual(2);
        });

        it('updates a patient profile', async () => {
            const res = await request(app)
                .patch(`/patients/${patientProfileId}`)
                .set('x-mock-user', USER1_HDR)
                .send({ name: 'Father (Updated)' });

            expect(res.status).toBe(200);
            expect(res.body.data.name).toBe('Father (Updated)');
        });

        it('soft deletes a patient profile', async () => {
            // Create a disposable profile
            const create = await request(app)
                .post('/patients')
                .set('x-mock-user', USER1_HDR)
                .send({ name: 'ToDelete' });

            const delRes = await request(app)
                .delete(`/patients/${create.body.data.id}`)
                .set('x-mock-user', USER1_HDR);

            expect(delRes.status).toBe(200);

            // Verify it no longer appears in listings
            const list = await request(app)
                .get('/patients')
                .set('x-mock-user', USER1_HDR);

            const ids = list.body.data.map(p => p.id);
            expect(ids).not.toContain(create.body.data.id);
        });
    });

    // ─── Insurance Order Flow ─────────────────────────────────────────
    describe('Insurance Order Flow', () => {
        it('creates an insurance order (201)', async () => {
            const res = await request(app)
                .post('/orders/insurance')
                .set('x-mock-user', USER1_HDR)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: areaId,
                    patient_profile_id: patientProfileId,
                    items: [{ medicine_id: medId, quantity: 2 }]
                });

            if (res.status === 500) console.error('500 ERROR:', res.body);
            expect(res.status).toBe(201);
            expect(res.body.data.type).toBe('insurance');
            expect(res.body.data.total_price).toBe(50); // 25 * 2
        });

        it('stores insurance documents when provided', async () => {
            const res = await request(app)
                .post('/orders/insurance')
                .set('x-mock-user', USER1_HDR)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: areaId,
                    patient_profile_id: patientProfileId,
                    items: [{ medicine_id: medId, quantity: 1 }],
                    prescription_image_url: 'https://example.com/rx.png',
                    insurance_approval_image_url: 'https://example.com/approval.png'
                });

            expect(res.status).toBe(201);

            // Verify documents stored
            const docs = await query(`SELECT * FROM insurance_documents WHERE order_id = $1`, [res.body.data.id]);
            expect(docs.rowCount).toBe(1);
            expect(docs.rows[0].prescription_image_url).toBe('https://example.com/rx.png');
        });

        it('rejects if patient has no insurance link (422)', async () => {
            // Create patient without insurance
            const p = await request(app)
                .post('/patients')
                .set('x-mock-user', USER1_HDR)
                .send({ name: 'NoInsurance' });

            const res = await request(app)
                .post('/orders/insurance')
                .set('x-mock-user', USER1_HDR)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: areaId,
                    patient_profile_id: p.body.data.id,
                    items: [{ medicine_id: medId, quantity: 1 }]
                });

            expect(res.status).toBe(422);
            expect(res.body.message).toContain('no linked insurance');
        });

        it('rejects if pharmacy has no contract (422)', async () => {
            // Create a second insurance company without contract
            const ic2 = await query(`INSERT INTO insurance_companies (name) VALUES ('P18 Unlinked Insurer ' || RANDOM()::TEXT) RETURNING id`);
            const ic2Id = ic2.rows[0].id;

            // Create profile for the unlinked insurer
            const uipRes = await query(`
                INSERT INTO user_insurance_profiles (user_id, insurance_company_id, member_id)
                VALUES ($1, $2, 'UNLINKED-CARD') RETURNING id
            `, [USER1.id, ic2Id]);

            // Patient linked to unlinked insurer
            const pRes = await request(app)
                .post('/patients')
                .set('x-mock-user', USER1_HDR)
                .send({ name: 'Unlinked', insurance_profile_id: uipRes.rows[0].id });

            const res = await request(app)
                .post('/orders/insurance')
                .set('x-mock-user', USER1_HDR)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: areaId,
                    patient_profile_id: pRes.body.data.id,
                    items: [{ medicine_id: medId, quantity: 1 }]
                });

            expect(res.status).toBe(422);
            expect(res.body.message).toContain('does not have an active contract');

            // Cleanup
            await query(`DELETE FROM patient_profiles WHERE id = $1`, [pRes.body.data.id]);
            await query(`DELETE FROM user_insurance_profiles WHERE id = $1`, [uipRes.rows[0].id]);
            await query(`DELETE FROM insurance_companies WHERE id = $1`, [ic2Id]);
        });
    });

    // ─── Subscription Inheritance ─────────────────────────────────────
    describe('Subscription from Order', () => {
        it('rejects non-completed orders (422)', async () => {
            // Create a pending direct order
            const orderRes = await request(app)
                .post('/orders/direct')
                .set('x-mock-user', USER1_HDR)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: areaId,
                    items: [{ medicine_id: medId, quantity: 1 }]
                });
            expect(orderRes.status).toBe(201);

            const res = await request(app)
                .post('/subscriptions/from-order')
                .set('x-mock-user', USER1_HDR)
                .send({ order_id: orderRes.body.data.id, frequency_days: 30 });

            expect(res.status).toBe(422);
            expect(res.body.error).toContain('completed orders');
        });

        it('creates medicine subscription from completed direct order', async () => {
            // Create + complete a direct order
            const orderRes = await request(app)
                .post('/orders/direct')
                .set('x-mock-user', USER1_HDR)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: areaId,
                    items: [{ medicine_id: medId, quantity: 1 }]
                });
            await query(`UPDATE orders SET status = 'completed' WHERE id = $1`, [orderRes.body.data.id]);

            const res = await request(app)
                .post('/subscriptions/from-order')
                .set('x-mock-user', USER1_HDR)
                .send({ order_id: orderRes.body.data.id, frequency_days: 30 });

            expect(res.status).toBe(201);
            expect(res.body.type).toBe('medicine');
        });

        it('creates insurance subscription from completed insurance order', async () => {
            // Create + complete an insurance order
            const orderRes = await request(app)
                .post('/orders/insurance')
                .set('x-mock-user', USER1_HDR)
                .send({
                    pharmacy_id: pharmacyId,
                    area_id: areaId,
                    patient_profile_id: patientProfileId,
                    items: [{ medicine_id: medId, quantity: 1 }]
                });
            await query(`UPDATE orders SET status = 'completed' WHERE id = $1`, [orderRes.body.data.id]);

            const res = await request(app)
                .post('/subscriptions/from-order')
                .set('x-mock-user', USER1_HDR)
                .send({ order_id: orderRes.body.data.id, frequency_days: 30 });

            expect(res.status).toBe(201);
            expect(res.body.type).toBe('insurance');

            // Verify subscription has insurance context
            const sub = await query(`SELECT insurance_company_id, patient_profile_id FROM subscriptions WHERE id = $1`, [res.body.id]);
            expect(sub.rows[0].insurance_company_id).toBe(insuranceCompanyId);
            expect(sub.rows[0].patient_profile_id).toBe(patientProfileId);
        });
    });
});
