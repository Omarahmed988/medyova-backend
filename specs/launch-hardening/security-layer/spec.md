# Rate Limiting & Security Layer — Specification

> **Status**: v2 — Approved (Constraints Confirmed)  
> **Layer**: 10D (Launch Hardening — Security)  
> **Depends on**: All request-handling layers

---

## 1. Purpose

This specification defines **rate limiting, abuse protection, and input validation** rules for Zone-1 production launch. The security layer is a lightweight middleware gate that prevents abuse without impacting legitimate traffic or modifying business logic.

---

## 2. Rate Limiting Strategy

### 2.1 Strategy: Hybrid (User-based + IP-based)

| Layer | Mechanism | Purpose |
|-------|-----------|---------|
| **IP-based** | In-memory rate limiter (per IP) | Prevents unauthenticated brute-force |
| **User-based** | DB-backed count (per user) | Prevents authenticated abuse |

### 2.2 Why Hybrid

- **IP-only** is insufficient: shared IPs (mobile carriers) cause false positives
- **User-only** doesn't protect pre-auth endpoints (login, register)
- **Hybrid** gates unauthenticated endpoints with IP limits, authenticated endpoints with user limits

### 2.3 Implementation: `express-rate-limit`

In-memory store is acceptable for **Zone-1 single-instance deployment only**. If horizontal scaling is applied (multiple API instances), must migrate to Redis-backed store.

> [!IMPORTANT]
> **Rate limiting constraints (confirmed):**
> 1. Rate limiting middleware runs BEFORE any transactional handler (Express middleware chain order)
> 2. No rate limiting logic exists inside service files (`offerAcceptance.js`, `orderService.js`, etc.)
> 3. In-memory limiter is acceptable for Zone-1 only — document migration path to Redis
> 4. No changes to routing workers — workers are internal processes, not API-facing

---

## 3. Rate Limit Definitions

### 3.1 Endpoint Limits

| Endpoint | Method | Limit | Window | Key |
|----------|--------|:---:|:---:|-----|
| `/requests` | POST | 5 | 1 hour | `user_id` |
| `/requests/:id/offers/:id/accept` | POST | 10 | 1 hour | `user_id` |
| `/subscriptions` | POST | 3 | 1 hour | `user_id` |
| `/admin/*` | ALL | 30 | 1 minute | `user_id` (admin) |
| `*` (global) | ALL | 100 | 1 minute | IP |

### 3.2 Business Limits (DB-enforced)

| Rule | Query | Enforcement |
|------|-------|-------------|
| Max active requests per user | `SELECT COUNT(*) FROM requests WHERE user_id = $1 AND state NOT IN ('expired', 'cancelled', 'accepted')` | Application: reject if ≥ 5 |
| Max active subscriptions per user | `SELECT COUNT(*) FROM subscriptions WHERE user_id = $1 AND is_active = true` | Application: reject if ≥ 10 |

### 3.3 Rate Limit Response

```json
{
  "error": "rate_limit_exceeded",
  "message": "Too many requests. Please try again later.",
  "retry_after_seconds": 3600
}
```

HTTP status: `429 Too Many Requests`  
Header: `Retry-After: 3600`

---

## 4. Abuse Protection

### 4.1 Request Creation Abuse

| Guard | Rule | Response |
|-------|------|----------|
| Rapid-fire requests | Rate limit: 5/hour/user | 429 |
| Excessive active requests | Max 5 non-terminal per user | 400 with error code |
| Bad zone_id | Zone must exist and be active | 400 |
| Missing items | At least 1 request_item required | 400 |

### 4.2 Acceptance Abuse

| Guard | Rule | Response |
|-------|------|----------|
| Double acceptance (different offers) | Already handled by `offerAcceptance.js` | 409 |
| Rapid acceptance attempts | Rate limit: 10/hour/user | 429 |

### 4.3 Subscription Abuse

| Guard | Rule | Response |
|-------|------|----------|
| Excessive subscriptions | Max 10 active per user | 400 |
| Invalid preferred_day | CHECK constraint (1-28) | 400 |
| Empty items | Validation: ≥ 1 item required | 400 |

---

## 5. JWT Validation Hardening

### 5.1 Current State

JWT is validated in authentication middleware. Phase 10 adds:

### 5.2 Hardening Additions

