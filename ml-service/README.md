# ml-service: rain forecast confidence

Two Random Forests that look at an Open-Meteo rain forecast and say how often similar past forecasts brought the rain an alert is
about. The alert engine adds the answer to rain alerts as one line:

```
পূর্বাভাসের নির্ভরযোগ্যতা: উচ্চ।      Forecast confidence: High.
```

| Alert | Model | Question it answers |
|---|---|---|
| Level 2 and 3 (heavy rain) | `heavy` | Did real Heavy Rain Level 2 happen (wettest 3 h ≥ 23 mm or 24 h ≥ 44 mm)? |
| Level 1 (moderate rain) | `moderate` | Did real moderate rain happen (wettest 3 h ≥ 7.5 mm)? |

Each model only answers the question its label asks, which is why there are two. Neither ever creates, cancels, raises or lowers an
alert. If the service is off or failing, alerts go out exactly as before.

## Run it

```
cd ml-service
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

Then set `ML_SERVICE_URL=http://127.0.0.1:8001` in `server/.env` and restart the server. Leave it empty to turn the feature off.

- `GET /health`: the loaded models and their versions
- `POST /predict`: `{ "items": [{ "id", "target": "heavy" | "moderate", "lat", "lon", "date", "lead_day", "rain24_mm", "rain3h_max_mm", "rh_mean", "cape_max" }] }`
  returns a `risk_score`, a `band` (`high` / `medium` / `low`), a `predicted_class` and the `model_version` per item

## Rebuild the models

The data and model files are not in git. Rebuild them in order:

```
python scripts/fetch_history.py --budget 3500     # resumable; run again to continue (Open-Meteo free tier: ~10,000 calls/day)
python scripts/build_dataset.py
.venv/Scripts/python scripts/train.py --target heavy      # models/heavy_rain_rf.joblib, reports/evaluation.md
.venv/Scripts/python scripts/train.py --target moderate   # models/moderate_rain_rf.joblib, reports/evaluation_moderate.md
```

## What the bands mean

Bands are the thirds of the 2024–2025 rule alerts (of that level) ranked by the model's risk score. Results on unseen 2026 data are
in `reports/evaluation.md` (heavy) and `reports/evaluation_moderate.md` (moderate), section "Forecast confidence on rule alerts".

The models show a band, not a percentage, because their probabilities failed the calibration check (they drift between wet and dry
years). Treat the bands as experimental until another monsoon confirms them.

Limits: the reference rainfall is ERA5 (a reanalysis, not rain gauges, and it smooths short showers), and the models only apply
to Open-Meteo forecasts. Past forecasts do not store rain probability, which the live Level 1 rule also uses.
