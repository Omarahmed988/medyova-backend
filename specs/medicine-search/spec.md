# Feature 1 — Medicine Search & Pharmacy Inventory Specification

**Status:** Ready for Review  
**Phase Sequence:** Phase 11–13 (complete) → Launch Readiness (approved) → **Medicine Search (planning)**  
**Flow:** Flow B — Medicine Discovery (independent from Flow A — Prescription Routing)

---

## Product Flow

```
User searches medicine by name
  → System returns matching medicines
  → Each medicine shows pharmacies that carry it
  → Filtered by user's delivery area (Phase 12 integration)
  → User selects pharmacy
  → Direct order created (no routing worker)
```

> **Critical constraint:** This flow does NOT touch the routing engine, routing workers, acceptance transactions, or escalation logic.

---

## 1. Medicine Catalog

### Table: `medicines`

```sql
CREATE TABLE medicines (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name         VARCHAR(255) NOT NULL,
    generic_name VARCHAR(255),
    brand_name   VARCHAR(255),
    form         VARCHAR(100),
    strength     VARCHAR(100),
    is_active    BOOLEAN NOT NULL DEFAULT true,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Search Indexes

```sql
-- Trigram index for fuzzy name search (requires pg_trgm extension)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX idx_medicines_name_trgm       ON medicines USING gin (name gin_trgm_ops);
CREATE INDEX idx_medicines_generic_trgm    ON medicines USING gin (generic_name gin_trgm_ops);
CREATE INDEX idx_medicines_brand_trgm      ON medicines USING gin (brand_name gin_trgm_ops);

-- Standard B-tree for exact lookups
CREATE INDEX idx_medicines_is_active       ON medicines(is_active);
```

**Why trigram?** Users may misspell medicine names or type partial names. Trigram similarity provides relevance-ranked results without a full-text search engine.

**Search query pattern:**

```sql
SELECT id, name, generic_name, brand_name, form, strength
FROM medicines
WHERE is_active = true
  AND (
       name        ILIKE '%' || $1 || '%'
    OR generic_name ILIKE '%' || $1 || '%'
    OR brand_name   ILIKE '%' || $1 || '%'
  )
ORDER BY similarity(name, $1) DESC
LIMIT 20;
```

---

## 2. Pharmacy Inventory

### Table: `pharmacy_inventory`

```sql
CREATE TABLE pharmacy_inventory (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pharmacy_id  UUID NOT NULL REFERENCES pharmacies(id) ON DELETE CASCADE,
    medicine_id  UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
    price        NUMERIC(10, 2) NOT NULL CHECK (price > 0),
    stock_status VARCHAR(20) NOT NULL DEFAULT 'available'
                 CHECK (stock_status IN ('available', 'low_stock', 'out_of_stock')),
    updated_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pharmacy_inventory_unique UNIQUE (pharmacy_id, medicine_id)
);
```

### Indexes

```sql
CREATE INDEX idx_pharmacy_inventory_medicine   ON pharmacy_inventory(medicine_id);
CREATE INDEX idx_pharmacy_inventory_pharmacy    ON pharmacy_inventory(pharmacy_id);
CREATE INDEX idx_pharmacy_inventory_updated     ON pharmacy_inventory(updated_at);
```

### Constraints

- `UNIQUE(pharmacy_id, medicine_id)` — one price/stock entry per pharmacy per medicine
- `CHECK (price > 0)` — prevents zero or negative pricing
- `stock_status` enum — restricts values to known states

---

## 3. Data Freshness Monitoring

### Staleness Definition

Inventory data is considered **stale** when:

```
updated_at < NOW() - INTERVAL '48 hours'
```

### Stale Inventory Detection Query

```sql
-- Pharmacies with stale inventory (not updated in 48h)
SELECT p.id AS pharmacy_id, p.name,
       MAX(pi.updated_at) AS last_inventory_update,
       NOW() - MAX(pi.updated_at) AS staleness
FROM pharmacies p
JOIN pharmacy_inventory pi ON pi.pharmacy_id = p.id
WHERE p.is_active = true
GROUP BY p.id, p.name
HAVING MAX(pi.updated_at) < NOW() - INTERVAL '48 hours'
ORDER BY staleness DESC;
```

### Completely Missing Inventory

```sql
-- Active pharmacies with zero inventory records
SELECT p.id, p.name
FROM pharmacies p
WHERE p.is_active = true
  AND NOT EXISTS (
    SELECT 1 FROM pharmacy_inventory pi WHERE pi.pharmacy_id = p.id
  );
