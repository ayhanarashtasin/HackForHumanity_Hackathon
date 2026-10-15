"""Himawari-9 infrared frames over Bangladesh, as images on a fixed latitude/longitude grid.

NASA GIBS serves Himawari AHI band 13 ("clean" infrared, cloud-top temperature) through WMS in EPSG:4326, so one request returns one
image for the whole box with pixels equally spaced in degrees. GIBS keeps only about six weeks of frames, so the demo day is kept
in storm/data/ and every live frame is cached in storm/cache/.
"""
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import cv2
import numpy as np

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


def load_frame(when, fetch=True):
    """BGR image for a time (datetime or ISO text), from the demo set, the cache or GIBS. None when the time is not available."""
    when = parse_time(when) if isinstance(when, str) else when
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
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    (CACHE_DIR / file_name(when)).write_bytes(raw)
    return image


def frames_before(when, count=3, step_minutes=10, fetch=True):
    """[(time, image)] for `when` and the frames 10 and 20 minutes earlier, oldest first; missing frames are left out."""
    when = parse_time(when) if isinstance(when, str) else when
    out = []
    for back in range(count - 1, -1, -1):
        at = when - timedelta(minutes=back * step_minutes)
        image = load_frame(at, fetch=fetch)
        if image is not None:
            out.append((at, image))
    return out
