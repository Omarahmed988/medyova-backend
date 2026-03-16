'use strict';
require('dotenv').config({ path: '.env.dev' });
const request = require('supertest');
const app = require('../src/app');
const { pool, query } = require('../src/config/db');

// Bypass JWT middleware
jest.mock('../src/middlewares/requireAuth', () => (req, res, next) => {
    req.user = req.headers['x-mock-user'] ? JSON.parse(req.headers['x-mock-user']) : null;
    if (!req.user) return res.status(401).json({ error: 'unauthorized mock' });
    next();
});

// Mock settingsCache for Feature flags and global settings
jest.mock('../src/config/settingsCache', () => ({
    getFlag: jest.fn().mockReturnValue(true),
    getSetting: jest.fn().mockReturnValue('5'),
    init: jest.fn(),
}));

const FOUNDER = JSON.stringify({ id: '00000000-0000-0000-0000-000000000017', role: 'super_admin' });
const PHARMACY_OWNER = JSON.stringify({ id: '11111111-1111-1111-1111-111111111117', role: 'pharmacy_owner' });

describe('Phase 17: Insurance Pharmacy Filter', () => {

    let zoneId, areaId, tierId;
    let pharmacy1Id, pharmacy2Id; // P1 has insurance, P2 doesn't
    let med1Id;
    let insuranceCompanyId;

    beforeAll(async () => {
        // Users
        await query(`INSERT INTO users (id, phone, full_name) VALUES ('00000000-0000-0000-0000-000000000017', '+96500000017', 'super_admin') ON CONFLICT (id) DO NOTHING`);
        await query(`INSERT INTO users (id, phone, full_name) VALUES ('11111111-1111-1111-1111-111111111117', '+96511111117', 'pharmacy_owner') ON CONFLICT (id) DO NOTHING`);

        // Zone & area
        const zoneRes = await query(`INSERT INTO zones (name, city) VALUES ('P17 Zone', 'P17City') RETURNING id`);
        zoneId = zoneRes.rows[0].id;

        const areaRes = await query(`INSERT INTO areas (zone_id, name, founder_override, is_active) VALUES ($1, 'P17 Area', true, true) RETURNING id`, [zoneId]);
        areaId = areaRes.rows[0].id;

        // Tier
        let tierRes = await query(`SELECT id FROM tiers LIMIT 1`);
        if (tierRes.rowCount > 0) tierId = tierRes.rows[0].id;
        else tierRes = (await query(`INSERT INTO tiers (name, rank) VALUES ('P17 Tier', 997) RETURNING id`)).rows[0].id;

        // Pharmacies (both serve the same area)
        const ph1 = await query(`INSERT INTO pharmacies (name, zone_id, tier_id, is_active) VALUES ('P17 Insured Pharmacy', $1, $2, true) RETURNING id`, [zoneId, tierId]);
        pharmacy1Id = ph1.rows[0].id;
        await query(`INSERT INTO pharmacy_delivery_areas (pharmacy_id, area_id) VALUES ($1, $2)`, [pharmacy1Id, areaId]);

        const ph2 = await query(`INSERT INTO pharmacies (name, zone_id, tier_id, is_active) VALUES ('P17 Uninsured Pharmacy', $1, $2, true) RETURNING id`, [zoneId, tierId]);
        pharmacy2Id = ph2.rows[0].id;
        await query(`INSERT INTO pharmacy_delivery_areas (pharmacy_id, area_id) VALUES ($1, $2)`, [pharmacy2Id, areaId]);

        // Medicine
        const m1 = await query(`INSERT INTO medicines (name, generic_name, is_active, max_order_qty) VALUES ('Amoxicillin P17', 'Amox', true, 5) RETURNING id`);
        med1Id = m1.rows[0].id;

        // Inventory (both have the drug in stock)
        await query(`INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status) VALUES ($1, $2, 10.00, 'available')`, [pharmacy1Id, med1Id]);
        await query(`INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status) VALUES ($1, $2, 9.50, 'available')`, [pharmacy2Id, med1Id]);
    });

    afterAll(async () => {
        // Cleanup in reverse order
        await query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE user_id = '00000000-0000-0000-0000-000000000017')`);
        await query(`DELETE FROM orders WHERE user_id = '00000000-0000-0000-0000-000000000017'`);
        await query(`DELETE FROM pharmacy_insurance_contracts WHERE pharmacy_id IN ($1, $2)`, [pharmacy1Id, pharmacy2Id]);
        if (insuranceCompanyId) await query(`DELETE FROM insurance_companies WHERE id = $1`, [insuranceCompanyId]);
        await query(`DELETE FROM pharmacy_inventory WHERE pharmacy_id IN ($1, $2)`, [pharmacy1Id, pharmacy2Id]);
        await query(`DELETE FROM pharmacy_delivery_areas WHERE pharmacy_id IN ($1, $2)`, [pharmacy1Id, pharmacy2Id]);
        await query(`DELETE FROM medicines WHERE id = $1`, [med1Id]);
        await query(`DELETE FROM pharmacies WHERE id IN ($1, $2)`, [pharmacy1Id, pharmacy2Id]);
        await query(`DELETE FROM areas WHERE id = $1`, [areaId]);
        await query(`DELETE FROM zones WHERE id = $1`, [zoneId]);
        await pool.end();
    });

    describe('Admin Insurance Management', () => {
        it('allows super_admin to create an insurance company', async () => {
            const res = await request(app)
                .post('/admin/insurance-companies')
                .set('x-mock-user', FOUNDER)
                .send({ name: 'Global Health Ins P17' });

            expect(res.status).toBe(201);
            expect(res.body.id).toBeDefined();
            expect(res.body.name).toBe('Global Health Ins P17');
            insuranceCompanyId = res.body.id;
        });

        it('rejects duplicate insurance company names', async () => {
            const res = await request(app)
                .post('/admin/insurance-companies')
                .set('x-mock-user', FOUNDER)
                .send({ name: 'Global Health Ins P17' });

            expect(res.status).toBe(409);
        });

        it('allows super_admin to patch an insurance company name', async () => {
            const res = await request(app)
                .patch(`/admin/insurance-companies/${insuranceCompanyId}`)
                .set('x-mock-user', FOUNDER)
                .send({ name: 'Global Health Ins P17 Updated' });

            expect(res.status).toBe(200);
            expect(res.body.name).toBe('Global Health Ins P17 Updated');
        });

        it('lists insurance companies', async () => {
            const res = await request(app)
                .get('/admin/insurance-companies')
                .set('x-mock-user', FOUNDER);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
            const found = res.body.find(i => i.id === insuranceCompanyId);
            expect(found).toBeDefined();
        });
    });

    describe('Pharmacy Portal Insurance Management', () => {
        it('allows a pharmacy to opt into an insurance company', async () => {
            const res = await request(app)
                .post(`/pharmacies/${pharmacy1Id}/insurance`)
                .set('x-mock-user', PHARMACY_OWNER)
                .send({ insurance_company_id: insuranceCompanyId });

            expect(res.status).toBe(201);
            expect(res.body.status).toBe('active');
        });

        it('lists the pharmacy active insurances', async () => {
            const res = await request(app)
                .get(`/pharmacies/${pharmacy1Id}/insurance`)
                .set('x-mock-user', PHARMACY_OWNER);

            expect(res.status).toBe(200);
            expect(res.body.data.length).toBe(1);
            expect(res.body.data[0].id).toBe(insuranceCompanyId);
            expect(res.body.data[0].contract_active).toBe(true);
        });
    });

    describe('Medicine Search Integration', () => {
        it('returns both pharmacies when no insurance filter is applied', async () => {
            const res = await request(app)
                .get(`/medicines/search?q=Amox&area_id=${areaId}`);

            expect(res.status).toBe(200);
            expect(res.body.data.length).toBe(1); // 1 medicine
            const med = res.body.data[0];
            expect(med.pharmacies.length).toBe(2); // carried by both p1 and p2
        });

        it('filters correctly when insurance_company_id is provided', async () => {
            const res = await request(app)
                .get(`/medicines/search?q=Amox&area_id=${areaId}&insurance_company_id=${insuranceCompanyId}`);

            expect(res.status).toBe(200);
            expect(res.body.data.length).toBe(1);
            const med = res.body.data[0];
            // Should ONLY list pharmacy 1
            expect(med.pharmacies.length).toBe(1);
            expect(med.pharmacies[0].pharmacy_id).toBe(pharmacy1Id);
        });

        it('returns 400 if insurance_company_id is not a valid UUID', async () => {
            const res = await request(app)
                .get(`/medicines/search?q=Amox&area_id=${areaId}&insurance_company_id=fake-uuid`);
            expect(res.status).toBe(400);
        });
    });

    describe('Direct Order Validation', () => {
        it('allows order if pharmacy supports the insurance', async () => {
            const res = await request(app)
                .post('/orders/direct')
                .set('x-mock-user', FOUNDER) // using founder just as a dummy user id
                .send({
                    pharmacy_id: pharmacy1Id,
                    area_id: areaId,
                    insurance_company_id: insuranceCompanyId,
                    items: [{ medicine_id: med1Id, quantity: 1 }]
                });

            if (res.status === 500) console.error('500 ERROR:', res.body);
            expect(res.status).toBe(201);
            expect(res.body.data.id).toBeDefined();

            // Verify context is saved
            const orderDoc = await query(`SELECT insurance_company_id FROM orders WHERE id = $1`, [res.body.data.id]);
            expect(orderDoc.rows[0].insurance_company_id).toBe(insuranceCompanyId);
        });

        it('rejects order with 422 if pharmacy does NOT support the insurance', async () => {
            const res = await request(app)
                .post('/orders/direct')
                .set('x-mock-user', FOUNDER)
                .send({
                    pharmacy_id: pharmacy2Id, // P2 has NO insurance contract
                    area_id: areaId,
                    insurance_company_id: insuranceCompanyId,
                    items: [{ medicine_id: med1Id, quantity: 1 }]
                });

            if (res.status === 500) console.error('500 ERROR:', res.body);
            expect(res.status).toBe(422);
            expect(res.body.message).toContain('does not have an active contract');
        });
    });

    describe('Pharmacy Insurance Deactivation', () => {
        it('deactivates an existing contract', async () => {
            const res = await request(app)
                .delete(`/pharmacies/${pharmacy1Id}/insurance/${insuranceCompanyId}`)
                .set('x-mock-user', PHARMACY_OWNER);

            expect(res.status).toBe(200);

            // Verify it drops from search
            const searchRes = await request(app)
                .get(`/medicines/search?q=Amox&area_id=${areaId}&insurance_company_id=${insuranceCompanyId}`);
            expect(searchRes.status).toBe(200);
            expect(searchRes.body.data.length).toBe(0); // the drug itself is removed from results when 0 pharmacies match
        });
    });
});
