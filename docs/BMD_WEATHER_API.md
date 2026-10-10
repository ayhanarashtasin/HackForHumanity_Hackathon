# BMD and Xweather Weather Data Reference

Checked on **2026-10-10** against the live public website and API. Git was initialized in this project with `git init` before this investigation and file creation.

**Main finding: the two BMD forecast endpoints currently work without any authentication credential.** Supply `SOURCE=BMDWRF` and a valid six-digit upazila/thana `PCODE`. The `uid` in the captured requests is optional and is not an authentication credential in the tested requests.

**Follow-up findings:** the API landing page documents an archived-forecast endpoint, parameter filtering, and repeated location parameters. Live tests confirmed these. BMD's public website also provides readable marine/warning PDFs and station-observation CSV feeds. Archived forecasts and measured rainfall are separate data products; details below.

**Satellite follow-up:** BMD's satellite viewer loads JMA Himawari JPEG imagery. Five Bangladesh-region image products were fetched successfully, including heavy-rainfall-potential imagery. The supplied `/slider_json/` endpoint contains website slideshow/news data, not satellite data.

**Xweather credential test:** the user-supplied client ID/secret authenticated successfully on 2026-10-10. Bangladesh lightning and lightning-threat queries were accepted but returned no matching records in the tested windows. Current/hourly weather, precipitation probability, provider WBGT, past conditions, air quality, and North Bay maritime data returned populated responses. This reference contains endpoint templates and results only, not the supplied credentials.

## Authentication and request parameters

| Item | Observed value | Meaning / requirement |
| --- | --- | --- |
| API base URL | `https://api.bdservers.site` | Forecast host used by BMD's public website. |
| Website base URL | `https://usf.bmd.gov.bd` | District/upazila selection and coordinate lookup. |
| HTTP method | `GET` | All BMD forecast and location endpoints below. |
| `SOURCE` | `BMDWRF` | Forecast-source selector. Omitting it from the daily endpoint returned `{"error":"no source defined"}` despite HTTP 200. |
| `PCODE` | `302604` | Six-digit upazila/thana location code; this example is **Badda, Dhaka**. |
| Repeated `PCODE` | `PCODE=302604&PCODE=302602` | Documented multi-location form; verified for rainfall. Do not use a comma-separated value. |
| `PARAM` | `rf`, `temp`, `rh`, etc. | Optional field filter. Repeat the parameter to select multiple fields, e.g. `PARAM=rf&PARAM=temp`. Omitting it returns all available variables. |
| `FDATE` | `20261009` | Forecast generation date, in `YYYYMMDD` format, for `/upazila_forecast_date`. |
| `district` | `3026` | Four-digit district selector for the upazila-list endpoints; this example is **Dhaka**. |
| `uid` from the supplied daily request | `6ac9ed8ca24c5` | Optional. The API returned identical content when this was supplied, omitted, or replaced with `weather-reference-check`. |
| `uid` from the supplied steps request | `6ac9ed8ca24c6` | Optional. The steps endpoint also returned weather data with it omitted. |
| Authorization / bearer token | None required in tested BMD requests | No `Authorization` header was sent. |
| API key | None required in tested BMD requests | No API-key header or query parameter was sent. See the separate third-party helper below. |
| Login / cookies | None required in tested BMD requests | Fresh standalone requests succeeded without browser-session cookies. |
| `Origin` / `Referer` | Not required in standalone tests | The browser sends these automatically. They are not weather credentials. |
| `Accept` | `application/json` is appropriate for forecasts | Optional content preference; the forecasts already returned JSON. |
| Browser-specific headers | Not needed for the tested fetches | `sec-ch-ua`, `sec-fetch-*`, priority, browser validation, and HTTP/2 pseudo-headers need not be copied. |

The public HTML generates changing `uid` values in `link_pref` and `link_pref_2`. For example, one fetched page contained `6ac9ee538a599` and `6ac9ee538a59a`. This is consistent with a per-render unique identifier, possibly for cache busting, but its intended server-side purpose is undocumented. The tests establish that it is unnecessary for these fetches; no generation algorithm is needed.

Forecast and tested lookup responses advertised `Access-Control-Allow-Origin: *`. Cookie-based cross-origin access is unnecessary for this flow.

## Weather endpoints

### 1. Latest daily upazila forecast

```text
GET https://api.bdservers.site/upazila_forecast_recent?SOURCE=BMDWRF&PCODE={UPAZILA_PCODE}
```

Working example for Badda:

<https://api.bdservers.site/upazila_forecast_recent?SOURCE=BMDWRF&PCODE=302604>

Original captured form, also verified:

<https://api.bdservers.site/upazila_forecast_recent?SOURCE=BMDWRF&uid=6ac9ed8ca24c5&PCODE=302604>

Returns daily forecast arrays and location metadata. Badda's `temp` array contained **10 daily entries**, starting 2026-10-10 and ending with the interval 2026-10-19 to 2026-10-20. Availability can differ between variables.

Other verified examples:

- Anowara, Chittagong: <https://api.bdservers.site/upazila_forecast_recent?SOURCE=BMDWRF&PCODE=201504>
- Balaganj, Sylhet: <https://api.bdservers.site/upazila_forecast_recent?SOURCE=BMDWRF&PCODE=609108>

### 2. Latest finer-step upazila forecast

```text
GET https://api.bdservers.site/upazila_forecast_steps_recent?SOURCE=BMDWRF&PCODE={UPAZILA_PCODE}
```

Working example for Badda:

<https://api.bdservers.site/upazila_forecast_steps_recent?SOURCE=BMDWRF&PCODE=302604>

Original captured form, also verified:

<https://api.bdservers.site/upazila_forecast_steps_recent?SOURCE=BMDWRF&uid=6ac9ed8ca24c6&PCODE=302604>

Badda's response contained **32 temperature steps**. BMD's dashboard uses this endpoint for its current-period forecast display and short-range charts. These are model forecasts, including the displayed current-period values; this flow does not establish a live station-observation feed.

**Timestamp encoding:** the steps API returned values such as `2026-10-10T00:06:00` and `2026-10-10T00:09:00`. BMD's own dashboard interprets characters 14–15, the apparent minute field, as the nominal hour (`step_start.substring(14, 16)`). Do not assume these strings represent ordinary ISO hourly times when implementing charts. The API landing page documents the daily endpoint's timezone as `UTC00` and the steps endpoint's as `UTC+06` (Bangladesh local time). Validate normalization against the actual responses; the naive `updated_at` value has no offset and its timezone is not separately established.

### Archived forecast by generation date

Provider documentation: <https://api.bdservers.site/>

```text
GET https://api.bdservers.site/upazila_forecast_date?SOURCE=BMDWRF&PARAM=rf&PCODE={UPAZILA_PCODE}&FDATE={YYYYMMDD}
```

Verified URLs:

- <https://api.bdservers.site/upazila_forecast_date?SOURCE=BMDWRF&PARAM=rf&PCODE=302604&FDATE=20261009>
- <https://api.bdservers.site/upazila_forecast_date?SOURCE=BMDWRF&PARAM=rf&PCODE=302604&FDATE=20261001>

Both returned HTTP 200, `error: null`, and 10 daily rainfall forecast entries for Badda. For the 2026-10-09 run, the first interval was 2026-10-09 to 2026-10-10, with `val_avg: 14.97`. For the 2026-10-01 run, its first interval had `val_avg: 1.19`.

**These are archived model predictions issued on `FDATE`, not measured historical rainfall.** Each run contains several future valid dates. Keep the run date and valid interval separate; avoid treating overlapping runs as independent daily measurements. Archive retention and complete historical coverage were not established by the two tests.

