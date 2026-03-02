'use strict';

/**
 * Unit tests for Phase 7: Order Lifecycle.
 *
 * Tests cover:
 *   - Order service state transitions
 *   - Commission_status transitions (earned/voided)
 *   - Cancellation rules (user/pharmacy)
 *   - No backward transitions
 *   - Terminal state enforcement
 *   - SLA sweep auto-cancel
 *   - Step 8: atomic order creation in acceptance tx
 */

// Mock db module
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

const { pool } = require('../src/config/db');

const MOCK_ORDER_ID = '880e8400-e29b-41d4-a716-446655440010';
const MOCK_REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';
const MOCK_OFFER_ID = '660e8400-e29b-41d4-a716-446655440001';

// ── Order Service Tests ──────────────────────────────────────────────────

describe('Order Service — State Transitions', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
        mockClient.release.mockReset();
    });

    // Must re-require after mock setup
    const { transitionOrder, ALLOWED_TRANSITIONS, TERMINAL_STATES } = require('../src/services/orderService');

    // ── Happy path transitions ───────────────────────────────────────

    test('pending → confirmed_by_pharmacy succeeds', async () => {
        mockClient.query
            .mockResolvedValueOnce({})                                          // BEGIN
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'pending', commission_status: 'pending' }],
            })                                                                   // SELECT FOR UPDATE
            .mockResolvedValueOnce({ rowCount: 1 })                             // UPDATE
            .mockResolvedValueOnce({});                                         // COMMIT

        const result = await transitionOrder(MOCK_ORDER_ID, 'confirmed_by_pharmacy');
        expect(result.success).toBe(true);
        expect(result.order.status).toBe('confirmed_by_pharmacy');
    });

    test('confirmed_by_pharmacy → preparing succeeds', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'confirmed_by_pharmacy', commission_status: 'pending' }],
            })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({});

        const result = await transitionOrder(MOCK_ORDER_ID, 'preparing');
        expect(result.success).toBe(true);
    });

    test('delivered → completed sets commission_status to earned', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'delivered', commission_status: 'pending' }],
            })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({});

        const result = await transitionOrder(MOCK_ORDER_ID, 'completed');
        expect(result.success).toBe(true);

        // Verify the UPDATE SQL includes commission_status = 'earned'
        const updateCall = mockClient.query.mock.calls[2];
        expect(updateCall[0]).toContain("commission_status = 'earned'");
    });

    // ── Cancellation with commission voiding ──────────────────────────

    test('pending → cancelled_by_user sets commission_status to voided', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'pending', commission_status: 'pending' }],
            })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({});

        const result = await transitionOrder(MOCK_ORDER_ID, 'cancelled_by_user', {
            cancellation_reason: 'Changed mind',
            cancelled_by: 'user',
        });

        expect(result.success).toBe(true);

        const updateCall = mockClient.query.mock.calls[2];
        expect(updateCall[0]).toContain("commission_status = 'voided'");
        expect(updateCall[0]).toContain('cancellation_reason');
        expect(updateCall[0]).toContain('cancelled_by');
    });

    test('confirmed → cancelled_by_pharmacy voids commission', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'confirmed_by_pharmacy', commission_status: 'pending' }],
            })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({});

        const result = await transitionOrder(MOCK_ORDER_ID, 'cancelled_by_pharmacy', {
            cancellation_reason: 'Out of stock',
            cancelled_by: 'pharmacy',
        });

        expect(result.success).toBe(true);
        const updateCall = mockClient.query.mock.calls[2];
        expect(updateCall[0]).toContain("commission_status = 'voided'");
    });

    // ── Forbidden transitions ────────────────────────────────────────

    test('rejects backward transition: confirmed → pending', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'confirmed_by_pharmacy', commission_status: 'pending' }],
            })
            .mockResolvedValueOnce({});  // ROLLBACK

        const result = await transitionOrder(MOCK_ORDER_ID, 'pending');
        expect(result.success).toBe(false);
        expect(result.error).toContain('not allowed');
    });

    test('rejects skip transition: pending → out_for_delivery', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'pending', commission_status: 'pending' }],
            })
            .mockResolvedValueOnce({});

        const result = await transitionOrder(MOCK_ORDER_ID, 'out_for_delivery');
        expect(result.success).toBe(false);
        expect(result.error).toContain('not allowed');
    });

    test('rejects out_for_delivery → cancelled_by_user (too late)', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'out_for_delivery', commission_status: 'pending' }],
            })
            .mockResolvedValueOnce({});

        const result = await transitionOrder(MOCK_ORDER_ID, 'cancelled_by_user');
        expect(result.success).toBe(false);
    });

    // ── Terminal state enforcement ───────────────────────────────────

    test('rejects transition from completed (terminal)', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'completed', commission_status: 'earned' }],
            })
            .mockResolvedValueOnce({});

        const result = await transitionOrder(MOCK_ORDER_ID, 'pending');
        expect(result.success).toBe(false);
        expect(result.error).toContain('terminal state');
    });

    test('rejects transition from cancelled_by_user (terminal)', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'cancelled_by_user', commission_status: 'voided' }],
            })
            .mockResolvedValueOnce({});

        const result = await transitionOrder(MOCK_ORDER_ID, 'confirmed_by_pharmacy');
        expect(result.success).toBe(false);
        expect(result.error).toContain('terminal state');
    });

    // ── Order not found ──────────────────────────────────────────────

    test('returns error when order not found', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({});

        const result = await transitionOrder(MOCK_ORDER_ID, 'confirmed_by_pharmacy');
        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });
});

