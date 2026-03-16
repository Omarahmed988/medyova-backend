'use strict';

/**
 * Unit tests for the Offer Acceptance flow (Phase 6).
 *
 * Tests cover:
 *   - Authentication enforcement (401)
 *   - Ownership check (403)
 *   - Successful acceptance (200)
 *   - Idempotent same-offer re-accept (200)
 *   - Double acceptance of different offers (409)
 *   - Accept after expiry (409)
 *   - Accept rejected offer (409)
 *   - Request not found (404)
 *   - Offer not found (404)
 *   - Structured error codes
 */

// Mock the db module before requiring anything
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
            _mockClient: mockClient, // expose for test access
        },
    };
});
jest.mock('../src/config/settingsCache', () => ({
    isReady: jest.fn().mockReturnValue(true),
    getSetting: jest.fn().mockReturnValue('10.00'),
    getSettingNumber: jest.fn().mockReturnValue(10.00),
}));

const request = require('supertest');
const app = require('../src/app');
const { query, pool } = require('../src/config/db');

const MOCK_REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';
const MOCK_OFFER_ID = '660e8400-e29b-41d4-a716-446655440001';
const MOCK_USER_ID = '770e8400-e29b-41d4-a716-446655440002';

// Helper: inject authenticated user into request
function authAgent(userId = MOCK_USER_ID) {
    // We need to inject req.user. Since we don't have real auth middleware,
    // we'll add a test middleware to app for these tests.
    const testApp = require('express')();
    testApp.use(require('express').json());
    testApp.use((req, _res, next) => {
        if (userId) {
            req.user = { id: userId };
        }
        next();
    });
    // Re-mount routes with requireDb mocked to pass
    const offersRouter = require('../src/routes/offers');
    testApp.use('/requests', offersRouter);
    testApp.use(require('../src/middlewares/errorHandler'));
    return request(testApp);
}

function noAuthAgent() {
    const testApp = require('express')();
    testApp.use(require('express').json());
    // No req.user set
    const offersRouter = require('../src/routes/offers');
    testApp.use('/requests', offersRouter);
    testApp.use(require('../src/middlewares/errorHandler'));
    return request(testApp);
}