The archived response contained top-level `error`, `source`, and `data`, but no `updated_at`. Record the requested `FDATE` and your fetch time explicitly.

### Filtered, multi-location forecast

```text
GET https://api.bdservers.site/upazila_forecast_recent?SOURCE=BMDWRF&PARAM=rf&PCODE=302604&PCODE=302602
```

This verified request returned rainfall-only forecasts for both Badda and Adabor. The API landing page also documents `PARAM=rf&PARAM=temp` for multiple variables and lists `BMDWRF`, `ECMWF`, and `RIMESWRF` as sources. Only the BMDWRF source was tested in this investigation.

### Response structure and fields

Both forecast endpoints use this structure. This abbreviated example keeps only the first daily temperature entry; actual responses contain other variables and entries:

```json
{
  "error": null,
  "source": "BMDWRF",
  "updated_at": "2026-10-10T13:15:12.215",
  "data": {
    "302604": {
      "upazila_name": "Badda",
      "district_name": "Dhaka",
      "division_name": "Dhaka",
      "ADM3_PCODE": 302604,
      "forecast_data": {
        "temp": [
          {
            "step_start": "2026-10-10T00:00:00",
            "step_end": "2026-10-11T00:00:00",
            "val_min": 24.049999237060547,
            "val_avg": 28.22,
            "val_max": 31.290000915527344,
            "val_avg_day": 0.0,
            "val_avg_night": 0.0
          }
        ]
      }
    }
  }
}
```

| Key under `forecast_data` | Meaning / evidence |
| --- | --- |
| `temp` | Temperature; dashboard displays degrees Celsius. |
| `rf` | Rainfall; dashboard displays millimetres. |
| `rh` | Relative humidity; dashboard displays percent. |
| `windspd` | Wind speed; dashboard labels values as km/h. |
| `winddir` | Wind direction, used as degrees for direction icons. |
| `cldcvr` | Cloud cover in okta, according to the API documentation. Daily responses use `val_avg_day` and `val_avg_night`. |
| `tempdew` | Dew-point temperature in degrees Celsius, according to the API documentation; empty in the Badda sample. |
| `smois` | Soil moisture; the API documentation lists percent, but the sample has values such as `0.28`. Confirm scaling/interpretation before crop-specific calculations. |
| `windgust` | Wind-speed gust in km/h, according to the API documentation, which describes this field as derived from GFS data. |
| `thi` | Temperature-humidity index derived from temperature and RH, according to the API documentation; duplicate intervals appeared in the sample. Its formula/scale was not established. |
| `tempbc` | Bias-corrected temperature in degrees Celsius, according to the API documentation. Badda's daily sample had five entries. |
| `thi_broilers` | Broiler-related temperature-humidity index by name; definition/units were not documented. |
| `thi_layers` | Layer-related temperature-humidity index by name; definition/units were not documented. |

Entries generally contain `step_start`, `step_end`, `val_min`, `val_avg`, and `val_max`. Daily entries can additionally contain `val_avg_day` and `val_avg_night`. Join different variables by interval rather than assuming equal array lengths or unique intervals. Check both HTTP status and the JSON `error` field, and verify that `data[PCODE]` exists.

## Location codes and district/upazila lookup

### 3. Upazila/thana list for a district — English

```text
GET https://usf.bmd.gov.bd/Dashboard/getUpazila?district={DISTRICT_CODE}
```

Verified URLs:

- Dhaka: <https://usf.bmd.gov.bd/Dashboard/getUpazila?district=3026> — 46 named locations.
- Chittagong: <https://usf.bmd.gov.bd/Dashboard/getUpazila?district=2015> — 25 named locations.
- Sylhet: <https://usf.bmd.gov.bd/Dashboard/getUpazila?district=6091> — 12 named locations.

The response is **HTML option elements, not JSON**:

```html
<option value="">Select Upazila</option>
<option value="302602">Adabor</option>
<option value="302604">Badda</option>
```

The numeric option `value` is the `PCODE` to pass to either forecast endpoint. The site also includes metropolitan thanas in this selector.

### 4. Upazila/thana list for a district — Bangla

```text
GET https://usf.bmd.gov.bd/Dashboard/getUpazilaBN?district={DISTRICT_CODE}
```

Verified Dhaka example:

<https://usf.bmd.gov.bd/Dashboard/getUpazilaBN?district=3026>

Returns the same location codes with Bangla display names, including `302604` = `বাড্ডা`.

### 5. Coordinates to upazila/thana code

```text
GET https://usf.bmd.gov.bd/Dashboard/getUpazilaByLatLon/{LATITUDE}/{LONGITUDE}
```

Verified example:

<https://usf.bmd.gov.bd/Dashboard/getUpazilaByLatLon/23.7806/90.4254>

The response body was the plain code `302604`, although its content type was `text/html; charset=UTF-8`. Use `response.text()` and trim it. The dashboard treats a response of `0` as no matched location. Pass the returned code to the forecast endpoints.

### District-wise weather workflow

The inspected BMD dashboard exposes a district selector that leads to upazila/thana forecasts. **A separate district-aggregate forecast endpoint was not found in that flow.**

1. Choose a district code from the table below.
2. Fetch its English or Bangla upazila list.
3. Fetch each selected location's daily and/or step forecast using its six-digit `PCODE`.
4. Group the resulting forecasts by `district_name` for a district-wise view.

A four-digit district code is not a substitute for an upazila code: `PCODE=3026` returned `data: {}`. Omitting `PCODE` also returned an empty `data` object; it did not return all Bangladesh forecasts. A comma-separated `PCODE=302604,302602` request returned HTTP 500. For multiple locations, repeat the query key: `PCODE=302604&PCODE=302602`, which was verified successfully. Any summary computed across upazilas is an application-derived district summary rather than a BMD-published district aggregate.

### All 64 district codes from the public selector

Names below retain the English spellings used by BMD's selector; some differ from current transliterations.

| District | Code | District | Code |
| --- | --- | --- | --- |
| Bagerhat | `4001` | Bandarban | `2003` |
| Barguna | `1004` | Barisal | `1006` |
| Bhola | `1009` | Bogra | `5010` |
| Brahamanbaria | `2012` | Chandpur | `2013` |
| Chapai Nawabganj | `5070` | Chittagong | `2015` |
| Chuadanga | `4018` | Comilla | `2019` |
| Cox's Bazar | `2022` | Dhaka | `3026` |
| Dinajpur | `5527` | Faridpur | `3029` |
| Feni | `2030` | Gaibandha | `5532` |
| Gazipur | `3033` | Gopalganj | `3035` |
| Habiganj | `6036` | Jamalpur | `4539` |
| Jessore | `4041` | Jhalokati | `1042` |
| Jhenaidah | `4044` | Joypurhat | `5038` |
| Khagrachhari | `2046` | Khulna | `4047` |
| Kishoreganj | `3048` | Kurigram | `5549` |
| Kushtia | `4050` | Lakshmipur | `2051` |
| Lalmonirhat | `5552` | Madaripur | `3054` |
| Magura | `4055` | Manikganj | `3056` |
| Maulvibazar | `6058` | Meherpur | `4057` |
| Munshiganj | `3059` | Mymensingh | `4561` |
| Naogaon | `5064` | Narail | `4065` |
| Narayanganj | `3067` | Narsingdi | `3068` |
| Natore | `5069` | Netrakona | `4572` |
| Nilphamari | `5573` | Noakhali | `2075` |
| Pabna | `5076` | Panchagarh | `5577` |
| Patuakhali | `1078` | Pirojpur | `1079` |
| Rajbari | `3082` | Rajshahi | `5081` |
| Rangamati | `2084` | Rangpur | `5585` |
| Satkhira | `4087` | Shariatpur | `3086` |
| Sherpur | `4589` | Sirajganj | `5088` |
| Sunamganj | `6090` | Sylhet | `6091` |
| Tangail | `3093` | Thakurgaon | `5594` |

