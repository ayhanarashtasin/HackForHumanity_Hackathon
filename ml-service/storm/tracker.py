"""Storm-cell detection, motion and short projection from Himawari infrared frames.

1. Colour -> intensity class. The GIBS band-13 palette is grey for warm surfaces and ordinary cloud, then cyan, blue, green, yellow,
   red and dark red as cloud tops get colder; tall thunderstorm tops are the coldest. Classes are ordinal (1 = cyan ... 6 = dark red),
   not degrees: GIBS publishes no colour table for this layer.
2. Cells = connected areas of class >= 4 (yellow and colder), larger than MIN_AREA_KM2.
3. Motion = dense optical flow (Farneback) from the current frame back to the frame 10-20 minutes earlier, averaged over each cell.
4. Parallax: Himawari-9 sits over 140.7 E and sees Bangladesh at about 62 degrees from vertical, so a 12 km cloud top appears about
   20-25 km away from the satellite. Positions are moved back toward the satellite by that amount.
5. Projection: straight-line motion for 30 / 60 / 90 minutes, with a circle that widens with distance, and the upazilas inside it.

This is an experimental nowcast of where cold cloud tops are heading. It does not observe lightning.
"""
import json
import math
from pathlib import Path

import cv2
import numpy as np

from .imagery import SIZE, format_time, km_per_px, pixel_to_lonlat

EARTH_KM = 6378.137
SATELLITE_KM = 42164.16
SATELLITE_LON = 140.7          # Himawari-9 sub-satellite longitude
CLOUD_TOP_KM = 12.0            # assumed height of a thunderstorm top, for the parallax correction
MIN_CLASS = 4                  # yellow and colder
MIN_AREA_KM2 = 200
MAX_SPEED_KMH = 120
HORIZONS = (30, 60, 90)
LABELS = {4: 'strong', 5: 'severe', 6: 'extreme'}
COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
LOCATIONS_FILE = Path(__file__).resolve().parents[2] / 'server' / 'data' / 'locations.json'


# ---------- colour -> intensity ----------
def intensity(image):
    """uint8 grid of classes 0-6 for a BGR frame."""
    spread = image.max(axis=2).astype(int) - image.min(axis=2)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue, value = hsv[..., 0].astype(int), hsv[..., 2].astype(int)
    coloured = spread > 60
    red = (hue < 12) | (hue >= 160)
    grid = np.zeros(image.shape[:2], np.uint8)
    grid[coloured & (hue >= 80) & (hue < 100)] = 1                 # cyan
    grid[coloured & (hue >= 100) & (hue < 160)] = 2                # blue
    grid[coloured & (hue >= 40) & (hue < 80)] = 3                  # green
    grid[coloured & (hue >= 12) & (hue < 40)] = 4                  # yellow, orange
    grid[coloured & red & (value >= 140)] = 5                      # red
    grid[coloured & red & (value < 140)] = 6                       # dark red
    # The very coldest tops run past the end of the palette and turn grey again: grey enclosed by red counts as the coldest class.
    core = cv2.morphologyEx((grid >= 5).astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    grid[(core == 1) & (grid == 0)] = 6
    return grid


# ---------- geometry ----------
def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371.0 * np.arcsin(np.sqrt(a))


def destination(lat, lon, bearing_deg, distance_km):
    d, b, p1, l1 = distance_km / 6371.0, math.radians(bearing_deg), math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def bearing(lat1, lon1, lat2, lon2):
    p1, p2, dl = math.radians(lat1), math.radians(lat2), math.radians(lon2 - lon1)
    return (math.degrees(math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))) + 360) % 360


def parallax_shift(lat, lon, height_km=CLOUD_TOP_KM):
    """(distance_km, bearing_deg) to move an apparent cloud-top position to the ground point under it."""
    phi, lam, lam_s = math.radians(lat), math.radians(lon), math.radians(SATELLITE_LON)
    point = EARTH_KM * np.array([math.cos(phi) * math.cos(lam), math.cos(phi) * math.sin(lam), math.sin(phi)])
    sat = SATELLITE_KM * np.array([math.cos(lam_s), math.sin(lam_s), 0.0])
    look = sat - point
    zenith = math.acos(float(look @ point) / (np.linalg.norm(look) * EARTH_KM))
    return height_km * math.tan(zenith), bearing(lat, lon, 0.0, SATELLITE_LON)


