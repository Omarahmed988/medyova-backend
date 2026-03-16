const { query } = require('../config/db');

class PharmacyScoreService {
    /**
     * Calculate scores for pharmacies that had recorded activity in the last 24 hours.
     * Updates pharmacy_scores table.
     */
    static async calculateScores() {
        console.log('[PharmacyScoreService] Starting incremental recalculation...');

        const client = await require('../config/db').pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Identify pharmacies with activity in the last 24 hours
            const activeResult = await client.query(`
                SELECT DISTINCT id AS pharmacy_id FROM pharmacies p
                WHERE EXISTS (
                    SELECT 1 FROM orders o WHERE o.pharmacy_id = p.id AND o.updated_at >= NOW() - INTERVAL '24 hours'
                )
                OR EXISTS (
                    SELECT 1 FROM offers ofr WHERE ofr.pharmacy_id = p.id AND ofr.updated_at >= NOW() - INTERVAL '24 hours'
                )
                OR EXISTS (
                    SELECT 1 FROM pharmacy_inventory pi WHERE pi.pharmacy_id = p.id AND pi.updated_at >= NOW() - INTERVAL '24 hours'
                )
            `);

            const activePharmacyIds = activeResult.rows.map(r => r.pharmacy_id);
            if (activePharmacyIds.length === 0) {
                console.log('[PharmacyScoreService] No pharmacies active in the last 24 hours. Skipping.');
                await client.query('COMMIT');
                return;
            }

            // 2. Compute stats for active pharmacies in the last 30 days
            for (const pharmacyId of activePharmacyIds) {
                // Determine denominator (orders count) in 30 days for threshold
                const ordersResult = await client.query(`
                    SELECT 
                        COUNT(*) AS total_orders,
                        COUNT(*) FILTER (WHERE status = 'completed') AS completed_orders,
                        COUNT(*) FILTER (WHERE status::text LIKE 'cancelled_%') AS cancelled_orders
                    FROM orders
                    WHERE pharmacy_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
                `, [pharmacyId]);

                const totalOrders = parseInt(ordersResult.rows[0].total_orders || 0, 10);
                const completedOrders = parseInt(ordersResult.rows[0].completed_orders || 0, 10);
                const cancelledOrders = parseInt(ordersResult.rows[0].cancelled_orders || 0, 10);

                if (completedOrders < 20) {
                    // Baseline -> Neutral (50.00, Bronze)
                    await this.upsertScore(client, pharmacyId, 50.00, 0, 0, 0, 0, cancelledOrders > 0 ? (cancelledOrders / totalOrders) : 0, 'bronze');
                    continue;
                }

                // If threshold met, compute factors

                // Factor 1: Response Time (25%) using Median
                // Capped at 15 minutes (900 seconds)
                const responseRes = await client.query(`
                    SELECT COALESCE(
                        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (updated_at - created_at))), 
                        900
                    ) AS median_response_seconds
                    FROM offers
                    WHERE pharmacy_id = $1 AND status != 'pending' AND updated_at >= NOW() - INTERVAL '30 days'
                `, [pharmacyId]);

                let medianSecs = parseFloat(responseRes.rows[0].median_response_seconds);
                if (medianSecs > 900) medianSecs = 900; // Cap at 15 mins

                // Normalization: 0 mins = 100, 15 mins = 0
                const responseScore = Math.max(0, 100 - (medianSecs / 900) * 100);

                // Factor 2: Medicine Availability (35%)
                // successful_items / requested_items
                const itemsRes = await client.query(`
                    SELECT 
                        COALESCE(SUM(oi.quantity), 0) AS requested_items,
                        COALESCE(SUM(oi.quantity) FILTER (WHERE o.status = 'completed'), 0) AS successful_items
                    FROM orders o
                    JOIN order_items oi ON o.id = oi.order_id
                    WHERE o.pharmacy_id = $1 AND o.created_at >= NOW() - INTERVAL '30 days'
                `, [pharmacyId]);

                const reqItems = parseFloat(itemsRes.rows[0].requested_items);
                const succItems = parseFloat(itemsRes.rows[0].successful_items);
                const authScore = reqItems > 0 ? (succItems / reqItems) * 100 : 100;

                // Factor 3: Customer Ratings (20%)
                const ratingsRes = await client.query(`
                    SELECT COALESCE(AVG(rating), 5.0) AS avg_rating
                    FROM order_reviews
                    WHERE pharmacy_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
                `, [pharmacyId]);
                // Rating is 1-5 scale -> Convert to 0-100 (e.g., 5.0 = 100, 1.0 = 20)
                const avgRating = parseFloat(ratingsRes.rows[0].avg_rating);
                const ratingScore = (avgRating / 5.0) * 100;

                // Factor 4: Inventory Freshness (10%)
                // Use the most recent updated_at in pharmacy_inventory
                const freshRes = await client.query(`
                    SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at))) AS freshness_seconds
                    FROM pharmacy_inventory
                    WHERE pharmacy_id = $1
                `, [pharmacyId]);
                // Normalization: <1 day = 100, >14 days = 0
                const freshnessSecs = freshRes.rows[0].freshness_seconds ? parseFloat(freshRes.rows[0].freshness_seconds) : (14 * 86400);
                const freshDays = Math.min(14, freshnessSecs / 86400);
                const freshnessScore = Math.max(0, 100 - (freshDays / 14) * 100);

                // Factor 5: Cancellation Rate (Penalty - 10% weight)
                const cancellationRate = totalOrders > 0 ? (cancelledOrders / totalOrders) : 0;
                const cancelScore = (1 - cancellationRate) * 100;

                // Weighted Math (sum = 100%)
                let finalScore = (responseScore * 0.25) + (authScore * 0.35) + (ratingScore * 0.20) + (freshnessScore * 0.10) + (cancelScore * 0.10);

                // Ensure bounds
                if (finalScore > 100) finalScore = 100;
                if (finalScore < 0) finalScore = 0;

                // Tier mapping
                let tier = 'bronze';
                if (finalScore >= 90) tier = 'platinum';
                else if (finalScore >= 75) tier = 'gold';
                else if (finalScore >= 60) tier = 'silver';

                await this.upsertScore(
                    client, pharmacyId, finalScore,
                    responseScore, authScore, ratingScore, freshnessScore,
                    cancellationRate, tier
                );
            }

            await client.query('COMMIT');
            console.log(`[PharmacyScoreService] Incremental score recalculation complete for ${activePharmacyIds.length} pharmacies.`);
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('[PharmacyScoreService] Failed to calculate scores', err);
        } finally {
            client.release();
        }
    }

    static async upsertScore(client, pharmacyId, total, resSc, availSc, ratSc, freshSc, cancelRate, tier) {
        await client.query(`
            INSERT INTO pharmacy_scores (
                pharmacy_id, total_score, response_time_score, availability_score, 
                rating_score, freshness_score, cancellation_rate, tier, last_calculated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
            ON CONFLICT (pharmacy_id) DO UPDATE SET
                total_score = EXCLUDED.total_score,
                response_time_score = EXCLUDED.response_time_score,
                availability_score = EXCLUDED.availability_score,
                rating_score = EXCLUDED.rating_score,
                freshness_score = EXCLUDED.freshness_score,
                cancellation_rate = EXCLUDED.cancellation_rate,
                tier = EXCLUDED.tier,
                last_calculated_at = EXCLUDED.last_calculated_at,
                updated_at = NOW()
        `, [pharmacyId, total, resSc, availSc, ratSc, freshSc, cancelRate, tier]);
    }
}

module.exports = PharmacyScoreService;