### All 46 Dhaka upazila/thana codes from the lookup response

| Location | PCODE | Location | PCODE |
| --- | --- | --- | --- |
| Adabor | `302602` | Badda | `302604` |
| Bangshal | `302605` | Biman Bandar | `302606` |
| Cantonment | `302608` | Chak Bazar | `302609` |
| Dakshinkhan | `302610` | Darus Salam | `302611` |
| Demra | `302612` | Dhamrai | `302614` |
| Dhanmondi | `302616` | Dohar | `302618` |
| Gendaria | `302624` | Gulshan | `302626` |
| Hazaribagh | `302628` | Jatrabari | `302629` |
| Kadamtali | `302632` | Kafrul | `302630` |
| Kalabagan | `302633` | Kamrangir Char | `302634` |
| Keraniganj | `302638` | Khilgaon | `302636` |
| Khilkhet | `302637` | Kotwali | `302640` |
| Lalbagh | `302642` | Mirpur | `302648` |
| Mohammadpur | `302650` | Motijheel | `302654` |
| Nawabganj | `302662` | New Market | `302663` |
| Pallabi | `302664` | Paltan | `302665` |
| Ramna | `302666` | Rampura | `302667` |
| Sabujbagh | `302668` | Savar | `302672` |
| Shah Ali | `302674` | Shahbagh | `302675` |
| Sher-e-bangla Nagar | `302680` | Shyampur | `302676` |
| Sutrapur | `302688` | Tejgaon | `302690` |
| Tejgaon Ind. Area | `302692` | Turag | `302693` |
| Uttar Khan | `302696` | Uttara | `302695` |

For other districts, use the lookup URL with any district code in the 64-district table. The displayed list is the source of valid codes; do not construct codes from names.

## Official marine forecasts and warning bulletins

The follow-up browser capture contains analytics and tracking POST requests, not marine data responses. However, its analytics `dl` parameter identifies the actual BMD content pages. Following those pages produced these public PDF links, all fetched and text-extracted successfully on 2026-10-10:

| Product | Stable content page | PDF linked at inspection time |
| --- | --- | --- |
| Fishermen Forecast | <https://www.bmd.gov.bd/web/en/p/Fishermen-Forecast> | <https://live8.bmd.gov.bd/file/2026/10/10/pdf/210645.pdf> |
| Fleet Forecast | <https://www.bmd.gov.bd/web/en/p/Fleet-Forecast-107> | <https://live8.bmd.gov.bd/file/2026/10/10/pdf/210643.pdf> |
| Sea Bulletin | <https://www.bmd.gov.bd/web/en/p/SEA-BULLETING> | <https://live8.bmd.gov.bd/file/2026/10/10/pdf/210644.pdf> |
| Inland Riverport Warning | <https://www.bmd.gov.bd/web/en/p/Inland-Riverport-Warning> | <https://live8.bmd.gov.bd/file/2026/10/10/pdf/210648.pdf> |
| General Weather Forecast | <https://www.bmd.gov.bd/web/en/p/Weather-Forecast> | <https://live8.bmd.gov.bd/file/2026/10/10/pdf/210654.pdf> |

The marine index is <https://www.bmd.gov.bd/web/en/marine_page/>. Fetch the stable content page and rediscover its current download link each time; date folders and file IDs change. These are website/PDF data sources, not a verified marine JSON API. No authentication was required for the inspected pages or PDFs.

### Fields actually found in the marine PDFs

| Field | Evidence in the inspected sample |
| --- | --- |
| Product and covered area | Fishermen forecast covers North Bay; fleet forecast covers area C-90. The C-90 boundary was not established. |
| Validity start and duration | Fishermen: 24 hours commencing 12:00 BST on 2026-10-10. Fleet: 12 hours commencing 10:00 UTC on 2026-10-10. |
| Bulletin reference time | Sea Bulletin: 2026-10-10 at 03:00 UTC. No separate forecast expiry was given in its extracted text. |
| Storm-warning statement | All three inspected marine products explicitly said `NO STORM WARNING`. |
| Synoptic situation | `MONSOON IS WEAK OVER NORTH BAY`. |
| Weather | Temporary rain/thunder over North Bay or the fleet area. |
| Wind | West/south-westerly, 10–15 knots. Preserve the original unit; knots can be converted to km/h using 1 knot = 1.852 km/h. |
| Localized marine wind descriptions | Fishermen forecast also lists 100 km west and 50 km south of Cox's Bazar. |
| Visibility | 3–5 km, temporarily reducing to 1,500 m or less in rain/showers. |
| Subsequent outlook | Fishermen: subsequent 24 hours, little change. Fleet: subsequent 12 hours, little change. |
| Pressure | Fishermen: Chattogram 1011.2 hPa and Cox's Bazar 1011.8 hPa. Fleet: Dhaka 1011.9 hPa. |

The inspected PDFs contained no numerical wave height, tide, current, swell, sea-surface temperature, or real-time lightning-strike locations. A rain/thunder forecast is an area forecast rather than a strike observation. An explicit `NO STORM WARNING` statement does not assert that every marine activity is safe; the same bulletin can forecast thunder and reduced visibility.

The inland river-port PDF explicitly said there was no inland river-port warning and no signal was to be hoisted, for the stated 10:00 AM to 6:00 PM period on 2026-10-10. Keep inland river-port and marine products separate.

### Additional official warning pages

- Marine: <https://www.bmd.gov.bd/web/en/p/Marine-Warning>
- Heavy rainfall: <https://www.bmd.gov.bd/web/en/p/Heavy-Rainfall-Warning>
- Kalbaishakhi: <https://www.bmd.gov.bd/web/en/p/Kalbaishakhi-Warning>
- Heat wave: <https://www.bmd.gov.bd/web/en/p/Heat-Wave-Warning>

These pages returned HTTP 200 but had no bulletin body or PDF link in the retrieved content at inspection time. Do not interpret a blank page as an explicit withdrawal/all-clear. A cancellation or no-warning statement must come from a dated official notice.

The mobile website currently displays a notice that its weather-warning display is a demo. Its automation endpoint <https://mobile.bmd.gov.bd/warning_automation/marine_warning_latest.json> returned a document date of 2026-09-30 with empty warning/signal data and null validity fields. This was not verified as a current operational warning feed. Use the dated desktop bulletins as evidence for the MVP.

### Minimal bulletin ingestion record

Store the product type, source page, current PDF URL, fetch time, original text, covered-area description, stated time zone, reference/issue time when present, validity start/end when present, official warning/signal text, wind values/unit, visibility, weather, and parser status. Preserve unknown fields as unknown. Date/time extraction must respect `BST` versus `UTC` and notices that have a future validity start.

The five inspected PDFs had extractable text; OCR was not required. If a future bulletin is scanned, OCR becomes a separate fallback. For an early MVP, displaying the original dated PDF plus its verified metadata is sufficient before adding structured automated parsing.

## Measured rainfall and other station observations

### Official daily weather PDF

The general Weather Forecast PDF above has a second page titled **Stations observation Data**. It includes:

- Measured rainfall for the preceding 24 hours, ending at 06:00 AM on the bulletin date.
- Yesterday's maximum temperature and today's minimum temperature.
- Station and division names.

