'use strict';
const xlsx = require('xlsx');
const { query } = require('../config/db');

/**
 * Service: Phase 14 Excel Inventory Normalization Pipeline
 * Steps:
 *  1. Parse Excel
 *  2. Normalize Quantity (Arabic numerals)
 *  3. Resolve Medicine Name (Exact -> Alias -> Fuzzy)
 *  4. Upsert/Replace
 */

const MEDICINE_COLUMNS = ['medicine', 'medicine_name', 'drug_name', 'name', 'اسم الدواء'];
const QUANTITY_COLUMNS = ['quantity', 'qty', 'الكمية'];
const PRICE_COLUMNS = ['price', 'unit_price', 'السعر'];

class InventoryNormalizationService {

    /**
     * Reads an Excel buffer, maps headers, and extracts rows.
     */
    static parseExcel(buffer) {
        const workbook = xlsx.read(buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];

        // Parse raw rows (header row = 1)
        const rawJson = xlsx.utils.sheet_to_json(sheet, { defval: null });
        if (!rawJson || rawJson.length === 0) return [];

        // Find mapped columns
        const sampleKeys = Object.keys(rawJson[0]).map(k => k.trim());
        const medKey = sampleKeys.find(k => MEDICINE_COLUMNS.includes(k.toLowerCase()));
        const qtyKey = sampleKeys.find(k => QUANTITY_COLUMNS.includes(k.toLowerCase()));
        const priceKey = sampleKeys.find(k => PRICE_COLUMNS.includes(k.toLowerCase()));

        if (!medKey || !priceKey) {
            throw new Error(`Invalid layout. Must contain a medicine column and a price column.`);
        }

        const rows = [];
        rawJson.forEach((rawRow, i) => {
            const rowIndex = i + 2; // +1 for 0-index, +1 for header
            rows.push({
                row: rowIndex,
                rawName: String(rawRow[medKey] || ''),
                rawQty: qtyKey ? rawRow[qtyKey] : null,
                rawPrice: rawRow[priceKey]
            });
        });

        return rows;
    }

    static normalizeQuantity(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        if (typeof raw === 'number') return Math.floor(raw);

        const str = String(raw).trim();
        // Convert Arabic-Indic numerals back to standard Western digits
        const westernized = str.replace(/[٠-٩]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x0660 + 48));

