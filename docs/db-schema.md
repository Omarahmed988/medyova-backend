# Database Schema: Medyova

> **Status**: Design only. No migrations in Sprint 0.
> Schema uses PostgreSQL conventions: snake_case, UUID PKs, timestamptz.

---

## Tables

### users

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| email | VARCHAR(255) | UNIQUE, NOT NULL | |
| phone | VARCHAR(20) | | |
| name | VARCHAR(255) | NOT NULL | |
| role | VARCHAR(20) | NOT NULL | 'patient' or 'admin' |
| zone_id | UUID | FK → zones.id | Delivery zone |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | |

**Indexes**: `email`, `zone_id`

---

### pharmacies

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| name | VARCHAR(255) | NOT NULL | |
| zone_id | UUID | FK → zones.id, NOT NULL | |
| tier | VARCHAR(10) | NOT NULL | 'gold', 'silver', 'bronze' |
| trust_score | NUMERIC(4,3) | NOT NULL, DEFAULT 0.600 | 0.000–1.000 |
| is_active | BOOLEAN | NOT NULL, DEFAULT true | |
| contact_email | VARCHAR(255) | | |
| contact_phone | VARCHAR(20) | | |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | |

**Indexes**: `zone_id`, `tier`, `is_active`, `trust_score DESC`

---

### zones

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| name | VARCHAR(100) | NOT NULL | e.g., "Maadi" |
| city | VARCHAR(100) | NOT NULL | e.g., "Cairo" |
| is_active | BOOLEAN | NOT NULL, DEFAULT true | |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | |

**Indexes**: `city`, `is_active`

---

### prescriptions

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| patient_id | UUID | FK → users.id, NOT NULL | |
| zone_id | UUID | FK → zones.id, NOT NULL | |
| status | VARCHAR(20) | NOT NULL | See routing-logic.md states |
| notes | TEXT | | |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | |
| updated_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | |

**Indexes**: `patient_id`, `status`, `created_at DESC`

---

### prescription_items

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| prescription_id | UUID | FK → prescriptions.id, NOT NULL | |
| name | VARCHAR(255) | NOT NULL | Drug name |
| quantity | SMALLINT | NOT NULL, CHECK (quantity > 0) | |
| requires_prescription | BOOLEAN | NOT NULL, DEFAULT true | |
| is_rare | BOOLEAN | NOT NULL, DEFAULT false | Triggers rare engine |

**Indexes**: `prescription_id`, `is_rare`

---

### offers

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| prescription_id | UUID | FK → prescriptions.id, NOT NULL | |
| pharmacy_id | UUID | FK → pharmacies.id, NOT NULL | |
| status | VARCHAR(20) | NOT NULL | 'submitted', 'selected', 'expired' |
| total_price | NUMERIC(10,2) | NOT NULL, CHECK (total_price >= 0) | |
| estimated_delivery_hours | SMALLINT | NOT NULL | |
| is_partial | BOOLEAN | NOT NULL, DEFAULT false | |
| notes | TEXT | | |
| created_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | |

**Indexes**: `prescription_id`, `pharmacy_id`, `status`

---

### offer_items

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| offer_id | UUID | FK → offers.id, NOT NULL | |
| prescription_item_id | UUID | FK → prescription_items.id, NOT NULL | |
| price | NUMERIC(8,2) | NOT NULL, CHECK (price >= 0) | |
| available | BOOLEAN | NOT NULL, DEFAULT true | |
| substitution | VARCHAR(255) | | Substituted drug name if applicable |

**Indexes**: `offer_id`

---

### orders

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| prescription_id | UUID | FK → prescriptions.id, NOT NULL | |
| offer_id | UUID | FK → offers.id, NOT NULL, UNIQUE | One order per offer |
| patient_id | UUID | FK → users.id, NOT NULL | |
| pharmacy_id | UUID | FK → pharmacies.id, NOT NULL | |
| status | VARCHAR(20) | NOT NULL | 'confirmed', 'fulfilled', 'cancelled' |
| total_price | NUMERIC(10,2) | NOT NULL | Copied from offer at time of order |
| commission_amount | NUMERIC(10,2) | | 5–7% of total_price |
| confirmed_at | TIMESTAMPTZ | NOT NULL, DEFAULT now() | |
| fulfilled_at | TIMESTAMPTZ | | |
| cancelled_at | TIMESTAMPTZ | | |

**Indexes**: `patient_id`, `pharmacy_id`, `status`, `confirmed_at DESC`

---

### order_items

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| order_id | UUID | FK → orders.id, NOT NULL | |
| offer_item_id | UUID | FK → offer_items.id, NOT NULL | |
| name | VARCHAR(255) | NOT NULL | Snapshot at order time |
| quantity | SMALLINT | NOT NULL | |
| price | NUMERIC(8,2) | NOT NULL | |

**Indexes**: `order_id`

---

### pharmacy_metrics

| Column | Type | Constraints | Notes |
|--------|------|------------|-------|
| id | UUID | PK, DEFAULT gen_random_uuid() | |
| pharmacy_id | UUID | FK → pharmacies.id, NOT NULL, UNIQUE | One row per pharmacy |
| fulfillment_rate | NUMERIC(4,3) | NOT NULL, DEFAULT 0.600 | |
| avg_response_hours | NUMERIC(6,2) | NOT NULL, DEFAULT 2.00 | |
| avg_rating | NUMERIC(3,2) | NOT NULL, DEFAULT 3.00 | 1–5 |
| completion_accuracy | NUMERIC(4,3) | NOT NULL, DEFAULT 0.600 | |
| total_orders | INTEGER | NOT NULL, DEFAULT 0 | |
| computed_trust_score | NUMERIC(4,3) | NOT NULL, DEFAULT 0.600 | Denormalized for fast routing |
| last_computed_at | TIMESTAMPTZ | | |

**Indexes**: `pharmacy_id`, `computed_trust_score DESC`
