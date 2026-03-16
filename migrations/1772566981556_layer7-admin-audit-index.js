/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
    // Phase 11 Step 4a: Create system_audit_logs table
    pgm.sql(`
        CREATE TABLE system_audit_logs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            actor_id UUID,
            ip_address VARCHAR(45),
            action VARCHAR(100) NOT NULL,
            target_type VARCHAR(100) NOT NULL,
            target_id VARCHAR(255) NOT NULL,
            previous_state JSONB,
            new_state JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

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
        DROP TABLE IF EXISTS system_audit_logs;
    `);
};
