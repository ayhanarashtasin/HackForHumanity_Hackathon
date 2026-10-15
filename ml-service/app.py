"""Rain forecast confidence and storm movement service.

Answers one question for the Node alert engine: for this Open-Meteo forecast, how often did similar past forecasts bring the rain
the alert is about? Two models, chosen per item by `target`:
  * heavy    : real Heavy Rain Level 2 (wettest 3 h >= 23 mm or 24 h >= 44 mm), for Level 2+ alerts
  * moderate : real Level 1 moderate rain (wettest 3 h >= 7.5 mm), for Level 1 alerts
Each returns a risk score (a ranking, not a calibrated probability) and a High / Medium / Low band. The engine only uses the band
to add one line to rain alerts; it never changes, adds or cancels an alert.

It also tracks thunderstorm cells on Himawari-9 infrared images (/storms/*, see storm/tracker.py): experimental, shown on the
map only, never used for alerts.

Run (from ml-service/):  .venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 8001
The model files come from scripts/train.py (--target heavy and --target moderate).
"""
import math
import re
import threading
from datetime import date
from pathlib import Path
from typing import Literal

import joblib
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from storm import imagery, tracker

MODELS = Path(__file__).resolve().parent / 'models'
FILES = {'heavy': MODELS / 'heavy_rain_rf.joblib', 'moderate': MODELS / 'moderate_rain_rf.joblib'}
# A missing model file only switches that target off: its items get no answer, and the engine sends those alerts without the line.
bundles = {target: joblib.load(path) for target, path in FILES.items() if path.exists()}

app = FastAPI(title='Rain forecast confidence and storm tracking', version='0.4.0')


class Forecast(BaseModel):
    """Forecast summary for one area over the rule's next-24-hour window, from Open-Meteo 3-hour blocks."""
    id: str = Field(max_length=64)
    target: Literal['heavy', 'moderate'] = 'heavy'
    lat: float = Field(ge=20, le=27.5)
    lon: float = Field(ge=88, le=93)
    date: date  # Bangladesh-time date the window starts on
    lead_day: int = Field(0, ge=0, le=2)
    rain24_mm: float = Field(ge=0, le=2000)
    rain3h_max_mm: float = Field(ge=0, le=1000)
    rh_mean: float = Field(ge=0, le=100)
    cape_max: float = Field(ge=0, le=20000)


class PredictRequest(BaseModel):
    items: list[Forecast] = Field(max_length=2000)


def band_for(bundle, risk, lead):
    cut = bundle['bands'][lead]
    if risk >= cut['high_from']:
        return 'high'
    return 'medium' if risk >= cut['medium_from'] else 'low'


def features(item):
    angle = 2 * math.pi * (item.date.timetuple().tm_yday - 1) / 365.25
    return {
        'f_rain24_mm': item.rain24_mm, 'f_rain3h_block_max_mm': item.rain3h_max_mm,
        'f_rh_mean': item.rh_mean, 'f_cape_max': item.cape_max,
        'lat': item.lat, 'lon': item.lon, 'doy_sin': math.sin(angle), 'doy_cos': math.cos(angle), 'lead_day': item.lead_day,
    }


@app.get('/health')
def health():
    return {
        'status': 'ok' if bundles else 'no-models',
        'models': {target: {'model_version': b['version'], 'provider': b['provider'], 'calibration_validated': b['calibration_validated']}
                   for target, b in bundles.items()},
    }


@app.post('/predict')
def predict(request: PredictRequest):
    answers = {}
    for target, bundle in bundles.items():
        items = [item for item in request.items if item.target == target]
        if not items:
            continue
        risk = bundle['model'].predict_proba(pd.DataFrame([features(item) for item in items], columns=bundle['features']))[:, 1]
        for item, score in zip(items, risk):
            answers[item.id] = {
                'id': item.id,
                'target': target,
                'model_version': bundle['version'],
                'risk_score': round(float(score), 4),
                'band': band_for(bundle, score, item.lead_day),
                'predicted_class': int(score >= bundle['thresholds'][item.lead_day]['same_budget']),
            }
    # Request order; items whose model is missing are left out.
    return {'items': [answers[item.id] for item in request.items if item.id in answers]}


# ---------- storm movement (experimental): see storm/tracker.py ----------
_storm_cache = {}
_demo = None
_demo_lock = threading.Lock()


@app.get('/storms/snapshot')
def storm_snapshot(time: str = Query(pattern=r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')):
    """Storm cells, motion and 30/60/90-minute projection for one Himawari frame time (with the two frames before it).
    404 while the source (STORM_SOURCE) has not published that frame yet: the caller asks again later, and nothing is cached
    under that time."""
    if time not in _storm_cache:
        try:
            published = imagery.load_frame(time) is not None
            frames = imagery.frames_before(time) if published else []
        except Exception as error:  # source unreachable: the caller keeps its previous snapshot
            raise HTTPException(502, f'satellite frames unavailable: {error}') from error
        if not published:
            raise HTTPException(404, 'frame not published yet')
        _storm_cache[time] = tracker.snapshot(frames, 'live')
        for old in sorted(_storm_cache)[:-12]:
            del _storm_cache[old]
    return _storm_cache[time]


@app.get('/storms/demo')
def storm_demo():
    """Replay of the saved storm day (2026-09-22), one snapshot per 10-minute frame, each with its satellite image name."""
    global _demo
    with _demo_lock:
        if _demo is None:
            times = imagery.demo_times()
            # The cell outlines are moved to the ground under the cloud tops; the image is moved by the same (box-centre) parallax
            # shift so both line up on the map.
            shift_km, shift_bearing = tracker.parallax_shift((imagery.NORTH + imagery.SOUTH) / 2, (imagery.WEST + imagery.EAST) / 2)
            lat0, lon0 = (imagery.NORTH + imagery.SOUTH) / 2, (imagery.WEST + imagery.EAST) / 2
            lat1, lon1 = tracker.destination(lat0, lon0, shift_bearing, shift_km)
            dlat, dlon = lat1 - lat0, lon1 - lon0
            _demo = {
                'day': '2026-09-22',
                'bounds': {'north': imagery.NORTH + dlat, 'south': imagery.SOUTH + dlat, 'west': imagery.WEST + dlon, 'east': imagery.EAST + dlon},
                'imageShiftKm': round(shift_km, 1),
                'snapshots': [
                    {**tracker.snapshot(imagery.frames_before(time, fetch=False, source='gibs'), 'demo'),
                     'image': imagery.file_name(imagery.parse_time(time))}
                    for time in times[2:]
                ],
            }
    return _demo


# Building the replay takes about 20 seconds, so it starts in the background as soon as the service does.
threading.Thread(target=storm_demo, daemon=True).start()


@app.get('/storms/demo/{name}')
def storm_demo_image(name: str):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{6}Z\.png', name) or not (imagery.DEMO_DIR / name).exists():
        raise HTTPException(404, 'no such demo frame')
    return FileResponse(imagery.DEMO_DIR / name, media_type='image/png', headers={'Cache-Control': 'public, max-age=86400'})
