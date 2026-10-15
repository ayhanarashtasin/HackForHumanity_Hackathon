"""Raw Himawari (HSD) reader checks on small synthetic segment files, and NOAA temperature frames in the tracker.

Run (from ml-service/): .venv/Scripts/python -m unittest discover tests
"""
import math
import struct
import unittest
from datetime import datetime, timedelta, timezone

import numpy as np

from storm import himawari, imagery, tracker

C, H, K = 2.99792458e8, 6.62606957e-34, 1.3806488e-23
WAVELENGTH_UM = 10.4
# Nominal 2 km full-disk projection of Himawari-9.
PROJ = {'sub_lon': 140.7, 'cfac': 20466275, 'lfac': 20466275, 'coff': 2750.5, 'loff': 2750.5, 'rs': 42164.0, 'req': 6378.137,
        'rpol': 6356.7523, 'e2': 0.00669438444, 'rpol2_req2': 0.993305616, 'req2_rpol2': 1.006739501}


def radiance_um(kelvin):
    """Planck radiance (W m-2 sr-1 um-1) at the band's central wavelength."""
    wavelength = WAVELENGTH_UM * 1e-6
    return 2 * H * C ** 2 / wavelength ** 5 / (math.exp(H * C / (wavelength * K * kelvin)) - 1) / 1e6


def block(number, size, fields=()):
    """A header block: number, 2-byte length, then (format, offset, value) fields; little-endian."""
    data = bytearray(size)
    data[0] = number
    struct.pack_into('<H', data, 1, size)
    for fmt, offset, value in fields:
        struct.pack_into('<' + fmt, data, offset, value)
    return bytes(data)


def segment_file(counts, first_line, gain, offset=0.0):
    """A minimal HSD segment: header blocks 1-9 at the guide's offsets, then the counts."""
    lines, columns = counts.shape
    blocks = [
        None,
        block(2, 50, [('H', 3, 16), ('H', 5, columns), ('H', 7, lines)]),
        block(3, 127, [('d', 3, PROJ['sub_lon']), ('I', 11, PROJ['cfac']), ('I', 15, PROJ['lfac']), ('f', 19, PROJ['coff']),
                       ('f', 23, PROJ['loff']), ('d', 27, PROJ['rs']), ('d', 35, PROJ['req']), ('d', 43, PROJ['rpol']),
                       ('d', 51, PROJ['e2']), ('d', 59, PROJ['rpol2_req2']), ('d', 67, PROJ['req2_rpol2'])]),
        block(4, 3),
        block(5, 147, [('H', 3, 13), ('d', 5, WAVELENGTH_UM), ('H', 13, 14), ('H', 15, 65535), ('H', 17, 65534), ('d', 19, gain),
                       ('d', 27, offset), ('d', 35, 0.0), ('d', 43, 1.0), ('d', 51, 0.0), ('d', 83, C), ('d', 91, H), ('d', 99, K)]),
        block(6, 3),
        block(7, 47, [('B', 3, 10), ('B', 4, 3), ('H', 5, first_line)]),
        block(8, 3),
        block(9, 3),
    ]
    header_length = 282 + sum(len(b) for b in blocks[1:])
    blocks[0] = block(1, 282, [('H', 3, 11), ('I', 70, header_length), ('I', 74, counts.size * 2)])
    return b''.join(blocks) + counts.astype('<u2').tobytes()


