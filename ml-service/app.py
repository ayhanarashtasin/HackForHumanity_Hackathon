"""Heavy-rain forecast confidence service.

Answers one question for the Node alert engine: for this Open-Meteo forecast, how often did similar past forecasts bring real
Heavy Rain Level 2 rain? It returns a risk score (a ranking, not a calibrated probability) and a High / Medium / Low band.
The engine only uses the band to add one line to Level 2+ heavy-rain alerts; it never changes, adds or cancels an alert.

Run (from ml-service/):  .venv/Scripts/python -m uvicorn app:app --host 127.0.0.1 --port 8001
The model file comes from scripts/train.py.
"""
import math
from datetime import date
from pathlib import Path

import joblib
import pandas as pd
from fastapi import FastAPI
from pydantic import BaseModel, Field

MODEL_FILE = Path(__file__).resolve().parent / 'models' / 'heavy_rain_rf.joblib'
bundle = joblib.load(MODEL_FILE)

app = FastAPI(title='Heavy rain forecast confidence', version=bundle['version'])


class Forecast(BaseModel):
    """Forecast summary for one area over the rule's next-24-hour window, from Open-Meteo 3-hour blocks."""
    id: str = Field(max_length=64)
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


def band_for(risk, lead):
    cut = bundle['bands'][lead]
    if risk >= cut['high_from']:
        return 'high'
    return 'medium' if risk >= cut['medium_from'] else 'low'


@app.get('/health')
def health():
    return {'status': 'ok', 'model_version': bundle['version'], 'provider': bundle['provider'],
            'calibration_validated': bundle['calibration_validated']}


@app.post('/predict')
def predict(request: PredictRequest):
    if not request.items:
        return {'model_version': bundle['version'], 'provider': bundle['provider'], 'items': []}

    rows = []
    for item in request.items:
        angle = 2 * math.pi * (item.date.timetuple().tm_yday - 1) / 365.25
        rows.append({
            'f_rain24_mm': item.rain24_mm, 'f_rain3h_block_max_mm': item.rain3h_max_mm,
            'f_rh_mean': item.rh_mean, 'f_cape_max': item.cape_max,
            'lat': item.lat, 'lon': item.lon, 'doy_sin': math.sin(angle), 'doy_cos': math.cos(angle), 'lead_day': item.lead_day,
        })
    risk = bundle['model'].predict_proba(pd.DataFrame(rows, columns=bundle['features']))[:, 1]

    return {
        'model_version': bundle['version'],
        'provider': bundle['provider'],
        'items': [{
            'id': item.id,
            'risk_score': round(float(score), 4),
            'band': band_for(score, item.lead_day),
            'predicted_class': int(score >= bundle['thresholds'][item.lead_day]['same_budget']),
        } for item, score in zip(request.items, risk)],
    }
