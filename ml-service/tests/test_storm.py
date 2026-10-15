"""Storm tracker checks on synthetic frames, where the true movement is known.

Run (from ml-service/): .venv/Scripts/python -m unittest discover tests
"""
import math
import unittest
from datetime import datetime, timedelta, timezone

import cv2
import numpy as np

from storm import imagery, tracker

GREY = (128, 128, 128)
DARK_RED = (0, 0, 110)     # BGR: the palette's coldest class
YELLOW = (0, 220, 240)


def frame(center_px, radius_px=14):
    """A grey (warm) frame with one storm: a yellow ring around a dark red core."""
    image = np.full((imagery.SIZE, imagery.SIZE, 3), GREY, np.uint8)
    cv2.circle(image, center_px, radius_px, YELLOW, -1)
    cv2.circle(image, center_px, radius_px - 5, DARK_RED, -1)
    return image


class TrackerTest(unittest.TestCase):
    def test_colour_classes(self):
        grid = tracker.intensity(frame((200, 200)))
        self.assertEqual(int(grid[200, 200]), 6, 'dark red core is the coldest class')
        self.assertEqual(int(grid[200, 200 + 12]), 4, 'yellow ring is class 4')
        self.assertEqual(int(grid[10, 10]), 0, 'grey is not a storm')

    def test_detects_one_cell(self):
        cells = tracker.detect_cells(tracker.intensity(frame((200, 200))))
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0]['max_class'], 6)

    def test_motion_direction_and_speed(self):
        # 8 pixels east and 4 pixels south in 20 minutes.
        start = datetime(2026, 9, 22, 9, 0, tzinfo=timezone.utc)
        frames = [(start, frame((200, 200))), (start + timedelta(minutes=10), frame((204, 202))), (start + timedelta(minutes=20), frame((208, 204)))]
        snap = tracker.snapshot(frames, 'test')
        self.assertEqual(len(snap['cells']), 1)
        motion = snap['cells'][0]['motion']
        self.assertIsNotNone(motion)

        lat = imagery.pixel_to_lonlat(208, 204)[1]
        kx, ky = imagery.km_per_px(lat)
        east, north = 8 * kx * 3, -4 * ky * 3                     # km per hour
        expected_speed = math.hypot(east, north)
        expected_bearing = (math.degrees(math.atan2(east, north)) + 360) % 360
        self.assertAlmostEqual(motion['speedKmh'], expected_speed, delta=expected_speed * 0.3)
        self.assertLess(abs((motion['bearingDeg'] - expected_bearing + 180) % 360 - 180), 20)

    def test_parallax_moves_toward_the_satellite(self):
        distance, bearing = tracker.parallax_shift(23.8, 90.4)
        self.assertTrue(15 < distance < 30, distance)
        self.assertTrue(90 < bearing < 130, bearing)               # east-southeast, toward 0 N 140.7 E

    def test_projection_and_upazilas(self):
        center = (23.81, 90.41)                                    # Dhaka
        motion = {'speed_kmh': 30.0, 'bearing_deg': 90.0}
        lat, lon, radius = tracker.projected(center, motion, 60, 10)
        self.assertAlmostEqual(float(tracker.haversine_km(center[0], center[1], lat, lon)), 30, delta=0.5)
        self.assertGreater(radius, 10)
        reached = tracker.reaches(center, motion, 10)
        self.assertTrue(reached and reached[0]['etaMin'] == 0, 'the cell is over Dhaka now')
        self.assertEqual(sorted(r['etaMin'] for r in reached), [r['etaMin'] for r in reached], 'soonest first')

    def test_no_frames_and_no_storms(self):
        self.assertEqual(tracker.snapshot([], 'test')['cells'], [])
        quiet = np.full((imagery.SIZE, imagery.SIZE, 3), GREY, np.uint8)
        start = datetime(2026, 10, 1, tzinfo=timezone.utc)
        self.assertEqual(tracker.snapshot([(start, quiet), (start + timedelta(minutes=10), quiet)], 'test')['cells'], [])


if __name__ == '__main__':
    unittest.main()
