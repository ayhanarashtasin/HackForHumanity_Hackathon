// NWS heat index (Rothfusz regression with its published adjustments). Input: °C and % relative humidity.
// This is a computed apparent-temperature estimate, not an on-site WBGT measurement.
export function heatIndexC(tempC, relativeHumidity) {
  if (!Number.isFinite(tempC) || !Number.isFinite(relativeHumidity)) return null;

  const t = (tempC * 9) / 5 + 32;
  const rh = Math.min(100, Math.max(0, relativeHumidity));

  let hi = 0.5 * (t + 61 + (t - 68) * 1.2 + rh * 0.094);

  if ((hi + t) / 2 >= 80) {
    hi = -42.379 + 2.04901523 * t + 10.14333127 * rh - 0.22475541 * t * rh
      - 0.00683783 * t * t - 0.05481717 * rh * rh + 0.00122874 * t * t * rh
      + 0.00085282 * t * rh * rh - 0.00000199 * t * t * rh * rh;

    if (rh < 13 && t >= 80 && t <= 112) {
      hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
    } else if (rh > 85 && t >= 80 && t <= 87) {
      hi += ((rh - 85) / 10) * ((87 - t) / 5);
    }
  }

  // Below roughly 27 °C the index carries no extra heat signal, so never report less than the air temperature.
  return ((Math.max(hi, t) - 32) * 5) / 9;
}
