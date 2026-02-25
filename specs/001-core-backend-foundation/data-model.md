# Data Model: Core Backend Foundation

## Entities

### Server

Represents the Node.js process lifecycle.

| Attribute | Type | Description |
|-----------|------|-------------|
| port | number | The bound TCP port (env: PORT, default: 3000) |
| startedAt | Date | Timestamp when the process started |
| uptime | number | Seconds since process start |

**State**: Running | Stopping

---

### DatabaseClient

Represents the PostgreSQL connection pool lifecycle.

| Attribute | Type | Description |
|-----------|------|-------------|
| url | string \| null | Connection string from DATABASE_URL |
| connected | boolean | Whether a test query succeeds |
| poolSize | number | Max connections (default: 10) |

**States**: NotConfigured → Connecting → Connected | Failed

**Transitions**:
- On startup: if `DATABASE_URL` missing → NotConfigured (log WARNING)
- If `DATABASE_URL` present → attempt connect → Connected or Failed

---

### HealthResponse

The JSON payload returned by `GET /health`.

| Field | Type | Example |
|-------|------|---------|
| status | "ok" | `"ok"` |
| timestamp | ISO8601 string | `"2026-02-25T20:36:00.000Z"` |
| uptime | number (seconds) | `142.5` |

---

### ErrorResponse

The JSON payload returned for all error conditions.

| Field | Type | Example |
|-------|------|---------|
| error | string | `"Not Found"` |
| message | string | `"Route /foo does not exist"` |
| statusCode | number | `404` |

---

### Config

Environment-sourced configuration, loaded at startup.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| PORT | No | 3000 | TCP port to bind |
| DATABASE_URL | No | — | PostgreSQL connection string |
| NODE_ENV | No | development | Runtime environment |

**Validation**: Missing `DATABASE_URL` logs WARNING; server continues.
Missing `PORT` uses default silently.