```

**Operational rule:** Pharmacies with stale inventory (> 48h) should receive a stock update reminder. Pharmacies with zero inventory should not appear in medicine search results.

---

## 4. Search API

### `GET /medicines/search?q=<term>&area_id=<uuid>`

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `q` | Yes | Search term (min 2 characters) |
| `area_id` | Yes | User's delivery area — filters pharmacies serving this area |

**Response (200):**

```json
{
    "medicines": [
        {
            "id": "<uuid>",
            "name": "Paracetamol 500mg",
            "generic_name": "Acetaminophen",
            "brand_name": "Panadol",
            "form": "Tablet",
            "strength": "500mg",
            "pharmacies": [
                {
                    "pharmacy_id": "<uuid>",
                    "pharmacy_name": "Al-Dawaa Pharmacy",
                    "price": 12.50,
                    "stock_status": "available",
                    "rating_avg": 4.50,
                    "rating_count": 23
                }
            ]
        }
    ]
}
```

**Response codes:**

| Code | Condition |
|------|-----------|
| `200` | Search results (may be empty array) |
| `400` | Missing `q`, `q` < 2 chars, or invalid `area_id` |

### Search Query (Area-Filtered)

```sql
SELECT m.id, m.name, m.generic_name, m.brand_name, m.form, m.strength,
       p.id AS pharmacy_id, p.name AS pharmacy_name,
       pi.price, pi.stock_status,
       p.rating_avg, p.rating_count
FROM medicines m
JOIN pharmacy_inventory pi ON pi.medicine_id = m.id
JOIN pharmacies p ON p.id = pi.pharmacy_id
JOIN pharmacy_delivery_areas pda ON pda.pharmacy_id = p.id
WHERE m.is_active = true
  AND p.is_active = true
  AND pi.stock_status != 'out_of_stock'
  AND pda.area_id = $2
  AND (
       m.name        ILIKE '%' || $1 || '%'
    OR m.generic_name ILIKE '%' || $1 || '%'
    OR m.brand_name   ILIKE '%' || $1 || '%'
  )
ORDER BY similarity(m.name, $1) DESC, pi.price ASC
LIMIT 20;
```

**Key joins:**
- `pharmacy_inventory` → links medicines to pharmacies
- `pharmacy_delivery_areas` → filters to pharmacies serving the user's area (Phase 12 integration)
- `pharmacies.rating_avg` / `rating_count` → surfaces Phase 13 ratings in search results

---

## 5. Delivery Area Integration

Medicine search reuses the Phase 12 `pharmacy_delivery_areas` table without modification.

| Integration Point | Usage |
|-------------------|-------|
| `pda.area_id = $2` | Filter pharmacies to those serving the user's delivery area |
| `p.is_active = true` | Only active pharmacies appear |
| DA-4 fail-closed | Pharmacies with no delivery areas naturally excluded by `INNER JOIN` |

**No changes to:**
- `areas` table
- `pharmacy_delivery_areas` table
- `queryEligiblePharmacies` in the routing worker
- Any routing invariant

---

## 6. Direct Order Creation (Flow B)

After the user selects a pharmacy from search results:

```
POST /orders/direct
```

**Payload:**

```json
{
    "pharmacy_id": "<uuid>",
    "medicine_id": "<uuid>",
    "area_id": "<uuid>"
}
```

**Flow:**

1. Validate `medicine_id` exists and `is_active = true`
2. Validate `pharmacy_id` has the medicine in inventory (`stock_status != 'out_of_stock'`)
3. Validate `pharmacy_id` serves `area_id` (via `pharmacy_delivery_areas`)
4. Create order with `type = 'direct'` — distinguishes from prescription routing orders
5. No routing job created — no waves, no escalation, no worker involvement

**Response codes:**

| Code | Condition |
|------|-----------|
| `201` | Order created |
| `400` | Missing fields or invalid UUIDs |
| `404` | Medicine or pharmacy not found |
| `422` | Medicine out of stock at selected pharmacy |
| `422` | Pharmacy does not serve the user's area |

### Orders Table Extension

```sql
ALTER TABLE orders ADD COLUMN type VARCHAR(20) NOT NULL DEFAULT 'prescription'
    CHECK (type IN ('prescription', 'direct'));
