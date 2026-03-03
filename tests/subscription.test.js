'use strict';

/**
 * Unit tests for Phase 8: Subscription Engine.
 *
 * Tests cover:
 *   - Request generation (direct broadcasted)
 *   - Idempotency (last_run_at guard)
 *   - Insurance guard (inactive profile skip)
 *   - Pre-check sweep
 *   - Notification stub
 *   - computeNextRunAt logic
 *   - FOR UPDATE SKIP LOCKED queries
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

const MOCK_SUB_ID = 'aaa00000-0000-0000-0000-000000000001';
const MOCK_USER_ID = 'bbb00000-0000-0000-0000-000000000002';
const MOCK_ZONE_ID = 'ccc00000-0000-0000-0000-000000000003';
const MOCK_REQUEST_ID = 'ddd00000-0000-0000-0000-000000000004';
const MOCK_INSURANCE_ID = 'eee00000-0000-0000-0000-000000000005';

// ── Subscription Service Tests ─────────────────────────────────────────

describe('Subscription Service — Request Generation', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
        mockClient.release.mockReset();
    });

    const { generateRequest } = require('../src/services/subscriptionService');

    function mockActiveSub(overrides = {}) {
        return {
            id: MOCK_SUB_ID,
            user_id: MOCK_USER_ID,
            zone_id: MOCK_ZONE_ID,
            contact_phone: '+966500000000',
            preferred_day_of_month: 15,
            next_run_at: new Date('2026-02-15T08:00:00Z'),
            last_run_at: null,
            insurance_profile_id: null,
            prescription_url: null,
            notes: 'Monthly refill',
            ...overrides,
        };
    }

    test('generates request directly as broadcasted', async () => {
        const sub = mockActiveSub();

        mockClient.query
            .mockResolvedValueOnce({})                                 // BEGIN
            .mockResolvedValueOnce({ rows: [sub] })                   // SELECT FOR UPDATE
            .mockResolvedValueOnce({ rows: [{ id: MOCK_REQUEST_ID }] }) // INSERT request
            .mockResolvedValueOnce({ rowCount: 3 })                   // INSERT items
            .mockResolvedValueOnce({ rowCount: 1 })                   // UPDATE subscription
            .mockResolvedValueOnce({});                                // COMMIT

        const result = await generateRequest(MOCK_SUB_ID);

        expect(result.success).toBe(true);
        expect(result.request_id).toBe(MOCK_REQUEST_ID);

        // Verify request INSERT uses 'broadcasted' state
        const insertCall = mockClient.query.mock.calls[2];
        expect(insertCall[0]).toContain("'broadcasted'");
        expect(insertCall[0]).toContain("broadcasted_at");
        expect(insertCall[0]).not.toContain("'draft'");
    });

    test('sets last_request_id on subscription update', async () => {
        const sub = mockActiveSub();

        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [sub] })
            .mockResolvedValueOnce({ rows: [{ id: MOCK_REQUEST_ID }] })
            .mockResolvedValueOnce({ rowCount: 2 })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({});

        await generateRequest(MOCK_SUB_ID);

        // Verify UPDATE subscription includes last_request_id
        const updateCall = mockClient.query.mock.calls[4];
        expect(updateCall[0]).toContain('last_request_id');
        expect(updateCall[1]).toContain(MOCK_REQUEST_ID);
    });

    test('skips when already generated this cycle (idempotency guard)', async () => {
        const sub = mockActiveSub({
            next_run_at: new Date('2026-03-15T08:00:00Z'),
            last_run_at: new Date('2026-03-15T08:01:00Z'),  // After next_run_at - 1 day
        });

        mockClient.query
            .mockResolvedValueOnce({})              // BEGIN
            .mockResolvedValueOnce({ rows: [sub] }) // SELECT FOR UPDATE
            .mockResolvedValueOnce({});              // ROLLBACK

        const result = await generateRequest(MOCK_SUB_ID);

        expect(result.success).toBe(true);
        expect(result.skipped).toBe('already_generated_this_cycle');
    });

    test('skips when insurance profile is inactive', async () => {
        const sub = mockActiveSub({
            insurance_profile_id: MOCK_INSURANCE_ID,
        });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        mockClient.query
            .mockResolvedValueOnce({})              // BEGIN
            .mockResolvedValueOnce({ rows: [sub] }) // SELECT FOR UPDATE
            .mockResolvedValueOnce({ rows: [{ is_active: false }] }) // Insurance check
            .mockResolvedValueOnce({});              // ROLLBACK

        const result = await generateRequest(MOCK_SUB_ID);

        expect(result.success).toBe(false);
        expect(result.skipped).toBe('insurance_profile_inactive');
        expect(warnSpy).toHaveBeenCalled();

        warnSpy.mockRestore();
    });

    test('skips when insurance profile not found', async () => {
        const sub = mockActiveSub({
            insurance_profile_id: MOCK_INSURANCE_ID,
        });
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [sub] })
            .mockResolvedValueOnce({ rows: [] })  // Profile not found
            .mockResolvedValueOnce({});

        const result = await generateRequest(MOCK_SUB_ID);

        expect(result.success).toBe(false);
        expect(result.skipped).toBe('insurance_profile_inactive');

        warnSpy.mockRestore();
    });

    test('proceeds when insurance profile is active', async () => {
        const sub = mockActiveSub({
            insurance_profile_id: MOCK_INSURANCE_ID,
        });

        mockClient.query
            .mockResolvedValueOnce({})                                   // BEGIN
            .mockResolvedValueOnce({ rows: [sub] })                     // SELECT FOR UPDATE
            .mockResolvedValueOnce({ rows: [{ is_active: true }] })     // Insurance check passes
            .mockResolvedValueOnce({ rows: [{ id: MOCK_REQUEST_ID }] }) // INSERT request
            .mockResolvedValueOnce({ rowCount: 2 })                     // INSERT items
            .mockResolvedValueOnce({ rowCount: 1 })                     // UPDATE subscription
            .mockResolvedValueOnce({});                                  // COMMIT

        const result = await generateRequest(MOCK_SUB_ID);

        expect(result.success).toBe(true);
        expect(result.request_id).toBe(MOCK_REQUEST_ID);
    });

    test('returns error for inactive subscription', async () => {
        mockClient.query
            .mockResolvedValueOnce({})          // BEGIN
            .mockResolvedValueOnce({ rows: [] }) // Not found / inactive
            .mockResolvedValueOnce({});          // ROLLBACK

        const result = await generateRequest(MOCK_SUB_ID);

        expect(result.success).toBe(false);
        expect(result.error).toContain('not found');
    });

    test('copies subscription_items to request_items', async () => {
        const sub = mockActiveSub();

        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [sub] })
            .mockResolvedValueOnce({ rows: [{ id: MOCK_REQUEST_ID }] })
            .mockResolvedValueOnce({ rowCount: 3 })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({});

        await generateRequest(MOCK_SUB_ID);

        // Verify item copy SQL
        const itemsCopyCall = mockClient.query.mock.calls[3];
        expect(itemsCopyCall[0]).toContain('INSERT INTO request_items');
        expect(itemsCopyCall[0]).toContain('FROM subscription_items');
        expect(itemsCopyCall[1]).toEqual([MOCK_REQUEST_ID, MOCK_SUB_ID]);
    });
});

// ── computeNextRunAt Tests ──────────────────────────────────────────────

describe('Subscription Service — computeNextRunAt', () => {
    const { computeNextRunAt } = require('../src/services/subscriptionService');

    test('computes next month same day at 08:00 UTC', () => {
        const from = new Date('2026-03-01T10:00:00Z');
        const next = computeNextRunAt(from, 15);

        expect(next.getUTCFullYear()).toBe(2026);
        expect(next.getUTCMonth()).toBe(3); // April (0-indexed)
        expect(next.getUTCDate()).toBe(15);
        expect(next.getUTCHours()).toBe(8);
    });

    test('handles December → January year rollover', () => {
        const from = new Date('2026-12-15T08:00:00Z');
        const next = computeNextRunAt(from, 10);

        expect(next.getUTCFullYear()).toBe(2027);
        expect(next.getUTCMonth()).toBe(0); // January
        expect(next.getUTCDate()).toBe(10);
    });

    test('day 28 works for all months (no overflow)', () => {
        const from = new Date('2026-01-28T08:00:00Z');
        const next = computeNextRunAt(from, 28);

        expect(next.getUTCMonth()).toBe(1); // February
        expect(next.getUTCDate()).toBe(28);
    });
});

// ── Pre-check Tests ─────────────────────────────────────────────────────

describe('Subscription Service — Pre-check', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
    });

    const { runPrecheck } = require('../src/services/subscriptionService');

    test('returns passed when pharmacies exist in zone', async () => {
        mockClient.query.mockResolvedValueOnce({
            rows: [{ has_pharmacies: true }],
        });

        const status = await runPrecheck(mockClient, { zone_id: MOCK_ZONE_ID });
        expect(status).toBe('passed');
    });

    test('returns failed when no pharmacies in zone', async () => {
        mockClient.query.mockResolvedValueOnce({
            rows: [{ has_pharmacies: false }],
        });

        const status = await runPrecheck(mockClient, { zone_id: MOCK_ZONE_ID });
        expect(status).toBe('failed');
    });
});

// ── Notification Stub Tests ─────────────────────────────────────────────

describe('Subscription Service — Notification Stub', () => {
    const { notifyPrecheckFailed } = require('../src/services/subscriptionService');

    test('logs structured notification event', () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();

        notifyPrecheckFailed(MOCK_SUB_ID, MOCK_USER_ID, 'No pharmacies');

        expect(logSpy).toHaveBeenCalledTimes(1);
        const logged = JSON.parse(logSpy.mock.calls[0][0]);
        expect(logged.event).toBe('precheck_notification');
        expect(logged.subscription_id).toBe(MOCK_SUB_ID);
        expect(logged.user_id).toBe(MOCK_USER_ID);

        logSpy.mockRestore();
    });
});

// ── Sweep Worker Tests ──────────────────────────────────────────────────

describe('Subscription Sweep — Pre-check Sweep', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
        mockClient.release.mockReset();
    });

    const { runPrecheckSweep } = require('../src/workers/subscription-sweep');

    test('uses FOR UPDATE SKIP LOCKED in query', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();

        mockClient.query.mockResolvedValueOnce({ rows: [] }); // No due subs

        await runPrecheckSweep();

        const sweepQuery = mockClient.query.mock.calls[0][0];
        expect(sweepQuery).toContain('FOR UPDATE SKIP LOCKED');

        logSpy.mockRestore();
    });

    test('calls notification stub on failed pre-check', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation();

        const sub = {
            id: MOCK_SUB_ID,
            user_id: MOCK_USER_ID,
            zone_id: MOCK_ZONE_ID,
            insurance_profile_id: null,
            precheck_offset_days: 2,
        };

        mockClient.query
            .mockResolvedValueOnce({ rows: [sub] })              // SELECT FOR UPDATE SKIP LOCKED
            .mockResolvedValueOnce({ rows: [{ has_pharmacies: false }] }) // Pre-check → failed
            .mockResolvedValueOnce({ rowCount: 1 });              // UPDATE precheck_status

        const result = await runPrecheckSweep();

        expect(result.processed).toBe(1);
        expect(result.failed).toBe(1);

        // Verify notification stub was called
        const notifLog = logSpy.mock.calls.find(
            c => JSON.parse(c[0]).event === 'precheck_notification'
        );
        expect(notifLog).toBeDefined();

        logSpy.mockRestore();
    });
});

describe('Subscription Sweep — Generation Sweep', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
        mockClient.release.mockReset();
    });

    const { runGenerationSweep } = require('../src/workers/subscription-sweep');

    test('uses FOR UPDATE SKIP LOCKED in query', async () => {
        mockClient.query.mockResolvedValueOnce({ rows: [] });

        await runGenerationSweep();

        const sweepQuery = mockClient.query.mock.calls[0][0];
        expect(sweepQuery).toContain('FOR UPDATE SKIP LOCKED');
    });
});

// ── Transaction Integrity Tests ─────────────────────────────────────────

describe('Subscription Service — Transaction Integrity', () => {
    let mockClient;

    beforeEach(() => {
        jest.clearAllMocks();
        mockClient = pool._mockClient;
        mockClient.query.mockReset();
        mockClient.release.mockReset();
    });

    const { generateRequest } = require('../src/services/subscriptionService');

    test('rolls back on error during request INSERT', async () => {
        const sub = {
            id: MOCK_SUB_ID, user_id: MOCK_USER_ID, zone_id: MOCK_ZONE_ID,
            contact_phone: '+966', preferred_day_of_month: 15,
            next_run_at: new Date('2026-02-15'), last_run_at: null,
            insurance_profile_id: null, prescription_url: null, notes: null,
        };

        mockClient.query
            .mockResolvedValueOnce({})              // BEGIN
            .mockResolvedValueOnce({ rows: [sub] }) // SELECT FOR UPDATE
            .mockRejectedValueOnce(new Error('Insert failed')) // INSERT fails
            .mockResolvedValueOnce({});              // ROLLBACK

        await expect(generateRequest(MOCK_SUB_ID)).rejects.toThrow('Insert failed');

        // Verify ROLLBACK was called
        const rollbackCalls = mockClient.query.mock.calls.filter(
            c => typeof c[0] === 'string' && c[0] === 'ROLLBACK'
        );
        expect(rollbackCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('SELECT uses FOR UPDATE for subscription lock', async () => {
        const sub = {
            id: MOCK_SUB_ID, user_id: MOCK_USER_ID, zone_id: MOCK_ZONE_ID,
            contact_phone: '+966', preferred_day_of_month: 15,
            next_run_at: new Date('2026-02-15'), last_run_at: null,
            insurance_profile_id: null, prescription_url: null, notes: null,
        };

        mockClient.query
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ rows: [sub] })
            .mockResolvedValueOnce({ rows: [{ id: MOCK_REQUEST_ID }] })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({ rowCount: 1 })
            .mockResolvedValueOnce({});

        await generateRequest(MOCK_SUB_ID);

        const lockQuery = mockClient.query.mock.calls[1][0];
        expect(lockQuery).toContain('FOR UPDATE');
    });
});
