# ml-service: heavy-rain forecast confidence

A Random Forest that looks at an Open-Meteo rain forecast and says how often similar past forecasts brought real Heavy Rain Level 2
rain (wettest 3 h ≥ 23 mm or 24 h ≥ 44 mm). The alert engine adds its answer to Level 2+ heavy-rain alerts as one line:

```
পূর্বাভাসের নির্ভরযোগ্যতা: উচ্চ।      Forecast confidence: High.
```

It never creates, cancels, raises or lowers an alert. If the service is off or failing, alerts go out exactly as before.

## Run it

```
cd ml-service
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

Then set `ML_SERVICE_URL=http://127.0.0.1:8001` in `server/.env` and restart the server. Leave it empty to turn the feature off.

- `GET /health`: model version and status
- `POST /predict`: `{ "items": [{ "id", "lat", "lon", "date", "lead_day", "rain24_mm", "rain3h_max_mm", "rh_mean", "cape_max" }] }`
  returns a `risk_score`, a `band` (`high` / `medium` / `low`) and a `predicted_class` per item

## Rebuild the model

The data and model files are not in git. Rebuild them in order:

```
python scripts/fetch_history.py --budget 3500     # resumable; run again to continue (Open-Meteo free tier: ~10,000 calls/day)
python scripts/build_dataset.py
.venv/Scripts/python scripts/train.py             # writes models/heavy_rain_rf.joblib and reports/evaluation.md
```

## What the bands mean

Bands are the thirds of the 2024–2025 Level 2+ alerts ranked by the model's risk score. On unseen 2026 data, of the alerts in each band:

| Band | Came true (forecast 1 day ahead) |
|---|---|
| High | 40% |
| Medium | 22% |
| Low | 9% |

The model shows a band, not a percentage, because its probabilities failed the calibration check (they drift between wet and dry
years). On 2024–2025 data the bands separated less clearly, so treat them as experimental. Full results: `reports/evaluation.md`.

Limits: the reference rainfall is ERA5 (a reanalysis, not rain gauges), and the model only applies to Open-Meteo forecasts.
