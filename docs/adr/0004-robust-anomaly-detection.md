# ADR 0004: Robust z-score and EWMA, reported as events

**Status:** accepted

## Context
`detect_anomalies` must find the injected problems (3-hour overheating step, 12-hour vibration drift, 2-hour signal dropout, a 20-minute historical spike) without flagging healthy devices. Measured on the seeded data, the textbook mean/standard-deviation z-score missed the overheating step: the long anomaly inflated the standard deviation so the step scored only about 2.6 sigma (masking).

## Decision
- `zscore` = modified z-score using median and MAD, threshold 3.5.
- `ewma` = exponentially weighted moving average (alpha 0.1) starting at the median, flagged when it drifts more than 3 robust sigmas from the median.
- Flagged points become *events*: runs shorter than 3 points (z-score) are dropped as noise; runs separated by fewer than 30 points are merged.

## Consequences
- All injected anomalies are found by both methods, and no healthy device is flagged across the 7-day fleet (tests assert both).
- Tool output stays small (a few events instead of hundreds of points), which saves LLM tokens.
- Not seasonal-aware: a large daily cycle would need de-seasoning (e.g. STL) first. The synthetic daily temperature cycle is small enough to stay under the thresholds.
