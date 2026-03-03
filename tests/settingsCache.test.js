'use strict';
/**
 * tests/settingsCache.test.js
 * Phase 11 — settingsCache unit tests
 *
 * Strategy: source-level + unit-mock approach.
 * The cache module's DB dependency is mocked so tests are hermetic
 * (no live DB required). The LISTEN client is mocked via jest.mock.
 */

const settingsCache = require('../src/config/settingsCache');

// ─── Mock pg.Client ─────────────────────────────────────────────────────────
// We intercept pg.Client so no real TCP connection is made.
const mockClientListeners = {};
const mockClient = {
    on: jest.fn((event, handler) => { mockClientListeners[event] = handler; }),
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
    end: jest.fn().mockResolvedValue(undefined),
    removeAllListeners: jest.fn(),
};

jest.mock('pg', () => ({
    Client: jest.fn(() => mockClient),
    Pool: jest.fn(() => ({
        on: jest.fn(),
        query: jest.fn(),
        end: jest.fn(),
    })),
}));

// ─── Mock db.js query ────────────────────────────────────────────────────────
jest.mock('../src/config/db', () => ({
    query: jest.fn(),
    pool: null,
    testConnection: jest.fn().mockResolvedValue({ connected: true }),
}));

// ─── Mock env.js ─────────────────────────────────────────────────────────────
jest.mock('../src/config/env', () => ({
    DATABASE_URL: 'postgresql://mocked/testdb',
    NODE_ENV: 'test',
    PORT: 3000,
}));

const { query: mockQuery } = require('../src/config/db');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function buildSettingsRows(overrides = []) {
    const defaults = [
        { id: 'id-1', key: 'commission_rate_percent', value: '10.00', type: 'decimal', min_val: null, max_val: '30.00', is_locked: false },
        { id: 'id-2', key: 'pharmacy_confirm_timeout_sec', value: '900', type: 'integer', min_val: '60', max_val: '7200', is_locked: false },
        { id: 'id-3', key: 'max_active_requests_per_user', value: '5', type: 'integer', min_val: '1', max_val: '20', is_locked: false },
    ];
    return [...defaults, ...overrides];
}

function buildFlagRows(overrides = []) {
    const defaults = [
        { key: 'insurance_routing_enabled', scope: 'global', scope_id: null, is_enabled: true },
        { key: 'subscription_engine_enabled', scope: 'global', scope_id: null, is_enabled: true },
        { key: 'rare_medicine_routing_enabled', scope: 'global', scope_id: null, is_enabled: true },
        { key: 'offer_visibility_enabled', scope: 'global', scope_id: null, is_enabled: true },
        { key: 'pharmacy_registration_open', scope: 'global', scope_id: null, is_enabled: false },
    ];
    return [...defaults, ...overrides];
}

