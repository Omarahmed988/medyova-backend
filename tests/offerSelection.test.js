'use strict';

/**
 * Unit tests for the Offer Selection Service (Phase 5).
 *
 * Tests verify the Two-Level Ranking Model:
 *   Level 1: Coverage classification (full vs partial)
 *   Level 2: Composite score (trust_score, acceptance_rate, response speed)
 *
 * The actual SQL query is tested via mocking the db.query function.
 * We verify that the service:
 *   - Calls the correct SQL with correct parameters
 *   - Enforces limit bounds (min 1, max 3, default 2)
 *   - Returns the query results directly
 */

// Mock the db module before requiring the service
jest.mock('../src/config/db', () => ({
    query: jest.fn(),
}));

const { query } = require('../src/config/db');
const { getTopOffersForRequest } = require('../src/services/offerSelection');

describe('Offer Selection Service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getTopOffersForRequest', () => {
        const mockRequestId = '550e8400-e29b-41d4-a716-446655440000';

        test('calls query with correct requestId and default limit of 2', async () => {
            query.mockResolvedValue({ rows: [] });

            await getTopOffersForRequest(mockRequestId);

            expect(query).toHaveBeenCalledTimes(1);
            const [sql, params] = query.mock.calls[0];
            expect(params[0]).toBe(mockRequestId);
            expect(params[1]).toBe(2); // default limit
        });

        test('respects custom limit parameter', async () => {
            query.mockResolvedValue({ rows: [] });

            await getTopOffersForRequest(mockRequestId, 3);

            const [, params] = query.mock.calls[0];
            expect(params[1]).toBe(3);
        });

        test('caps limit at maximum of 3', async () => {
            query.mockResolvedValue({ rows: [] });

            await getTopOffersForRequest(mockRequestId, 10);

            const [, params] = query.mock.calls[0];
            expect(params[1]).toBe(3);
        });

        test('treats zero limit as default (2)', async () => {
            query.mockResolvedValue({ rows: [] });

            await getTopOffersForRequest(mockRequestId, 0);

            const [, params] = query.mock.calls[0];
            // 0 is falsy → parseInt(0) || 2 → 2 → Math.min(Math.max(1,2),3) = 2
            expect(params[1]).toBe(2);
        });

        test('handles NaN limit by defaulting to 2', async () => {
            query.mockResolvedValue({ rows: [] });

            await getTopOffersForRequest(mockRequestId, 'invalid');

            const [, params] = query.mock.calls[0];
            expect(params[1]).toBe(2);
        });

        test('returns query rows directly', async () => {
            const mockOffers = [
                {
                    offer_id: 'offer-1',
                    pharmacy_name: 'Gold Pharmacy',
                    trust_score: 95,
                    acceptance_rate: 0.98,
                    coverage_ratio: '100.00',
                    total_price: '150.00',
                },
                {
                    offer_id: 'offer-2',
                    pharmacy_name: 'Silver Pharmacy',
                    trust_score: 88,
                    acceptance_rate: 0.92,
                    coverage_ratio: '100.00',
                    total_price: '120.00',
                },
            ];
            query.mockResolvedValue({ rows: mockOffers });

            const result = await getTopOffersForRequest(mockRequestId);

            expect(result).toEqual(mockOffers);
            expect(result).toHaveLength(2);
        });

        test('returns empty array when no offers exist', async () => {
            query.mockResolvedValue({ rows: [] });

            const result = await getTopOffersForRequest(mockRequestId);

            expect(result).toEqual([]);
        });

        test('SQL query includes coverage_check CTE', async () => {
            query.mockResolvedValue({ rows: [] });

            await getTopOffersForRequest(mockRequestId);

            const [sql] = query.mock.calls[0];
            expect(sql).toContain('coverage_check');
            expect(sql).toContain('has_full_coverage');
            expect(sql).toContain('coverage_ratio = 100.00');
        });

        test('SQL query orders by trust_score DESC, acceptance_rate DESC, created_at ASC', async () => {
            query.mockResolvedValue({ rows: [] });

            await getTopOffersForRequest(mockRequestId);

            const [sql] = query.mock.calls[0];
            expect(sql).toContain('trust_score DESC');
            expect(sql).toContain('acceptance_rate DESC');
            expect(sql).toContain('created_at ASC');
        });

        test('SQL query does NOT include price in ORDER BY', async () => {
            query.mockResolvedValue({ rows: [] });

            await getTopOffersForRequest(mockRequestId);

            const [sql] = query.mock.calls[0];
            // Extract just the ORDER BY clause
            const orderByClause = sql.substring(sql.indexOf('ORDER BY'));
            expect(orderByClause).not.toContain('total_price');
            expect(orderByClause).not.toContain('delivery_fee');
        });

        test('SQL query joins pharmacies table for ranking fields', async () => {
            query.mockResolvedValue({ rows: [] });

            await getTopOffersForRequest(mockRequestId);

            const [sql] = query.mock.calls[0];
            expect(sql).toContain('JOIN pharmacies');
            expect(sql).toContain('p.trust_score');
            expect(sql).toContain('p.acceptance_rate');
        });
    });
});
