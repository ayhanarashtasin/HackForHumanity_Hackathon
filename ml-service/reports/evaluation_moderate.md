# Moderate rain classifier: evaluation (moderate-rain-rf-0.1.0)

Train 2024-02-01 .. 2025-12-31 · Test 2026-01-01 .. 2026-10-06 (unseen) · Forecast open-meteo:best_match · Reference era5 (reanalysis, not gauges)

Label: reference rainfall with wettest 3 h >= 7.5 mm (Level 1, moderate rain).
* `equal warnings`: the ML's top N days in 2026, where N is the number of warnings the rule gave. Same alert count, so hits and false alarms compare directly.
* `same budget`: threshold fixed in 2024-2025 so the ML warned as often as the rule did there (what a deployed model would do).
* `best CSI`: threshold with the best CSI in 2024-2025.
* `forecast only`: ranking days by how far the forecast is past the rule's line, i.e. the rule's own information.

## Test 2026, forecast 0 day(s) ahead: 2329 moderate-rain days in 17,856

| | Warnings | Hits | False alarms | Misses | Precision | Recall | CSI |
|---|---|---|---|---|---|---|---|
| Existing rule (Level >= 1) | 2343 | 968 | 1375 | 1361 | 41% | 42% | 0.26 |
| ML, equal warnings | 2343 | 1069 | 1274 | 1260 | 46% | 46% | 0.30 |
| ML, same budget | 2670 | 1170 | 1500 | 1159 | 44% | 50% | 0.31 |
| ML, best CSI | 1973 | 949 | 1024 | 1380 | 48% | 41% | 0.28 |

Ranking quality: ML ROC-AUC 0.845, average precision 0.442 · forecast only ROC-AUC 0.831, average precision 0.388

95% interval (bootstrap over days) for the ML gain: average precision [0.033, 0.076], CSI at same budget [0.023, 0.065]. An interval above 0 means the gain is not luck.

## Test 2026, forecast 1 day(s) ahead: 2329 moderate-rain days in 17,856

| | Warnings | Hits | False alarms | Misses | Precision | Recall | CSI |
|---|---|---|---|---|---|---|---|
| Existing rule (Level >= 1) | 2670 | 1086 | 1584 | 1243 | 41% | 47% | 0.28 |
| ML, equal warnings | 2670 | 1174 | 1496 | 1155 | 44% | 50% | 0.31 |
| ML, same budget | 1854 | 896 | 958 | 1433 | 48% | 38% | 0.27 |
| ML, best CSI | 2512 | 1114 | 1398 | 1215 | 44% | 48% | 0.30 |

Ranking quality: ML ROC-AUC 0.848, average precision 0.439 · forecast only ROC-AUC 0.833, average precision 0.407

95% interval (bootstrap over days) for the ML gain: average precision [0.0, 0.063], CSI at same budget [-0.03, 0.018]. An interval above 0 means the gain is not luck.

## Test 2026, forecast 2 day(s) ahead: 2329 moderate-rain days in 17,856

| | Warnings | Hits | False alarms | Misses | Precision | Recall | CSI |
|---|---|---|---|---|---|---|---|
| Existing rule (Level >= 1) | 2624 | 991 | 1633 | 1338 | 38% | 43% | 0.25 |
| ML, equal warnings | 2624 | 1048 | 1576 | 1281 | 40% | 45% | 0.27 |
| ML, same budget | 1899 | 823 | 1076 | 1506 | 43% | 35% | 0.24 |
| ML, best CSI | 2538 | 1025 | 1513 | 1304 | 40% | 44% | 0.27 |

Ranking quality: ML ROC-AUC 0.827, average precision 0.394 · forecast only ROC-AUC 0.815, average precision 0.356

95% interval (bootstrap over days) for the ML gain: average precision [0.011, 0.066], CSI at same budget [-0.032, 0.013]. An interval above 0 means the gain is not luck.

## Shadow-mode view (1 day ahead, same-budget threshold)

* The rule missed 1243 moderate-rain days. The ML flagged 152 of them (253 at the best-CSI threshold).
* The rule gave 1584 false alarms. The ML scored 880 of them below its threshold.

## By division (1 day ahead, same budget)

| Division | Moderate-rain days | Rule precision | ML precision | Rule recall | ML recall |
|---|---|---|---|---|---|
| Barishal | 168 | 37% | 50% | 42% | 44% |
| Chattogram | 342 | 39% | 54% | 50% | 51% |
| Dhaka | 444 | 40% | 47% | 43% | 32% |
| Khulna | 356 | 41% | 47% | 40% | 28% |
| Mymensingh | 179 | 41% | 48% | 57% | 46% |
| Rajshahi | 249 | 38% | 44% | 38% | 30% |
| Rangpur | 357 | 42% | 46% | 46% | 36% |
| Sylhet | 234 | 46% | 50% | 64% | 53% |

## Forecast confidence on rule alerts (Level 1), 2026

Bands are the risk-score terciles of the 2024-2025 rule alerts. "Came true" = share of the alerts in that band with real moderate-rain.

| Lead | High: alerts / came true | Medium | Low |
|---|---|---|---|
| 0 | 724 / 49% | 698 / 38% | 586 / 22% |
| 1 | 661 / 49% | 825 / 39% | 888 / 26% |
| 2 | 752 / 47% | 799 / 35% | 834 / 25% |

## Calibration (all leads, 2026)

Brier 0.09236 vs climatology 0.11382 (skill 0.189). Calibrated probability validated: **yes**.

| Risk band | Rows | Mean predicted | Observed |
|---|---|---|---|
| 0.00–0.02 | 18,180 | 0.002 | 0.005 |
| 0.02–0.05 | 3,271 | 0.036 | 0.037 |
| 0.05–0.10 | 7,665 | 0.077 | 0.077 |
| 0.10–0.20 | 10,091 | 0.153 | 0.133 |
| 0.20–0.30 | 4,059 | 0.257 | 0.213 |
| 0.30–0.50 | 6,791 | 0.360 | 0.326 |
| 0.50–0.70 | 2,923 | 0.557 | 0.478 |
| 0.70–1.00 | 588 | 0.715 | 0.628 |

## What the model relies on (permutation importance, 1 day ahead)

| Feature | Drop in average precision |
|---|---|
| f_rain24_mm | 0.1556 |
| f_rain3h_block_max_mm | 0.0673 |
| f_rh_mean | 0.0417 |
| doy_cos | 0.0184 |
| doy_sin | 0.0131 |
| f_cape_max | 0.0053 |
| lon | 0.0013 |
| lat | 0.0012 |
| lead_day | 0.0 |
