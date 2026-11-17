# STRATEGY.md — gta6-twitch-ccu-forecast v2

## Model

Scale-matched launch curves, rebuilt from the comparables in each case file:

1. **Clean pool.** Drop comparables whose unlock note carries the
   `early-access-contaminated` Tier marker — their release-day curve is
   polluted by the early-access peak. A mere mention of early access does
   not disqualify. Rebuild each launch's 24-hour release-day curve from
   its `day_start`; drop launches with no hour-1 print.
2. **Tight scale band.** Keep comparables whose hour-1 print is within 2x
   of the case's hour-1 print (fallbacks: 10x, then hour-1 >= 10k, then
   persistence). Launch-curve shape depends strongly on launch size: the
   pooled average is dominated by big front-loaded launches and is badly
   wrong (blending it in cost +0.16 loss in testing).
3. **Centre.** Per hour, the 20% trimmed mean of log-ratios
   ln(viewers_h / viewers_1) across the band, multiplied by a 1.3 lift.
   The band centre systematically understates how much a rolling-midnight
   console launch grows over its first day (late-day bias +0.23 to +0.50
   in log terms); the lift corrects most of it. The lift optimum is
   interior (1.3 beats 1.2 and 1.4) and flat.
4. **Quantiles.** q = p1 * exp(1.3 * centre + z * s) with asymmetric
   spreads: s = 0.2 below the median, 0.3 above it. Launch outcomes are
   right-skewed in log space — a launch can explode upward but can only
   fall so far — so the upside tail is wider. Clamped to [1, 1e9] and
   forced non-decreasing.
5. **Shape guard.** When the hour-1 print towers over every past launch,
   the tight band holds only front-loaded launches whose hour-1 was a
   peak, and their curves decay all day. If the band centre's late-day
   shape (mean centre, hours 18–24) is below +0.2 in log terms, widen
   the band through 3x, 4x, 6x, 10x until the shape is clearly rising;
   if no width gets there, fall back to the comparables that kept
   growing into the evening. The guard never fires on any practice case
   (all late shapes +0.38 to +1.59), so it costs nothing there and only
   protects the final. Without it, a 900k hour-1 print would forecast a
   decaying day (median 0.84x by hour 24); with it, the same print
   forecasts a rising day (1.39x by hour 24).

## Evidence (local RULES-exact scorer, 4 practice cases)

| variant | mean loss | p00 | p01 | p02 | p03 |
|---|---|---|---|---|---|
| v1 (band 4x, lift 1.1, spread 0.35) | 0.163452 | 0.2270 | 0.1638 | 0.1008 | 0.1622 |
| **v2 (this entry)** | **0.128170** | 0.1271 | 0.1234 | 0.0792 | 0.1831 |

- v2 beats v1 on all four leave-one-out means (mean of the other three
  cases) and on the full mean (-21.6%). Worst case 0.1831, well under
  v1's worst (0.2270). 90% coverage 0.902 (target 0.90).
- Strict LOO parameter selection (pick the best variant on 3 cases,
  score on the held-out case): mean held-out loss 0.1327 vs v1's 0.1635.
- Rejected after testing: log(h1) regression centres (unstable, worst
  0.41 on p00 at lift 1.3), similarity-weighted bands, per-hour empirical
  spreads (overstate the needed width), hour-group lifts, empirical
  quantiles, console-only and rising-shape pools (both fail practice),
  blending the pooled centre (catastrophic, 0.29).

## Runtime

~0.2 s per case, deterministic (no randomness, no clock, no network).
Outputs are 23 rows x 5 quantiles, byte-identical across runs.