def compass(degrees):
    return COMPASS[round(degrees / 45) % 8]


# ---------- cells ----------
def detect_cells(grid):
    """[{mask, pixels, center, area_km2, max_class, extreme_share}] for the strong cells of one frame, largest first."""
    mask = (grid >= MIN_CLASS).astype(np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    count, labels = cv2.connectedComponents(mask, connectivity=8)
    cells = []
    for label in range(1, count):
        component = labels == label
        rows, cols = np.nonzero(component)
        lat = 28.0 - (rows.mean() + 0.5) * (9.0 / SIZE)
        kx, ky = km_per_px(lat)
        area = len(rows) * kx * ky
        if area < MIN_AREA_KM2:
            continue
        lon_c, lat_c = pixel_to_lonlat(cols.mean(), rows.mean())
        classes = grid[component]
        cells.append({
            'mask': component.astype(np.uint8), 'pixels': len(rows), 'center': (lat_c, lon_c), 'area_km2': area,
            'max_class': int(classes.max()), 'extreme_share': float((classes >= 6).mean()),
        })
    return sorted(cells, key=lambda cell: -cell['area_km2'])


def polygon(mask, shift):
    """Outline of a cell mask as [[lon, lat], ...], moved by the parallax shift (dlat, dlon)."""
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    outline = cv2.approxPolyDP(max(contours, key=cv2.contourArea), 1.2, True)[:, 0, :]
    ring = []
    for col, row in outline:
        lon, lat = pixel_to_lonlat(col - 0.5, row - 0.5)
        ring.append([round(lon + shift[1], 4), round(lat + shift[0], 4)])
    if ring and ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring


# ---------- motion ----------
def flow_back(current, earlier):
    """Per-pixel displacement (dx, dy) in pixels from each current pixel to where it was in the earlier frame."""
    prep = lambda grid: cv2.GaussianBlur((grid.astype(np.float32) * 40).clip(0, 255).astype(np.uint8), (5, 5), 0)
    return cv2.calcOpticalFlowFarneback(prep(current), prep(earlier), None, 0.5, 3, 21, 3, 7, 1.5, 0)


def cell_motion(cell, flow, minutes):
    """{speed_kmh, bearing_deg, dx_px, dy_px} of a cell from the backward flow over `minutes`, or None when it is not credible."""
    inside = cell['mask'] == 1
    dx, dy = -float(flow[..., 0][inside].mean()), -float(flow[..., 1][inside].mean())
    kx, ky = km_per_px(cell['center'][0])
    east, north = dx * kx * 60 / minutes, -dy * ky * 60 / minutes
    speed = math.hypot(east, north)
    if speed > MAX_SPEED_KMH:
        return None
    return {'speed_kmh': speed, 'bearing_deg': (math.degrees(math.atan2(east, north)) + 360) % 360, 'dx_px': dx, 'dy_px': dy}


def cell_trend(cell, earlier_grid, motion):
    """growing / steady / weakening: the cell's strong area now against the same area, moved back along its motion, earlier."""
    if motion is None:
        return None
    back = np.float32([[1, 0, -motion['dx_px']], [0, 1, -motion['dy_px']]])
    where = cv2.warpAffine(cell['mask'], back, (SIZE, SIZE), flags=cv2.INTER_NEAREST)
    where = cv2.dilate(where, np.ones((5, 5), np.uint8)) == 1
    before = int(((earlier_grid >= MIN_CLASS) & where).sum())
    ratio = cell['pixels'] / max(before, 1)
    return 'growing' if ratio > 1.2 else ('weakening' if ratio < 0.8 else 'steady')


# ---------- places ----------
_locations = None


def locations():
    global _locations
    if _locations is None:
        data = json.loads(LOCATIONS_FILE.read_text(encoding='utf-8'))
        rows = data['locations']
        _locations = {
            'rows': [{'pcode': r['pcode'], 'name': r['name'], 'nameBn': r.get('nameBn'), 'district': r.get('district')} for r in rows],
            'lat': np.array([r['lat'] for r in rows]), 'lon': np.array([r['lon'] for r in rows]),
        }
    return _locations


def projected(center, motion, minutes, radius_km):
    """(lat, lon, radius_km) after `minutes` of straight-line motion; the circle widens by a quarter of the distance travelled."""
    distance = motion['speed_kmh'] * minutes / 60 if motion else 0.0
    lat, lon = destination(center[0], center[1], motion['bearing_deg'], distance) if motion else center
    return lat, lon, radius_km + 5 + 0.25 * distance


def reaches(center, motion, radius_km, horizon=90, step=5, limit=40):
    """Upazilas inside the cell now (eta 0) or inside its projected circle within `horizon` minutes, soonest first."""
    places = locations()
    eta = np.full(len(places['rows']), np.inf)
    for minutes in range(0, horizon + 1, step if motion else horizon + 1):
        lat, lon, radius = projected(center, motion, minutes, radius_km)
        hit = (haversine_km(places['lat'], places['lon'], lat, lon) <= radius) & np.isinf(eta)
        eta[hit] = minutes
    order = [i for i in np.argsort(eta) if np.isfinite(eta[i])][:limit]
    return [{**places['rows'][i], 'etaMin': int(eta[i])} for i in order]


# ---------- one snapshot ----------
def snapshot(frames, source='live'):
    """Cells, motion and projection for the newest of `frames` ([(time, BGR image)], oldest first)."""
    if not frames:
        return {'source': source, 'observedAt': None, 'frames': [], 'cells': [], 'note': 'no-frames'}
    times = [when for when, _ in frames]
    grids = [intensity(image) for _, image in frames]
    current, earlier = grids[-1], grids[0] if len(grids) > 1 else None
    minutes = (times[-1] - times[0]).total_seconds() / 60 if earlier is not None else 0
    flow = flow_back(current, earlier) if earlier is not None and minutes > 0 else None

    cells = []
    for index, cell in enumerate(detect_cells(current)[:40], start=1):
        motion = cell_motion(cell, flow, minutes) if flow is not None else None
        apparent = cell['center']
        shift_km, shift_bearing = parallax_shift(*apparent)
        ground = destination(apparent[0], apparent[1], shift_bearing, shift_km)
        delta = (ground[0] - apparent[0], ground[1] - apparent[1])
        radius = math.sqrt(cell['area_km2'] / math.pi)
        cells.append({
            'id': f'c{index}',
            'center': {'lat': round(ground[0], 4), 'lon': round(ground[1], 4)},
            'apparentCenter': {'lat': round(apparent[0], 4), 'lon': round(apparent[1], 4)},
            'areaKm2': round(cell['area_km2']),
            'radiusKm': round(radius, 1),
            'intensity': cell['max_class'],
            'intensityLabel': LABELS.get(cell['max_class'], 'strong'),
            'extremeShare': round(cell['extreme_share'], 3),
            'trend': cell_trend(cell, earlier, motion) if earlier is not None else None,
            'motion': None if motion is None else {
                'speedKmh': round(motion['speed_kmh'], 1), 'bearingDeg': round(motion['bearing_deg']),
                'towards': compass(motion['bearing_deg']),
            },
            'polygon': polygon(cell['mask'], delta),
            'forecast': [
                {'minutes': m, 'lat': round(p[0], 4), 'lon': round(p[1], 4), 'radiusKm': round(p[2], 1)}
                for m in HORIZONS for p in [projected(ground, motion, m, radius)]
            ] if motion else [],
            'reaches': reaches(ground, motion, radius),
        })

    return {
        'source': source,
        'observedAt': format_time(times[-1]),
        'frames': [format_time(when) for when in times],
        'motionMinutes': round(minutes),
        'assumptions': {'cloudTopKm': CLOUD_TOP_KM, 'minClass': MIN_CLASS, 'minAreaKm2': MIN_AREA_KM2},
        'cells': cells,
    }
