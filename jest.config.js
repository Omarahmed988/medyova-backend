'use strict';

/** @type {import('jest').Config} */
module.exports = {
    // Test file pattern
    testMatch: ['**/tests/**/*.test.js'],

    // Node environment (no DOM)
    testEnvironment: 'node',

    // Coverage always collected on npm test
    collectCoverage: true,
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],

    // Coverage collected from src/ only
    collectCoverageFrom: [
        'src/**/*.js',
        '!src/**/__mocks__/**',
    ],

    // Verbose output for CI visibility
    verbose: true,
};
