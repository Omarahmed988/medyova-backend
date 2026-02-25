# API Contract: Medyova Backend

> **Status**: Contract only. No implementation in Sprint 0.
> All endpoints return JSON. All error responses follow the standard error structure.

## Standard Error Response

```json
{
  "error": "Bad Request",
  "message": "prescription_id is required",
  "statusCode": 400
}
```

---

## POST /prescriptions

Upload a prescription and initiate the routing process.

**Request**:
```json
{
  "patient_id": "uuid",
  "zone_id": "uuid",
  "items": [
    {
      "name": "Amoxicillin 500mg",
      "quantity": 2,
      "requires_prescription": true
    }
  ],
  "notes": "string (optional)"
}
```

**Response — 201 Created**:
```json
{
  "prescription_id": "uuid",
  "status": "PENDING",
  "created_at": "2026-02-25T20:00:00.000Z"
}
```

---

## GET /offers/:prescriptionId

Get all offers submitted by pharmacies for a prescription.

**Request**: `GET /offers/uuid`

**Response — 200 OK**:
```json
{
  "prescription_id": "uuid",
  "offers": [
    {
      "offer_id": "uuid",
      "pharmacy_id": "uuid",
      "pharmacy_name": "string",
      "trust_score": 0.92,
      "items": [
        {
          "name": "Amoxicillin 500mg",
          "price": 25.00,
          "available": true
        }
      ],
      "total_price": 25.00,
      "estimated_delivery_hours": 2,
      "is_partial": false,
      "submitted_at": "2026-02-25T20:30:00.000Z"
    }
  ]
}
```

---

## POST /offers

Pharmacy submits an offer for a prescription.

**Request**:
```json
{
  "prescription_id": "uuid",
  "pharmacy_id": "uuid",
  "items": [
    {
      "name": "Amoxicillin 500mg",
      "price": 25.00,
      "available": true,
      "substitution": null
    }
  ],
  "estimated_delivery_hours": 2,
  "notes": "string (optional)"
}
```

**Response — 201 Created**:
```json
{
  "offer_id": "uuid",
  "status": "SUBMITTED",
  "created_at": "2026-02-25T20:30:00.000Z"
}
```

---

## POST /orders

Patient confirms an offer and creates an order.

**Request**:
```json
{
  "prescription_id": "uuid",
  "offer_id": "uuid",
  "patient_id": "uuid"
}
```

**Response — 201 Created**:
```json
{
  "order_id": "uuid",
  "status": "CONFIRMED",
  "pharmacy_id": "uuid",
  "total_price": 25.00,
  "estimated_delivery_hours": 2,
  "created_at": "2026-02-25T21:00:00.000Z"
}
```

---

## GET /zones

List all active delivery zones.

**Request**: `GET /zones`

**Response — 200 OK**:
```json
{
  "zones": [
    {
      "zone_id": "uuid",
      "name": "Maadi",
      "city": "Cairo",
      "active": true
    }
  ]
}
```