In the inspected 2026-10-10 table, Dhaka rainfall was **4 mm**, Nikli **25 mm**, and Dimla **43 mm**. Some stations had `Trace` or `N/A`. Retain those distinctions; neither missing values nor trace amounts should be silently treated as exact zero.

This supplies recent actual rainfall at stations, rather than a complete historical series for every upazila. Archiving successive daily bulletins can build a station-level observation history. No multi-day historical PDF discovery endpoint was verified here.

### Public BMD mobile station-data feeds

Source page: <https://mobile.bmd.gov.bd/bmdmobile/aws/>

The public script <https://mobile.bmd.gov.bd/bmdmobile/mobile.bmd.js?v=3.05.06> defines station CSV and observation-feed URLs. Both compressed and plain CSV observation forms were tested successfully without authentication:

| Feed | Plain CSV URL | Variables observed |
| --- | --- | --- |
| Automatic rain gauges (ARG) | <https://mobile.bmd.gov.bd/bmdmobile/aws_data.php?dtype=ARG> | Rain 1h, 3h, 6h, 12h, 24h. |
| Synoptic stations | <https://mobile.bmd.gov.bd/bmdmobile/aws_data.php?dtype=Synop> | Rain periods, air temperature/humidity/pressure, scalar wind speed/direction, solar radiation, sunshine duration. |
| Agricultural AWS | <https://mobile.bmd.gov.bd/bmdmobile/aws_data.php?dtype=AgAWS> | Rain periods, air temperature/humidity/pressure, scalar wind speed/direction, solar radiation, soil temperature/humidity. |

For the compressed form, append `&size=.min`. The inspected compressed bodies were zlib-compatible compressed CSV despite the `text/csv` content type, and were decoded successfully with Python's `zlib.decompress`. Plain forms avoid that decoding step.

In the inspected samples, the observation window was approximately 2026-10-09 to 2026-10-10, with recent readings at 14:00 on 2026-10-10. Data was present for 44 ARG, 34 Synop, and 114 AgAWS station IDs. These are snapshot counts, not guarantees of full station coverage. Observation timestamps had no UTC offset; verify source timezone before normalizing or matching work shifts.

### Station metadata

| Dataset | URL | Metadata rows in inspected response |
| --- | --- | --- |
| ARG | <https://mobile.bmd.gov.bd/bmdmobile/station_arg.csv> | 65 |
| Synop | <https://mobile.bmd.gov.bd/bmdmobile/station_synop.csv> | 35 |
| AgAWS | <https://mobile.bmd.gov.bd/bmdmobile/station_agaws.csv> | 285 |

These provide `StationID`, `StationName`, `Latitude`, and `Longitude`; some include station type, altitude, or active status. Synop station `41923` is Dhaka, at latitude `23.7799`, longitude `90.3783`. Join observations to metadata using the station ID. A nearby station reading must be labeled with its station and distance; it is not an exact observation for every upazila or field nearby. Metadata membership alone does not establish that a station currently supplies usable readings.

### CSV interpretation

- Columns include `file_name`, `station_id`, `parameter`, `data_type`, `value`, summary fields, and timestamps.
- Rows omit repeated file/station/parameter values; forward-fill those identifiers as the BMD script does.
- Some timestamps use compact `DDHH`, such as `0914`, rather than a full date. Reconstruct with the applicable full-date context and explicitly handle month/year boundaries.
- The site's parser treats `data_type=d` as individual readings and `data_type=s` as summaries; separate them.
- Preserve gaps/missing values and confirm units/scaling for each station parameter.
- Do not add overlapping 3h/6h/12h/24h accumulations together. Build daily totals from a defined non-overlapping interval, with completeness checks.

The snapshot does not establish a five-day observed history or a documented date-selection parameter for these station feeds. Collect and deduplicate fresh observations into your own history. Until enough complete observed days exist, use a forecast-based field-moisture check advisory and label its evidence accordingly.

The desktop website also links <https://bmdrainfallnetwork.com/realtimedatas/>, but this session could not validate that site's TLS certificate. It is not counted as a verified usable feed here.

## Satellite imagery and products used by BMD

### Supplied satellite page and slideshow endpoint

- BMD page: <https://server6.bmd.gov.bd/en/satelite>
- Viewer source: <https://server6.bmd.gov.bd/assets/js/bmd.web.js?v=1.09.0909>
- Supplied JSON: <https://server6.bmd.gov.bd/slider_json/?t=20261010151951>
- Same JSON without the optional query: <https://server6.bmd.gov.bd/slider_json/>

Both JSON requests succeeded without cookies or an API key. Their `data` object contained `Slides` and `Scroll`: five website banner-image records and a news-scroll HTML string. Banner `timeUpdate` values were 2026-02-18; the scroll record was dated 2026-10-02. These are content-edit timestamps, not satellite observation times. The `t` parameter is a client-generated timestamp in the website's slideshow request; its omission was verified to work.

The Google Analytics POST with measurement ID `G-FPQ67QZSSE` records the satellite page visit. It supplies no satellite measurements or imagery.

### Actual imagery source and URL pattern

The viewer's `loadSatellitePageNew_LoadImage` method constructs URLs to JMA's Meteorological Satellite Center:

```text
https://www.data.jma.go.jp/mscweb/data/himawari/img/{AREA}/{AREA}_{PRODUCT}_{FRAME_CODE}.jpg
```

| Area code | BMD selector | JMA region |
| --- | --- | --- |
| `ha3` | Bangladesh | High-Resolution Asia 3, approximately 84–95 degrees east and 18–27 degrees north. |
| `se4` | South Asia | Approximately 70–100 degrees east and 0–30 degrees north. |

Provider pages:

- JMA image portal: <https://www.data.jma.go.jp/mscweb/data/himawari/>
- Bangladesh-region viewer: <https://www.data.jma.go.jp/mscweb/data/himawari/sat_img.php?area=ha3>
- South Asia viewer: <https://www.data.jma.go.jp/mscweb/data/himawari/sat_img.php?area=se4>
- Bangladesh-region file index: <https://www.data.jma.go.jp/mscweb/data/himawari/list_ha3.html>
- South Asia file index: <https://www.data.jma.go.jp/mscweb/data/himawari/list_se4.html>

These return JPEG imagery or HTML frame listings rather than upazila-keyed numerical JSON. No authentication was required in the tested requests. GET requests to the sample JPEG and JMA viewer with `Origin: http://localhost:5173` returned `Access-Control-Allow-Origin: *` and `Cache-Control: max-age=600`. The BMD slideshow JSON did not advertise CORS in that test.

### Product codes and potential use

All 17 products below are listed in BMD's selector. JMA's two file indexes listed 16 products, with 142 frame filenames per product in the inspected snapshot; `hrp` was absent from those indexes, but its direct Bangladesh image URL was verified successfully.

