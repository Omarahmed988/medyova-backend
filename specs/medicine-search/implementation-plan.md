# Phase 14 — Medicine Search Implementation Plan (Revision 3)

**Status:** Ready for Review  
**Spec:** `specs/medicine-search/spec.md` (approved)  
**Test Baseline:** 179 tests / 11 suites / all passing  
**Revision History:**
- Rev 1: Base plan
- Rev 2: Added scarcity handling, Excel normalization, medicine_aliases
- Rev 3: Added inventory freshness enforcement, upload safety strategy, out-of-stock visibility

---

## 1. Migration Sequence

### Migration A — `layer10-medicine-catalog.js`

**Creates:** `medicines`, `pharmacy_inventory`, `medicine_aliases`, trigram extension

```sql
-- Enable trigram extension
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 1. Medicines catalog (with scarcity fields)
CREATE TABLE medicines (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          VARCHAR(255) NOT NULL,
    generic_name  VARCHAR(255),
    brand_name    VARCHAR(255),
    form          VARCHAR(100),
    strength      VARCHAR(100),
    is_active     BOOLEAN NOT NULL DEFAULT true,
    is_shortage   BOOLEAN NOT NULL DEFAULT false,
    max_order_qty SMALLINT NOT NULL DEFAULT 5 CHECK (max_order_qty >= 1),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_medicines_name_trgm    ON medicines USING gin (name gin_trgm_ops);
CREATE INDEX idx_medicines_generic_trgm ON medicines USING gin (generic_name gin_trgm_ops);
CREATE INDEX idx_medicines_brand_trgm   ON medicines USING gin (brand_name gin_trgm_ops);
CREATE INDEX idx_medicines_is_active    ON medicines(is_active);

-- 2. Medicine aliases (for Excel normalization)
CREATE TABLE medicine_aliases (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias       VARCHAR(255) NOT NULL,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_medicine_aliases_alias_lower ON medicine_aliases(LOWER(alias));
CREATE INDEX idx_medicine_aliases_medicine           ON medicine_aliases(medicine_id);

-- 3. Pharmacy inventory
CREATE TABLE pharmacy_inventory (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pharmacy_id  UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    medicine_id  UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    price        NUMERIC(10,2) NOT NULL CHECK (price > 0),
    stock_status VARCHAR(20) NOT NULL DEFAULT 'available'
                 CHECK (stock_status IN ('available', 'low_stock', 'out_of_stock')),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pharmacy_inventory_unique UNIQUE (pharmacy_id, medicine_id)
);

CREATE INDEX idx_pharmacy_inventory_medicine ON pharmacy_inventory(medicine_id);
CREATE INDEX idx_pharmacy_inventory_pharmacy ON pharmacy_inventory(pharmacy_id);
CREATE INDEX idx_pharmacy_inventory_updated  ON pharmacy_inventory(updated_at);
```

**Down:** `DROP TABLE pharmacy_inventory; DROP TABLE medicine_aliases; DROP TABLE medicines;`

---

### Migration B — `layer10-direct-orders.js`

**Modifies:** `orders` table (additive only)  
**Creates:** `order_items`

```sql
-- 1. Add type column — existing rows default to 'prescription'
ALTER TABLE orders ADD COLUMN type VARCHAR(20) NOT NULL DEFAULT 'prescription'
    CHECK (type IN ('prescription', 'direct'));

-- 2. Relax request_id and offer_id for direct orders
ALTER TABLE orders ALTER COLUMN request_id DROP NOT NULL;
ALTER TABLE orders ALTER COLUMN offer_id   DROP NOT NULL;

-- 3. Prescription integrity — Flow A invariants preserved at DB level
ALTER TABLE orders ADD CONSTRAINT orders_prescription_integrity
    CHECK (type = 'direct' OR (request_id IS NOT NULL AND offer_id IS NOT NULL));

-- 4. Area activation: founder override
ALTER TABLE areas ADD COLUMN founder_override BOOLEAN NOT NULL DEFAULT false;

-- 5. Order items
CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    medicine_id     UUID NOT NULL REFERENCES medicines(id) ON DELETE RESTRICT,
    quantity        SMALLINT NOT NULL DEFAULT 1 CHECK (quantity > 0),
    price_snapshot  NUMERIC(10,2) NOT NULL CHECK (price_snapshot > 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_items_order_id    ON order_items(order_id);
CREATE INDEX idx_order_items_medicine_id ON order_items(medicine_id);
```