class HimawariReaderTest(unittest.TestCase):
    def test_counts_become_brightness_temperatures(self):
        gain = radiance_um(220.0) / 5000                          # count 5000 is exactly a 220 K scene
        counts = np.array([[5000, 65535], [65534, 5000]], np.uint16)
        segment = himawari.parse_segment(segment_file(counts, 1101, gain))
        self.assertAlmostEqual(float(segment['kelvin'][0, 0]), 220.0, places=3)
        self.assertTrue(np.isnan(segment['kelvin'][0, 1]), 'error pixel')
        self.assertTrue(np.isnan(segment['kelvin'][1, 0]), 'outside the scan')
        self.assertEqual(segment['first_line'], 1101)
        self.assertAlmostEqual(segment['proj']['sub_lon'], 140.7)
        self.assertEqual(segment['proj']['cfac'], 20466275)

    def test_colder_scenes_read_colder(self):
        gain = radiance_um(300.0) / 10000
        counts = np.array([[int(radiance_um(t) / gain) for t in (200, 250, 300)]], np.uint16)
        kelvin = himawari.parse_segment(segment_file(counts, 1101, gain))['kelvin'][0]
        np.testing.assert_allclose(kelvin, [200, 250, 300], atol=0.05)

    def test_sub_satellite_point_is_the_image_centre(self):
        column, line = himawari.fulldisk_position(0.0, 140.7, PROJ)
        self.assertAlmostEqual(float(column), 2750.5, places=6)
        self.assertAlmostEqual(float(line), 2750.5, places=6)
        north_west = himawari.fulldisk_position(10.0, 130.0, PROJ)
        self.assertLess(float(north_west[0]), 2750.5, 'west is to the left')
        self.assertLess(float(north_west[1]), 2750.5, 'north is up')

    def test_segments_3_and_4_cover_the_storm_box(self):
        lats = np.array([imagery.NORTH, imagery.NORTH, imagery.SOUTH, imagery.SOUTH, (imagery.NORTH + imagery.SOUTH) / 2])
        lons = np.array([imagery.WEST, imagery.EAST, imagery.WEST, imagery.EAST, imagery.EAST])
        _, lines = himawari.fulldisk_position(lats, lons, PROJ)
        first, last = (himawari.SEGMENTS[0] - 1) * 550 + 1, himawari.SEGMENTS[-1] * 550
        self.assertTrue(((lines > first + 50) & (lines < last - 50)).all(), lines)

    def test_grid_samples_the_right_pixel(self):
        # Values that are the full-disk column (and line) number, so the grid must give back each grid point's own position.
        size, columns = 40, 1000
        sections = [(1101, 550), (1651, 550)]
        by_column = [np.tile(np.arange(1, columns + 1, dtype=np.float32), (lines, 1)) for _, lines in sections]
        by_line = [np.repeat(np.arange(first, first + lines, dtype=np.float32)[:, None], columns, axis=1) for first, lines in sections]
        north, south, west, east = 28.0, 19.0, 86.0, 95.0
        step = (north - south) / size
        lon, lat = np.meshgrid(west + (np.arange(size) + 0.5) * step, north - (np.arange(size) + 0.5) * step)
        column, line = himawari.fulldisk_position(lat, lon, PROJ)
        for values, expected in ((by_column, column), (by_line, line)):
            segments = [{'kelvin': v, 'first_line': first, 'proj': PROJ} for v, (first, _) in zip(values, sections)]
            grid = himawari.to_grid(segments, north, south, west, east, size)
            np.testing.assert_allclose(grid, expected, atol=0.01)

    def test_segment_url(self):
        when = datetime(2026, 9, 22, 8, 0, tzinfo=timezone.utc)
        self.assertEqual(himawari.segment_url(when, 3), 'https://noaa-himawari9.s3.amazonaws.com/AHI-L1b-FLDK/2026/09/22/0800/'
                                                       'HS_H09_20260922_0800_B13_FLDK_R20_S0310.DAT.bz2')


class KelvinFramesTest(unittest.TestCase):
    def kelvin_frame(self, center_px):
        """A warm (15 C) frame with one storm: -60 C ring around a -75 C core."""
        frame = np.full((imagery.SIZE, imagery.SIZE), 288.15, np.float32)
        rows, cols = np.ogrid[:imagery.SIZE, :imagery.SIZE]
        distance = np.hypot(cols - center_px[0], rows - center_px[1])
        frame[distance <= 14] = 213.15
        frame[distance <= 9] = 198.15
        return frame

    def test_temperature_classes(self):
        grid = tracker.intensity(self.kelvin_frame((200, 200)))
        self.assertEqual(int(grid[200, 200]), 6, '-75 C is the coldest class')
        self.assertEqual(int(grid[200, 212]), 4, '-60 C is class 4')
        self.assertEqual(int(grid[10, 10]), 0)
        edges = tracker.intensity(np.array([[c + 273.15 for c in (-26.9, -27.0, -58.0, -72.0, np.nan)]], np.float32))
        self.assertEqual(edges[0].tolist(), [0, 1, 4, 6, 0])

    def test_snapshot_reports_the_coldest_cloud_top(self):
        start = datetime(2026, 9, 22, 9, 0, tzinfo=timezone.utc)
        frames = [(start + timedelta(minutes=10 * i), self.kelvin_frame((200 + 4 * i, 200))) for i in range(3)]
        snap = tracker.snapshot(frames, 'test')
        self.assertEqual(len(snap['cells']), 1)
        self.assertAlmostEqual(snap['cells'][0]['minTempC'], -75.0, places=1)
        self.assertEqual(snap['assumptions']['imagery'], 'noaa')
        self.assertEqual(snap['assumptions']['minTempC'], -58)
        self.assertIsNotNone(snap['cells'][0]['motion'])


if __name__ == '__main__':
    unittest.main()
