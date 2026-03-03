'use strict';
/**
 * tests/settingsService.test.js
 * Phase 11 — settingsService unit tests
 */

const settingsService = require('../src/services/settingsService');
const settingsCache = require('../src/config/settingsCache');
const { query } = require('../src/config/db');

// Mock dependencies
jest.mock('../src/config/db', () => ({
    query: jest.fn(),
}));

jest.mock('../src/config/settingsCache', () => ({
    getSettingMeta: jest.fn(),
    refresh: jest.fn().mockResolvedValue(),
}));

const DUMMY_ACTOR_ID = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
    jest.clearAllMocks();
});

describe('settingsService.updateSetting', () => {

    test('throws 404 NOT_FOUND if key not in cache', async () => {
        settingsCache.getSettingMeta.mockReturnValue(null);
        await expect(settingsService.updateSetting('unknown_key', '10', DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'setting_not_found' });
    });

    test('throws 403 FORBIDDEN if setting is locked', async () => {
        settingsCache.getSettingMeta.mockReturnValue({ is_locked: true });
        await expect(settingsService.updateSetting('locked_key', '10', DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'setting_locked' });
    });

    test('throws 400 BAD_REQUEST for type mismatch (boolean expects true/false)', async () => {
        settingsCache.getSettingMeta.mockReturnValue({ type: 'boolean', is_locked: false });
        await expect(settingsService.updateSetting('bool_key', 'yes', DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'invalid_type: expected "true" or "false"' });
    });

    test('throws 400 BAD_REQUEST for type mismatch (integer expects integer)', async () => {
        settingsCache.getSettingMeta.mockReturnValue({ type: 'integer', is_locked: false });
        await expect(settingsService.updateSetting('int_key', '10.5', DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'invalid_type: expected integer' });
    });

    test('throws 400 BAD_REQUEST for exceeding max_val (integer)', async () => {
        settingsCache.getSettingMeta.mockReturnValue({ type: 'integer', max_val: '100', is_locked: false });
        await expect(settingsService.updateSetting('int_key', '101', DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'exceeds_maximum: max allowed is 100' });
    });

    test('throws 400 BAD_REQUEST for dropping below min_val (decimal)', async () => {
        settingsCache.getSettingMeta.mockReturnValue({ type: 'decimal', min_val: '5.00', is_locked: false });
        await expect(settingsService.updateSetting('dec_key', '4.99', DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'below_minimum: min allowed is 5.00' });
    });

    test('accepts 0% for commission_rate_percent (no min_val limit)', async () => {
        settingsCache.getSettingMeta.mockReturnValue({ type: 'decimal', min_val: null, max_val: '30.00', is_locked: false });

        // Mock current DB value fetch
        query.mockResolvedValueOnce({ rows: [{ value: '10.00' }] });
        // Mock UPDATE
        query.mockResolvedValueOnce({});
        // Mock NOTIFY
        query.mockResolvedValueOnce({});

        const res = await settingsService.updateSetting('commission_rate_percent', '0.00', DUMMY_ACTOR_ID, true);

        expect(res).toEqual({
            key: 'commission_rate_percent',
            previous_value: '10.00',
            new_value: '0.00'
        });
    });

    test('throws 400 BAD_REQUEST if critical key missing confirmFlag (strict check)', async () => {
        settingsCache.getSettingMeta.mockReturnValue({ type: 'decimal', max_val: '30.00', is_locked: false });

        // Pass 1, 'true', undefined -> all should fail
        await expect(settingsService.updateSetting('commission_rate_percent', '10.00', DUMMY_ACTOR_ID, undefined))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('confirmation_required') });

        await expect(settingsService.updateSetting('commission_rate_percent', '10.00', DUMMY_ACTOR_ID, 'true'))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('confirmation_required') });

        await expect(settingsService.updateSetting('commission_rate_percent', '10.00', DUMMY_ACTOR_ID, 1))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('confirmation_required') });
    });

    test('success sequence executes UPDATE -> NOTIFY -> refresh', async () => {
        settingsCache.getSettingMeta.mockReturnValue({ type: 'integer', min_val: '1', max_val: '20', is_locked: false });

        query.mockResolvedValueOnce({ rows: [{ value: '5' }] }); // SELECT current
        query.mockResolvedValueOnce({}); // UPDATE
        query.mockResolvedValueOnce({}); // NOTIFY

        await settingsService.updateSetting('max_active_requests_per_user', '10', DUMMY_ACTOR_ID);

        // Sequence verifications
        expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('SELECT value FROM system_settings'), ['max_active_requests_per_user']);
        expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('UPDATE system_settings'), ['10', DUMMY_ACTOR_ID, 'max_active_requests_per_user']);
        expect(query).toHaveBeenNthCalledWith(3, 'NOTIFY config_changed');

        // Assert refresh was called
        expect(settingsCache.refresh).toHaveBeenCalledTimes(1);
    });
});


