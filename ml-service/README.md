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

From the repository root (needs Python 3.12+; the trained models in `models/` are committed):

```
npm run dev         # backend + frontend + ML service together (the usual way)
npm run ml          # only the ML service, on http://127.0.0.1:8001
```

The first run creates `ml-service/.venv` and installs `requirements.txt`. In development the backend uses http://127.0.0.1:8001 unless
`server/.env` sets `ML_SERVICE_URL` (empty turns the feature off; production needs it set explicitly). `npm run demo:rain` adds a
demo alert to see the line.

Manual equivalent (Windows paths; use `.venv/bin/python` on macOS and Linux):

```
cd ml-service
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements.txt
.venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 8001
```

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

## Storm movement (experimental)

`storm/` tracks thunderstorm cells on Himawari-9 infrared images (band 13, every 10 minutes, from NASA GIBS) and shows them on the
weather map as **Map layers → Storm movement**. It never creates, changes or cancels an alert.

How it works (`storm/tracker.py`):

1. The satellite colour scale is turned into intensity classes: grey for warm ground and ordinary cloud, then cyan, blue, green,
   yellow, red and dark red as cloud tops get colder (classes, not °C: GIBS publishes no colour table for this layer).
2. Cells are the connected areas of yellow or colder, at least 200 km².
3. Motion is dense optical flow (OpenCV Farneback) between the newest frame and the one 20 minutes earlier, averaged over each cell.
4. Positions are moved about 22 km east-south-east: Himawari-9 sits over 140.7°E and sees Bangladesh at about 62° from vertical, so a
   12 km cloud top appears displaced away from the satellite (parallax).
5. Each cell is projected 30, 60 and 90 minutes ahead in a straight line, in a circle that widens with distance, and the upazilas
   inside it are listed with their arrival times.

The Node backend asks for the newest frame every 10 minutes (`GET /storms/snapshot?time=...`) and keeps each result for 30 days in
MongoDB (`StormSnapshot`), which is the future test set. `GET /storms/demo` replays the saved storm day, **22 September 2026**,
13:00–18:00 Bangladesh time (`storm/data/demo-2026-09-22/`, kept in git because GIBS deletes frames after about six weeks). The map
opens it directly with `/map#o=storms&storm=replay`.

### How accurate is it?

`python -m storm.validate` follows every cell 60 minutes forward on the saved day, without using the tracker's own motion, and
compares (`reports/storm_validation.json`):

| 60 minutes ahead (418 cases) | Median position error |
|---|---|
| Tracker (straight-line motion) | **30.5 km** |
| "The storm stays where it is" | 34.6 km |

The tracker is closer in about 59% of cases (61% of the cells that really moved). The gain is modest: most of the remaining
error comes from storms growing, splitting and merging, which straight-line motion cannot capture. One day is a small test; the
live history in MongoDB will give a larger one.

Limits: cloud-top intensity is not lightning; the 12 km cloud height in the parallax correction is an assumption; frames reach GIBS
about 45–60 minutes late, so live positions are where storms were then.

Tests: `python -m unittest discover tests` (synthetic storms moved by a known distance).
