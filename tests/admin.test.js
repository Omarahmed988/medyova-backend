'use strict';
/**
 * tests/admin.test.js
 * Integration tests for the Founder Control REST surface.
 */

const request = require('supertest');
const app = require('../src/app');
const { query } = require('../src/config/db');
const settingsService = require('../src/services/settingsService');

// We must bypass standard requireAuth specifically so we can inject role contexts
jest.mock('../src/middlewares/requireAuth', () => (req, res, next) => {
    req.user = req.headers['x-mock-user'] ? JSON.parse(req.headers['x-mock-user']) : null;
    if (!req.user) {
        return res.status(401).json({ error: 'unauthorized mock' });
    }
    next();
});

jest.mock('../src/services/settingsService', () => ({
    updateSetting: jest.fn(),
    updateFlag: jest.fn(),
}));

jest.mock('../src/config/db', () => ({
    query: jest.fn().mockResolvedValue({}),
}));

const SUPER_ADMIN = JSON.stringify({ id: 'admin-id', role: 'super_admin' });
const NORMAL_USER = JSON.stringify({ id: 'user-id', role: 'patient' });

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Admin Security Guards', () => {
    test('returns 401 if unauthenticated', async () => {
        const res = await request(app).patch('/admin/settings/commission_rate_percent');
        expect(res.status).toBe(401);
    });

    test('returns 403 if role is not super_admin', async () => {
        const res = await request(app)
            .patch('/admin/settings/commission_rate_percent')
            .set('x-mock-user', NORMAL_USER)
            .send({ value: '10' });
        expect(res.status).toBe(403);
    });

    test('rate limiter blocks > 20 requests', async () => {
        const LIMIT_ADMIN = JSON.stringify({ id: 'spam-id', role: 'super_admin' });
        for (let i = 0; i < 20; i++) {
            await request(app)
                .patch('/admin/settings/foo')
                .set('x-mock-user', LIMIT_ADMIN)
                .send(); // Will fail 400 since value is missing, but counts against limit
        }

        const res = await request(app)
            .patch('/admin/settings/foo')
            .set('x-mock-user', LIMIT_ADMIN)
            .send();

        expect(res.status).toBe(429);
        expect(res.body.error).toBe('too_many_requests');
    });
});

describe('PATCH /admin/settings/:key', () => {
    test('returns 400 if value is not string', async () => {
        const res = await request(app)
            .patch('/admin/settings/commission_rate_percent')
            .set('x-mock-user', SUPER_ADMIN)
            .send({ value: 10 }); // integer

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('value must be a string');
    });

    test('returns 200 on success and fires audit log', async () => {
        settingsService.updateSetting.mockResolvedValueOnce({
            key: 'commission_rate_percent',
            previous_value: '10.00',
            new_value: '12.00',
            status: 'updated'
        });

        const res = await request(app)
            .patch('/admin/settings/commission_rate_percent')
            .set('x-mock-user', SUPER_ADMIN)
            .send({ value: '12.00', confirm: true });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('updated');

        // Assert service was called
        expect(settingsService.updateSetting).toHaveBeenCalledWith('commission_rate_percent', '12.00', 'admin-id', true);

        // Yield event loop to allow fire-and-forget audit to execute
        await new Promise(r => setImmediate(r));

        // Assert audit log was fired
        expect(query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO system_audit_logs'),
            expect.arrayContaining(['admin-id', 'UPDATE_SETTING', 'system_settings', 'commission_rate_percent'])
        );
    });

    test('does not fire audit log when status is no_change', async () => {
        settingsService.updateSetting.mockResolvedValueOnce({
            key: 'foo', status: 'no_change'
        });

        const res = await request(app)
            .patch('/admin/settings/foo')
            .set('x-mock-user', SUPER_ADMIN)
            .send({ value: 'same' });

        expect(res.status).toBe(200);

        await new Promise(r => setImmediate(r));
        expect(query).not.toHaveBeenCalled();
    });
});

describe('PATCH /admin/flags/:key', () => {
    test('returns 400 if isEnabled is not boolean', async () => {
        const res = await request(app)
            .patch('/admin/flags/some_flag')
            .set('x-mock-user', SUPER_ADMIN)
            .send({ isEnabled: 'true' });

        expect(res.status).toBe(400);
    });

    test('returns 200 on success and fires audit log', async () => {
        settingsService.updateFlag.mockResolvedValueOnce({
            key: 'some_flag',
            scope: 'global',
            scope_id: null,
            previous_value: false,
            new_value: true,
            status: 'updated'
        });

        const res = await request(app)
            .patch('/admin/flags/some_flag')
            .set('x-mock-user', SUPER_ADMIN)
            .send({ isEnabled: true, scope: 'global' });

        expect(res.status).toBe(200);

        await new Promise(r => setImmediate(r));
        expect(query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO system_audit_logs'),
            expect.arrayContaining(['admin-id', 'UPDATE_FLAG', 'feature_flags', 'some_flag'])
        );
    });

    test('audit write failure does not rollback 200 response', async () => {
        settingsService.updateFlag.mockResolvedValueOnce({ status: 'updated' });
        query.mockRejectedValueOnce(new Error('Audit DB Down'));

        const res = await request(app)
            .patch('/admin/flags/some_flag')
            .set('x-mock-user', SUPER_ADMIN)
            .send({ isEnabled: true });

        expect(res.status).toBe(200); // Route still succeeds
    });
});