function mockDbLoad(settingRows, flagRows) {
    mockQuery
        .mockResolvedValueOnce({ rows: settingRows ?? buildSettingsRows() })
        .mockResolvedValueOnce({ rows: flagRows ?? buildFlagRows() });
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────
beforeEach(() => {
    jest.clearAllMocks();
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.query.mockResolvedValue(undefined);
    mockClient.end.mockResolvedValue(undefined);

    // Reset internal state by stopping (then re-init in each test)
    settingsCache.stop();
});

afterEach(() => {
    settingsCache.stop();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('settingsCache — init & load', () => {
    test('loads settings and flags from DB on init', async () => {
        mockDbLoad();
        await settingsCache.init();

        expect(settingsCache.getSetting('commission_rate_percent')).toBe('10.00');
        expect(settingsCache.getSetting('pharmacy_confirm_timeout_sec')).toBe('900');
    });

    test('getSettingNumber returns parsed float', async () => {
        mockDbLoad();
        await settingsCache.init();

        expect(settingsCache.getSettingNumber('commission_rate_percent', 5)).toBe(10.00);
    });

    test('getSettingNumber returns fallback for missing key', async () => {
        mockDbLoad();
        await settingsCache.init();

        expect(settingsCache.getSettingNumber('nonexistent_key', 42)).toBe(42);
    });

    test('getSetting returns null for unknown key', async () => {
        mockDbLoad();
        await settingsCache.init();

        expect(settingsCache.getSetting('unknown_key')).toBeNull();
    });

    test('getSettingMeta returns full row data', async () => {
        mockDbLoad();
        await settingsCache.init();

        const meta = settingsCache.getSettingMeta('commission_rate_percent');
        expect(meta).not.toBeNull();
        expect(meta.min_val).toBeNull(); // 0% allowed — no min
        expect(meta.max_val).toBe('30.00');
        expect(meta.is_locked).toBe(false);
    });
});

describe('settingsCache — feature flags', () => {
    test('isEnabled returns true for enabled global flag', async () => {
        mockDbLoad();
        await settingsCache.init();

        expect(settingsCache.isEnabled('insurance_routing_enabled')).toBe(true);
        expect(settingsCache.isEnabled('subscription_engine_enabled')).toBe(true);
    });

    test('isEnabled returns false for pharmacy_registration_open (disabled by default)', async () => {
        mockDbLoad();
        await settingsCache.init();

        expect(settingsCache.isEnabled('pharmacy_registration_open')).toBe(false);
    });

    test('isEnabled returns false for unknown flag (FC-7 fail-closed)', async () => {
        mockDbLoad();
        await settingsCache.init();

        expect(settingsCache.isEnabled('unknown_flag_xyz')).toBe(false);
    });

    test('isEnabled respects zone scope with scope_id', async () => {
        const zoneId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        mockDbLoad(
            buildSettingsRows(),
            [
                ...buildFlagRows(),
                { key: 'insurance_routing_enabled', scope: 'zone', scope_id: zoneId, is_enabled: false },
            ]
        );
        await settingsCache.init();

        // Global is still true
        expect(settingsCache.isEnabled('insurance_routing_enabled', { scope: 'global' })).toBe(true);
        // Zone-scoped is false
        expect(settingsCache.isEnabled('insurance_routing_enabled', { scope: 'zone', scope_id: zoneId })).toBe(false);
    });
});

describe('settingsCache — LISTEN / NOTIFY client', () => {
    test('uses pg.Client (not Pool) for LISTEN connection', async () => {
        mockDbLoad();
        const { Client } = require('pg');
        await settingsCache.init();

        expect(Client).toHaveBeenCalled();
    });

    test('calls LISTEN config_changed on the dedicated client', async () => {
        mockDbLoad();
        await settingsCache.init();

        const listenCall = mockClient.query.mock.calls.find(
            (c) => typeof c[0] === 'string' && c[0].includes('LISTEN config_changed')
        );
        expect(listenCall).toBeDefined();
    });

    test('wires error, end, and notification handlers on client', async () => {
        mockDbLoad();
        await settingsCache.init();

        expect(mockClient.on).toHaveBeenCalledWith('error', expect.any(Function));
        expect(mockClient.on).toHaveBeenCalledWith('end', expect.any(Function));
        expect(mockClient.on).toHaveBeenCalledWith('notification', expect.any(Function));
    });

    test('notification handler triggers DB refresh', async () => {
        mockDbLoad();
        await settingsCache.init();

        // Prime a second DB load for after-notification refresh
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { id: 'id-1', key: 'commission_rate_percent', value: '5.00', type: 'decimal', min_val: null, max_val: '30.00', is_locked: false },
                ]
            })
            .mockResolvedValueOnce({ rows: buildFlagRows() });

        // Simulate PG notification
        const notificationHandler = mockClientListeners['notification'];
        expect(notificationHandler).toBeDefined();
        await notificationHandler({ channel: 'config_changed', payload: 'system_settings' });

        // Cache should reflect updated value
        expect(settingsCache.getSetting('commission_rate_percent')).toBe('5.00');
    });
});

describe('settingsCache — no memory leaks', () => {
    test('stop() calls removeAllListeners on the client', async () => {
        mockDbLoad();
        await settingsCache.init();

        settingsCache.stop();

        expect(mockClient.removeAllListeners).toHaveBeenCalled();
    });

    test('stop() calls end() on the LISTEN client', async () => {
        mockDbLoad();
        await settingsCache.init();

        settingsCache.stop();

        expect(mockClient.end).toHaveBeenCalled();
    });

    test('init() is idempotent — second call is no-op', async () => {
        mockDbLoad();
        await settingsCache.init();
        await settingsCache.init(); // second call

        // DB query should only have been called once (2 queries: settings + flags)
        expect(mockQuery.mock.calls.length).toBe(2);
    });
});

describe('settingsCache — refresh()', () => {
    test('refresh() re-reads from DB and updates cache', async () => {
        mockDbLoad();
        await settingsCache.init();

        // Set up refresh response with new value
        mockQuery
            .mockResolvedValueOnce({
                rows: [
                    { id: 'id-1', key: 'commission_rate_percent', value: '0.00', type: 'decimal', min_val: null, max_val: '30.00', is_locked: false },
                ]
            })
            .mockResolvedValueOnce({ rows: buildFlagRows() });

        await settingsCache.refresh();

        expect(settingsCache.getSetting('commission_rate_percent')).toBe('0.00');
    });
});

describe('settingsCache — getStats()', () => {
    test('returns correct counts after init', async () => {
        mockDbLoad();
        await settingsCache.init();

        const stats = settingsCache.getStats();
        expect(stats.settings_count).toBe(3); // from buildSettingsRows default
        expect(stats.flags_count).toBe(5);    // from buildFlagRows default
        expect(stats.listen_connected).toBe(true);
    });

    test('listen_connected is false after stop()', async () => {
        mockDbLoad();
        await settingsCache.init();
        settingsCache.stop();

        const stats = settingsCache.getStats();
        expect(stats.listen_connected).toBe(false);
    });
});
