const cron = require('node-cron');
const PharmacyScoreService = require('../services/pharmacyScoreService');

// Run the score calculator incrementally every hour
const calculateScoresTask = cron.schedule('0 * * * *', async () => {
    console.log(`[PharmacyScoreCalculator] Scheduled run started at ${new Date().toISOString()}`);
    try {
        await PharmacyScoreService.calculateScores();
    } catch (err) {
        console.error('[PharmacyScoreCalculator] Uncaught error during run:', err);
    }
}, {
    scheduled: false // Do not start automatically upon require
});

module.exports = {
    start: () => {
        calculateScoresTask.start();
        console.log('[PharmacyScoreCalculator] Background worker registered (cron: 0 * * * *)');
    },
    stop: () => {
        calculateScoresTask.stop();
        console.log('[PharmacyScoreCalculator] Background worker stopped');
    }
};