ALTER TABLE orders ADD COLUMN medicine_id UUID REFERENCES medicines(id);
```

- Existing prescription-routed orders default to `type = 'prescription'`
- Direct medicine orders use `type = 'direct'` + populated `medicine_id`

---

## 7. Area Activation Rule

### Rule Definition

An area is operationally active when:

```
pharmacy_count >= 2
```

where `pharmacy_count` is the number of active pharmacies with at least one `pharmacy_delivery_areas` entry for that area.

### Enforcement

```sql
-- Computed view: area activation status
SELECT a.id AS area_id, a.name,
       COUNT(DISTINCT pda.pharmacy_id) AS pharmacy_count,
       CASE WHEN COUNT(DISTINCT pda.pharmacy_id) >= 2 THEN true ELSE false END AS area_active
FROM areas a
LEFT JOIN pharmacy_delivery_areas pda ON pda.area_id = a.id
LEFT JOIN pharmacies p ON p.id = pda.pharmacy_id AND p.is_active = true
WHERE a.is_active = true AND a.is_legacy = false
GROUP BY a.id, a.name;
```

### Behavior

| Condition | Effect |
|-----------|--------|
| `pharmacy_count >= 2` | Area is selectable by users |
| `pharmacy_count < 2` | Area is NOT selectable by users |
| Founder override | Super-admin can manually set `is_active = true` on any area via `PATCH /admin/areas/:id/activate` regardless of pharmacy count |

### API Impact

- `GET /areas?selectable=true` — returns only areas with `pharmacy_count >= 2` OR manually activated by founder
- Search API filters on `is_active = true` for the provided `area_id` — if the area is inactive, search returns `400`

### Schema Change

```sql
ALTER TABLE areas ADD COLUMN founder_override BOOLEAN NOT NULL DEFAULT false;
```

- `founder_override = true` → area stays active regardless of pharmacy count
- `founder_override = false` → area activation follows the `pharmacy_count >= 2` rule

---

## 8. Feature Flags Integration

All expansion features integrate with the Founder Control Layer (`system_feature_flags`).

### Required Flags

| Flag Key | Default | Controls |
|----------|---------|----------|
| `medicine_search_enabled` | `false` | Enables `GET /medicines/search` and `POST /orders/direct` |
| `subscriptions_enabled` | `false` | Future: monthly medicine subscriptions |
| `insurance_filter_enabled` | `false` | Future: insurance provider filtering in search |
| `loyalty_program_enabled` | `false` | Future: points and tiers |
| `referral_program_enabled` | `false` | Future: referral rewards |

### Enforcement Pattern

```js
// At the top of each feature route handler:
const flagValue = settingsCache.getFlag('medicine_search_enabled');
if (!flagValue) {
    return res.status(503).json({ error: 'Medicine search is currently unavailable' });
}
```

**Fail-closed:** Features return `503` when disabled — no silent degradation.

---

## 9. Invariant Confirmations

- **RI-1:** `queryEligiblePharmacies` — zero modifications
- **RI-2:** Routing worker — zero modifications
- **RI-3:** Acceptance transaction — zero modifications
- **RI-4:** Escalation logic — zero modifications
- **RI-5:** `trust_score` — unaffected
- **RI-6:** Flow A (prescription routing) and Flow B (medicine discovery) are completely independent
- **RI-7:** No long transactions introduced — all writes are single-row autocommit
- **RI-8:** No external infrastructure required

---

## 10. Future Compatibility Notes

### Subscription Readiness

The `medicines` table and `pharmacy_inventory` table are sufficient for the subscription model:
- Subscription references `medicine_id` + `pharmacy_id`
- Monthly order generation uses `pharmacy_inventory.price` at fulfillment time (not subscription creation time)

### Insurance Readiness

The existing `pharmacy_insurance_contracts` table (used by routing) already links pharmacies to insurance companies. Medicine search can reuse this table for filtering — no new table needed. The `pharmacy_insurance_providers` concept maps directly to the existing `pharmacy_insurance_contracts`.

### Loyalty Readiness

The `orders` table (both `prescription` and `direct` types) serves as the event source for point accumulation. No schema changes needed beyond the loyalty-specific tables.
