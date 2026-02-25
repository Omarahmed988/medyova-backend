# Routing Logic: Medyova

> **Status**: Specification only. No implementation in Sprint 0.

## Purpose

The Routing Engine connects patient prescription demand to the most suitable
pharmacies in the patient's zone, using trust scores and tier eligibility.

## Routing Flow

```
1. Patient uploads prescription
   └─► Prescription validated (items extracted)

2. Zone Identification
   └─► Patient's zone determined from delivery address

3. Pharmacy Filtering
   └─► Filter pharmacies by:
       - Same zone as patient
       - Tier = Gold (primary)
       - Active status (not suspended, not offline)

4. Broadcast
   └─► Send routing request to all matched pharmacies simultaneously
       - Pharmacies receive: prescription items, patient zone, SLA window

5. Pharmacy Response Window (SLA = 2 hours)
   └─► Each pharmacy may:
       - Accept (full offer — all items, prices, delivery time)
       - Partially fulfill (subset of items, reason provided)
       - Reject (with rejection reason)
       - Ignore (treated as implicit reject after SLA window)

6. Offer Collection
   └─► Collect all accepted/partial offers after SLA window (or early if full)

7. Offer Ranking
   └─► Rank collected offers by:
       - Fulfillment completeness (full > partial)
       - Trust score (desc)
       - Total price (asc, as tiebreaker)

8. Patient Selects
   └─► Patient reviews ranked offers and selects one

9. Order Confirmed
   └─► Order created, commission tracked
```

## Fallback Logic

If fewer than 2 Gold pharmacies are matched in the zone:

```
IF matched_gold_pharmacies < 2:
  EXPAND to include Silver tier pharmacies in same zone
  RE-BROADCAST to Gold + Silver combined
```

If still no pharmacies after Silver expansion:

```
IF total_matched == 0:
  Return "No pharmacies available in your zone" to patient
  Log rare escalation for operations team
```

## Rare Medicine Path

If one or more prescription items are flagged as "rare" or "scarce":

1. Standard zone + Gold filter applied first.
2. If no Gold pharmacy in zone stocks the rare item:
   - Expand to Gold pharmacies in **adjacent zones**.
   - If still no match: include Silver in adjacent zones.
3. Patient is notified of extended delivery window.

## Timeout and Expiry

- Broadcast SLA: 2 hours (configurable per `SLA_HOURS` env var)
- Offers expire: 1 hour after patient notification
- Unclaimed orders: archived, patient re-prompted

## Data States

| State | Description |
|-------|-------------|
| PENDING | Prescription received, routing not started |
| BROADCASTING | Routing request sent to pharmacies |
| OFFERS_READY | At least one offer collected, awaiting patient |
| CONFIRMED | Patient selected offer, order created |
| FULFILLED | Order delivered, commission recorded |
| FAILED | No offers collected or patient did not select |
