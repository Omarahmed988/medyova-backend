# Business Model: Medyova

## Identity

**Medyova** is a demand router, trust layer, and rare priority engine for
healthcare pharmacy fulfillment in Egypt.

## Model

Asset-light B2B2C marketplace connecting patients with pharmacies.

```
Patient → Prescription Upload
        → Demand Router (Medyova) → Matched Pharmacies
        → Pharmacy Offers → Patient Selects
        → Order Fulfilled → Commission Collected
```

## Revenue

- **Commission**: 5–7% on routed, completed orders.
- Revenue is earned only on successful fulfillment — no listing fees, no subscriptions.

## Core Engines

| Engine | Responsibility |
|--------|---------------|
| **Routing Engine** | Match patient demand to pharmacies by zone, tier, and availability |
| **Trust Layer** | Score pharmacies by fulfillment rate, response speed, rating, accuracy |
| **Rare Priority Engine** | Broadcast scarce medications to premium-tier pharmacies first |

## Actors

| Actor | Role |
|-------|------|
| Patient | Uploads prescription, reviews offers, places order |
| Pharmacy | Receives routed requests, submits offers, fulfills orders |
| Medyova Platform | Routes demand, enforces trust, collects commission |

## Zones

Geographic segmentation used for routing. Pharmacies and patients are
assigned to zones. Routing is zone-first to minimize delivery time and
improve fulfillment rates.

## Pharmacy Tiers

| Tier | Criteria | Routing Priority |
|------|----------|-----------------|
| Gold | High trust score, high fulfillment rate | First priority |
| Silver | Moderate trust score | Fallback when < 2 Gold available |
| Bronze | New or low-performing | Not included in initial routing |