| Check | Currently Enforced? | Phase 10 |
|-------|:---:|:---:|
| Token signature validation | ✅ | ✅ |
| Token expiry check | ✅ | ✅ |
| `iss` (issuer) claim validation | ❌ | ✅ Add |
| `aud` (audience) claim validation | ❌ | ✅ Add |
| Token blacklist (logout) | ❌ | ⏳ Deferred |
| Refresh token rotation | ❌ | ⏳ Deferred |

### 5.3 Admin JWT Claims

```json
{
  "sub": "user-uuid",
  "role": "admin",
  "iss": "medyova-auth",
  "aud": "medyova-api",
  "exp": 1710000000
}
```

Admin endpoints validate `role === 'admin'`. Non-admin tokens receive `403`.

---

## 6. Input Validation Audit

### 6.1 Validation Rules

| Endpoint | Field | Rule |
|----------|-------|------|
| `POST /requests` | `zone_id` | UUID format + exists + active |
| `POST /requests` | `contact_phone` | Non-empty, max 20 chars |
| `POST /requests` | `items[]` | Array, min 1, each has product_name + quantity > 0 |
| `POST /requests` | `prescription_url` | URL format if provided |
| `POST /subscriptions` | `preferred_day_of_month` | Integer 1-28 |
| `POST /accept` | `requestId`, `offerId` | UUID format |
| All PATCH admin | Body fields | Strict allowlist (no extra fields) |

### 6.2 Validation Library

Use `express-validator` or manual validation middleware. No heavy frameworks.

### 6.3 SQL Injection Prevention

Already handled by parameterized queries (`$1`, `$2`). Phase 10 confirms no string concatenation in any SQL query across the codebase.

---

## 7. What Must NOT Be Modified

| Component | Reason |
|-----------|--------|
| Routing worker internals | Security layer is pre-routing |
| Offer acceptance atomic transaction | Rate limit is middleware, not tx logic |
| Order lifecycle state machine | Security is pre-handler |
| Commission calculation | Not security-related |
| Subscription sweep | Worker is internal, not API-facing |

---

## 8. Concurrency

- In-memory rate limiter is per-process — single instance deployment means no sync needed
- DB-backed business limits use autocommit SELECT — no locking
- Rate limit checks happen BEFORE route handler — no conflict with business transactions
- Rate limit middleware is stateless per-request (check → allow/deny)

## 9. Transaction Boundaries

- Rate limiting adds ZERO new transactions
- Business limit checks are single autocommit SELECTs
- No modification to existing transaction boundaries
- Rate limit rejection (429) returns before any business logic executes

## 10. Performance

- In-memory rate limiter: O(1) lookup — negligible
- Business limit check (active request count): indexed query, < 2ms
- Validation middleware: synchronous string checks, < 1ms
- Total overhead per request: < 5ms

## 11. Legal Boundary

- Rate limiting is standard security practice — no legal implications
- IP addresses are not stored persistently (in-memory only)
- JWT claims are already collected via authentication
- No additional PII collection

---

## 12. Invariants

| ID | Invariant | Enforcement |
|----|-----------|-------------|
| **SL-1** | Rate limits never modify business state | Middleware returns 429 before handler |
| **SL-2** | Business limits are eventually consistent | DB count at query time |
| **SL-3** | SQL injection impossible | All queries use parameterized statements |
| **SL-4** | Admin endpoints require admin JWT | `requireAdmin` middleware |

---

## 13. Explicit Non-Goals

| Non-Goal | Reason |
|----------|--------|
| DDoS protection | Infrastructure-level (CDN/WAF), not application |
| Bot detection | Out of scope for MVP |
| CAPTCHA | No frontend in scope |
| Geofencing | Not needed for Zone-1 |
| Encryption at rest | Database-level configuration |

---

## 14. Implementation Impact

### New Files

| File | Description |
|------|-------------|
| `src/middlewares/rateLimiter.js` | Rate limit configuration per endpoint |
| `src/middlewares/validateInput.js` | Input validation middleware |
| `src/middlewares/requireAdmin.js` | Admin JWT validation (shared with admin layer) |

### Modified Files

| File | Change |
|------|--------|
| `src/app.js` | Mount global rate limiter |
| `src/routes/*.js` | Add per-route rate limit + validation middleware |

### Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `express-rate-limit` | Rate limiting | ~15KB |
| `express-validator` | Input validation | ~50KB |

### Unmodified Files

All services, workers, and business logic remain unchanged.
