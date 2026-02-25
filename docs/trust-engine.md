# Trust Engine: Medyova

> **Status**: Specification only. No implementation in Sprint 0.

## Purpose

The Trust Engine assigns each pharmacy a composite score used to rank offers
and determine routing eligibility. Higher-trust pharmacies receive demand
first and appear higher in patient-facing offer lists.

## Score Formula

```
trust_score =
  0.40 × fulfillment_rate
+ 0.30 × response_speed_score
+ 0.15 × rating
+ 0.15 × completion_accuracy
```

All inputs are normalized to [0.0, 1.0] before aggregation.

## Metrics

### fulfillment_rate

Proportion of accepted orders that were fully delivered.

```
fulfillment_rate = fully_fulfilled_orders / accepted_orders
```

- Range: 0.0 – 1.0
- Minimum accepted orders for scoring: 10 (new pharmacies use platform average)

### response_speed_score

How quickly the pharmacy responds to routed broadcasts.

```
response_time_hours = avg(time_from_broadcast_to_offer)
response_speed_score = max(0, 1 - (response_time_hours / SLA_HOURS))
```

- `SLA_HOURS` = 2 hours (configurable)
- A pharmacy that always responds in < 30 min scores ≈ 0.75
- A pharmacy that always responds in < 5 min scores ≈ 0.97
- No response within SLA = 0.0

### rating

Aggregated patient rating after order completion.

```
rating = avg(patient_ratings) / 5.0
```

- Patient ratings are 1–5 stars
- Minimum 5 ratings required; otherwise use configurable default (e.g., 0.6)

### completion_accuracy

Whether the pharmacy fulfilled the exact items prescribed.

```
completion_accuracy = exact_matches / total_prescription_items
```

- Partial substitutions reduce the score
- Unapproved substitutions are treated as misses

## Partial Fulfillment Effect

If a pharmacy partially fulfills an order:

- `fulfillment_rate` is reduced by `(1 - fill_ratio)` for that order
- `completion_accuracy` is reduced proportionally
- Partial fulfillment does not count as rejection — it still counts as
  "accepted" for response speed purposes

## Score Decay (Future)

Scores decay toward the platform average when inactivity exceeds 30 days.
Decay rate and floor to be defined in Sprint 2+ spec.

## Tier Assignment

| Score Range | Tier |
|-------------|------|
| 0.80 – 1.00 | Gold |
| 0.55 – 0.79 | Silver |
| 0.00 – 0.54 | Bronze |