**Down:** Reverses all changes in reverse order.

---

## 2. Medicine Scarcity Handling

### Schema Fields

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| `is_shortage` | `BOOLEAN` | `false` | Marks medicine as constrained supply |
| `max_order_qty` | `SMALLINT` | `5` | Max units allowed per order line |

### Enforcement Points

**1. `POST /orders/direct` — Hard enforcement**

```js
for (const item of items) {
    const medicine = await getMedicine(item.medicine_id);
    if (item.quantity > medicine.max_order_qty) {
        return res.status(422).json({
            error: `Requested quantity for ${medicine.name} exceeds allowed limit of ${medicine.max_order_qty}`
        });
    }
}
```

Validation runs before any INSERT — fail-fast.

**2. `GET /medicines/search` — Response includes scarcity info**

```json
{
    "id": "<uuid>",
    "name": "Ozempic",
    "is_shortage": true,
    "max_order_qty": 2,
    "pharmacies": [...]
}
```

Client UI uses `max_order_qty` to limit the quantity selector.

**3. Future extension (not enforced now)**

When `stock_status = 'low_stock'`, the architecture supports tightening to `quantity <= 1`. This is **not implemented in v1** — only the schema supports it.

---

## 3. Inventory Freshness Enforcement

### Rule

```
inventory_stale_threshold = 48 hours
```

### Search Query Filter

All search queries include:

```sql
AND pi.updated_at > NOW() - INTERVAL '48 hours'
```

Pharmacies with stale inventory are **excluded from search results** entirely. This protects user trust by preventing false availability signals.

### Full Search Query (Updated)

```sql
SELECT m.id, m.name, m.generic_name, m.brand_name, m.form, m.strength,
       m.is_shortage, m.max_order_qty,
       p.id AS pharmacy_id, p.name AS pharmacy_name,
       pi.price, pi.stock_status,
       p.rating_avg, p.rating_count
FROM medicines m
JOIN pharmacy_inventory pi ON pi.medicine_id = m.id
JOIN pharmacies p ON p.id = pi.pharmacy_id
JOIN pharmacy_delivery_areas pda ON pda.pharmacy_id = p.id
WHERE m.is_active = true
  AND p.is_active = true
  AND pda.area_id = $2
  AND pi.updated_at > NOW() - INTERVAL '48 hours'
  AND (
       m.name        ILIKE '%' || $1 || '%'
    OR m.generic_name ILIKE '%' || $1 || '%'
    OR m.brand_name   ILIKE '%' || $1 || '%'
  )
ORDER BY similarity(m.name, $1) DESC, pi.price ASC
LIMIT 10;
```

**Key changes from Rev 2:**
- `pi.updated_at > NOW() - INTERVAL '48 hours'` — freshness gate
- `out_of_stock` rows are **included** (see §4 below)

### Monitoring Query — Stale Pharmacies

```sql
SELECT p.id, p.name, MAX(pi.updated_at) AS last_update,
       NOW() - MAX(pi.updated_at) AS staleness
FROM pharmacies p
JOIN pharmacy_inventory pi ON pi.pharmacy_id = p.id
WHERE p.is_active = true
GROUP BY p.id, p.name
HAVING MAX(pi.updated_at) < NOW() - INTERVAL '48 hours'
ORDER BY staleness DESC;
```

---

## 4. Out-of-Stock Visibility

### Behavior

Out-of-stock medicines are **included** in search results but marked as unavailable.

The search query does **NOT** filter `stock_status != 'out_of_stock'`.

### Response Format

```json
{
    "pharmacy_id": "<uuid>",
    "pharmacy_name": "Al-Dawaa Pharmacy",
    "price": 12.50,
    "stock_status": "out_of_stock",
    "rating_avg": 4.50,
    "rating_count": 23
}
```

The client UI renders this as "Currently unavailable" — informing the user that the pharmacy normally carries the medicine.

### Order Enforcement

`POST /orders/direct` still **rejects** out-of-stock items:

