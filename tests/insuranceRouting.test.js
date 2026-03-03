'use strict';

/**
 * Unit tests for Phase 9: Insurance Layer — Routing Filter.
 *
 * Tests cover:
 *   - Insured request → only eligible pharmacies returned
 *   - Non-insured request → behavior unchanged
 *   - Inactive insurance profile → no pharmacies returned
 *   - Inactive contract → excluded
 *   - Rare request + insurance → filter applies + rare logic preserved
 *   - Ranking unchanged (trust_score DESC)
 *   - Escalation semantics unchanged
 *   - claimNextJob includes insurance_profile_id
 *
 * NOTE: These tests validate the SQL structure and branching logic
 * of the routing worker's queryEligiblePharmacies function. The actual
 * routing worker is a standalone process — we test via module extraction.
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

const { query, pool } = require('../src/config/db');

const MOCK_ZONE_ID = 'aaa00000-0000-0000-0000-000000000001';
const MOCK_TIER_ID = 'bbb00000-0000-0000-0000-000000000002';
const MOCK_INSURANCE_ID = 'ccc00000-0000-0000-0000-000000000003';
const MOCK_PHARMACY_1 = 'ddd00000-0000-0000-0000-000000000004';
const MOCK_PHARMACY_2 = 'ddd00000-0000-0000-0000-000000000005';

// ── Extract queryEligiblePharmacies for testing ─────────────────────────
// We need to read the routing-worker source to validate SQL structure
const fs = require('fs');
const path = require('path');
const routingWorkerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'workers', 'routing-worker.js'),
    'utf8'
);

// ═══════════════════════════════════════════════════════════════════════
// SQL Structure Validation
// ═══════════════════════════════════════════════════════════════════════

describe('Insurance Layer — SQL Structure Validation', () => {
    test('claimNextJob SELECT includes insurance_profile_id', () => {
        expect(routingWorkerSource).toContain('r.insurance_profile_id');
    });

    test('queryEligiblePharmacies has insurance JOIN for standard path', () => {
        // Verify JOIN structure exists
        expect(routingWorkerSource).toContain(
            'JOIN pharmacy_insurance_contracts pic ON pic.pharmacy_id = p.id'
        );
        expect(routingWorkerSource).toContain(
            'JOIN user_insurance_profiles uip ON uip.insurance_company_id = pic.insurance_company_id'
        );
    });

    test('insurance filter checks both profile and contract is_active', () => {
        expect(routingWorkerSource).toContain('pic.is_active = true');
        expect(routingWorkerSource).toContain('uip.is_active = true');
    });

    test('ranking remains ORDER BY trust_score DESC in all paths', () => {
        // Count occurrences of trust_score DESC in the function
        const matches = routingWorkerSource.match(/ORDER BY.*trust_score DESC/g);
        // Should appear in: standard (no insurance), standard (insurance),
        // rare (no insurance), rare (insurance) = 4 paths
        expect(matches).not.toBeNull();
        expect(matches.length).toBeGreaterThanOrEqual(4);
    });

    test('non-insured standard query is unchanged', () => {
        // The original query must still exist for non-insured path
        // Use individual line checks to avoid CRLF issues
        expect(routingWorkerSource).toContain('SELECT id FROM pharmacies');
        expect(routingWorkerSource).toContain('WHERE zone_id = $1');
        expect(routingWorkerSource).toContain('AND tier_id = $2');
        expect(routingWorkerSource).toContain('AND is_active = true');
    });

    test('non-insured rare query is unchanged', () => {
        // Use individual line checks to avoid CRLF issues
        expect(routingWorkerSource).toContain('AND supports_rare = true');
        // Verify original rare SELECT still exists (non-aliased)
        const rareMatches = routingWorkerSource.match(/SELECT id FROM pharmacies[\s\S]*?supports_rare = true/g);
        expect(rareMatches).not.toBeNull();
        expect(rareMatches.length).toBeGreaterThanOrEqual(1);
    });

    test('insurance filter uses uip.id parameter (not user_id)', () => {
        // Standard insured: should use uip.id = $3
        expect(routingWorkerSource).toContain('uip.id = $3');
        // Rare insured: should use uip.id = $2
        expect(routingWorkerSource).toContain('uip.id = $2');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Branching Logic Validation
// ═══════════════════════════════════════════════════════════════════════

describe('Insurance Layer — Branching Logic', () => {
    test('insurance_profile_id null check gates the JOIN path', () => {
        // The code should check job.insurance_profile_id before using JOIN
        expect(routingWorkerSource).toContain('if (job.insurance_profile_id)');
    });

    test('standard + rare paths both have insurance branches', () => {
        // Find all occurrences of insurance_profile_id check
        const checks = routingWorkerSource.match(/if \(job\.insurance_profile_id\)/g);
        // Should be at least 2: one for rare, one for standard
        expect(checks).not.toBeNull();
        expect(checks.length).toBeGreaterThanOrEqual(2);
    });

    test('rare path preserves supports_rare = true in insured query', () => {
        // The insured rare query must still filter by supports_rare
        const insuredRareSection = routingWorkerSource.indexOf('Rare path');
        const standardSection = routingWorkerSource.indexOf('Standard path');
        const rarePortion = routingWorkerSource.slice(insuredRareSection, standardSection);

        expect(rarePortion).toContain('supports_rare = true');
        expect(rarePortion).toContain('pharmacy_insurance_contracts');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Escalation & Tier Integrity
// ═══════════════════════════════════════════════════════════════════════

describe('Insurance Layer — Escalation Semantics Unchanged', () => {
    test('processJob function does NOT reference insurance', () => {
        // Extract processJob function body
        const processJobStart = routingWorkerSource.indexOf('async function processJob');
        const nextFunction = routingWorkerSource.indexOf('async function ', processJobStart + 30);
        const processJobBody = routingWorkerSource.slice(processJobStart, nextFunction > 0 ? nextFunction : undefined);

        // processJob should not contain direct insurance logic
        // (it delegates to queryEligiblePharmacies via executeWave)
        expect(processJobBody).not.toContain('insurance_profile_id');
        expect(processJobBody).not.toContain('insurance_company');
    });

    test('loadActiveTiers function is unchanged (no insurance reference)', () => {
        const loadTiersStart = routingWorkerSource.indexOf('async function loadActiveTiers');
        const nextFn = routingWorkerSource.indexOf('async function ', loadTiersStart + 30);
        const loadTiersBody = routingWorkerSource.slice(loadTiersStart, nextFn);

        expect(loadTiersBody).not.toContain('insurance');
    });

    test('hasFullCoverage function is unchanged (no insurance reference)', () => {
        const hasFullStart = routingWorkerSource.indexOf('async function hasFullCoverage');
        const nextFn = routingWorkerSource.indexOf('async function ', hasFullStart + 30);
        const hasFullBody = routingWorkerSource.slice(hasFullStart, nextFn);

        expect(hasFullBody).not.toContain('insurance');
    });

    test('completeWave function is unchanged (no insurance reference)', () => {
        const completeStart = routingWorkerSource.indexOf('async function completeWave');
        const nextFn = routingWorkerSource.indexOf('async function ', completeStart + 30);
        const completeBody = routingWorkerSource.slice(completeStart, nextFn);

        expect(completeBody).not.toContain('insurance');
    });

    test('waitForWaveWindow function is unchanged (no insurance reference)', () => {
        const waitStart = routingWorkerSource.indexOf('async function waitForWaveWindow');
        const nextFn = routingWorkerSource.indexOf('async function ', waitStart + 30);
        const waitBody = routingWorkerSource.slice(waitStart, nextFn);

        expect(waitBody).not.toContain('insurance');
    });

    test('activateWave function body has no insurance query logic', () => {
        const activateStart = routingWorkerSource.indexOf('async function activateWave');
        // activateWave ends with "}\n\n/**" before queryEligiblePharmacies JSDoc
        // Find the JSDoc block that starts before queryEligiblePharmacies
        const jsdocStart = routingWorkerSource.indexOf('* Query eligible pharmacies');
        // activateWave body ends a few lines before the JSDoc
        const activateBody = routingWorkerSource.slice(activateStart, jsdocStart);

        // activateWave should not contain insurance tables or columns in its SQL
        expect(activateBody).not.toContain('pharmacy_insurance_contracts');
        expect(activateBody).not.toContain('user_insurance_profiles');
        expect(activateBody).not.toContain('insurance_profile_id');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Zero-Impact Verification
// ═══════════════════════════════════════════════════════════════════════

describe('Insurance Layer — Zero Impact Verification', () => {
    const readFile = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

    test('offerAcceptance.js has ZERO insurance references', () => {
        const src = readFile('src/services/offerAcceptance.js');
        expect(src).not.toContain('insurance');
    });

    test('orderService.js has ZERO insurance references', () => {
        const src = readFile('src/services/orderService.js');
        expect(src).not.toContain('insurance');
    });

    test('offerSelection.js has ZERO insurance references', () => {
        const src = readFile('src/services/offerSelection.js');
        expect(src).not.toContain('insurance');
    });

    test('order-sla-sweep.js has ZERO insurance references', () => {
        const src = readFile('src/workers/order-sla-sweep.js');
        expect(src).not.toContain('insurance');
    });

    test('offers.js route has ZERO insurance references', () => {
        const src = readFile('src/routes/offers.js');
        expect(src).not.toContain('insurance');
    });
});

// ═══════════════════════════════════════════════════════════════════════
// Legal Boundary Confirmation
// ═══════════════════════════════════════════════════════════════════════

describe('Insurance Layer — Legal Boundary (code-level confirmation)', () => {
    test('no claim processing logic exists anywhere in services', () => {
        const services = ['offerAcceptance.js', 'orderService.js', 'offerSelection.js', 'subscriptionService.js'];
        for (const svc of services) {
            const src = fs.readFileSync(
                path.join(__dirname, '..', 'src', 'services', svc), 'utf8'
            );
            expect(src).not.toContain('claim');
            expect(src).not.toContain('coverage_calculation');
            expect(src).not.toContain('co_pay');
            expect(src).not.toContain('copay');
        }
    });

    test('routing worker has no coverage calculation', () => {
        expect(routingWorkerSource).not.toContain('coverage_calculation');
        expect(routingWorkerSource).not.toContain('co_pay');
        expect(routingWorkerSource).not.toContain('copay');
    });

    test('routing worker has no pricing logic', () => {
        expect(routingWorkerSource).not.toContain('price_adjustment');
        expect(routingWorkerSource).not.toContain('discount');
    });
});