describe('settingsService.updateFlag', () => {

    test('throws 400 BAD_REQUEST for invalid scope', async () => {
        await expect(settingsService.updateFlag('flag1', true, 'invalid_scope', null, DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'invalid_scope: must be global or zone' });
    });

    test('throws 400 BAD_REQUEST for global scope with scope_id', async () => {
        await expect(settingsService.updateFlag('flag1', true, 'global', 'zone-id', DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'scope_id_not_allowed: global flags must not have a scope_id' });
    });

    test('throws 400 BAD_REQUEST for zone scope missing scope_id', async () => {
        await expect(settingsService.updateFlag('flag1', true, 'zone', null, DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'zone_not_found: scope_id required for zone flags' });
    });

    test('throws 400 BAD_REQUEST if zone scope_id is invalid or inactive', async () => {
        // zone check returns empty rows
        query.mockResolvedValueOnce({ rows: [] });

        await expect(settingsService.updateFlag('flag1', true, 'zone', 'invalid-zone-uuid', DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'zone_not_found: zone does not exist or is inactive' });

        // Verify rigorous SQL check for zone fail-closed requirement
        expect(query).toHaveBeenNthCalledWith(1,
            'SELECT id FROM zones WHERE id = $1 AND is_active = true',
            ['invalid-zone-uuid']
        );
    });

    test('throws 400 BAD_REQUEST if critical flag missing strict confirmFlag', async () => {
        await expect(settingsService.updateFlag('subscription_engine_enabled', false, 'global', null, DUMMY_ACTOR_ID, 'true'))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('confirmation_required') });
    });

    test('throws 400 BAD_REQUEST for non-boolean isEnabled', async () => {
        query.mockResolvedValueOnce({ rows: [{ is_enabled: true }] }); // flag exists query prep

        await expect(settingsService.updateFlag('offer_visibility_enabled', 'false', 'global', null, DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'invalid_type: isEnabled must be boolean' });
    });

    test('throws 404 NOT_FOUND if flag state not found', async () => {
        query.mockResolvedValueOnce({ rows: [] }); // state select returns empty

        await expect(settingsService.updateFlag('offer_visibility_enabled', false, 'global', null, DUMMY_ACTOR_ID))
            .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'flag_not_found' });
    });

    test('success sequence executes UPDATE -> NOTIFY -> refresh (Global)', async () => {
        query.mockResolvedValueOnce({ rows: [{ is_enabled: true }] }); // SELECT current state
        query.mockResolvedValueOnce({}); // UPDATE
        query.mockResolvedValueOnce({}); // NOTIFY

        const res = await settingsService.updateFlag('offer_visibility_enabled', false, 'global', null, DUMMY_ACTOR_ID);

        expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('SELECT is_enabled FROM feature_flags'), ['offer_visibility_enabled', 'global', null]);
        expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('UPDATE feature_flags'), [false, DUMMY_ACTOR_ID, 'offer_visibility_enabled', 'global', null]);
        expect(query).toHaveBeenNthCalledWith(3, 'NOTIFY config_changed');
        expect(settingsCache.refresh).toHaveBeenCalledTimes(1);

        expect(res).toEqual({
            key: 'offer_visibility_enabled',
            scope: 'global',
            scope_id: null,
            previous_value: true,
            new_value: false
        });
    });

    test('success sequence works for Zone scope', async () => {
        const zoneId = 'uuid-uuid';
        query.mockResolvedValueOnce({ rows: [{ id: zoneId }] }); // SELECT zone check
        query.mockResolvedValueOnce({ rows: [{ is_enabled: true }] }); // SELECT current state
        query.mockResolvedValueOnce({}); // UPDATE
        query.mockResolvedValueOnce({}); // NOTIFY

        await settingsService.updateFlag('rare_medicine_routing_enabled', false, 'zone', zoneId, DUMMY_ACTOR_ID, true);

        // check sequence
        expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('SELECT id FROM zones'), [zoneId]);
        expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('SELECT is_enabled FROM feature_flags'), ['rare_medicine_routing_enabled', 'zone', zoneId]);
        expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining('UPDATE feature_flags'), [false, DUMMY_ACTOR_ID, 'rare_medicine_routing_enabled', 'zone', zoneId]);
        expect(query).toHaveBeenNthCalledWith(4, 'NOTIFY config_changed');
    });

});
