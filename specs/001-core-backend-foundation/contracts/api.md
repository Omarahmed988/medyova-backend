# API Contract: Health Check Endpoint

## GET /health

**Purpose**: Confirm the server process is alive and running.

**Auth**: None required.

**Request**:
```
GET /health HTTP/1.1
Host: api.medyova.com
```

**Response — 200 OK**:
```json
{
  "status": "ok",
  "timestamp": "2026-02-25T20:36:00.000Z",
  "uptime": 142.5
}
```

| Field | Type | Description |
|-------|------|-------------|
| status | string | Always `"ok"` when endpoint responds |
| timestamp | ISO8601 | Current UTC timestamp |
| uptime | number | Server uptime in seconds |

**Notes**:
- This endpoint MUST respond 200 even when the database is unavailable.
- This endpoint does NOT check database connectivity (liveness only).
- A future `/ready` endpoint may be added for readiness checks.

---

## Error Response Contract (All Routes)

All error responses follow this structure:

**Response — 4xx / 5xx**:
```json
{
  "error": "Not Found",
  "message": "The requested resource does not exist.",
  "statusCode": 404
}
```

| Field | Type | Description |
|-------|------|-------------|
| error | string | Short error category |
| message | string | Human-readable description |
| statusCode | number | HTTP status code (mirrors response status) |

**Common status codes**:

| Code | Meaning |
|------|---------|
| 400 | Bad request / malformed JSON body |
| 404 | Route or resource not found |
| 500 | Unhandled server error |
| 503 | Service unavailable (database unreachable — future DB routes) |
