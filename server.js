'use strict';

const app = require('./src/app');
const { PORT, NODE_ENV } = require('./src/config/env');

// Handle unhandled promise rejections — log and continue (do not crash)
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled Promise Rejection:', reason);
});

// Handle uncaught exceptions — log and exit (cannot safely continue)
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err.message, err.stack);
    process.exit(1);
});

const server = app.listen(PORT, () => {
    console.info(`[SERVER] Medyova backend running`);
    console.info(`[SERVER] Port:        ${PORT}`);
    console.info(`[SERVER] Environment: ${NODE_ENV}`);
    console.info(`[SERVER] Health:      http://localhost:${PORT}/health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.info('[SERVER] SIGTERM received — shutting down gracefully');
    server.close(() => {
        console.info('[SERVER] HTTP server closed');
        process.exit(0);
    });
});

module.exports = server;
