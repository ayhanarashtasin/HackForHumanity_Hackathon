"""Downloads the two raw datasets for the heavy-rain classifier (standard library only).

Dataset X (forecast): Open-Meteo Previous Runs API, the same `best_match` model the live server reads
from api.open-meteo.com. For every hour it returns the value forecast 0, 1 and 2 days earlier, so each
hour can be rebuilt as "what the forecast said N days before". Archived from about February 2024.

Dataset Y (reference): ERA5 reanalysis through the Open-Meteo Archive API (about 5 days behind real time).
ERA5 is a model reconstruction on a 0.25 degree grid, NOT a rain-gauge observation.

The free Open-Meteo tier allows about 10,000 weighted calls per day per IP, and the live server already
spends a few thousand of them. Each run therefore stops at --budget and can be run again later: finished
chunks are cached under data/raw/ and never fetched twice.

Usage:
  python scripts/fetch_history.py --locations 16          # pilot: 2 districts per division
  python scripts/fetch_history.py                          # all 64 districts (resumes)
  python scripts/fetch_history.py --source era5 --budget 3000
"""
import argparse
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
RAW = ROOT / 'data' / 'raw'
LOCATIONS_FILE = REPO / 'server' / 'data' / 'locations.json'

FIRST_DAY = date(2024, 2, 1)  # first day the Previous Runs API has rainfall for Bangladesh
ERA5_LAG_DAYS = 7
LEADS = (0, 1, 2)
FORECAST_BASE = ('precipitation', 'relative_humidity_2m', 'cape')

SOURCES = {
    'forecast': {
        'url': 'https://previous-runs-api.open-meteo.com/v1/forecast',
        'hourly': [name if lead == 0 else f'{name}_previous_day{lead}' for lead in LEADS for name in FORECAST_BASE],
        'extra': {},
    },
    'era5': {
        'url': 'https://archive-api.open-meteo.com/v1/archive',
        'hourly': ['precipitation'],
        'extra': {'models': 'era5'},
    },
}


def load_districts():
    data = json.loads(LOCATIONS_FILE.read_text(encoding='utf-8'))
    return [{k: d[k] for k in ('pcode', 'name', 'division', 'lat', 'lon')} for d in data['districts']]


def spread(districts, count):
    """The first `count` districts taken round-robin across divisions, so a pilot covers the whole country."""
    by_division = {}
    for d in districts:
        by_division.setdefault(d['division'], []).append(d)
    picked, round_index = [], 0
    while len(picked) < min(count, len(districts)):
        for group in by_division.values():
            if round_index < len(group) and len(picked) < count:
                picked.append(group[round_index])
        round_index += 1
    return picked


def quarters(first, last):
    start = first
    while start <= last:
        month = ((start.month - 1) // 3 + 1) * 3 + 1
        next_start = date(start.year + (month > 12), (month - 1) % 12 + 1, 1)
        end = min(next_start - timedelta(days=1), last)
        yield start, end
        start = next_start


def weight(days, variables):
    # Open-Meteo counts a request as several calls when it spans more than 2 weeks or more than 10 variables.
    return max(1.0, days / 14) * max(1.0, variables / 10)


class LimitReached(Exception):
    pass


def fetch(url, params, attempts=4):
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(f'{url}?{query}', headers={'User-Agent': 'HackForHumanity-ml-dataset/1.0'})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            body = error.read().decode('utf-8', 'replace')
            if error.code == 429:
                if 'Minutely' in body:
                    print('    minutely limit, waiting 65 s')
                    time.sleep(65)
                    continue
                raise LimitReached(body) from error
            if error.code < 500 or attempt == attempts - 1:
                raise RuntimeError(f'HTTP {error.code}: {body[:300]}') from error
        except (urllib.error.URLError, TimeoutError) as error:
            if attempt == attempts - 1:
                raise RuntimeError(str(error)) from error
        time.sleep(5 * (attempt + 1))
    raise RuntimeError('gave up after retries')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', choices=['all', *SOURCES], default='all')
    parser.add_argument('--locations', type=int, default=64, help='number of districts (spread across divisions)')
    parser.add_argument('--budget', type=float, default=4000, help='max weighted Open-Meteo calls this run')
    parser.add_argument('--pause', type=float, default=4.0, help='seconds between requests')
    args = parser.parse_args()

    last_day = date.today() - timedelta(days=ERA5_LAG_DAYS)
    districts = spread(load_districts(), args.locations)
    sources = list(SOURCES) if args.source == 'all' else [args.source]
    (RAW / 'districts.json').parent.mkdir(parents=True, exist_ok=True)
    (RAW / 'districts.json').write_text(json.dumps(districts, indent=2), encoding='utf-8')

    spent, fetched, skipped = 0.0, 0, 0
    try:
        for name in sources:
            source = SOURCES[name]
            folder = RAW / name
            folder.mkdir(parents=True, exist_ok=True)
            for d in districts:
                for start, end in quarters(FIRST_DAY, last_day):
                    target = folder / f"{d['pcode']}_{start}_{end}.json"
                    if target.exists():
                        skipped += 1
                        continue
                    cost = weight((end - start).days + 1, len(source['hourly']))
                    if spent + cost > args.budget:
                        raise LimitReached(f'budget of {args.budget:.0f} weighted calls used')
                    params = {
                        'latitude': f"{d['lat']:.4f}", 'longitude': f"{d['lon']:.4f}",
                        'hourly': ','.join(source['hourly']), 'timezone': 'Asia/Dhaka',
                        'start_date': start.isoformat(), 'end_date': end.isoformat(), **source['extra'],
                    }
                    data = fetch(source['url'], params)
                    target.write_text(json.dumps({'district': d, 'source': name, 'grid': {'lat': data['latitude'], 'lon': data['longitude']},
                                                  'hourly': data['hourly']}), encoding='utf-8')
                    spent += cost
                    fetched += 1
                    print(f"  {name:8} {d['name']:<14} {start}..{end}  (~{spent:.0f} calls used)")
                    time.sleep(args.pause)
    except LimitReached as stop:
        print(f'\nStopped early: {stop}\nRun the same command again later; finished chunks are kept.')
    print(f'\nFetched {fetched} chunks, {skipped} already cached, ~{math.ceil(spent)} weighted calls used.')


if __name__ == '__main__':
    main()
