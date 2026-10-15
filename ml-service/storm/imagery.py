"""Himawari-9 infrared frames over Bangladesh, on a fixed latitude/longitude grid.

Two sources of the same band 13 ("clean" infrared, cloud-top temperature) frames, chosen with STORM_SOURCE:
  noaa (default)  JMA's raw data on NOAA's open-data bucket (storm/himawari.py): real brightness temperatures, about 15 minutes late.
  gibs            NASA GIBS colour images through WMS in EPSG:4326 (one request returns the whole box with pixels equally spaced in
                  degrees): colours instead of temperatures, about 45-60 minutes late.
GIBS keeps only about six weeks of frames, so the demo day is kept in storm/data/ (as GIBS images). Live frames are cached in
storm/cache/ for CACHE_DAYS: the tracker needs a frame for only 20 minutes, and both sources keep them far longer.
"""
import os
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import cv2
import numpy as np

from . import himawari

SOURCE = os.environ.get('STORM_SOURCE', 'noaa').strip().lower()
CACHE_DAYS = 2

# The box covers Bangladesh plus the upstream hills (Meghalaya, Tripura) and the head of the Bay, where storms come from.
NORTH, SOUTH, WEST, EAST = 28.0, 19.0, 86.0, 95.0
SIZE = 450                               # pixels per side: 0.02 degrees, about 2.2 km, close to the sensor's 2 km
DEG_PER_PX = (NORTH - SOUTH) / SIZE
KM_PER_DEG_LAT = 111.2

HERE = Path(__file__).resolve().parent
DEMO_DIR = HERE / 'data' / 'demo-2026-09-22'
CACHE_DIR = HERE / 'cache'
WMS = ('https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap'
       '&LAYERS=Himawari_AHI_Band13_Clean_Infrared&CRS=EPSG:4326'
       f'&BBOX={SOUTH:g},{WEST:g},{NORTH:g},{EAST:g}&WIDTH={SIZE}&HEIGHT={SIZE}&FORMAT=image/png&TIME=')


def parse_time(text):
    return datetime.strptime(text.replace(':', '').replace('-', ''), '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)


def format_time(when):
    return when.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def file_name(when):
    return when.astimezone(timezone.utc).strftime('%Y-%m-%dT%H%M%SZ') + '.png'


def demo_times():
    return [format_time(parse_time(path.stem)) for path in sorted(DEMO_DIR.glob('*.png'))]


def pixel_to_lonlat(col, row):
    return WEST + (col + 0.5) * DEG_PER_PX, NORTH - (row + 0.5) * DEG_PER_PX


def km_per_px(lat):
    """Pixel size in km (x, y) at a latitude."""
    return DEG_PER_PX * KM_PER_DEG_LAT * np.cos(np.radians(lat)), DEG_PER_PX * KM_PER_DEG_LAT


def _usable(image):
    # A time GIBS does not have comes back as an empty image: no coloured (cold cloud) or grey (warm) detail at all.
    return image is not None and image.shape[:2] == (SIZE, SIZE) and int(image.std()) > 5


def load_frame(when, fetch=True, source=None):
    """The frame for a time (datetime or ISO text), or None when it is not available (yet): a BGR image from GIBS (the demo set,
    the cache or GIBS), or with source 'noaa' a 2-D grid of brightness temperatures in kelvin (the cache or NOAA)."""
    when = parse_time(when) if isinstance(when, str) else when
    return _load_noaa(when, fetch) if (source or SOURCE) == 'noaa' else _load_gibs(when, fetch)


def _load_gibs(when, fetch):
    for folder in (DEMO_DIR, CACHE_DIR):
        path = folder / file_name(when)
        if path.exists():
            image = cv2.imread(str(path), cv2.IMREAD_COLOR)
            if _usable(image):
                return image
    if not fetch:
        return None
    raw = urllib.request.urlopen(urllib.request.Request(WMS + format_time(when), headers={'User-Agent': 'AkashSathi-storm-tracker'}),
                                 timeout=60).read()
    image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if not _usable(image):
        return None
    _cache(file_name(when), raw)
    return image


def _load_noaa(when, fetch):
    # Cached as a 16-bit PNG of hundredths of a kelvin (0 = no measurement): lossless and about a third of the raw float size.
    name = file_name(when).replace('.png', '-b13.png')
    path = CACHE_DIR / name
    stored = cv2.imread(str(path), cv2.IMREAD_UNCHANGED) if path.exists() else None
    if stored is None or stored.shape != (SIZE, SIZE):
        if not fetch:
            return None
        segments = himawari.download(when)
        if segments is None:
            return None
        kelvin = himawari.to_grid(segments, NORTH, SOUTH, WEST, EAST, SIZE)
        stored = np.nan_to_num(kelvin * 100, nan=0).round().clip(0, 65535).astype(np.uint16)
        _cache(name, cv2.imencode('.png', stored)[1].tobytes())
    return np.where(stored > 0, stored / 100, np.nan).astype(np.float32)


def _cache(name, data):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / name).write_bytes(data)
    cutoff = time.time() - CACHE_DAYS * 86_400
    for old in CACHE_DIR.glob('*.png'):
        if old.stat().st_mtime < cutoff:
            old.unlink(missing_ok=True)


# The live picture under the storm outlines (BGRA). Each tracker class has the colour GIBS gives it (cyan, blue, green, yellow, red,
# dark red, colder and colder), so live and replay read alike; cloud between 0 C and the first class is grey and fades out toward
# 0 C, and anything warmer (clear ground, low cloud) is transparent so the map shows through.
CLASS_COLORS = [(230, 190, 0), (220, 90, 30), (60, 185, 50), (40, 210, 245), (35, 50, 225), (20, 10, 125)]


def render_kelvin(kelvin, edges_c):
    """PNG bytes (BGRA) of a brightness-temperature grid, classed with `edges_c` (degrees C, class 1 first)."""
    celsius = kelvin - 273.15
    out = np.zeros(kelvin.shape + (4,), np.uint8)
    cold = np.clip(celsius / edges_c[0], 0, 1)  # 0 at 0 C, 1 at the first class edge
    grey = (celsius < 0) & (celsius > edges_c[0])
    out[grey, :3] = (150 + 80 * cold[grey])[:, None].astype(np.uint8)
    out[grey, 3] = (30 + 150 * cold[grey]).astype(np.uint8)
    for level, edge in enumerate(edges_c):
        out[celsius <= edge] = (*CLASS_COLORS[level], 225)
    return cv2.imencode('.png', out)[1].tobytes()


def frames_before(when, count=3, step_minutes=10, fetch=True, source=None):
    """[(time, frame)] for `when` and the frames 10 and 20 minutes earlier, oldest first; missing frames are left out."""
    when = parse_time(when) if isinstance(when, str) else when
    out = []
    for back in range(count - 1, -1, -1):
        at = when - timedelta(minutes=back * step_minutes)
        frame = load_frame(at, fetch=fetch, source=source)
        if frame is not None:
            out.append((at, frame))
    return out
