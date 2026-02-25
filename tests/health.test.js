'use strict';

const request = require('supertest');
const app = require('../src/app');

describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
        const res = await request(app).get('/health');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
    });

    it('returns a valid ISO timestamp', async () => {
        const res = await request(app).get('/health');
        const ts = new Date(res.body.timestamp);

        expect(isNaN(ts.getTime())).toBe(false);
    });

    it('returns a positive uptime in seconds', async () => {
        const res = await request(app).get('/health');

        expect(typeof res.body.uptime).toBe('number');
        expect(res.body.uptime).toBeGreaterThan(0);
    });

    it('returns 200 even when DATABASE_URL is not set', async () => {
        const savedUrl = process.env.DATABASE_URL;
        delete process.env.DATABASE_URL;

        const res = await request(app).get('/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');

        process.env.DATABASE_URL = savedUrl;
    });
});

describe('Unknown routes', () => {
    it('returns 404 JSON for undefined GET route', async () => {
        const res = await request(app).get('/undefined-route-xyz');

        expect(res.status).toBe(404);
        expect(res.body).toHaveProperty('error', 'Not Found');
        expect(res.body).toHaveProperty('statusCode', 404);
        expect(res.headers['content-type']).toMatch(/application\/json/);
    });

    it('returns 404 JSON for undefined POST route', async () => {
        const res = await request(app).post('/undefined-route-xyz');

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Not Found');
    });
});

describe('Error handling', () => {
    it('returns 500 JSON when route throws an error', async () => {
        // Create a minimal test app that exercises the error handler directly
        const express = require('express');
        const errorHandler = require('../src/middlewares/errorHandler');

        const testApp = express();
        testApp.get('/test-error-trigger', (_req, _res, next) => {
            const err = new Error('Test error');
            err.status = 500;
            next(err);
        });
        testApp.use(errorHandler);

        const res = await request(testApp).get('/test-error-trigger');
        expect(res.status).toBe(500);
        expect(res.body).toHaveProperty('error');
        expect(res.headers['content-type']).toMatch(/application\/json/);
    });
});