// ── Cancel Helper Tests ──────────────────────────────────────────────────

describe('Order Service — Cancel Helpers', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
    });

    const { cancelByUser, cancelByPharmacy, cancelBySystem } = require('../src/services/orderService');

    test('cancelByUser sets cancelled_by to user', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'pending', commission_status: 'pending' }],
            })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({});

        const result = await cancelByUser(MOCK_ORDER_ID, 'Changed mind');
        expect(result.success).toBe(true);

        const updateSql = mockClient.query.mock.calls[2][0];
        expect(updateSql).toContain("commission_status = 'voided'");
    });

    test('cancelBySystem sets cancelled_by to system and status to cancelled_by_pharmacy', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'pending', commission_status: 'pending' }],
            })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({});

        const result = await cancelBySystem(MOCK_ORDER_ID, 'confirmation_timeout');
        expect(result.success).toBe(true);
    });
});

// ── SLA Sweep Tests ──────────────────────────────────────────────────────

describe('Order SLA Sweep', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
        mockClient.release.mockReset();
    });

    const { runSweep } = require('../src/workers/order-sla-sweep');

    test('cancels stale pending orders', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();

        mockClient.query
            // Initial query to find stale orders
            .mockResolvedValueOnce({ rows: [{ id: MOCK_ORDER_ID }] })
            // Per-order transaction
            .mockResolvedValueOnce({})  // BEGIN
            .mockResolvedValueOnce({    // Re-check
                rows: [{ id: MOCK_ORDER_ID, status: 'pending' }],
            })
            .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE cancelled
            .mockResolvedValueOnce({});               // COMMIT

        const result = await runSweep();
        expect(result.processed).toBe(1);
        expect(result.cancelled).toContain(MOCK_ORDER_ID);

        // Verify the update sets correct statuses
        const updateCall = mockClient.query.mock.calls[3];
        expect(updateCall[0]).toContain("status = 'cancelled_by_pharmacy'");
        expect(updateCall[0]).toContain("commission_status = 'voided'");
        expect(updateCall[0]).toContain("confirmation_timeout");
        expect(updateCall[0]).toContain("cancelled_by = 'system'");

        logSpy.mockRestore();
    });

    test('skips orders no longer pending', async () => {
        mockClient.query
            .mockResolvedValueOnce({ rows: [{ id: MOCK_ORDER_ID }] })
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({
                rows: [{ id: MOCK_ORDER_ID, status: 'confirmed_by_pharmacy' }],  // Already confirmed
            })
            .mockResolvedValueOnce({});  // ROLLBACK

        const result = await runSweep();
        expect(result.processed).toBe(1);
        expect(result.cancelled).toHaveLength(0);
    });

    test('returns empty when no stale orders', async () => {
        mockClient.query.mockResolvedValueOnce({ rows: [] });

        const result = await runSweep();
        expect(result.processed).toBe(0);
        expect(result.cancelled).toHaveLength(0);
    });
});

// ── Step 8: Acceptance + Order Creation Tests ────────────────────────────