| Code | Product | Useful information / interpretation |
| --- | --- | --- |
| `b13` | B13 infrared | Cloud patterns and relative cloud-top/surface brightness temperature; usable for day/night cloud monitoring. A rendered grayscale value is not a calibrated temperature measurement. |
| `b03` | B03 visible | Daytime cloud structure and distribution; relies on sunlight. |
| `b08` | B08 water vapour | Upper-atmospheric moisture/cloud patterns; does not provide surface relative humidity. |
| `b07` | B07 short-wave infrared | Supporting cloud/surface discrimination; interpretation depends on day/night conditions. |
| `dms` | Day Microphysics RGB | Daytime cloud-type interpretation. |
| `ngt` | Night Microphysics RGB | Nighttime cloud-type and low-cloud/fog interpretation. |
| `dst` | Dust RGB | Dust-plume interpretation; not a measured PM2.5/AQI feed. |
| `arm` | Airmass RGB | Air-mass and upper-atmospheric pattern interpretation. |
| `dsl` | Day Snow-Fog RGB | Low-level cloud/snow/fog interpretation with appropriate training; not a station visibility reading. |
| `dnc` | Natural Color RGB | Visual cloud/land context. |
| `tre` | Enhanced True Color RGB | Visual cloud/land context. |
| `trm` | True Color Reproduction Image | Human-readable Earth imagery; source attribution applies. |
| `cve` | Day Convective Storm RGB | Cumulonimbus/deep-convection interpretation; not a lightning-strike feed. |
| `snd` | Sandwich | Combined cloud-image context. |
| `vir` | B03 combined with B13 | Visible/infrared combined cloud context. |
| `irv` | B03 and B13 at night | Combined imagery adapted for nighttime display. |
| `hrp` | Heavy rainfall potential areas | Highlights potential rainfall areas associated with deep convective clouds; not actual rainfall amount or a numerical precipitation probability. |

JMA interpretation resources:

- RGB training library: <https://www.jma.go.jp/jma/jma-eng/satellite/RGB_TL.html>
- Heavy-rainfall-potential description: <https://www.data.jma.go.jp/mscweb/data/himawari/sat_hrp.php?area=r2s>
- Linked user guide, read during this investigation: <https://www.data.jma.go.jp/mscweb/data/himawari/Users_Guide.pdf>

The rainfall-potential description states that potential areas are indicated in magenta. Its linked guide explains that infrared cloud-top radiance identifies deep convection and does not measure rainfall amounts. Dense cirrus can be misclassified and small clouds can be missed. The linked guide is a 2015 document with historical regional specifications; do not assume its old resolution/coverage or historical verification scores establish the performance of every current crop/product.

### Successfully fetched Bangladesh-region images

| Product | Verified sample URL |
| --- | --- |
| Infrared | <https://www.data.jma.go.jp/mscweb/data/himawari/img/ha3/ha3_b13_0910.jpg> |
| Visible | <https://www.data.jma.go.jp/mscweb/data/himawari/img/ha3/ha3_b03_0910.jpg> |
| Water vapour | <https://www.data.jma.go.jp/mscweb/data/himawari/img/ha3/ha3_b08_0910.jpg> |
| Convective storm RGB | <https://www.data.jma.go.jp/mscweb/data/himawari/img/ha3/ha3_cve_0910.jpg> |
| Rainfall potential | <https://www.data.jma.go.jp/mscweb/data/himawari/img/ha3/ha3_hrp_0910.jpg> |

All five returned HTTP 200 and `image/jpeg`. The inspected infrared, convection and rainfall-potential images were 551 by 441 pixels, and their image captions named **Himawari-9**, with time **2026-10-10 09:20 UTC**, equivalent to **15:20 BST**.

### Frame timing, availability and location

- Frames are generally presented at 10-minute intervals, with gaps possible. The viewer offers recent animation windows up to 23 hours. Playback settings of 2/5/10/20 fps change animation speed, not satellite observation frequency.
- The filename code is not the complete observation timestamp. The inspected filename suffix `0910` was labeled **09:20 UTC** in JMA's time selector and image caption. BMD's `getUTC_LAST_10_Minutes` method also adds 10 minutes for the display label. Use the provider's dated time label/caption rather than interpreting the filename as the observation instant.
- Filenames contain a time-of-day code but no calendar date. Treat them as a rolling window, not a permanent dated archive; archive images with full timestamps if historical image comparison is required.
- Prefer provider-listed available frames to blindly constructing a current-time URL. An unavailable image or unhighlighted rainfall-potential image is not evidence of safe conditions.
- BMD overlays the Bangladesh crop using approximate bounds from latitude 18.5771426661 to 27.3560931709 and longitude 83.95 to 94.9822998047. South Asia image bounds in the source run from latitude 0 to 29.5 and longitude 70 to 100. These viewer settings need geographic validation before pixel-to-upazila risk extraction.

### Useful AkashSathi integration

1. Add a source-labeled cloud/convection image layer with observation time and a short animation.
2. Keep rainfall amounts, wind and temperature from the forecast JSON, and measured rainfall from station feeds. Use imagery as supplementary visual evidence for weather context.
3. For farmers, show changing cloud/rainfall-potential patterns alongside the harvest forecast. For fishermen, show North Bay cloud patterns alongside the marine bulletin. For outdoor workers/students, show source-labeled convective-cloud context alongside applicable official warnings.
4. If later extracting machine-readable indicators, calibrate product colors, remove map labels/borders, validate geographic alignment, distinguish daylight-dependent products, and compare results against observations. Any cloud-coverage estimate, motion vector, or rainfall-potential overlap is derived data, not a provider-published upazila measurement.
5. Store `source`, `area`, `product`, `image_url`, full observation time, fetch time, image dimensions and data status. Keep derived-indicator method/version separate from original imagery.

Imagery alone does not fill the gaps for verified flooding/waterlogging, nearby lightning strikes, rainfall history in millimetres, surface humidity, rain probability, WBGT, waves/tides/currents, or precise storm arrival at a user's location. Prioritize the viewer and source fusion for the MVP before automatic image-derived alert rules.

Credit JMA as the imagery source and BMD as the viewer source. The JMA portal also specifies extra acknowledgements for True Color Reproduction imagery; consult the source page when using that product.

## Xweather access test for Bangladesh

### Authentication and future environment configuration

API base URL: `https://data.api.xweather.com`

The Weather API accepts separate `client_id` and `client_secret` query parameters. The combined key string supplied by the user was not needed as an additional header. Authentication succeeded using the supplied ID/secret pair. This test establishes access to the request forms below; it does not establish access to every product in the provider's catalog or the account's commercial plan name.

For later backend configuration, use these variable names with your actual values in `server/.env`:

```dotenv
XWEATHER_CLIENT_ID=your_client_id
XWEATHER_CLIENT_SECRET=your_client_secret
XWEATHER_BASE_URL=https://data.api.xweather.com
```

These are placeholders. The actual credentials have not been added to project files during this test. The existing `.gitignore` excludes `.env` files. Requests should be made from the backend so response/request logging can omit authentication query parameters and the client secret does not enter the React bundle.

### Verified requests and results

Tests were performed around **2026-10-10 09:45–09:47 UTC / 15:45–15:47 BST**. Each request below additionally needs `client_id` and `client_secret`; they are omitted here.

| Product | Credential-free endpoint/query | Live result |
| --- | --- | --- |
| Current conditions | `/conditions/23.8103,90.4125?limit=1` | HTTP 200, `success: true`, `error: null`; populated Bangladesh response. |
| Daily forecast | `/forecasts/23.8103,90.4125?limit=1` | HTTP 200; one populated daily period. |
| Hourly forecast | `/forecasts/23.8103,90.4125?filter=1hr&limit=3` | HTTP 200; three populated hourly periods. |
| Past conditions | `/conditions/23.8103,90.4125?from=-1day&filter=1hr&limit=1` | HTTP 200; populated period for 2026-10-09. |
| Air quality | `/airquality/23.8103,90.4125?limit=1` | HTTP 200; AQI and pollutant values returned. |
| Maritime | `/maritime/21.5,91.0?filter=1hr&limit=1` | HTTP 200; populated North Bay marine period. |
| Observed lightning | `/lightning/closest?p={LAT},{LON}&r=100km&limit=2` | HTTP 200, `success: true`, `warn_no_data` for all four tested centers. Dhaka used `limit=3`. |
| Lightning threats | `/lightning/threats/closest?p={LAT},{LON}&r=100km&limit=1` | HTTP 200, `success: true`, `warn_no_data` for Dhaka and Cox's Bazar. Dhaka used `limit=2`. |