        const match = westernized.match(/^(\d+)/);
        return match ? parseInt(match[1], 10) : null;
    }

    static normalizePrice(raw) {
        if (raw === null || raw === undefined || raw === '') return null;
        if (typeof raw === 'number') return parseFloat(raw.toFixed(2));

        const str = String(raw).trim();
        const westernized = str.replace(/[٠-٩]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x0660 + 48));

        const match = westernized.match(/^(\d+(\.\d+)?)/);
        return match ? parseFloat(parseFloat(match[1]).toFixed(2)) : null;
    }

    /**
     * Three-phase resolution: Exact -> Alias -> Fuzzy (threshold 0.3)
     */
    static async resolveMedicineName(nameStr) {
        const cleanName = nameStr.trim();
        if (!cleanName) return null;

        // 1. Exact Match
        const exact = await query(
            `SELECT id FROM medicines WHERE LOWER(name) = LOWER($1) AND is_active = true LIMIT 1`,
            [cleanName]
        );
        if (exact.rowCount > 0) return exact.rows[0].id;

        // 2. Alias Resolution
        const alias = await query(
            `SELECT medicine_id AS id FROM medicine_aliases WHERE LOWER(alias) = LOWER($1) LIMIT 1`,
            [cleanName]
        );
        if (alias.rowCount > 0) return alias.rows[0].id;

        // 3. Fuzzy Match
        const fuzzy = await query(
            `SELECT id, similarity(name, $1) AS sim 
             FROM medicines 
             WHERE is_active = true AND similarity(name, $1) > 0.3 
             ORDER BY sim DESC LIMIT 1`,
            [cleanName]
        );
        if (fuzzy.rowCount > 0) return fuzzy.rows[0].id;

        return null;
    }

    /**
     * Processes an Excel file upload and performs the exact DB operations.
     */
    static async processInventoryUpload(pharmacyId, buffer, replaceAll = false) {
        let rawRows;
        try {
            rawRows = this.parseExcel(buffer);
        } catch (err) {
            throw new Error(`Excel parse failed: ${err.message}`);
        }

        const report = {
            mode: replaceAll ? 'replace_all' : 'upsert',
            processed: rawRows.length,
            inserted: 0,
            updated: 0,
            errors: []
        };

        const resolvedItems = [];

        // 1. Normalize and Resolve Line-by-Line
        for (const r of rawRows) {
            // Ignore completely empty rows
            if (!r.rawName.trim() && r.rawPrice == null) continue;

            const nameId = await this.resolveMedicineName(r.rawName);
            if (!nameId) {
                if (r.rawName && r.rawName.trim()) {
                    await query(
                        `INSERT INTO unmatched_medicines_log (pharmacy_id, raw_name, frequency_count, updated_at)
                         VALUES ($1, $2, 1, NOW())
                         ON CONFLICT (pharmacy_id, raw_name) 
                         DO UPDATE SET frequency_count = unmatched_medicines_log.frequency_count + 1, updated_at = NOW()`,
                        [pharmacyId, r.rawName.trim()]
                    );
                }
                report.errors.push({ row: r.row, raw_name: r.rawName, reason: 'Medicine not found or matched below similarity threshold' });
                continue;
            }

            const price = this.normalizePrice(r.rawPrice);
            if (price === null || price <= 0) {
                report.errors.push({ row: r.row, raw_price: r.rawPrice, reason: 'Price must be a positive number' });
                continue;
            }

            // Quantity mapping for stock status
            let stock_status = 'available';
            if (r.rawQty != null) {
                const qty = this.normalizeQuantity(r.rawQty);
                if (qty === null) {
                    report.errors.push({ row: r.row, raw_quantity: r.rawQty, reason: 'Could not parse quantity' });
                    continue;
                }
                if (qty === 0) stock_status = 'out_of_stock';
                else if (qty <= 2) stock_status = 'low_stock';
            }

            resolvedItems.push({ medicine_id: nameId, price, stock_status });
        }

        // 2. Database Insert Phase
        // In replaceAll mode, we clear first
        if (replaceAll && resolvedItems.length > 0) {
            await query(`DELETE FROM pharmacy_inventory WHERE pharmacy_id = $1`, [pharmacyId]);
        }

        for (const item of resolvedItems) {
            if (replaceAll) {
                // Bulk insert behavior - just simple insert since we cleared
                await query(
                    `INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status, updated_at) 
                     VALUES ($1, $2, $3, $4, NOW())
                     ON CONFLICT (pharmacy_id, medicine_id) DO NOTHING`,
                    [pharmacyId, item.medicine_id, item.price, item.stock_status]
                );
                report.inserted++;
            } else {
                // Upsert behavior
                const res = await query(
                    `INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status, updated_at) 
                     VALUES ($1, $2, $3, $4, NOW())
                     ON CONFLICT (pharmacy_id, medicine_id) 
                     DO UPDATE SET 
                        price = EXCLUDED.price, 
                        stock_status = EXCLUDED.stock_status, 
                        updated_at = NOW()
                     RETURNING (xmax = 0) AS inserted`,
                    [pharmacyId, item.medicine_id, item.price, item.stock_status]
                );

                if (res.rowCount > 0) {
                    if (res.rows[0].inserted) report.inserted++;
                    else report.updated++;
                }
            }
        }

        // 3. Operational Upload Log
        await query(
            `INSERT INTO inventory_upload_logs (pharmacy_id, status, total_rows, matched_rows) VALUES ($1, $2, $3, $4)`,
            [pharmacyId, 'success', rawRows.length, resolvedItems.length]
        );

        return report;
    }
}

module.exports = InventoryNormalizationService;
