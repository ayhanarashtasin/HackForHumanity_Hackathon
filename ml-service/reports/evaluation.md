# Heavy rain classifier: evaluation (heavy-rain-rf-0.1.0)

Train 2024-02-01 .. 2025-12-31 · Test 2026-01-01 .. 2026-10-06 (unseen) · Forecast open-meteo:best_match · Reference era5 (reanalysis, not gauges)

Label: reference rainfall with wettest 3 h >= 23 mm or 24 h total >= 44 mm (Heavy Rain Level 2).
* `equal warnings`: the ML's top N days in 2026, where N is the number of warnings the rule gave. Same alert count, so hits and false alarms compare directly.
* `same budget`: threshold fixed in 2024-2025 so the ML warned as often as the rule did there (what a deployed model would do).
* `best CSI`: threshold with the best CSI in 2024-2025.
* `forecast only`: ranking days by how far the forecast is past the Level 2 line, i.e. the rule's own information.

## Test 2026, forecast 0 day(s) ahead: 350 heavy-rain days in 17,856

| | Warnings | Hits | False alarms | Misses | Precision | Recall | CSI |
|---|---|---|---|---|---|---|---|
| Existing rule (Level >= 2) | 335 | 98 | 237 | 252 | 29% | 28% | 0.17 |
| ML, equal warnings | 335 | 115 | 220 | 235 | 34% | 33% | 0.20 |
| ML, same budget | 269 | 99 | 170 | 251 | 37% | 28% | 0.19 |
| ML, best CSI | 543 | 144 | 399 | 206 | 26% | 41% | 0.19 |

Ranking quality: ML ROC-AUC 0.93, average precision 0.305 · forecast only ROC-AUC 0.913, average precision 0.224

95% interval (bootstrap over days) for the ML gain: average precision [0.036, 0.132], CSI at same budget [-0.012, 0.062]. An interval above 0 means the gain is not luck.

## Test 2026, forecast 1 day(s) ahead: 350 heavy-rain days in 17,856

| | Warnings | Hits | False alarms | Misses | Precision | Recall | CSI |
|---|---|---|---|---|---|---|---|
| Existing rule (Level >= 2) | 296 | 87 | 209 | 263 | 29% | 25% | 0.16 |
| ML, equal warnings | 296 | 98 | 198 | 252 | 33% | 28% | 0.18 |
| ML, same budget | 573 | 141 | 432 | 209 | 25% | 40% | 0.18 |
| ML, best CSI | 1175 | 210 | 965 | 140 | 18% | 60% | 0.16 |

Ranking quality: ML ROC-AUC 0.921, average precision 0.263 · forecast only ROC-AUC 0.893, average precision 0.197

95% interval (bootstrap over days) for the ML gain: average precision [0.008, 0.129], CSI at same budget [-0.013, 0.064]. An interval above 0 means the gain is not luck.

## Test 2026, forecast 2 day(s) ahead: 350 heavy-rain days in 17,856

| | Warnings | Hits | False alarms | Misses | Precision | Recall | CSI |
|---|---|---|---|---|---|---|---|
| Existing rule (Level >= 2) | 239 | 67 | 172 | 283 | 28% | 19% | 0.13 |
| ML, equal warnings | 239 | 75 | 164 | 275 | 31% | 21% | 0.15 |
| ML, same budget | 560 | 140 | 420 | 210 | 25% | 40% | 0.18 |
| ML, best CSI | 986 | 181 | 805 | 169 | 18% | 52% | 0.16 |

Ranking quality: ML ROC-AUC 0.92, average precision 0.245 · forecast only ROC-AUC 0.895, average precision 0.187

95% interval (bootstrap over days) for the ML gain: average precision [0.003, 0.123], CSI at same budget [0.012, 0.094]. An interval above 0 means the gain is not luck.

## Shadow-mode view (1 day ahead, same-budget threshold)

* The rule missed 263 heavy-rain days. The ML flagged 71 of them (125 at the best-CSI threshold).
* The rule gave 209 false alarms. The ML scored 94 of them below its threshold.

## By division (1 day ahead, same budget)

| Division | Heavy days | Rule precision | ML precision | Rule recall | ML recall |
|---|---|---|---|---|---|
| Barishal | 34 | 50% | 28% | 21% | 38% |
| Chattogram | 98 | 48% | 34% | 29% | 67% |
| Dhaka | 51 | 17% | 16% | 16% | 28% |
| Khulna | 28 | 19% | 17% | 11% | 14% |
| Mymensingh | 18 | 30% | 20% | 44% | 50% |
| Rajshahi | 14 | 0% | 0% | 0% | 0% |
| Rangpur | 62 | 23% | 16% | 18% | 11% |
| Sylhet | 45 | 30% | 28% | 49% | 62% |

## Calibration (all leads, 2026)

Brier 0.01723 vs climatology 0.01923 (skill 0.104). Calibrated probability validated: **no, show a risk score only**.

| Risk band | Rows | Mean predicted | Observed |
|---|---|---|---|
| 0.00–0.02 | 37,313 | 0.004 | 0.001 |
| 0.02–0.05 | 9,422 | 0.030 | 0.020 |
| 0.05–0.10 | 2,722 | 0.068 | 0.051 |
| 0.10–0.20 | 1,762 | 0.139 | 0.096 |
| 0.20–0.30 | 1,403 | 0.276 | 0.146 |
| 0.30–0.50 | 849 | 0.344 | 0.276 |
| 0.50–0.70 | 96 | 0.598 | 0.573 |
| 0.70–1.00 | 1 | 0.787 | 1.000 |

## What the model relies on (permutation importance, 1 day ahead)

| Feature | Drop in average precision |
|---|---|
| f_rain24_mm | 0.1539 |
| f_rh_mean | 0.0831 |
| f_rain3h_block_max_mm | 0.0656 |
| f_cape_max | 0.0605 |
| lon | 0.0378 |
| doy_sin | 0.0354 |
| doy_cos | 0.035 |
| lat | 0.0057 |
| lead_day | 0.0 |
