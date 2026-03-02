'use strict';

/**
 * Unit tests for the Offers Route and Offer Selection Service (Phase 5B).
 *
 * Tests cover:
 *   - Visibility gate pass (fully_offered + completed → serves offers)
 *   - Visibility gate fail (broadcasted, draft, expired → returns [])
 *   - Defensive recovery: expired + full coverage → serves offers with warning
 *   - Ranking order includes response_rate
 *   - 404 for unknown request
 *   - Limit enforcement
 */

// Mock the db module before requiring anything
jest.mock('../src/config/db', () => ({
    query: jest.fn(),
    testConnection: jest.fn().mockResolvedValue({ connected: true }),
}));

const request = require('supertest');
const app = require('../src/app');
const { query } = require('../src/config/db');

const MOCK_REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('GET /requests/:id/offers', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: testConnection succeeds
        require('../src/config/db').testConnection.mockResolvedValue({ connected: true });
    });

    // ── Gate Pass Tests ──────────────────────────────────────────────────

    describe('Visibility Gate — Pass', () => {
        test('returns offers when request.state=fully_offered AND job.status=completed', async () => {
            const mockOffers = [
                { offer_id: 'o1', pharmacy_name: 'Gold Pharmacy', trust_score: 95 },
                { offer_id: 'o2', pharmacy_name: 'Silver Pharmacy', trust_score: 88 },
            ];

            // Call 1: testConnection (requireDb middleware)
            // Call 2: SELECT state FROM requests
            // Call 3: SELECT status FROM routing_jobs
            // Call 4: the ranking query from offerSelection service
            query
                .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })     // request state
                .mockResolvedValueOnce({ rows: [{ status: 'completed' }] })         // job status
                .mockResolvedValueOnce({ rows: mockOffers });                        // offers query

            const res = await request(app).get(`/requests/${MOCK_REQUEST_ID}/offers`);

            expect(res.status).toBe(200);
            expect(res.body.offers).toHaveLength(2);
            expect(res.body.offers[0].offer_id).toBe('o1');
        });

        test('returns offers when request.state=partially_offered AND job.status=expired', async () => {
            const mockOffers = [
                { offer_id: 'o1', pharmacy_name: 'Partial Pharmacy', coverage_ratio: '75.00' },
            ];

            query
                .mockResolvedValueOnce({ rows: [{ state: 'partially_offered' }] })
                .mockResolvedValueOnce({ rows: [{ status: 'expired' }] })
                .mockResolvedValueOnce({ rows: mockOffers });

            const res = await request(app).get(`/requests/${MOCK_REQUEST_ID}/offers`);

            expect(res.status).toBe(200);
            expect(res.body.offers).toHaveLength(1);
        });
    });

    // ── Gate Fail Tests ──────────────────────────────────────────────────

    describe('Visibility Gate — Fail', () => {
        test('returns [] when request.state=broadcasted (routing in progress)', async () => {
            query
                .mockResolvedValueOnce({ rows: [{ state: 'broadcasted' }] })
                .mockResolvedValueOnce({ rows: [{ status: 'active' }] });

            const res = await request(app).get(`/requests/${MOCK_REQUEST_ID}/offers`);

            expect(res.status).toBe(200);
            expect(res.body.offers).toEqual([]);
        });

        test('returns [] when request.state=draft (no routing job)', async () => {
            query
                .mockResolvedValueOnce({ rows: [{ state: 'draft' }] })
                .mockResolvedValueOnce({ rows: [] }); // no job exists

            const res = await request(app).get(`/requests/${MOCK_REQUEST_ID}/offers`);

            expect(res.status).toBe(200);
            expect(res.body.offers).toEqual([]);
        });

        test('returns [] when request.state=expired and no offers exist', async () => {
            query
                .mockResolvedValueOnce({ rows: [{ state: 'expired' }] })
                .mockResolvedValueOnce({ rows: [{ status: 'expired' }] })
                .mockResolvedValueOnce({ rows: [{ has_full_coverage: false }] }); // no full coverage

            const res = await request(app).get(`/requests/${MOCK_REQUEST_ID}/offers`);

            expect(res.status).toBe(200);
            expect(res.body.offers).toEqual([]);
        });

        test('returns [] when request.state=cancelled', async () => {
            query
                .mockResolvedValueOnce({ rows: [{ state: 'cancelled' }] })
                .mockResolvedValueOnce({ rows: [{ status: 'cancelled' }] });

            const res = await request(app).get(`/requests/${MOCK_REQUEST_ID}/offers`);

            expect(res.status).toBe(200);
            expect(res.body.offers).toEqual([]);
        });

        test('returns [] when request.state=fully_offered but job.status=active (I-4 violation)', async () => {
            query
                .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })
                .mockResolvedValueOnce({ rows: [{ status: 'active' }] }); // job still active

            const res = await request(app).get(`/requests/${MOCK_REQUEST_ID}/offers`);

            expect(res.status).toBe(200);
            expect(res.body.offers).toEqual([]);
        });
    });

    // ── Defensive Recovery ───────────────────────────────────────────────

    describe('Defensive Recovery — Expired + Full Coverage (§3.3)', () => {
        test('serves offers when expired but full coverage exists (invariant_violation_I1)', async () => {
            const mockOffers = [
                { offer_id: 'o1', coverage_ratio: '100.00' },
            ];

            const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

            query
                .mockResolvedValueOnce({ rows: [{ state: 'expired' }] })         // request state
                .mockResolvedValueOnce({ rows: [{ status: 'expired' }] })         // job status
                .mockResolvedValueOnce({ rows: [{ has_full_coverage: true }] })   // defensive check
                .mockResolvedValueOnce({ rows: mockOffers });                      // offers query

            const res = await request(app).get(`/requests/${MOCK_REQUEST_ID}/offers`);

            expect(res.status).toBe(200);
            expect(res.body.offers).toHaveLength(1);
            expect(res.body.offers[0].coverage_ratio).toBe('100.00');

            // Verify invariant violation was logged
            expect(warnSpy).toHaveBeenCalledTimes(1);
            const logMsg = JSON.parse(warnSpy.mock.calls[0][0]);
            expect(logMsg.event).toBe('invariant_violation_I1');
            expect(logMsg.request_id).toBe(MOCK_REQUEST_ID);

            warnSpy.mockRestore();
        });
    });

    // ── 404 ──────────────────────────────────────────────────────────────

    describe('Request Not Found', () => {
        test('returns 404 when request does not exist', async () => {
            query.mockResolvedValueOnce({ rows: [] }); // no request found

            const res = await request(app).get(`/requests/${MOCK_REQUEST_ID}/offers`);

            expect(res.status).toBe(404);
            expect(res.body.error).toBe('Not Found');
        });
    });
});

