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

`storm/` tracks thunderstorm cells on Himawari-9 infrared frames (band 13, every 10 minutes) and shows them on the weather map as
**Map layers → Storm movement**. The server also turns a strong cell heading for a subscriber's area into a prototype storm warning
(`server/src/services/alerts/stormEpisodes.js`, rule PUBLIC-06); the tracker itself only describes the image.

Where the frames come from (`STORM_SOURCE`):

| Source | Arrives after the scan | What it holds |
|---|---|---|
| `noaa` (default) | about 15 minutes | JMA's raw data (Himawari Standard Data) on NOAA's open-data bucket: real brightness temperatures |
| `gibs` | 45–60 minutes | NASA GIBS colour images: colour classes, no temperatures |

`storm/himawari.py` downloads the two full-disk segments (of ten) that cover the box, about 5.5 MB per frame, decodes them as
JMA's *Himawari Standard Data User's Guide* describes, calibrates the counts to brightness temperature and resamples them to the
same 450 × 450 latitude/longitude grid as the GIBS frames. Decoded frames are cached in `storm/cache/` as 16-bit PNGs (about
290 KB each) and deleted after two days. Data: JMA Himawari-9, accessed from <https://registry.opendata.aws/noaa-himawari>
(NOAA Open Data Dissemination); NOAA and JMA ask for attribution and do not endorse this project.

How it works (`storm/tracker.py`):

1. Cloud tops are put into intensity classes 1–6. GIBS images: grey for warm ground and ordinary cloud, then cyan, blue, green,
   yellow, red and dark red as cloud tops get colder (GIBS publishes no colour table). NOAA temperatures: colder than −27, −36, −47,
   −58, −66 and −72 °C, the edges between the GIBS colours fitted on the 31 frames of the saved storm day (1–6% of pixels fall on
   the other side of an edge), so both sources give the same classes.
2. Cells are the connected areas of class 4 or colder (yellow, or −58 °C), at least 200 km². With NOAA frames each cell also
   reports its coldest cloud top (`minTempC`).
3. Motion is dense optical flow (OpenCV Farneback) between the newest frame and the one 20 minutes earlier, averaged over each cell.
4. Positions are moved about 22 km east-south-east: Himawari-9 sits over 140.7°E and sees Bangladesh at about 62° from vertical, so a
   12 km cloud top appears displaced away from the satellite (parallax).
5. Each cell is projected 30, 60 and 90 minutes ahead in a straight line, in a circle that widens with distance, and the upazilas
   inside it are listed with their arrival times.

The Node backend asks for the frame after the last one it analysed every 2 minutes (`STORM_MINUTES`; `GET /storms/snapshot?time=...`
answers 404 until GIBS has published that frame), so a frame is analysed within minutes of reaching GIBS. It keeps each result for
30 days in MongoDB (`StormSnapshot`), which is the future test set. `GET /storms/demo` replays the saved storm day, **22 September 2026**,
13:00–18:00 Bangladesh time (`storm/data/demo-2026-09-22/`, kept in git because GIBS deletes frames after about six weeks). The map
opens it directly with `/map#o=storms&storm=replay`.

### How accurate is it?

`python -m storm.validate [gibs|noaa]` follows every cell 60 minutes forward on the saved day, without using the tracker's own
motion, and compares (`reports/storm_validation.json`, `reports/storm_validation_noaa.json`):

| 60 minutes ahead | GIBS images (418 cases) | NOAA temperatures (425 cases) |
|---|---|---|
| Tracker (straight-line motion), median error | **30.5 km** | **28.4 km** |
| "The storm stays where it is", median error | 34.6 km | 33.4 km |
| Tracker closer | 59% | 58% |

Both sources track about equally well; the NOAA data arrives 30–45 minutes sooner. The gain is modest: most of the remaining
error comes from storms growing, splitting and merging, which straight-line motion cannot capture. One day is a small test; the
live history in MongoDB will give a larger one.

Limits: cloud-top intensity is not lightning; the 12 km cloud height in the parallax correction is an assumption; frames arrive about
15 minutes (NOAA) or 45–60 minutes (GIBS) after the scan, so live positions are where storms were then.

Tests: `python -m unittest discover tests` (synthetic storms moved by a known distance).
