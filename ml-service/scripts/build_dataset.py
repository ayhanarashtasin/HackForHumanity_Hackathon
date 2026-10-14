"""Joins the cached forecasts (dataset X) with the ERA5 reference (dataset Y) into one labelled CSV.

One row = one district x one local calendar day (Asia/Dhaka, 00:00-24:00) x one forecast lead (0, 1, 2 days).
  * Features come only from the forecast issued `lead_day` days before the target day.
  * The labels come only from the reference rainfall of that same district and day:
      label          = 1 if reference max rolling 3 h rain >= 23 mm OR reference 24 h rain >= 44 mm, else 0 (Heavy Rain Level 2)
      label_moderate = 1 if reference max rolling 3 h rain >= 7.5 mm, else 0 (Level 1, moderate rain)
    (server/src/config/alertRules.js). They are never taken from the rule's forecast output.
  * rule_level / rule_heavy replay the existing rule on the forecast exactly as the live server computes it
    (3-hour blocks aligned to 00, 03, 06 ... local time), so the model can be compared against that baseline.

Usage: python scripts/build_dataset.py
"""
import csv
import json
import math
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / 'data' / 'raw'
OUT = ROOT / 'data' / 'processed' / 'heavy_rain_dataset.csv'

# Mirrors hazardRules.HEAVY_RAIN.levels in server/src/config/alertRules.js. Change both together, never one.
LEVELS = {1: {'rain3h': 7.5}, 2: {'rain3h': 23, 'rain24h': 44}, 3: {'rain3h': 50, 'rain24h': 89}}
WET_HOUR_MM = 0.5
LEADS = (0, 1, 2)
PROVIDER = 'open-meteo:best_match'
REFERENCE = 'era5'


def column(name, lead):
    return name if lead == 0 else f'{name}_previous_day{lead}'


def load(source):
    """{pcode: {'district': ..., 'grid': ..., 'hours': {time: {variable: value}}}}; later files win on overlap."""
    merged = {}
    for path in sorted((RAW / source).glob('*.json')):
        data = json.loads(path.read_text(encoding='utf-8'))
        entry = merged.setdefault(data['district']['pcode'], {'district': data['district'], 'grid': data['grid'], 'hours': {}})
        hourly = data['hourly']
        for i, time in enumerate(hourly['time']):
            entry['hours'].setdefault(time, {}).update({k: v[i] for k, v in hourly.items() if k != 'time'})
    return merged


def by_day(hours, variable):
    """{day: [24 hourly values]} for days where all 24 hours are present."""
    days = defaultdict(dict)
    for time, values in hours.items():
        if values.get(variable) is not None:
            days[time[:10]][int(time[11:13])] = values[variable]
    return {day: [v[h] for h in range(24)] for day, v in days.items() if len(v) == 24}


def rolling_max(values, width=3):
    return max(sum(values[i:i + width]) for i in range(len(values) - width + 1))


def block_max(values, width=3):
    return max(sum(values[i:i + width]) for i in range(0, len(values), width))


def rule_level(rain3h, rain24h):
    # pop is not archived, so the Level 1 probability gate is treated as "not available" (as the live rule does).
    if rain24h >= LEVELS[3]['rain24h'] or rain3h >= LEVELS[3]['rain3h']:
        return 3
    if rain24h >= LEVELS[2]['rain24h'] or rain3h >= LEVELS[2]['rain3h']:
        return 2
    return 1 if rain3h >= LEVELS[1]['rain3h'] else 0


def r(value, digits=2):
    return round(value, digits)


