'use strict';

/**
 * Unit tests for Phase 13: Order Rating System.
 *
 * Tests cover:
 *   - Review submission (eligibility, ownership, status, anti-duplicate)
 *   - Input validation (rating range, comment length)
 *   - Review retrieval
 *   - Admin moderation (delete + aggregate recalculation)
 *   - Aggregate correctness
 *   - pharmacy_id sourced from DB, not client
 *   - Aggregate failure isolation
 *   - Zero-impact verification on routing/acceptance
 */

// ── Mock DB ─────────────────────────────────────────────────────────────
jest.mock('../src/config/db', () => {
    const mockClient = {
        query: jest.fn(),
        release: jest.fn(),
    };
    return {
        query: jest.fn(),
        testConnection: jest.fn().mockResolvedValue({ connected: true }),
        pool: {
            connect: jest.fn().mockResolvedValue(mockClient),
            _mockClient: mockClient,
        },
    };
});
jest.mock('../src/config/settingsCache', () => ({
    isReady: jest.fn().mockReturnValue(true),
    getSetting: jest.fn().mockReturnValue('10.00'),
    getSettingNumber: jest.fn().mockReturnValue(10.00),
}));

const request = require('supertest');
const express = require('express');
const { query } = require('../src/config/db');

const MOCK_ORDER_ID = '110e8400-e29b-41d4-a716-446655440001';
const MOCK_USER_ID = '220e8400-e29b-41d4-a716-446655440002';
const MOCK_PHARMACY_ID = '330e8400-e29b-41d4-a716-446655440003';
const MOCK_REVIEW_ID = '440e8400-e29b-41d4-a716-446655440004';
const WRONG_USER_ID = '550e8400-e29b-41d4-a716-446655440005';

// ── Test App Helpers ────────────────────────────────────────────────────

function createReviewApp(userId) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (userId) {
            req.user = { id: userId };
        }
        next();
    });
    const reviewsRouter = require('../src/routes/reviews');
    app.use('/orders', reviewsRouter);
    app.use(require('../src/middlewares/errorHandler'));
    return request(app);
}

function createAdminApp(role = 'super_admin') {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        if (role) {
            req.user = { id: MOCK_USER_ID, role };
        }
        next();
    });
    const adminRoutes = require('../src/routes/admin');
    app.use('/admin', adminRoutes);
    app.use(require('../src/middlewares/errorHandler'));
    return request(app);
}

// ═══════════════════════════════════════════════════════════════════════
// Review Submission
// ═══════════════════════════════════════════════════════════════════════

