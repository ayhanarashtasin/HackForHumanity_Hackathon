"""Honest check of the storm tracker on the saved demo day (2026-09-22, 13:00-18:00 Bangladesh time).

For every cell with motion at time t, where was it really at t + 60 minutes? The answer must not use the tracker's own motion, so a
cell is followed frame by frame (10 minutes apart) through the strong cell it overlaps most. Then:
  * tracker error     = distance from the projected position to the real position at t + 60
  * persistence error = distance from the position at t to the real position ("the storm stays where it is")
Both use apparent (not parallax-corrected) positions: the parallax shift is the same at both ends and cancels.

Usage (from ml-service/): .venv/Scripts/python -m storm.validate [gibs|noaa]
  gibs (default)  the saved GIBS images in storm/data/; writes reports/storm_validation.json
  noaa            the same times from NOAA's raw data (downloaded, about 175 MB); writes reports/storm_validation_noaa.json
Prints a summary.
"""
import json
import sys
from datetime import timedelta
from pathlib import Path

import numpy as np

from . import imagery, tracker

STEP = timedelta(minutes=10)
AHEAD = 6  # 6 x 10 minutes = 60 minutes


def follow(mask, grids):
    """The cell's mask after following it through `grids` by largest overlap, or None if it was lost."""
    import cv2
    for grid in grids:
        reach = cv2.dilate(mask, np.ones((5, 5), np.uint8)) == 1
        best, best_overlap = None, 0
        for cell in tracker.detect_cells(grid):
            overlap = int((reach & (cell['mask'] == 1)).sum())
            if overlap > best_overlap:
                best, best_overlap = cell, overlap
        if best is None:
            return None
        mask = best['mask']
    return mask


def centroid(mask):
    rows, cols = np.nonzero(mask)
    lon, lat = imagery.pixel_to_lonlat(cols.mean(), rows.mean())
    return lat, lon


def main(source='gibs'):
    times = [imagery.parse_time(t) for t in imagery.demo_times()]
    frames = {when: imagery.load_frame(when, fetch=source == 'noaa', source=source) for when in times}
    grids = {when: tracker.intensity(frame) for when, frame in frames.items() if frame is not None}
    rows = []
    for when in times:
        future = [when + STEP * k for k in range(1, AHEAD + 1)]
        if when - 2 * STEP not in grids or any(t not in grids for t in future):
            continue
        flow = tracker.flow_back(grids[when], grids[when - 2 * STEP])
        for cell in tracker.detect_cells(grids[when])[:40]:
            motion = tracker.cell_motion(cell, flow, 20)
            if motion is None:
                continue
            end = follow(cell['mask'], [grids[t] for t in future])
            if end is None:
                continue
            real = centroid(end)
            start = cell['center']
            moved = tracker.destination(start[0], start[1], motion['bearing_deg'], motion['speed_kmh'])
            rows.append({
                'time': imagery.format_time(when), 'areaKm2': round(cell['area_km2']), 'speedKmh': round(motion['speed_kmh'], 1),
                'trackerErrorKm': round(float(tracker.haversine_km(moved[0], moved[1], *real)), 1),
                'persistenceErrorKm': round(float(tracker.haversine_km(start[0], start[1], *real)), 1),
            })

    tracker_err = np.array([r['trackerErrorKm'] for r in rows])
    persist_err = np.array([r['persistenceErrorKm'] for r in rows])
    # Cells that really moved more than 10 km are where a direction matters; tiny moves are mostly growth and shrinkage.
    moving = persist_err > 10
    summary = {
        'day': '2026-09-22 13:00-18:00 Bangladesh time (Himawari-9 band 13 via ' + ('NOAA, raw temperatures' if source == 'noaa' else 'NASA GIBS') + ')',
        'horizonMinutes': 60,
        'cases': len(rows),
        'trackerMedianKm': round(float(np.median(tracker_err)), 1),
        'persistenceMedianKm': round(float(np.median(persist_err)), 1),
        'trackerMeanKm': round(float(tracker_err.mean()), 1),
        'persistenceMeanKm': round(float(persist_err.mean()), 1),
        'trackerBetterShare': round(float((tracker_err < persist_err).mean()), 3),
        'movingCases': int(moving.sum()),
        'movingTrackerMedianKm': round(float(np.median(tracker_err[moving])), 1) if moving.any() else None,
        'movingPersistenceMedianKm': round(float(np.median(persist_err[moving])), 1) if moving.any() else None,
        'movingTrackerBetterShare': round(float((tracker_err[moving] < persist_err[moving]).mean()), 3) if moving.any() else None,
    }
    out = Path(__file__).resolve().parents[1] / 'reports' / ('storm_validation_noaa.json' if source == 'noaa' else 'storm_validation.json')
    out.write_text(json.dumps({'summary': summary, 'cases': rows}, indent=2), encoding='utf-8')
    for key, value in summary.items():
        print(f'{key}: {value}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'gibs')