Lightning query centers:

| Center | Latitude | Longitude | Observed lightning | Lightning threats |
| --- | --- | --- | --- | --- |
| Dhaka area | `23.8103` | `90.4125` | Accepted; no matching records | Accepted; no matching records |
| Chattogram | `22.3569` | `91.7832` | Accepted; no matching records | Not tested |
| Sylhet | `24.8949` | `91.8687` | Accepted; no matching records | Not tested |
| Cox's Bazar | `21.4272` | `92.0058` | Accepted; no matching records | Accepted; no matching records |

The Dhaka weather response identified `country: bd`, nearby place `bhatara`, and timezone `Asia/Dhaka`, with an explicit `+06:00` offset. These coordinates are fixed test locations; GPS access is not required to query a selected-area representative coordinate.

### Lightning and thunderstorm availability

Both lightning endpoints accepted the authenticated Bangladesh queries. Their application-level result was:

```json
{
  "success": true,
  "error": {
    "code": "warn_no_data",
    "description": "Valid request. No results available based on your query parameters."
  }
}
```

No strike or threat records were returned in these tests. This is a successful query with no matches, not an invalid-key or subscription-denial error. It does not prove that Bangladesh was lightning-free or guarantee safety beyond the query area/time. A populated live-event payload and map/alert rendering remain to be verified when a matching event occurs.

The provider documents global lightning coverage. For standard `/lightning` access, its documentation specifies the last **five minutes**, a maximum **100 km** query radius and up to 1,000 records per query. Older lightning data and polygon/`within` access require the Lightning Enterprise add-on. Those extended request forms were not tested here.

Documented strike fields, when records are present, include:

- `id`, `loc.lat`, `loc.long`.
- `ob.timestamp`, `ob.dateTimeISO`, `ob.age`.
- `ob.pulse.type`: intracloud/cloud-to-ground classification.
- `ob.pulse.peakamp`: pulse amplitude and polarity.
- Sensor/confidence-related fields when available.
- `relativeTo.distanceKM` and bearing relative to the query center, not the user's exact location.

The provider documents `/lightning/threats` as a **nowcast up to 60 minutes ahead**, in 10-minute periods, updated about every two minutes. Its documented records include issue/validity times, period polygons, storm movement speed/direction/reliability and a forecast path. These are potential future threat areas, distinct from observed strikes and official BMD warning signals.

The forecast endpoint also supplies `weather`, `weatherPrimary`, and coded-weather fields that can describe thunderstorms when forecast. The sampled Dhaka hourly period described mostly cloudy weather, not a thunderstorm; no active thunderstorm message is established by that sample.

### Populated weather fields and previously missing inputs

| Data | Verified fields | Example from a dated sample |
| --- | --- | --- |
| Temperature | `tempC`, daily minimum/maximum/average fields | Current conditions at 15:45 BST: `29.67` degrees Celsius. |
| Feels-like temperature | `feelslikeC` | Current sample: `33.55` degrees Celsius. |
| Provider WBGT | `wetBulbGlobeTempC` | Current sample: `26.82` degrees Celsius; 16:00 BST hourly forecast: `26.5`. |
| Precipitation probability | `pop` | Daily sample: `100`; 16:00 BST hourly sample: `0`. Values are percent for their respective periods. |
| Precipitation | `precipMM`, `precipRateMM` in conditions; `precipMM` in forecasts | Daily forecast: `0.5` mm expected over that forecast period. |
| Humidity/dew point | `humidity`, `dewpointC` | Current sample: RH `67`, dew point `22.84` degrees Celsius. |
| Wind/gust/direction | `windSpeedKPH`, `windGustKPH`, `windDirDEG`, `windDir` | Current sample: wind `5.92` km/h, gust `13.54` km/h. |
| Pressure | `pressureMB`, plus station/altimeter-related pressure fields | Current sample: `1010` mb. |
| Visibility | `visibilityKM` | Current sample: `4.693` km. |
| Cloud cover/condition | `sky`, `cloudsCoded`, `weather`, `weatherPrimary`, `icon` | Current sample: sky `76`, weather `Haze`. |
| Solar radiation/UV | `solradWM2`, `solrad`, `uvi` | Solar radiation `226` W/m2 and UVI `0` in the current sample. |

The provider documentation defines `pop` as probability of precipitation, 0–100 percent. `wetBulbGlobeTempC` is a WBGT field in its conditions and forecasts products. For the prototype, use it as a provider-supplied condition/forecast estimate with its source and valid time, rather than implying an on-site occupational WBGT measurement. Method/exposure assumptions were not independently validated here.

Match probability, precipitation amount and activity to the **same valid period and source**. A daily probability of 100 percent and a particular hour's probability of zero refer to different intervals. Do not pair a daily Xweather probability with a BMD rainfall interval without explicitly aligning their definitions/times.

The `/conditions` documentation describes interpolated/blended conditions from observations, radar/satellite information, models and other sources. The tested past-period result is a historical condition estimate, not proof of a direct rain-gauge measurement at the selected upazila. Only a one-day-old single period was tested; complete multi-day history was not downloaded. Archive requests can return `pop: null`, as in this test.

### Marine data available near Bangladesh

The North Bay test point was latitude `21.5`, longitude `91.0`. Its sample period was **2026-10-10 15:00 BST**:

| Field | Sample value |
| --- | --- |
| `seaSurfaceTemperatureC` | `30.91` |
| `seaCurrentSpeedMPS` | `0.1` |
| `seaCurrentDir` | `S` |
| `significantWaveHeightM` | `0.79` |
| `primaryWaveDir` / `primaryWavePeriod` | `SSW` / `19` seconds |
| `primarySwellHeightM` | `0.55` |
| `secondarySwellHeightM` | `0.51` |
| `tertiarySwellHeightM` | `0.24` |
| `tidesM` | `-0.98` |
| `surgeM` | `0.04` |
| `windWaveDir` / `windWavePeriod` | `SW` / `10.28` seconds |

Directions and heights should retain their provider definitions. Tide/surge height is not water depth or confirmation of flooded roads. The maritime product adds numerical marine conditions alongside BMD's official instructions; it does not substitute for an inland river forecast. The documentation describes global coverage, an approximately six-hour update cycle and a time range from the past 48 hours to 15 days ahead, with field-specific/null availability.

### Air quality

The Bangladesh sample returned AQI, category/color, a dominant pollutant, health-index fields and values for PM2.5, PM10, ozone, carbon monoxide, nitrogen dioxide and sulfur dioxide. At 15:00 BST, the sampled AQI was `145`, dominant pollutant `pm2.5`, and PM2.5 concentration `54` micrograms/m3. The response identified CAMS and Vaisala Xweather sources and had no reporting-station list. Treat it as the provider's air-quality product rather than an independently verified local station reading.

### Account usage observed during testing

Response headers reported:

- `X-Ratelimit-Limit-Minute: 100`.
- `X-Ratelimit-Limit-Period: 15000` with period type `1m`.
- Period reset: `2026-11-09 00:00:00 GMT`.

Observed `X-Cost-Tokens` per tested request:

| Request | Tokens |
| --- | --- |
| Current/past conditions, daily/hourly forecast, maritime | `1` each for the tested small query |
| Air quality | `5` |
| Lightning | `10` |
| Lightning threats | `10` |