```js
if (inventory.stock_status === 'out_of_stock') {
    return res.status(422).json({
        error: `${medicine.name} is currently out of stock at this pharmacy`
    });
}
```

**Summary:** Visible in search → blocked at order creation.

---

## 5. Inventory Upload Safety Strategy

### Default Mode: Upsert Only

```
POST /pharmacies/:id/inventory/upload
```

**Behavior:**
- Existing rows → **updated** (price, stock_status, updated_at)
- New rows → **inserted**
- Missing rows → **untouched**

This prevents accidental inventory loss due to partial Excel files.

### Full Replacement Mode

```
POST /pharmacies/:id/inventory/upload?replace_all=true
```

**Behavior:**
1. Delete all existing `pharmacy_inventory` rows for this pharmacy
2. Insert all resolved rows from the uploaded file

**Safeguard:** The `replace_all` parameter must be explicitly set. The API returns a confirmation count before deletion:

```json
{
    "warning": "This will replace 142 existing inventory records with 45 new records",
    "confirm_token": "<short-lived-uuid>"
}
```

The pharmacy must re-submit with the token to confirm:

```
POST /pharmacies/:id/inventory/upload?replace_all=true&confirm=<token>
```

This two-step confirmation prevents accidental data loss.

### SQL Patterns

**Upsert (default):**

```sql
INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status, updated_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (pharmacy_id, medicine_id)
DO UPDATE SET price = EXCLUDED.price,
              stock_status = EXCLUDED.stock_status,
              updated_at = NOW();
```

**Full replacement:**

```sql
-- Step 1: Clear
DELETE FROM pharmacy_inventory WHERE pharmacy_id = $1;

-- Step 2: Bulk insert resolved rows
INSERT INTO pharmacy_inventory (pharmacy_id, medicine_id, price, stock_status, updated_at)
VALUES ($1, $2, $3, $4, NOW());
```

---

## 6. Excel Normalization Pipeline

### Overview

```
Pharmacy uploads .xlsx file
  → Parse raw rows
  → Normalize quantities (Arabic numerals, unit suffixes)
  → Resolve medicine names (exact → alias → fuzzy)
  → Validate resolved rows
  → Upsert or replace inventory
  → Return validation report
```

### Service: `inventoryNormalizationService.js`

#### Step 1 — Parse Excel

Uses `xlsx` npm package (no external infrastructure).

**Flexible column detection:**

```js
const MEDICINE_COLUMNS = ['medicine', 'medicine_name', 'drug_name', 'name', 'اسم الدواء'];
const QUANTITY_COLUMNS  = ['quantity', 'qty', 'الكمية'];
const PRICE_COLUMNS     = ['price', 'unit_price', 'السعر'];
```

The parser scans row 1 headers and maps to canonical fields using case-insensitive matching against these lists. Unrecognized columns are ignored.

#### Step 2 — Normalize Quantity

```js
function normalizeQuantity(raw) {
    if (typeof raw === 'number') return Math.floor(raw);

    const str = String(raw).trim();

    // Convert Arabic-Indic numerals → Western
    const westernized = str.replace(/[٠-٩]/g, (ch) =>
        String.fromCharCode(ch.charCodeAt(0) - 0x0660 + 48)
    );

    // Extract leading integer
    const match = westernized.match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}
```

| Input | Output |
|-------|--------|
| `3` | `3` |
| `"3 boxes"` | `3` |
| `"٣ علب"` | `3` |
| `"twelve"` | `null` (validation error) |

#### Step 3 — Medicine Name Resolution

Three-phase cascade:

```
1️⃣ Exact match (case-insensitive)
   SELECT id FROM medicines WHERE LOWER(name) = LOWER($1) AND is_active = true

2️⃣ Alias resolution
   SELECT medicine_id FROM medicine_aliases WHERE LOWER(alias) = LOWER($1)

3️⃣ Fuzzy match (trigram similarity > 0.3)
   SELECT id, similarity(name, $1) AS sim
   FROM medicines
   WHERE is_active = true AND similarity(name, $1) > 0.3
   ORDER BY sim DESC
   LIMIT 1
```

