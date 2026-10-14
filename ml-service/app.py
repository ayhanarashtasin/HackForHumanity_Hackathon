"""Rain forecast confidence service.

Answers one question for the Node alert engine: for this Open-Meteo forecast, how often did similar past forecasts bring the rain
the alert is about? Two models, chosen per item by `target`:
  * heavy    : real Heavy Rain Level 2 (wettest 3 h >= 23 mm or 24 h >= 44 mm), for Level 2+ alerts
  * moderate : real Level 1 moderate rain (wettest 3 h >= 7.5 mm), for Level 1 alerts
Each returns a risk score (a ranking, not a calibrated probability) and a High / Medium / Low band. The engine only uses the band
to add one line to rain alerts; it never changes, adds or cancels an alert.

Run (from ml-service/):  .venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 8001
The model files come from scripts/train.py (--target heavy and --target moderate).
"""
import math
from datetime import date
from pathlib import Path
from typing import Literal

import joblib
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel, Field

MODELS = Path(__file__).resolve().parent / 'models'
FILES = {'heavy': MODELS / 'heavy_rain_rf.joblib', 'moderate': MODELS / 'moderate_rain_rf.joblib'}
# A missing model file only switches that target off: its items get no answer, and the engine sends those alerts without the line.
bundles = {target: joblib.load(path) for target, path in FILES.items() if path.exists()}

app = FastAPI(title='Rain forecast confidence', version='0.3.0')


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
