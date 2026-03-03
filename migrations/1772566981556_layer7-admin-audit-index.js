/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
    // Phase 11 Step 4a: Partial Index for Admin Critical Settings Audit
    // Ensures reading from the audit log for settings/flags is 0ms, ignoring millions of non-setting events.
    pgm.sql(`
        CREATE INDEX idx_system_audit_critical_reads
        ON system_audit_logs (created_at DESC)
        WHERE target_type IN ('system_settings', 'feature_flags');
    `);
};

exports.down = (pgm) => {
    pgm.sql(`
        DROP INDEX IF EXISTS idx_system_audit_critical_reads;
    `);
};