describe('POST /orders/:id/review', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ── Authentication ──────────────────────────────────────────────────

    test('returns 401 when no user is authenticated', async () => {
        const agent = createReviewApp(null);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 4 });

        expect(res.status).toBe(401);
        expect(res.body.error).toBe('Unauthorized');
    });

    // ── Input Validation ────────────────────────────────────────────────

    test('returns 400 when rating is missing', async () => {
        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({});

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('rating is required');
    });

    test('returns 400 when rating is below 1', async () => {
        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 0 });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('rating must be an integer between 1 and 5');
    });

    test('returns 400 when rating is above 5', async () => {
        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 6 });

        expect(res.status).toBe(400);
    });

    test('returns 400 when rating is a float', async () => {
        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 3.5 });

        expect(res.status).toBe(400);
    });

    test('returns 400 when comment exceeds 500 characters', async () => {
        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 4, comment: 'x'.repeat(501) });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('500 characters');
    });

    // ── Eligibility Rules ───────────────────────────────────────────────

    test('returns 422 when order is not completed', async () => {
        // Mock: order exists but status is 'pending'
        query.mockResolvedValueOnce({
            rows: [{ status: 'pending', user_id: MOCK_USER_ID, pharmacy_id: MOCK_PHARMACY_ID }],
        });

        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 4 });

        expect(res.status).toBe(422);
        expect(res.body.error).toContain('completed');
    });

    test('returns 403 when user does not own the order', async () => {
        // Mock: order completed but owned by a different user
        query.mockResolvedValueOnce({
            rows: [{ status: 'completed', user_id: WRONG_USER_ID, pharmacy_id: MOCK_PHARMACY_ID }],
        });

        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 5 });

        expect(res.status).toBe(403);
        expect(res.body.error).toContain('own orders');
    });

    test('returns 409 when review already exists (duplicate submission)', async () => {
        // Mock: order valid
        query.mockResolvedValueOnce({
            rows: [{ status: 'completed', user_id: MOCK_USER_ID, pharmacy_id: MOCK_PHARMACY_ID }],
        });
        // Mock: INSERT throws UNIQUE violation (23505)
        const uniqueError = new Error('duplicate key value violates unique constraint');
        uniqueError.code = '23505';
        query.mockRejectedValueOnce(uniqueError);

        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 4 });

        expect(res.status).toBe(409);
        expect(res.body.error).toContain('already exists');
    });

    // ── Successful Submission ───────────────────────────────────────────

    test('returns 201 on successful review submission', async () => {
        const createdAt = new Date().toISOString();

        // Mock: order valid
        query.mockResolvedValueOnce({
            rows: [{ status: 'completed', user_id: MOCK_USER_ID, pharmacy_id: MOCK_PHARMACY_ID }],
        });
        // Mock: INSERT returns review
        query.mockResolvedValueOnce({
            rows: [{
                id: MOCK_REVIEW_ID,
                order_id: MOCK_ORDER_ID,
                pharmacy_id: MOCK_PHARMACY_ID,
                user_id: MOCK_USER_ID,
                rating: 4,
                comment: 'Great service',
                created_at: createdAt,
            }],
        });
        // Mock: aggregate UPDATE succeeds
        query.mockResolvedValueOnce({ rows: [] });

        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 4, comment: 'Great service' });

        expect(res.status).toBe(201);
        expect(res.body.id).toBe(MOCK_REVIEW_ID);
        expect(res.body.rating).toBe(4);
        expect(res.body.pharmacy_id).toBe(MOCK_PHARMACY_ID);
    });

    // ── pharmacy_id Source Verification ──────────────────────────────────

    test('pharmacy_id in INSERT is sourced from orders row, not client', async () => {
        const createdAt = new Date().toISOString();

        // Mock: order valid — pharmacy_id is MOCK_PHARMACY_ID
        query.mockResolvedValueOnce({
            rows: [{ status: 'completed', user_id: MOCK_USER_ID, pharmacy_id: MOCK_PHARMACY_ID }],
        });
        // Mock: INSERT
        query.mockResolvedValueOnce({
            rows: [{
                id: MOCK_REVIEW_ID,
                order_id: MOCK_ORDER_ID,
                pharmacy_id: MOCK_PHARMACY_ID,
                user_id: MOCK_USER_ID,
                rating: 5,
                comment: null,
                created_at: createdAt,
            }],
        });
        // Mock: aggregate
        query.mockResolvedValueOnce({ rows: [] });

        const agent = createReviewApp(MOCK_USER_ID);
        await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 5 });

        // The INSERT call is the second query call (index 1)
        const insertCall = query.mock.calls[1];
        const insertSQL = insertCall[0];
        const insertParams = insertCall[1];

        // Verify INSERT SQL targets order_reviews
        expect(insertSQL).toContain('INSERT INTO order_reviews');
        // Verify pharmacy_id parameter (index 1 in params) is from orders query, not client payload
        expect(insertParams[1]).toBe(MOCK_PHARMACY_ID);
    });

    // ── Aggregate Failure Isolation ─────────────────────────────────────

    test('review persists even when aggregate recalculation fails', async () => {
        const createdAt = new Date().toISOString();
        const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => { });

        // Mock: order valid
        query.mockResolvedValueOnce({
            rows: [{ status: 'completed', user_id: MOCK_USER_ID, pharmacy_id: MOCK_PHARMACY_ID }],
        });
        // Mock: INSERT succeeds
        query.mockResolvedValueOnce({
            rows: [{
                id: MOCK_REVIEW_ID,
                order_id: MOCK_ORDER_ID,
                pharmacy_id: MOCK_PHARMACY_ID,
                user_id: MOCK_USER_ID,
                rating: 3,
                comment: null,
                created_at: createdAt,
            }],
        });
        // Mock: aggregate UPDATE fails
        query.mockRejectedValueOnce(new Error('Aggregate DB failure'));

        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.post(`/orders/${MOCK_ORDER_ID}/review`)
            .send({ rating: 3 });

        // Review still returns 201
        expect(res.status).toBe(201);
        expect(res.body.id).toBe(MOCK_REVIEW_ID);

        // Error was logged
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('[review] Aggregate recalculation failed'),
            expect.any(String)
        );

        consoleSpy.mockRestore();
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Review Retrieval
// ═══════════════════════════════════════════════════════════════════════