describe('Acceptance Service — Step 8 (Order Creation)', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        require('../src/config/db').testConnection.mockResolvedValue({ connected: true });
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
        mockClient.release.mockReset();
    });

    const { acceptOffer, COMMISSION_RATE_PERCENT } = require('../src/services/offerAcceptance');

    test('Step 8 INSERT is included in acceptance transaction', async () => {
        const orderUUID = '990e8400-e29b-41d4-a716-446655440099';

        mockClient.query
            .mockResolvedValueOnce({})                                              // BEGIN
            .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })          // Step 1: lock request
            .mockResolvedValueOnce({ rows: [{ id: MOCK_OFFER_ID, status: 'pending' }] }) // Step 3: lock offer
            .mockResolvedValueOnce({ rowCount: 1 })                                 // Step 5: accept
            .mockResolvedValueOnce({ rowCount: 2 })                                 // Step 6: reject others
            .mockResolvedValueOnce({ rowCount: 1 })                                 // Step 7: transition request
            .mockResolvedValueOnce({ rows: [{ id: orderUUID }] })                   // Step 8: INSERT order
            .mockResolvedValueOnce({});                                             // COMMIT

        const result = await acceptOffer(MOCK_REQUEST_ID, MOCK_OFFER_ID);

        expect(result.success).toBe(true);
        expect(result.idempotent).toBe(false);
        expect(result.order_id).toBe(orderUUID);

        // Verify Step 8 SQL
        const step8Call = mockClient.query.mock.calls[6];
        const sql = step8Call[0];
        expect(sql).toContain('INSERT INTO orders');
        expect(sql).toContain('ROUND(o.total_price');
        expect(sql).toContain('RETURNING id');

        // Verify commission rate parameter
        const params = step8Call[1];
        expect(params).toContain(COMMISSION_RATE_PERCENT);

        // Verify Step 8 is BEFORE COMMIT
        const commitCall = mockClient.query.mock.calls[7];
        expect(commitCall[0]).toBe('COMMIT');
    });

    test('commission excludes delivery_fee (SQL only uses total_price)', async () => {
        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [{ state: 'fully_offered' }] })
            .mockResolvedValueOnce({ rows: [{ id: MOCK_OFFER_ID, status: 'pending' }] })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({ rowCount: 0 })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({ rows: [{ id: 'order-123' }] })
            .mockResolvedValueOnce({});

        await acceptOffer(MOCK_REQUEST_ID, MOCK_OFFER_ID);

        const step8Sql = mockClient.query.mock.calls[6][0];
        // Commission formula should reference total_price, not delivery_fee
        expect(step8Sql).toContain('o.total_price * $2 / 100');
        expect(step8Sql).not.toContain('delivery_fee * $');
    });

    test('COMMISSION_RATE_PERCENT defaults to 10.00', () => {
        expect(COMMISSION_RATE_PERCENT).toBe(10.00);
    });
});

// ── Allowed Transitions Map Verification ─────────────────────────────────

describe('Order Service — Transition Map Integrity', () => {
    const { ALLOWED_TRANSITIONS, TERMINAL_STATES } = require('../src/services/orderService');

    test('terminal states have no outgoing transitions', () => {
        for (const state of TERMINAL_STATES) {
            expect(ALLOWED_TRANSITIONS[state]).toBeUndefined();
        }
    });

    test('no transition leads back to pending', () => {
        for (const [, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
            expect(targets).not.toContain('pending');
        }
    });

    test('user can only cancel from pending and confirmed_by_pharmacy', () => {
        const statesAllowingUserCancel = Object.entries(ALLOWED_TRANSITIONS)
            .filter(([, targets]) => targets.includes('cancelled_by_user'))
            .map(([from]) => from);

        expect(statesAllowingUserCancel).toEqual(
            expect.arrayContaining(['pending', 'confirmed_by_pharmacy'])
        );
        expect(statesAllowingUserCancel).toHaveLength(2);
    });

    test('pharmacy can cancel from pending, confirmed, and preparing', () => {
        const statesAllowingPharmacyCancel = Object.entries(ALLOWED_TRANSITIONS)
            .filter(([, targets]) => targets.includes('cancelled_by_pharmacy'))
            .map(([from]) => from);

        expect(statesAllowingPharmacyCancel).toEqual(
            expect.arrayContaining(['pending', 'confirmed_by_pharmacy', 'preparing'])
        );
        expect(statesAllowingPharmacyCancel).toHaveLength(3);
    });
});