// ── Service Layer Tests (updated for response_rate) ──────────────────────

describe('Offer Selection Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    // Re-require after mock setup
    const { getTopOffersForRequest } = require('../src/services/offerSelection');

    test('SQL includes response_rate in ORDER BY', async () => {
        query.mockResolvedValue({ rows: [] });
        await getTopOffersForRequest(MOCK_REQUEST_ID);

        const [sql] = query.mock.calls[0];
        expect(sql).toContain('response_rate DESC');
    });

    test('SQL ordering is: trust_score DESC, acceptance_rate DESC, response_rate DESC, created_at ASC', async () => {
        query.mockResolvedValue({ rows: [] });
        await getTopOffersForRequest(MOCK_REQUEST_ID);

        const [sql] = query.mock.calls[0];
        const orderByClause = sql.substring(sql.indexOf('ORDER BY'));

        // Verify correct sequence by position
        const trustPos = orderByClause.indexOf('trust_score DESC');
        const acceptPos = orderByClause.indexOf('acceptance_rate DESC');
        const responsePos = orderByClause.indexOf('response_rate DESC');
        const createdPos = orderByClause.indexOf('created_at ASC');

        expect(trustPos).toBeLessThan(acceptPos);
        expect(acceptPos).toBeLessThan(responsePos);
        expect(responsePos).toBeLessThan(createdPos);
    });

    test('SQL does NOT include price in ORDER BY', async () => {
        query.mockResolvedValue({ rows: [] });
        await getTopOffersForRequest(MOCK_REQUEST_ID);

        const [sql] = query.mock.calls[0];
        const orderByClause = sql.substring(sql.indexOf('ORDER BY'));
        expect(orderByClause).not.toContain('total_price');
        expect(orderByClause).not.toContain('delivery_fee');
    });

    test('SQL selects response_rate from pharmacies', async () => {
        query.mockResolvedValue({ rows: [] });
        await getTopOffersForRequest(MOCK_REQUEST_ID);

        const [sql] = query.mock.calls[0];
        expect(sql).toContain('p.response_rate');
    });

    test('enforces max limit of 3', async () => {
        query.mockResolvedValue({ rows: [] });
        await getTopOffersForRequest(MOCK_REQUEST_ID, 10);

        const [, params] = query.mock.calls[0];
        expect(params[1]).toBe(3);
    });

    test('defaults limit to 2', async () => {
        query.mockResolvedValue({ rows: [] });
        await getTopOffersForRequest(MOCK_REQUEST_ID);

        const [, params] = query.mock.calls[0];
        expect(params[1]).toBe(2);
    });
});