| Input | Resolution |
|-------|-----------|
| `"Panadol"` | Phase 1 — exact match |
| `"بنادول"` | Phase 2 — alias table |
| `"Panado 500"` | Phase 3 — fuzzy match |
| `"xyznotamedicine"` | Unresolved — returned in errors |

#### Step 4 — Validation Report

```json
{
    "mode": "upsert",
    "processed": 45,
    "inserted": 38,
    "updated": 4,
    "errors": [
        { "row": 12, "raw_name": "xyznotamedicine", "reason": "Medicine not found" },
        { "row": 23, "raw_quantity": "twelve", "reason": "Could not parse quantity" },
        { "row": 31, "raw_price": "-5", "reason": "Price must be positive" }
    ]
}
```

Partial success is acceptable. Failed rows are returned for manual correction.

---

## 7. `medicine_aliases` Table Design

```sql
CREATE TABLE medicine_aliases (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alias       VARCHAR(255) NOT NULL,
    medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_medicine_aliases_alias_lower ON medicine_aliases(LOWER(alias));
```

- `UNIQUE(LOWER(alias))` — prevents duplicate aliases regardless of case
- One medicine → many aliases (Arabic names, abbreviations, misspellings)
- Admin-managed via `POST /admin/medicines/:id/aliases` and `DELETE /admin/medicines/aliases/:id`

---

## 8. Service Layer Summary

| Service | Functions |
|---------|-----------|
| `medicineService.js` | `searchMedicines(query, areaId)`, `getMedicine(id)`, `getInventoryForPharmacy(pharmacyId)`, `upsertInventory(pharmacyId, items[])` |
| `directOrderService.js` | `createDirectOrder(userId, pharmacyId, areaId, items[])` — scarcity + stock validation |
| `inventoryNormalizationService.js` | `parseExcel(buffer)`, `normalizeQuantity(raw)`, `resolveMedicineName(name)`, `processInventoryUpload(pharmacyId, buffer, replaceAll)` |

---

## 9. API Routes Summary

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /medicines/search?q=&area_id=` | Public | Fuzzy search, area-filtered, freshness-gated, includes out-of-stock |
| `GET /medicines/:id` | Public | Single medicine detail |
| `POST /orders/direct` | `requireAuth` | Multi-item order with scarcity + stock validation |
| `GET /orders/direct/:id` | `requireAuth` | Read direct order with items |
| `PUT /pharmacies/:id/inventory` | `requireAuth` | JSON bulk upsert |
| `POST /pharmacies/:id/inventory/upload` | `requireAuth` | Excel upload (?replace_all optional) |
| `GET /pharmacies/:id/inventory` | `requireAuth` | Read pharmacy inventory |
| `POST /admin/medicines/:id/aliases` | `super_admin` | Add medicine alias |
| `DELETE /admin/medicines/aliases/:id` | `super_admin` | Remove alias |
| `PATCH /admin/areas/:id/activate` | `super_admin` | Founder override on |
| `PATCH /admin/areas/:id/deactivate` | `super_admin` | Founder override off |

---

## 10. npm Dependencies

| Package | Purpose |
|---------|---------|
| `xlsx` | Parse Excel files (`.xlsx`, `.xls`). Pure JS, no native bindings. |

No other external infrastructure added.

---

## 11. Rollout Order

| Step | Action |
|------|--------|
| 1 | `npm install xlsx` |
| 2 | Apply Migration A (medicines + medicine_aliases + pharmacy_inventory) |
| 3 | Apply Migration B (orders extension + order_items + founder_override) |
| 4 | Seed medicine catalog + aliases |
| 5 | Deploy services + routes |
| 6 | Run full test suite |
| 7 | Enable flag: `medicine_search_enabled = true` |
| 8 | Monitor: stale inventory, unresolved Excel rows, scarcity limits |

---

## 12. Invariant Confirmations

- **RI-1:** `queryEligiblePharmacies` — **zero modifications**
- **RI-2:** Routing worker — **zero modifications**
- **RI-3:** Acceptance transaction — **zero modifications**
- **RI-4:** Existing `orders` rows — unaffected (`type = 'prescription'` default)
- **RI-5:** `orders_prescription_integrity` CHECK preserves Flow A invariants
- **RI-6:** No long transactions — Excel processing is row-by-row upsert
- **RI-7:** No external infrastructure — `xlsx` is pure JS