The investigation made 12 authenticated requests, whose returned cost headers totaled **70 usage tokens**. Costs can change with temporal range, spatial coverage, endpoint or add-ons; these are the observed costs for these exact queries. No-data lightning queries still returned HTTP 200 and a 10-token cost. Remaining-usage headers are snapshots, not a durable balance.

For the prototype, cache/shared-fetch by selected area and keep refreshes explicit or carefully budgeted. At the observed multipliers, querying strikes and threats every two minutes continuously for one area would cost about 432,000 tokens over 30 days, exceeding the reported period limit. Conversely, polling gaps beyond the strike endpoint's five-minute window can miss events; do not describe a sporadically refreshed prototype as continuous lightning monitoring.

### Remaining geographic/product gaps

The provider's endpoint catalog does not list Bangladesh among supported regions for `/alerts`, US radar `/stormcells`, or `/roadweather`; `/rivers` is US-only. Those products were not queried and are not counted as verified Bangladesh capabilities. Continue using dated BMD bulletins for official Bangladesh warnings. Verified local flooding/waterlogging remains a separate missing dataset.

Other catalog products and extended history request forms were not tested. A successful key does not establish blanket access to all endpoints, historical ranges or add-ons.

### Documentation used

- Authentication: <https://www.xweather.com/docs/weather-api/getting-started/authentication>
- Lightning: <https://www.xweather.com/docs/weather-api/endpoints/lightning>
- Lightning threats: <https://www.xweather.com/docs/weather-api/endpoints/lightning-threats>
- Conditions: <https://www.xweather.com/docs/weather-api/endpoints/conditions>
- Forecasts: <https://www.xweather.com/docs/weather-api/endpoints/forecasts>
- Maritime: <https://www.xweather.com/docs/weather-api/endpoints/maritime>
- Endpoint coverage catalog: <https://www.xweather.com/docs/weather-api/endpoints>
- Rate limits: <https://www.xweather.com/docs/weather-api/getting-started/rate-limiting>
- Cost headers: <https://www.xweather.com/docs/weather-api/getting-started/cost-headers>

## AkashSathi MVP with the verified data

| Feature | Available basis | Scope |
| --- | --- | --- |
| Harvest rain advisory | BMD forecast or Xweather forecast with `pop` + crop stage/work period | Xweather probability and amount are available; align source/valid periods before advising. |
| Worker/vendor/public heat advisory | Xweather provider WBGT, or temperature/RH-based heat index + activity/shift/exposure | Label the indicator and source accurately; provider WBGT is not an on-site measurement and livestock THI is not a human substitute. |
| Construction/stall wind advisory | Wind/gust forecast + active activity | Keep units consistent and thresholds configurable. |
| Fishermen weather advisory | BMD marine PDFs and Xweather maritime values + water body/operating-area selection | Use official area forecast/instructions alongside numerical waves/currents/tides; C-90 needs a known boundary before spatial targeting. |
| Commute rain advisory | Forecast + commute window | Advise rain preparation and checking road conditions; `flood_claim=false` while verified flood data is absent. |
| Recent-rain/site-inspection reminder | Matched station observations + site location | Ask for a site check; no automatic safe-site declaration. |
| Satellite weather-context viewer | Verified JMA infrared/convection/rainfall-potential JPEGs used by BMD | Display source and image time; machine-derived local indicators need separate validation. |
| Dry-day/irrigation check | Observed history as it accumulates, plus crop/field context | Forecast dry spells can support limited planning now; observed five-day claims require complete actual history. |
| Selected-area lightning alerts | Xweather strike and threat queries accepted for Bangladesh | Empty tested results establish access, not a live-event demonstration; verify event handling when data is present and identify the query center/area. |

The current prototype scope uses a form-selected district/upazila, occupation, active activity, work schedule, exposure and crop/water-body context where relevant. GPS and detailed station-feed integration are deferred at the user's request. Combine BMD forecasts/bulletins with the verified Xweather products as needed. Display per-hazard freshness/availability and retain source/validity for every advisory. A fresh no-match lightning result describes only its query window; missing/failed hazard data is unavailable, not a safe status.

## Additional weather-service URL and credential in the public source

The English and Bangla dashboard scripts also contain an optional Kachelmannwetter fog/weather-symbol helper:

```text
GET https://api.kachelmannwetter.com/v02/forecast/{LATITUDE}/{LONGITUDE}/advanced/1h
Header: X-API-Key
```

Locations hard-coded in that helper:

- Dhaka: <https://api.kachelmannwetter.com/v02/forecast/23.781/90.379/advanced/1h>
- Rangpur: <https://api.kachelmannwetter.com/v02/forecast/25.656/89.624/advanced/1h>

A credential value was visible in the public source at the time of inspection. It is deliberately not reproduced in this repository:

```text
X-API-Key: <redacted: third-party credential seen in BMD public source; not reproduced here>
```

Evidence: `dashboard.js`, lines 1722–1752, particularly line 1739; `dashboard_bn.js`, lines 1795–1830, particularly line 1812. The caller `//fogCalculation(currentDistrict);` is commented out in the inspected Bangla script. This is a credential for the separate third-party service, and is not sent to `api.bdservers.site`. Its validity, permissions, and third-party endpoint responses were **not tested**. For an independent integration with that provider, obtain your own provider credential.

## Google Analytics request in the supplied capture

```text
POST https://analytics.google.com/g/collect
```

The supplied query included measurement ID `G-SNG7BEXS38`; the fetched website HTML referenced <https://www.googletagmanager.com/gtag/js?id=UA-173456288-2>. These are analytics identifiers. The HTTP 204 request is page-view telemetry and supplies no district/upazila weather data. Google account/session cookies from the capture are unrelated to BMD weather authentication and are not included in this reference.

The subsequent marine-page capture used `POST https://www.google-analytics.com/g/collect` with measurement ID `G-KNWN1Y7RZF`, and `POST https://presite.bmd.gov.bd/tracking/track.php`. These are tracking requests. The PDF source URLs were obtained from the actual content pages referenced in the analytics query, rather than from the tracking endpoints. The captured `PHPSESSID` is not needed to retrieve the inspected public bulletins.

## Request examples

### PowerShell

```powershell
# Latest daily forecast for Badda, Dhaka. No uid, cookies, or API key.
$daily = Invoke-RestMethod -Method Get -Uri 'https://api.bdservers.site/upazila_forecast_recent?SOURCE=BMDWRF&PCODE=302604'
if ($daily.error) { throw $daily.error }
$daily.data.'302604'.forecast_data.temp

# Finer-step forecast.
$steps = Invoke-RestMethod -Method Get -Uri 'https://api.bdservers.site/upazila_forecast_steps_recent?SOURCE=BMDWRF&PCODE=302604'

# District's locations: the response is HTML, not JSON.
$locations = Invoke-WebRequest -UseBasicParsing -Uri 'https://usf.bmd.gov.bd/Dashboard/getUpazila?district=3026'
$locations.Content
```

### JavaScript — browser or modern Node.js forecast fetch

