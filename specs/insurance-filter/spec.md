# MEDYOVA — PHASE 17 INSURANCE FILTER SPEC

## 1. Insurance Data Model
The current schema does not include insurance tables. We will define the following new structures.

### `insurance_companies`
| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `name` | VARCHAR(100) | Name of the insurance company |
| `created_at` | TIMESTAMPTZ | Creation timestamp |

### `pharmacy_insurance_contracts`
| Column | Type | Description |
|--------|------|-------------|
| `pharmacy_id` | UUID | Foreign key to `pharmacies(id)` |
| `insurance_company_id` | UUID | Foreign key to `insurance_companies(id)` |
| `contract_active` | BOOLEAN | Indicates if the contract is currently active |
| `created_at` | TIMESTAMPTZ | Creation timestamp |

*Constraints & Indexes*: 
- `UNIQUE (pharmacy_id, insurance_company_id)` constraint to prevent duplicate contracts.
- `CREATE INDEX idx_pharmacy_insurance_company ON pharmacy_insurance_contracts (insurance_company_id, pharmacy_id) WHERE contract_active = true;` for scalable searching.

### `orders` table extension
Orders will persist the insurance context to support analytics and auditing:
- `insurance_company_id` UUID REFERENCES `insurance_companies(id)`

## 2. Founder Admin Control
Insurance companies must be managed centrally by founders to maintain a canonical list of providers.
Endpoints (mounted in `admin.js`):
- `GET /admin/insurance-companies` — List all providers
- `POST /admin/insurance-companies` — Add a new provider
- `PATCH /admin/insurance-companies/:id` — Update provider name

## 3. Search Integration
The existing `GET /medicines/search` endpoint will be extended with an optional query parameter:
`?insurance_company_id={UUID}`

### Behavior
- When the parameter is provided, the SQL query discovering available pharmacies will efficiently filter using the `idx_pharmacy_insurance_company` index.
- Only pharmacies that have a record matching the requested `insurance_company_id` with `contract_active = true` will be considered.
- This filter applies safely over the existing conditions (areas, inventory, stock status).

## 4. Direct Order Validation
The direct order creation endpoint `POST /orders/direct` will accept an optional `insurance_company_id` parameter in the request body.

### Strict Validation behavior
If `insurance_company_id` is provided during order creation:
1. The system must verify that the selected `pharmacy_id` has an active contract (`contract_active = true`) with the given `insurance_company_id`.
2. The `insurance_company_id` is saved into the newly generated `order` record.
3. If the contract is missing or inactive, the system will reject the request and return a `422 Unprocessable Entity` validation error.

*Note: Medyova does not process the claim; this exists solely to confirm the match.*

## 5. Pharmacy Portal Management
Pharmacies will manage their own insurance relationships via the portal.

### Endpoints
All endpoints require authentication and strict ownership verification:
- `GET /pharmacies/:id/insurance`
- `POST /pharmacies/:id/insurance` (Accepts `insurance_company_id`)
- `DELETE /pharmacies/:id/insurance/:insuranceId` (Soft-deletes / sets `contract_active = false`)

## 6. UI Filtering Strategy
Insurance filtering operates strictly as an **optional search filter**. 
- It does not affect background workflows.
- It **does not affect** the routing engine, subscriptions, or the prescription marketplace.

## 7. Invariant Confirmation
We explicitly confirm that the addition of the Insurance Filter will leave the following core components **completely unchanged**:

1. `routing-worker.js` — untouched.
2. `offerAcceptance.js` — untouched.
3. `queryEligiblePharmacies` — untouched.
4. `subscription-scheduler.js` — untouched.
5. `DirectOrderService` logic handles Flow B order creation; it will only add a synchronous validation check (and persist the context), leaving all existing invariants identical.
