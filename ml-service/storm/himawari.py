"""Himawari-9 band 13 brightness temperatures over the storm box, from JMA's raw data on NOAA's open-data bucket.

NASA GIBS publishes a coloured image of each 10-minute frame about 45-60 minutes after the scan starts; the raw files ("Himawari
Standard Data", HSD) reach NOAA's bucket about 12-15 minutes after it, and carry real temperatures instead of colours. A full-disk
band is cut into ten segments north to south; segments 3 and 4 (lines 1101-2200 of 5500 at 2 km) cover the whole box, so a frame
costs about 5.5 MB of download. Each segment is decoded as JMA's "Himawari Standard Data User's Guide" describes (header blocks,
then 16-bit counts), calibrated to brightness temperature, and resampled to the same latitude/longitude grid as the GIBS frames
(imagery.NORTH..EAST, SIZE x SIZE), so the tracker works on either.

Data: JMA Himawari-9, accessed from https://registry.opendata.aws/noaa-himawari (NOAA Open Data Dissemination). NOAA and JMA ask
for attribution and do not endorse this project.
"""
import bz2
import struct
import urllib.error
import urllib.request

import cv2
import numpy as np

BUCKET = 'https://noaa-himawari9.s3.amazonaws.com'
SEGMENTS = (3, 4)
ERROR_COUNTS = 65534  # 65535 = error pixel, 65534 = outside the scan area


def segment_url(when, segment):
    return (f'{BUCKET}/AHI-L1b-FLDK/{when:%Y/%m/%d/%H%M}/'
            f'HS_H09_{when:%Y%m%d_%H%M}_B13_FLDK_R20_S{segment:02d}10.DAT.bz2')


# ---------- one segment file ----------
def parse_segment(raw):
    """{'kelvin': lines x columns float32 (NaN where there is no measurement), 'first_line': 1-based full-disk line, 'proj': {...}}."""
    order = '<' if raw[5] == 0 else '>'
    read = lambda fmt, block, offset: struct.unpack_from(order + fmt, block, offset)[0]

    # Header blocks 1-9 each start with their number (1 byte) and length (2 bytes); block 1 gives the total header length.
    blocks, at = {}, 0
    for _ in range(9):
        number, length = raw[at], read('H', raw, at + 1)
        blocks[number] = raw[at:at + length]
        at += length
    basic, info, proj, cal, seg = blocks[1], blocks[2], blocks[3], blocks[5], blocks[7]

    columns, lines = read('H', info, 5), read('H', info, 7)
    counts = np.frombuffer(raw, dtype=np.dtype(np.uint16).newbyteorder(order), count=lines * columns, offset=read('I', basic, 70))
    counts = counts.reshape(lines, columns)

    # Count -> radiance (W m-2 sr-1 um-1) -> effective brightness temperature (Planck) -> brightness temperature (JMA's correction).
    wavelength = read('d', cal, 5) * 1e-6
    gain, offset = read('d', cal, 19), read('d', cal, 27)
    c0, c1, c2 = read('d', cal, 35), read('d', cal, 43), read('d', cal, 51)
    c, h, k = read('d', cal, 83), read('d', cal, 91), read('d', cal, 99)
    radiance = counts.astype(np.float64) * gain + offset
    valid = (counts < ERROR_COUNTS) & (radiance > 0)
    radiance = np.where(valid, radiance, np.nan)
    effective = (h * c / (k * wavelength)) / np.log(1 + 2 * h * c ** 2 / (radiance * 1e6 * wavelength ** 5))
    kelvin = (c0 + c1 * effective + c2 * effective ** 2).astype(np.float32)

    return {
        'kelvin': kelvin,
        'first_line': read('H', seg, 5),
        'proj': {
            'sub_lon': read('d', proj, 3), 'cfac': read('I', proj, 11), 'lfac': read('I', proj, 15),
            'coff': read('f', proj, 19), 'loff': read('f', proj, 23), 'rs': read('d', proj, 27), 'rpol': read('d', proj, 43),
            'e2': read('d', proj, 51), 'rpol2_req2': read('d', proj, 59),
        },
    }


# ---------- geometry ----------
def fulldisk_position(lat, lon, proj):
    """(column, line) in the full-disk image, 1-based and fractional, for latitudes and longitudes in degrees (the normalized
    geostationary projection of the HSD guide)."""
    lam = np.radians(np.asarray(lon, dtype=np.float64) - proj['sub_lon'])
    c_lat = np.arctan(proj['rpol2_req2'] * np.tan(np.radians(np.asarray(lat, dtype=np.float64))))
    rl = proj['rpol'] / np.sqrt(1 - proj['e2'] * np.cos(c_lat) ** 2)
    r1 = proj['rs'] - rl * np.cos(c_lat) * np.cos(lam)
    r2 = -rl * np.cos(c_lat) * np.sin(lam)
    r3 = rl * np.sin(c_lat)
    rn = np.sqrt(r1 ** 2 + r2 ** 2 + r3 ** 2)
    x, y = np.degrees(np.arctan(-r2 / r1)), np.degrees(np.arcsin(-r3 / rn))
    return proj['coff'] + x * proj['cfac'] / 2 ** 16, proj['loff'] + y * proj['lfac'] / 2 ** 16


def to_grid(segments, north, south, west, east, size):
    """Brightness temperatures (K, float32, size x size) on a latitude/longitude grid, from consecutive segments (north first)."""
    stack = np.vstack([segment['kelvin'] for segment in segments])
    first_line, proj = segments[0]['first_line'], segments[0]['proj']
    step = (north - south) / size
    lon, lat = np.meshgrid(west + (np.arange(size) + 0.5) * step, north - (np.arange(size) + 0.5) * step)
    column, line = fulldisk_position(lat, lon, proj)
    # Array index = full-disk number - 1 for columns, - first line for rows; whole numbers are pixel centres.
    map_x, map_y = (column - 1).astype(np.float32), (line - first_line).astype(np.float32)
    return cv2.remap(stack, map_x, map_y, interpolation=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=np.nan)


# ---------- download ----------
def download(when, timeout=60):
    """Decoded segments for a frame time, or None when NOAA does not have all of them (yet)."""
    segments = []
    for number in SEGMENTS:
        try:
            raw = urllib.request.urlopen(urllib.request.Request(segment_url(when, number), headers={'User-Agent': 'AkashSathi-storm-tracker'}),
                                         timeout=timeout).read()
        except urllib.error.HTTPError as error:
            if error.code in (403, 404):  # the public bucket answers 403 or 404 for a file that does not exist
                return None
            raise
        segments.append(parse_segment(bz2.decompress(raw)))
    return segments