def main():
    forecast, reference = load('forecast'), load('era5')
    if not forecast or not reference:
        raise SystemExit('No raw data yet. Run scripts/fetch_history.py first.')

    rows = []
    for pcode, fc in sorted(forecast.items()):
        if pcode not in reference:
            continue
        district = fc['district']
        ref_rain = by_day(reference[pcode]['hours'], 'precipitation')
        for lead in LEADS:
            rain = by_day(fc['hours'], column('precipitation', lead))
            rh = by_day(fc['hours'], column('relative_humidity_2m', lead))
            cape = by_day(fc['hours'], column('cape', lead))
            for day in sorted(set(rain) & set(ref_rain)):
                f_rain, y_rain = rain[day], ref_rain[day]
                f24, f3_block = sum(f_rain), block_max(f_rain)
                y24, y3 = sum(y_rain), rolling_max(y_rain)
                d = date.fromisoformat(day)
                angle = 2 * math.pi * (d.timetuple().tm_yday - 1) / 365.25
                level = rule_level(f3_block, f24)
                rows.append({
                    'district_pcode': pcode, 'district': district['name'], 'division': district['division'],
                    'date': day, 'lead_day': lead, 'provider': PROVIDER,
                    'lat': district['lat'], 'lon': district['lon'], 'month': d.month,
                    'doy_sin': r(math.sin(angle), 4), 'doy_cos': r(math.cos(angle), 4),
                    'f_rain24_mm': r(f24), 'f_rain3h_block_max_mm': r(f3_block), 'f_rain3h_rolling_max_mm': r(rolling_max(f_rain)),
                    'f_rain1h_max_mm': r(max(f_rain)), 'f_wet_hours': sum(v >= WET_HOUR_MM for v in f_rain),
                    'f_rh_mean': r(sum(rh[day]) / 24, 1) if day in rh else '', 'f_rh_max': max(rh[day]) if day in rh else '',
                    'f_cape_mean': r(sum(cape[day]) / 24, 0) if day in cape else '', 'f_cape_max': max(cape[day]) if day in cape else '',
                    'rule_level': level, 'rule_heavy': int(level >= 2),
                    'reference': REFERENCE, 'ref_rain24_mm': r(y24), 'ref_rain3h_max_mm': r(y3),
                    'label': int(y3 >= LEVELS[2]['rain3h'] or y24 >= LEVELS[2]['rain24h']),
                    # Level 1 (moderate rain) happened: the reference's wettest 3 hours reached the Level 1 amount.
                    'label_moderate': int(y3 >= LEVELS[1]['rain3h']),
                })

    if not rows:
        raise SystemExit('Forecast and reference files do not overlap yet.')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    summarize(rows)
    print(f'\nWrote {len(rows):,} rows to {OUT.relative_to(ROOT.parent)}')


def summarize(rows):
    print(f"Districts: {len({x['district_pcode'] for x in rows})}   Days: {min(x['date'] for x in rows)} .. {max(x['date'] for x in rows)}")
    for lead in LEADS:
        part = [x for x in rows if x['lead_day'] == lead]
        if not part:
            continue
        c = Counter((x['rule_heavy'], x['label']) for x in part)
        tp, fp, fn = c[(1, 1)], c[(1, 0)], c[(0, 1)]
        pos = tp + fn
        print(f"\nLead {lead} day: {len(part):,} rows, {pos:,} heavy-rain days by {REFERENCE} ({pos / len(part):.1%})")
        print(f"  Rule baseline (Level >= 2 on forecast): hits {tp}, false alarms {fp}, misses {fn}")
        if tp + fp:
            print(f"  precision {tp / (tp + fp):.2f}   recall {tp / pos if pos else 0:.2f}   CSI {tp / (tp + fp + fn):.2f}")
    labelled = [x for x in rows if x['lead_day'] == 1]
    print('\nHeavy-rain days (lead 1) by month:', dict(sorted(Counter(x['month'] for x in labelled if x['label']).items())))
    print('Label from 3 h condition only:', sum(x['ref_rain3h_max_mm'] >= 23 and x['ref_rain24_mm'] < 44 for x in labelled),
          '| from 24 h condition:', sum(x['ref_rain24_mm'] >= 44 for x in labelled))


if __name__ == '__main__':
    main()