describe('GET /orders/:id/review', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns 200 with review data when review exists', async () => {
        query.mockResolvedValueOnce({
            rows: [{
                id: MOCK_REVIEW_ID,
                order_id: MOCK_ORDER_ID,
                pharmacy_id: MOCK_PHARMACY_ID,
                user_id: MOCK_USER_ID,
                rating: 5,
                comment: 'Excellent',
                created_at: new Date().toISOString(),
            }],
        });

        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.get(`/orders/${MOCK_ORDER_ID}/review`);

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(MOCK_REVIEW_ID);
        expect(res.body.rating).toBe(5);
    });

    test('returns 404 when no review exists for the order', async () => {
        query.mockResolvedValueOnce({ rows: [] });

        const agent = createReviewApp(MOCK_USER_ID);
        const res = await agent.get(`/orders/${MOCK_ORDER_ID}/review`);

        expect(res.status).toBe(404);
        expect(res.body.error).toContain('No review found');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Admin Moderation
// ═══════════════════════════════════════════════════════════════════════

describe('DELETE /admin/reviews/:id', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('returns 403 for non-super_admin', async () => {
        const agent = createAdminApp('pharmacy_admin');
        const res = await agent.delete(`/admin/reviews/${MOCK_REVIEW_ID}`);

        expect(res.status).toBe(403);
        expect(res.body.error).toContain('forbidden');
    });

    test('returns 200 and deletes review for super_admin', async () => {
        // Mock: fetch pharmacy_id
        query.mockResolvedValueOnce({
            rows: [{ pharmacy_id: MOCK_PHARMACY_ID }],
        });
        // Mock: DELETE
        query.mockResolvedValueOnce({ rows: [] });
        // Mock: aggregate recalculation
        query.mockResolvedValueOnce({ rows: [] });

        const agent = createAdminApp('super_admin');
        const res = await agent.delete(`/admin/reviews/${MOCK_REVIEW_ID}`);

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('deleted');
    });

    test('returns 404 when review does not exist', async () => {
        // Mock: review not found
        query.mockResolvedValueOnce({ rows: [] });

        const agent = createAdminApp('super_admin');
        const res = await agent.delete(`/admin/reviews/${MOCK_REVIEW_ID}`);

        expect(res.status).toBe(404);
        expect(res.body.error).toContain('Review not found');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Aggregate SQL Verification
// ═══════════════════════════════════════════════════════════════════════

describe('Aggregate Recalculation — SQL Structure', () => {
    const fs = require('fs');
    const path = require('path');
    const serviceSource = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'services', 'reviewService.js'),
        'utf8'
    );

    test('aggregate UPDATE uses AVG(rating)::NUMERIC(3,2) explicit cast', () => {
        expect(serviceSource).toContain('AVG(rating)::NUMERIC(3,2)');
    });

    test('aggregate UPDATE uses COUNT(*) for rating_count', () => {
        expect(serviceSource).toContain('rating_count = (SELECT COUNT(*) FROM order_reviews');
    });

    test('aggregate UPDATE uses COALESCE for zero-review edge case', () => {
        expect(serviceSource).toContain('COALESCE(');
        expect(serviceSource).toContain('0.00');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Zero-Impact Verification
// ═══════════════════════════════════════════════════════════════════════

describe('Rating System — Zero Impact Verification', () => {
    const fs = require('fs');
    const path = require('path');
    const readFile = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

    test('routing-worker.js has ZERO review/rating references', () => {
        const src = readFile('src/workers/routing-worker.js');
        expect(src).not.toContain('order_reviews');
        expect(src).not.toContain('rating_avg');
        expect(src).not.toContain('rating_count');
        expect(src).not.toContain('reviewService');
    });

    test('offerAcceptance.js has ZERO review/rating references', () => {
        const src = readFile('src/services/offerAcceptance.js');
        expect(src).not.toContain('review');
        expect(src).not.toContain('rating');
    });

    test('orderService.js has ZERO review/rating references', () => {
        const src = readFile('src/services/orderService.js');
        expect(src).not.toContain('review');
        expect(src).not.toContain('rating');
    });

    test('queryEligiblePharmacies does NOT reference rating_avg', () => {
        const src = readFile('src/workers/routing-worker.js');
        const qepStart = src.indexOf('async function queryEligiblePharmacies');
        const qepEnd = src.indexOf('\n}', src.indexOf('return rows;', qepStart));
        const qepBody = src.slice(qepStart, qepEnd);

        expect(qepBody).not.toContain('rating');
    });
});