describe('POST /requests/:requestId/offers/:offerId/accept', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        require('../src/config/db').testConnection.mockResolvedValue({ connected: true });
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
        mockClient.release.mockReset();
    });

    // ── Authentication ───────────────────────────────────────────────────

    describe('Authentication', () => {
        test('returns 401 when no user is authenticated', async () => {
            const res = await noAuthAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(401);
            expect(res.body.error).toBe('Unauthorized');
        });
    });

    // ── Ownership ────────────────────────────────────────────────────────

    describe('Ownership', () => {
        test('returns 403 when user does not own the request', async () => {
            // Ownership query returns a different user
            query.mockResolvedValueOnce({
                rows: [{ user_id: 'different-user-id' }],
            });

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(403);
            expect(res.body.error).toBe('Forbidden');
        });

        test('returns 404 when request does not exist (ownership check)', async () => {
            query.mockResolvedValueOnce({ rows: [] });

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(404);
            expect(res.body.error_code).toBe('request_not_found');
        });
    });

    // ── Successful Acceptance ────────────────────────────────────────────

    describe('Successful Acceptance', () => {
        test('accepts offer and returns 200 with standard response', async () => {
            // Ownership check passes
            query.mockResolvedValueOnce({
                rows: [{ user_id: MOCK_USER_ID }],
            });

            // Transaction steps (8 total now, including Step 8: order INSERT)
            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })      // Step 1: lock request
                .mockResolvedValueOnce({ rows: [{ id: MOCK_OFFER_ID, status: 'pending' }] }) // Step 3: lock offer
                .mockResolvedValueOnce({ rowCount: 1 })                             // Step 5: accept offer
                .mockResolvedValueOnce({ rowCount: 2 })                             // Step 6: reject others
                .mockResolvedValueOnce({ rowCount: 1 })                             // Step 7: transition request
                .mockResolvedValueOnce({ rows: [{ id: 'new-order-id' }] })          // Step 8: INSERT order
                .mockResolvedValueOnce({});                                         // COMMIT

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(200);
            expect(res.body.accepted).toBe(true);
            expect(res.body.offer_id).toBe(MOCK_OFFER_ID);
            expect(res.body.request_id).toBe(MOCK_REQUEST_ID);
            expect(res.body.request_state).toBe('accepted');

            // Verify lock order: BEGIN → requests FOR UPDATE → offers FOR UPDATE
            const calls = mockClient.query.mock.calls;
            expect(calls[0][0]).toBe('BEGIN');
            expect(calls[1][0]).toContain('requests');
            expect(calls[1][0]).toContain('FOR UPDATE');
            expect(calls[2][0]).toContain('offers');
            expect(calls[2][0]).toContain('FOR UPDATE');
        });
    });

    // ── Idempotent Re-Accept ─────────────────────────────────────────────

    describe('Idempotent Re-Accept', () => {
        test('returns 200 when the same offer is already accepted (inside tx)', async () => {
            query.mockResolvedValueOnce({ rows: [{ user_id: MOCK_USER_ID }] });

            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })      // Step 1
                .mockResolvedValueOnce({ rows: [{ id: MOCK_OFFER_ID, status: 'accepted' }] }) // Step 3: already accepted
                .mockResolvedValueOnce({});                                         // ROLLBACK

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(200);
            expect(res.body.accepted).toBe(true);
        });

        test('returns 200 when request already accepted and this offer was the one (state check)', async () => {
            query.mockResolvedValueOnce({ rows: [{ user_id: MOCK_USER_ID }] });

            // Request already in 'accepted' state
            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'accepted' }] })           // Step 1: already accepted
                .mockResolvedValueOnce({})                                          // ROLLBACK
                .mockResolvedValueOnce({ rows: [{ status: 'accepted' }] });         // Idempotency check (still uses client)

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(200);
            expect(res.body.accepted).toBe(true);
        });
    });

    // ── Double Acceptance (Different Offers) ─────────────────────────────

    describe('Double Acceptance', () => {
        test('returns 409 when trying to accept a different offer after one is already accepted', async () => {
            query.mockResolvedValueOnce({ rows: [{ user_id: MOCK_USER_ID }] });

            // Request already 'accepted' — and this offer was NOT the accepted one
            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'accepted' }] })           // Step 1
                .mockResolvedValueOnce({})                                          // ROLLBACK
                .mockResolvedValueOnce({ rows: [{ status: 'rejected' }] });         // Idempotency check (rejected)

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(409);
            expect(res.body.error_code).toBe('offer_already_rejected');
        });
    });

    // ── Accept After Expiry ──────────────────────────────────────────────

    describe('Accept After Expiry', () => {
        test('returns 409 when request is expired', async () => {
            query.mockResolvedValueOnce({ rows: [{ user_id: MOCK_USER_ID }] });

            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'expired' }] })            // Step 1
                .mockResolvedValueOnce({});                                         // ROLLBACK

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(409);
            expect(res.body.error_code).toBe('request_not_accepting');
            expect(res.body.message).toContain('expired');
        });
    });

    // ── Offer Not Found ──────────────────────────────────────────────────

    describe('Offer Not Found', () => {
        test('returns 404 when offer does not belong to request', async () => {
            // Ownership check passes
            query.mockResolvedValueOnce({ rows: [{ user_id: MOCK_USER_ID }] });

            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })      // Step 1: lock request
                .mockResolvedValueOnce({ rows: [] })                                // Step 3: offer not found
                .mockResolvedValueOnce({});                                         // ROLLBACK

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(404);
            expect(res.body.error_code).toBe('offer_not_found');
        });
    });

    // ── Accept Rejected Offer ────────────────────────────────────────────

    describe('Accept Rejected Offer', () => {
        test('returns 409 when offer has already been rejected', async () => {
            query.mockResolvedValueOnce({ rows: [{ user_id: MOCK_USER_ID }] });

            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })      // Step 1
                .mockResolvedValueOnce({ rows: [{ id: MOCK_OFFER_ID, status: 'rejected' }] }) // Step 3
                .mockResolvedValueOnce({});                                         // ROLLBACK

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(409);
            expect(res.body.error_code).toBe('offer_already_rejected');
        });
    });

    // ── Accept Expired Offer ─────────────────────────────────────────────

    describe('Accept Expired Offer', () => {
        test('returns 409 when offer has expired', async () => {
            query.mockResolvedValueOnce({ rows: [{ user_id: MOCK_USER_ID }] });

            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })      // Step 1
                .mockResolvedValueOnce({ rows: [{ id: MOCK_OFFER_ID, status: 'expired' }] }) // Step 3
                .mockResolvedValueOnce({});                                         // ROLLBACK

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(409);
            expect(res.body.error_code).toBe('offer_expired');
        });
    });

    // ── Lock Order Invariant ─────────────────────────────────────────────

    describe('Invariants', () => {
        test('lock order is always requests first, then offers (A-5 deadlock prevention)', async () => {
            query.mockResolvedValueOnce({ rows: [{ user_id: MOCK_USER_ID }] });

            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })      // Step 1
                .mockResolvedValueOnce({ rows: [{ id: MOCK_OFFER_ID, status: 'pending' }] })
                .mockResolvedValueOnce({ rowCount: 1 })
                .mockResolvedValueOnce({ rowCount: 0 })
                .mockResolvedValueOnce({ rowCount: 1 })
                .mockResolvedValueOnce({ rows: [{ id: 'order-id' }] })              // Step 8
                .mockResolvedValueOnce({});                                         // COMMIT

            await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            const calls = mockClient.query.mock.calls;
            // Find the two FOR UPDATE calls
            const forUpdateCalls = calls.filter(c =>
                typeof c[0] === 'string' && c[0].includes('FOR UPDATE')
            );

            expect(forUpdateCalls).toHaveLength(2);
            expect(forUpdateCalls[0][0]).toContain('requests');
            expect(forUpdateCalls[1][0]).toContain('offers');
        });

        test('transaction is rolled back on error (no partial state)', async () => {
            query.mockResolvedValueOnce({ rows: [{ user_id: MOCK_USER_ID }] });

            mockClient.query
                .mockResolvedValueOnce({})                                          // BEGIN
                .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })      // Step 1
                .mockRejectedValueOnce(new Error('DB connection lost'));             // Step 3 fails

            const res = await authAgent()
                .post(`/requests/${MOCK_REQUEST_ID}/offers/${MOCK_OFFER_ID}/accept`);

            expect(res.status).toBe(500);

            // Verify ROLLBACK was called
            const rollbackCalls = mockClient.query.mock.calls.filter(c =>
                typeof c[0] === 'string' && c[0] === 'ROLLBACK'
            );
            expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
        });
    });
});