```javascript
async function fetchBmdForecast(pcode, { steps = false } = {}) {
  const code = String(pcode);
  if (!/^\d{6}$/.test(code)) throw new Error('A six-digit upazila PCODE is required');

  const path = steps ? 'upazila_forecast_steps_recent' : 'upazila_forecast_recent';
  const url = new URL(path, 'https://api.bdservers.site/');
  url.search = new URLSearchParams({ SOURCE: 'BMDWRF', PCODE: code }).toString();

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`BMD HTTP ${response.status}`);

  const payload = await response.json();
  if (payload.error) throw new Error(String(payload.error));
  const location = payload.data?.[code];
  if (!location) throw new Error(`No forecast returned for PCODE ${code}`);

  return { source: payload.source, updatedAt: payload.updated_at, ...location };
}

const daily = await fetchBmdForecast('302604');
const steps = await fetchBmdForecast('302604', { steps: true });
console.log(daily.upazila_name, daily.forecast_data.temp);
```

### JavaScript — browser district-to-upazila lookup

```javascript
async function fetchBmdUpazilas(districtCode, { bangla = false } = {}) {
  const code = String(districtCode);
  if (!/^\d{4}$/.test(code)) throw new Error('A four-digit district code is required');

  const path = bangla ? 'getUpazilaBN' : 'getUpazila';
  const url = new URL(`/Dashboard/${path}`, 'https://usf.bmd.gov.bd');
  url.searchParams.set('district', code);
  const response = await fetch(url, {
    credentials: 'omit',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Location lookup HTTP ${response.status}`);

  const document = new DOMParser().parseFromString(await response.text(), 'text/html');
  return [...document.querySelectorAll('option')]
    .filter((option) => /^\d{6}$/.test(option.value))
    .map((option) => ({ pcode: option.value, name: option.textContent.trim() }));
}

const dhakaUpazilas = await fetchBmdUpazilas('3026');
```

`DOMParser` is a browser API; the lookup snippet is browser-specific. A Node/Express backend needs an HTML parser or an equivalent server-side extraction step for the option fragment. Cache district lists and repeated forecasts, and use `updated_at` to expose the source update time. This investigation did not establish a provider refresh schedule or rate limit.

## Verification results and sources

All verification requests were read-only. The BMD requests used standalone clients without copied browser credentials or authentication headers.

| Check | HTTP result | Application result |
| --- | --- | --- |
| Supplied daily URL with original `uid` | 200 | `error: null`; Badda weather returned. |
| Supplied steps URL with original `uid` | 200 | `error: null`; Badda weather returned. |
| Daily URL with `uid` omitted | 200 | Same daily response content as the supplied daily URL. |
| Steps URL with `uid` omitted | 200 | `error: null`; 32 Badda temperature steps. |
| Daily URL with `uid=weather-reference-check` | 200 | Same daily response content as the supplied daily URL. |
| Daily URL with `SOURCE` omitted | 200 | `{"error": "no source defined"}`. |
| Daily URL with `PCODE=3026` | 200 | Empty `data` object. |
| Daily URL with `PCODE` omitted | 200 | Empty `data` object. |
| Daily URL with `PCODE=302604,302602` | 500 | Server error; not a supported form in this test. |
| English Dhaka lookup | 200 | 46 location option values. |
| Bangla Dhaka lookup | 200 | 46 location option values. |
| English Chittagong lookup | 200 | 25 location option values. |
| English Sylhet lookup | 200 | 12 location option values. |
| Coordinates `23.7806/90.4254` | 200 | Body `302604`. |
| Daily forecast for `201504` | 200 | Anowara, Chittagong; 10 temperature entries. |
| Daily forecast for `609108` | 200 | Balaganj, Sylhet; 10 temperature entries. |
| Archive rainfall, `FDATE=20261009`, Badda | 200 | 10 rainfall forecast entries; `error: null`. |
| Archive rainfall, `FDATE=20261001`, Badda | 200 | 10 rainfall forecast entries; `error: null`. |
| `PARAM=rf&PCODE=302604&PCODE=302602` | 200 | Rainfall-only forecasts for Badda and Adabor. |
| Fishermen, fleet, sea and river-port PDFs | 200 | All four had extractable text. |
| General Weather Forecast PDF | 200 | Two pages; second page has measured 24-hour station rainfall. |
| ARG/Synop/AgAWS CSV feeds | 200 | Compressed and plain forms retrieved; station parameters inspected. |
| ARG/Synop/AgAWS metadata CSVs | 200 | IDs, names and coordinates inspected. |
| BMD `/slider_json/`, with and without `t` | 200 | Website banner/news data, not satellite data. |
| JMA `ha3` infrared/visible/water-vapour/convection/rainfall-potential JPEGs | 200 | Five image products fetched; representative captions and dimensions checked. |
| JMA Bangladesh/South Asia viewer and file-index pages | 200 | Region/product/frame URL patterns and dated observation labels inspected. |
| JMA image GET with local-browser Origin | 200 | `Access-Control-Allow-Origin: *`; image cache max-age 600 seconds. |
| Xweather current/daily/hourly/past weather queries in Bangladesh | 200 | Populated data, including provider WBGT and precipitation probability in current/forecast products. |
| Xweather lightning queries: Dhaka, Chattogram, Sylhet, Cox's Bazar | 200 | `success: true`, `warn_no_data`; authenticated request access confirmed. |
| Xweather lightning threats: Dhaka and Cox's Bazar | 200 | `success: true`, `warn_no_data`; authenticated request access confirmed. |
| Xweather air quality in Bangladesh | 200 | AQI and pollutant values returned. |
| Xweather North Bay maritime query | 200 | Waves, swells, currents, tides, surge and SST returned. |

The three Badda daily responses with original, omitted, and replaced `uid` had the same SHA-256 digest:

```text
59cc0492ff0db81ed565d6a28e3b19a1bc756b2e86a1fcd7d94261cfc4cd92a3
```

Their `updated_at` was `2026-10-10T13:15:12.215`. Forecast values and availability will change as the provider updates the data.

### Public website/source URLs inspected

| URL | Relevant information |
| --- | --- |
| <https://usf.bmd.gov.bd/> | Bangla dashboard, all 64 district codes, `link_pref` / `link_pref_2`, Bangla and coordinate lookup routes. |
| <https://usf.bmd.gov.bd/en> | English dashboard, English district labels, English upazila lookup route. |
| <https://usf.bmd.gov.bd/src/js/dashboard.js> | English forecast parsing, display units, step-time interpretation, optional third-party helper. |
| <https://usf.bmd.gov.bd/src/js/dashboard_bn.js> | Bangla forecast parsing, step-time interpretation, optional third-party helper and commented caller. |
| <https://api.bdservers.site/> | Provider endpoint/parameter documentation, archive route, variable units, source and upazila-code lists. |
| <https://www.bmd.gov.bd/web/en/marine_page/> | Marine forecast content pages and official bulletin links. |
| <https://mobile.bmd.gov.bd/bmdmobile/mobile.bmd.js?v=3.05.06> | Station observation/metadata URLs and compact CSV parsing. |
| <https://server6.bmd.gov.bd/en/satelite> | Satellite region/product selector. |
| <https://server6.bmd.gov.bd/assets/js/bmd.web.js?v=1.09.0909> | JMA image URL construction, frame-label offset and Leaflet overlay bounds. |
| <https://www.data.jma.go.jp/mscweb/data/himawari/> | Provider image portal, regions and source attribution. |
| <https://www.jma.go.jp/jma/jma-eng/satellite/RGB_TL.html> | Official RGB product interpretation/training references. |

The dashboard also loads `https://usf.bmd.gov.bd/src/js/language_array.js` for display translations; it is not a forecast or location-data endpoint. Script `?id=...` values vary by page render and are unnecessary for the stable source URLs above.

This file documents the endpoints found in the inspected BMD dashboards and the authenticated Xweather request forms tested above. It is an observed integration reference, not a provider-published guarantee or exhaustive inventory of every service or account entitlement.
