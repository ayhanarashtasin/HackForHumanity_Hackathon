# AkashSathi (আকাশসাথী)

[![CI](https://github.com/ayhanarashtasin/HackForHumanity_Hackathon/actions/workflows/ci.yml/badge.svg)](https://github.com/ayhanarashtasin/HackForHumanity_Hackathon/actions/workflows/ci.yml)

**Bangladesh-focused weather intelligence and occupation-aware alerts.**

AkashSathi, meaning "sky companion," helps people understand how local weather may affect their work and daily activities. Developed for HackForHumanity, it combines an interactive weather map, English and Bangla guidance, an anonymous alert inbox, and optional messaging integrations for farmers, fishermen, construction workers, vendors, students, and rickshaw pullers.

> **Project status: prototype.** AkashSathi is not an official warning service or a replacement for Bangladesh Meteorological Department (BMD) guidance. Alert thresholds are marked `prototype` and have not been expert-validated. Missing, stale, or unavailable data must never be interpreted as safe conditions.

## Table of contents

- [Features](#features)
- [Technology stack](#technology-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Using the application](#using-the-application)
- [Architecture](#architecture)
- [Messaging integrations](#messaging-integrations)
- [Data sources and coverage](#data-sources-and-coverage)
- [API overview](#api-overview)
- [Project structure](#project-structure)
- [Development commands](#development-commands)
- [Testing](#testing)
- [Deployment](#deployment)
- [Security and privacy](#security-and-privacy)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License and attribution](#license-and-attribution)

## Features

| Capability | Description |
| --- | --- |
| Interactive weather map | Temperature, computed heat index, rainfall, wind, and thunderstorm potential across 64 districts and 544 BMD forecast locations, with radar, satellite, and automatic route-weather summaries. |
| Occupation-aware alerts | Scenario-based guidance using a subscriber's occupation, selected areas, activity, and work context. Cards include severity, evidence, source, validity, and recommended actions. |
| Anonymous profiles | Browser-based registration without an account, name, email address, or phone number. Profiles support editing, pausing, deletion, and temporary activity changes. |
| Optional external delivery | Telegram, WhatsApp, and SMS copies of inbox alerts, with verified connections, quiet hours, delivery limits, and retries. |
| Telegram weather reports | English and Bangla weather commands, including `/route start to destination`, interactive report buttons, and a scheduled morning forecast for connected profiles. |
| Administrator dashboard | Alert previews, manual declarations, messages, withdrawals, severity holds, hazard switches, delivery health, and isolated demo audiences. |
| Bilingual interface | Persistent বাংলা / English switching across public and admin screens, localized dates and numbers, and a self-hosted Bengali font with responsive text layouts. |
| Cached forecasts and history | Background collection, persisted snapshots, per-source freshness indicators, and compact district-level forecast history. |

## Technology stack

| Layer | Technologies |
| --- | --- |
| Frontend | React 19, Vite 8, MapLibre GL JS 6, CSS |
| Backend | Node.js 22.12+, Express 5 |
| Database | MongoDB, Mongoose 9 |
| Messaging | Telegram Bot API, WhatsApp Business Cloud API, Twilio or a configurable HTTP SMS gateway |
| Tooling | npm workspaces, Node.js test runner, concurrently, Mapshaper |

The frontend uses a lightweight History API router. Map, alert, and administrator pages are loaded separately to avoid loading the map bundle on the landing page. Visual tokens and weather-color conventions are documented in [`docs/design.md`](docs/design.md).

## Getting started

### Prerequisites

- **Node.js 22.12 or later**, with npm.
- **MongoDB**, either running locally or accessible through MongoDB Atlas.
- Internet access for weather collection and map imagery. Provider credentials are optional for the core map and website inbox.

### 1. Install dependencies

Clone the repository if you do not already have a local checkout:

```sh
git clone https://github.com/ayhanarashtasin/HackForHumanity_Hackathon.git
cd HackForHumanity_Hackathon
```

From the repository root, install dependencies:

```sh
npm ci
```

This installs both workspaces using the committed lockfile. Use `npm install` when intentionally changing dependencies.

### 2. Configure the server

Copy [`server/.env.example`](server/.env.example) to `server/.env` using **one** of the following commands. Do not overwrite an existing environment file.

**macOS / Linux / Git Bash**

```sh
cp server/.env.example server/.env
```

**Windows PowerShell**

```powershell
Copy-Item server/.env.example server/.env
```

The example is configured for a local MongoDB instance:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/environmental_hackathon
PORT=5000
CLIENT_ORIGIN=http://localhost:5173
```

For Atlas, replace `MONGODB_URI` with your connection string, including a dedicated database name. Keep credentials in `server/.env`; never commit them.

### 3. Start development servers

```sh
npm run dev
```

| Service | Local address |
| --- | --- |
| Landing page | <http://localhost:5173> |
| Weather map | <http://localhost:5173/map> |
| Alert registration and inbox | <http://localhost:5173/alert> |
| Administrator dashboard | <http://localhost:5173/admin> — requires administrator setup |
| API health and source freshness | <http://localhost:5000/api/health> |

Vite proxies `/api` requests to the backend. Collection starts after the API connects to MongoDB; the first forecast may take time to arrive. Existing forecast snapshots are restored when weather jobs are enabled.

**Quota-safe development:** leave Xweather credentials unconfigured, or set both `LIGHTNING_ENABLED=off` and `ALERT_XWEATHER=off`. Adding valid credentials with the default switches enabled allows background jobs to spend the provider allowance.

Generated boundaries and location catalogues are already committed. Geography builds are not required for normal setup.

## Configuration

Server configuration is loaded from `server/.env`. The complete template is [`server/.env.example`](server/.env.example); validation and additional tuning options are defined in [`server/src/config/env.js`](server/src/config/env.js). Restart the backend after changing environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment; use `production` on a deployed server. |
| `PORT` | `5000` | API listening port. |
| `MONGODB_URI` | Local MongoDB URI | Database connection string. |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Frontend origin allowed by CORS and the origin guard. |
| `PUBLIC_URL` | `http://localhost:5173` in the example | Website address used in external message links. |
| `TRUST_PROXY` | `0` | Number of trusted reverse-proxy hops; match the deployment topology. |
| `WEATHER_JOBS` | `on` | BMD, Open-Meteo, radar, and satellite collectors. Does not disable the alert engine, lightning campaign, or delivery. |
| `WEATHER_HISTORY_DAYS` | `60` | District-summary retention; `0` disables recording new history. |
| `LIGHTNING_ENABLED` | `on` | Scheduled Xweather map-summary campaign, when credentials are present. |
| `ALERT_ENGINE` | `on` | Automatic hazard detection and notification publication. |
| `ALERT_TICK_MINUTES` | `2` | Alert-engine cycle interval. |
| `ALERT_XWEATHER` | `on` | Alert-engine Xweather requests, when credentials are present. |
| `ALERT_BULLETINS` | `on` | Official BMD bulletin checks within the alert engine. |
| `ALERT_BMD_RAIN_VERIFIED` | `off` | Enables BMD rainfall amounts for thresholds only after their units have been verified. |
| `ADMIN_PASSCODE` | Unconfigured placeholder | Enables administrator login with a non-placeholder passcode of at least 8 characters. |
| `ADMIN_AUTH` | `on` | Set `off` only for local loopback demos; the bypass is ignored in production. |
| `DELIVERY` | `on` | External delivery, the Telegram bot, and its morning-digest job. Unconfigured channels remain idle. |
| `CHANNEL_SECRET` | Unconfigured placeholder | Phone-number encryption secret for WhatsApp and SMS; at least 16 random characters. |
| `MORNING_DIGEST` | `on` | Scheduled Telegram morning weather message. |
| `MORNING_DIGEST_TIME` | `06:00` | Digest send time in `Asia/Dhaka`, using 24-hour `HH:mm` format. |
| `MORNING_DIGEST_GRACE_HOURS` | `4` | Catch-up window after the scheduled time. |
| `DNS_SERVERS` | Unset | Optional comma-separated DNS servers for Atlas SRV-resolution problems. |

To run without background provider collection or messaging, set:

```dotenv
WEATHER_JOBS=off
LIGHTNING_ENABLED=off
ALERT_ENGINE=off
DELIVERY=off
```

This is useful for isolated API work, not an offline weather mode: map tiles still need connectivity, and forecast snapshots are not restored into memory when `WEATHER_JOBS=off`.

## Using the application

### Pages

| Route | Purpose |
| --- | --- |
| `/` | Project introduction, division atlas, coverage information, occupation guidance, and attribution. |
| `/map` | Weather layers, radar and satellite playback, forecast timeline, bilingual place search, and shareable map views. |
| `/alert` | Bilingual registration, inbox, profile controls, channel connections, source coverage, and official-document references. |
| `/admin`, `/admin/login` | Protected administration and demo tools; not linked from public navigation. |

### Occupation-aware alerts

1. Open `/alert` and select an occupation, home/work areas, relevant activity, and language.
2. Receive scenario-based notifications in the website inbox. Each card explains the hazard, why it applies, its validity, and the supporting data.
3. Optionally connect a messaging channel under **Alerts on your phone**.
4. Edit, pause, or delete the profile, or temporarily update the current activity.

An HttpOnly cookie identifies the browser; the server stores only its token hash. Profiles are not portable between devices, and clearing site data removes access to the existing profile.

The engine evaluates monitored areas every two minutes by default. Weather scenarios use cached forecasts; optional Xweather data adds hourly, maritime, WBGT, and lightning coverage. Verified, dated North Bay marine notices can generate fisherman alerts. Other bulletin products remain reference links when scope, timing, or document structure cannot be verified.

Automatic publication is the default. Administrators can hold selected severities as drafts or disable individual hazard types. Stale data may annotate an existing alert but must not create, escalate, or rewrite it. Lightning alerts are always `CRITICAL`; expiry and withdrawal do not imply an all-clear.

### Administrator setup and demo

Set a strong `ADMIN_PASSCODE` in `server/.env`, restart the backend, and open `/admin`. `ADMIN_AUTH=off` is a local-only demonstration bypass and produces a startup warning.

For a demonstration, use **Settings** to create a demo audience in a selected upazila, preview a weather alert or manual declaration, confirm the send, and inspect its read-only **View as** inbox. Use **History → Withdraw** to demonstrate withdrawal. Demo notifications are isolated from live subscribers and external delivery. Unsupported declarations and `CRITICAL` sends require additional confirmation; confirmed sends and withdrawals are audited.

### Weather map

- **Weather layers:** temperature, heat index, rain, wind, and thunderstorm potential. District summaries appear at lower zoom levels; detailed locations appear as you zoom in.
- **Radar:** Dhaka and Rangpur BMD radar, with 10-minute frames covering the last three hours.
- **Satellite:** Himawari-9 infrared and visible imagery via NASA GIBS; imagery is delayed, not instantaneous.
- **Timeline:** switch between imagery playback and three-hourly forecasts for approximately four days.
- **Route weather:** choose a start and destination from the Bangladesh place list. The app selects the fastest driving route automatically, draws it on the map, and summarizes heat index, rain, wind, and thunderstorm potential along the journey. The route service receives the selected place coordinates; this is a fastest-road route, not a weather-optimized route.
- **Telegram route report:** send `/route Savar to Chattogram` or `/route Savar থেকে Chattogram`. The bot returns estimated distance/time and weather at sampled route locations. Add the district when a place name is ambiguous.
- **Search and sharing:** search in English or Bangla; the URL hash preserves the map view and selected layers. Legacy `/#view=...` links redirect to `/map`.
- **Language:** search, controls, tooltips, and area details support Bangla. Map canvas labels remain English because the hosted glyphs and WebGL text shaping do not support Bengali reliably. Delivered messages and official quotations retain their original language; Bengali copy still needs fluent-human review.
- **Data interpretation:** grey means no data. Forecasts are not station observations, thunderstorm potential is not a detected strike, and computed heat index is not an on-site WBGT measurement.
- **Route provider:** road geometry comes from the public OSRM routing service. It can be unavailable and has no project-controlled uptime; route distances, ETAs, and sampled weather are estimates.

## Architecture

**Collect in the background, persist, then serve cached data.** Forecast page views and Telegram weather commands do not trigger upstream weather requests.

```text
BMD / Open-Meteo / Xweather / official bulletins
                     |
              Background jobs
         fetch -> normalize -> validate
                     |
         MongoDB + in-memory forecast cache
             |                    |
        Express API          Alert engine
             |                    |
     React application       Notifications
                                  |
                           Delivery queue
                                  |
                       Telegram / WhatsApp / SMS

Stored forecasts -> Telegram commands + morning-digest job
```

This separates provider availability and quota usage from visitor traffic. Last successful data is retained with explicit freshness states: `ok`, `stale`, `unavailable`, or `not-checked`.

| Model | Responsibility |
| --- | --- |
| `ForecastSnapshot` | Latest normalized BMD and Open-Meteo payloads, restored on startup with weather jobs enabled. |
| `WeatherRun` | Compact district summaries for trends and back-testing; TTL cleanup defaults to 60 days. |
| `WeatherSnapshot` | Cached normalized provider queries for forecast, maritime, and lightning processing. |
| `LightningCampaign`, `LightningSample` | Scheduled map lightning-summary campaign and results. |
| `HazardEvent`, `Notification`, `Delivery` | Hazard lifecycle, subscriber inbox, and external delivery state. |
| `MorningDigest` | Per-subscriber, per-day digest progress and outcomes, retained for 30 days without message text or chat IDs. |

History stores district summaries rather than every full-resolution forecast. For example: `GET /api/weather/history?district=3026&source=bmd&days=7`.

**Imagery exceptions:** radar images are fetched on demand through an allowlisted, in-memory-cached BMD proxy because upstream images lack CORS headers. Satellite and basemap tiles load directly in the browser from NASA GIBS and OpenFreeMap; they are not stored in MongoDB.

## Messaging integrations

The website inbox is the primary alert record. Optional channels send short copies of stored notifications; they do not evaluate weather independently. Set `DELIVERY=off` to disable the entire messaging layer.

| Channel | Connection | Default severity | Daily cap per subscriber |
| --- | --- | --- | --- |
| Telegram | One-time bot link; no phone number required | `ADVISORY` and above | 20 |
| WhatsApp | Consented Bangladeshi mobile number, verified by code | `WARNING` and above | 6 |
| SMS | Consented Bangladeshi mobile number, verified by code | `WARNING` and above | 6 |

Routine messages respect quiet hours and caps; **`CRITICAL` alerts bypass both**. Draft, demo, withdrawn, expired, stale-data, and superseded stages are excluded. By default, updates older than three hours are not delivered externally. Temporary failures retry with backoff, and blocked destinations are disconnected.

Unique delivery keys and worker leases prevent routine duplicate processing. They do **not** guarantee exactly-once provider delivery: a crash after a provider accepts a message but before the database records success can result in a duplicate.

### Telegram setup

1. Create a bot through [@BotFather](https://t.me/BotFather) using `/newbot`.
2. Set `TELEGRAM_BOT_TOKEN` and `PUBLIC_URL` in `server/.env`, then restart the backend.
3. Open `/alert` → **Alerts on your phone** → **Connect Telegram** → **Open Telegram** → **Start**.

Without `TELEGRAM_WEBHOOK_URL`, the backend uses polling, which works locally. For a webhook deployment, configure:

```dotenv
TELEGRAM_WEBHOOK_URL=https://your-domain.example/api/channels/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=replace_with_a_random_webhook_secret
```

The webhook requires public HTTPS and a secret containing 16–256 characters from `A–Z`, `a–z`, `0–9`, `_`, or `-`. The backend registers it at startup and verifies Telegram's secret header. The bot handles private chats only; `/help` explains usage and `/stop` disconnects the chat.

### Telegram weather commands

Weather commands are available with or without a connected profile and read stored forecasts only.

| Command | Report |
| --- | --- |
| `/update [place]` | Current three-hour forecast step, next 12 hours, latest lightning check, stale-data warnings when applicable, and report buttons. |
| `/heat [place]` | Temperature, heat index, next-24-hour peak, category, and practical guidance. |
| `/rain [place]` | Next-24-hour total and wettest interval, plus a three-hourly timeline for the next 12 hours with rainfall probability. |
| `/wind [place]` | Wind, gusts, and the strongest forecast gust in the next 24 hours. |
| `/thunderstorm [place]` | Forecast thunderstorm potential and any modeled thunderstorm or hail conditions. |
| `/lightning [place]` | Latest stored lightning checks and their age, not continuous strike monitoring. |
| `/forecast [place]` | Multi-day temperature, rainfall, wind, and thunderstorm outlook. |
| `/alerts` | Active inbox alerts for the connected profile. |
| `/status` | Source freshness and the alert engine's latest run. |

Examples: `/heat Badda`, `/rain বাড্ডা`, `/wind Savar, Dhaka`, or `/forecast Badda bn`. Places may be upazilas, city thanas, districts, or city corporations; ambiguous names return candidates. Connected chats can omit the place to use up to two saved areas. Aliases include `/weather`, `/thunder`, `/storm`, and `/days`.

A trailing `bn` or `en` selects the language; otherwise the bot uses profile, place-script, or Telegram language preferences. Compact report headings identify forecasts, stale data carries an update-time warning, and `/status` lists source freshness and age. Missing values are never presented as zero, and "no active alert" is not an all-clear. Rain amounts prefer current Open-Meteo data because BMD rainfall units remain unconfirmed. The default request limit is 30 commands per chat per 10 minutes (`TELEGRAM_COMMAND_LIMIT`).

### Morning weather message

By default, active, non-demo profiles with connected Telegram chats receive a daily forecast at **06:00 Asia/Dhaka**, with one message for each saved area, up to two areas. Each report includes temperature range, heat guidance, rain, wind, thunderstorm potential, the latest lightning check, active-alert count, day-part forecasts, a brief tomorrow outlook, and report buttons.

- `MORNING_DIGEST=off` disables the feature globally; `MORNING_DIGEST_TIME` changes the scheduled time.
- `MORNING_DIGEST_GRACE_HOURS` defaults to four hours. Catch-up and retries stay within that day's send window, which is at least 10 minutes and never extends past midnight.
- Missing or stale forecasts are deferred; uncovered places are skipped. Keep `WEATHER_JOBS=on` to populate the forecast cache.
- Quiet hours are respected. A database progress record coordinates ticks, restarts, and workers; completed area messages are not repeated during ordinary retries.
- Digests run outside the alert delivery queue, do not consume the Telegram alert cap, and are not included in administrator delivery counts.
- **There is no separate per-profile digest opt-in, time setting, or opt-out yet.** `/stop` disconnects Telegram for both digests and alerts.

### WhatsApp templates

Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `CHANNEL_SECRET`. Business-initiated messages require approved Meta templates:

1. **Alert template:** `WHATSAPP_ALERT_TEMPLATE` defaults to `akashsathi_alert`. Submit a Utility template in each enabled language (`WHATSAPP_TEMPLATE_LANG_EN` / `WHATSAPP_TEMPLATE_LANG_BN`) with exactly four body variables:

   ```text
   AkashSathi {{1}}: {{2}}

   {{3}}

   Valid until {{4}}. More details on the AkashSathi alerts page.
   ```

   Variables represent severity, title, message with sender attribution, and validity end time, respectively.

2. **Verification template:** set `WHATSAPP_OTP_TEMPLATE` to an approved Authentication template with a copy-code button. The verification code is passed as both the body variable and button parameter. Without it, WhatsApp remains unavailable.

### SMS gateways

Set `CHANNEL_SECRET` and choose `SMS_PROVIDER=twilio` or `SMS_PROVIDER=http`.

- **Twilio:** configure `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID`.
- **HTTP gateway:** configure `SMS_HTTP_URL`, `SMS_HTTP_METHOD`, and, for POST requests, `SMS_HTTP_CONTENT_TYPE` and `SMS_HTTP_BODY`. Optional headers use `SMS_HTTP_HEADERS`.
- Supported placeholders are `{to}` (`+8801712345678`), `{to_digits}` (`8801712345678`), `{to_local}` (`01712345678`), and `{text}`. JSON substitution escapes message values.
- Set `SMS_HTTP_SUCCESS_MATCH` when the gateway can return HTTP 200 for a rejected message. Examples are included in [`server/.env.example`](server/.env.example).

Use an appropriately registered sender ID. English SMS content is ASCII and limited to 320 characters; Bangla content is limited to 200 characters. WhatsApp and SMS may incur provider charges; confirm pricing before enabling them.

**Verification status:** automated delivery tests use mocked providers. The repository does not document successful validation against live Telegram, WhatsApp, or SMS accounts. Confirm credentials, templates, gateway response handling, and end-to-end delivery before public use.

## Data sources and coverage

| Source | Use | Important considerations |
| --- | --- | --- |
| BMD WRF forecast via `api.bdservers.site` | Temperature, rain, humidity, wind, gusts, cloud, three-hourly forecasts, and a 10-day outlook | Third-party host; no published uptime guarantee or confirmed usage terms. Rainfall units are not independently verified. |
| BMD radar (`radar.bmd.gov.bd`) | Radar frames and geographic bounds | Allowlisted server proxy for image access. |
| BMD bulletins (`bmd.gov.bd`) | Official marine, fishermen, and fleet documents | Only sufficiently verified, dated North Bay statements drive automatic marine notices. |
| Open-Meteo | Forecast fallback, rainfall, precipitation probability, and thunderstorm potential | Review attribution and free-tier/non-commercial usage terms. |
| NASA GIBS / JMA Himawari-9 | Infrared and visible satellite imagery | Browser-loaded tiles; delayed availability. |
| Xweather | Hourly forecasts, maritime conditions, WBGT, and lightning products | Optional server-side credentials; quota-controlled background requests. |
| OCHA/HDX COD-AB | Administrative boundaries | 495 upazila polygons, 12 city corporations, 64 districts, and 8 divisions in generated data; CC BY-IGO attribution. |
| OpenFreeMap / OpenStreetMap | Basemap | Preserve map attribution and applicable usage terms. |

District forecasts are derived from upazila values, not separately published BMD district forecasts. Some city thanas use markers rather than their own polygons; some newer administrative areas use a nearby forecast location. The map flags these approximations, but equivalent alert coverage labeling remains a known gap. Map-rendered place labels are English; search, tooltips, and panels support Bangla.

### Lightning campaign

The map campaign uses Xweather's `lightning/summary/closest` endpoint for aggregate search-circle counts, not individual strike coordinates. Configure `XWEATHER_CLIENT_ID` and `XWEATHER_CLIENT_SECRET` to enable it.

- Default duration: **10 days**, with at most **30 slots**, scheduled at **07:00, 15:00, and 23:00 Asia/Dhaka**.
- **Mode A:** 20 km searches per upazila, chosen only when the campaign fits the available budget after the reserve.
- **Mode B:** 14 circles of 100 km covering Bangladesh, used when per-upazila sampling does not fit. With the example allowance of 14,817 tokens, a reserve of 100, and assumed cost of one token per request, this is the selected mode.
- The selected mode is locked for the campaign. Database keys and leases coordinate workers; request cost is settled using provider headers, and authentication failures stop collection.

Each sample covers a five-minute interval. It is **not** continuous monitoring or a daily total; circle counts are not upazila counts, and overlapping circles are never summed. The alert engine's gated lightning probes are separate from this map campaign. Populated live lightning payloads remain unverified.

## API overview

The local API base is `http://localhost:5000/api`. Most JSON endpoints return `{ "data": ... }`; application errors use `{ "message": "..." }`. `/health` returns top-level health fields, and radar image endpoints return image data.

| Method | Endpoint | Purpose / access |
| --- | --- | --- |
| `GET` | `/api/health` | Database health and source freshness; `200` when connected, `503` otherwise. A healthy database does not imply fresh weather data. |
| `GET` | `/api/weather/snapshot`, `/api/weather/daily` | Cached forecasts and BMD daily outlook. |
| `GET` | `/api/weather/history?district=3026&source=bmd&days=7` | District run summaries; sources: `bmd`, `openMeteo`; lookback: 1–60 days. |
| `GET` | `/api/radar/frames`, `/api/radar/image/:site/:file` | Radar frame index and proxied images. |
| `GET` | `/api/satellite/frames` | Available satellite times and tile URL template. |
| `GET` | `/api/lightning/status`, `/api/lightning/summaries`, `/api/lightning/upazila/:pcode` | Map-campaign status and results. |
| `GET` | `/api/alerts/schema`, `/api/alerts/status` | Registration schema and monitoring status. |
| `POST` | `/api/alerts/subscribe` | Create an anonymous browser profile. |
| `GET` | `/api/alerts/session` | Current session, including `profile: null` for a new visitor. |
| `GET`, `PUT`, `DELETE` | `/api/alerts/me` | Read, edit, or delete the current profile; subscriber cookie required. |
| `PUT` | `/api/alerts/me/activity`, `/api/alerts/me/status` | Temporary activity and pause/resume controls; subscriber cookie required. |
| `GET` | `/api/alerts/me/coverage`, `/api/alerts/inbox` | Personal coverage and inbox; subscriber cookie required. |
| `POST` | `/api/alerts/inbox/:id/read`, `/api/alerts/inbox/read-all` | Mark notifications read; subscriber cookie required. |
| `GET` | `/api/alerts/me/channels` | Channel availability and masked connection state; subscriber cookie required. |
| `POST` | `/api/alerts/me/channels/telegram/link` | Create a one-time Telegram connection link; subscriber cookie required. |
| `POST` | `/api/alerts/me/channels/:channel/start`, `/api/alerts/me/channels/:channel/verify` | Phone verification for `whatsapp` or `sms`; subscriber cookie required. |
| `DELETE` | `/api/alerts/me/channels/:channel` | Disconnect a channel; subscriber cookie required. |
| `POST` | `/api/channels/telegram/webhook` | Receive Telegram updates; configured secret header required. |
| `GET` | `/api/admin/session` | Administrator session state: `closed`, `signed-out`, or `signed-in`. |
| Various | `/api/admin/*` | Login plus protected overview, previews, sends, withdrawals, rules, settings, and demo tools. |

See [`server/src/routes/`](server/src/routes) and [`server/src/controllers/`](server/src/controllers) for request handling. Browser state-changing requests are origin-checked and must use JSON when a body is present.

## Project structure

```text
.
├── client/
│   ├── public/data/          Generated boundaries and location catalogue
│   ├── src/
│   │   ├── pages/            Landing, map, alert, and administrator pages
│   │   ├── map/              MapLibre layers, imagery, and interactions
│   │   ├── alert/            Registration, inbox, profiles, and channels
│   │   ├── admin/            Administrator dashboard views
│   │   ├── components/       Shared UI components
│   │   ├── lib/              Routing, scales, time, and UI utilities
│   │   └── services/         API clients
│   └── test/                 Client tests
├── server/
│   ├── data/                 Generated locations and lightning coverage
│   ├── src/
│   │   ├── config/           Environment, database, and alert rules
│   │   ├── controllers/      HTTP request handlers
│   │   ├── routes/           API route definitions
│   │   ├── middleware/       Authentication, origin checks, and limits
│   │   ├── models/           Mongoose schemas and indexes
│   │   ├── jobs/             Weather, alert, delivery, and digest scheduling
│   │   └── services/
│   │       ├── alerts/       Hazards, scenarios, notifications, and admin
│   │       └── delivery/     Queue, linking, adapters, bot reports, digest
│   ├── test/                 Unit and MongoDB-backed integration tests
│   └── .env.example          Server configuration template
├── scripts/                  Geography generators and database-test preload
├── docs/                     Design, plans, provider notes, and project status
├── package.json              Workspace scripts
└── package-lock.json         Reproducible dependency lockfile
```

## Development commands

Run these commands from the repository root.

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the backend watcher and frontend development server together. |
| `npm run dev:server` | Start only the backend watcher. |
| `npm run dev:client` | Start only the frontend development server. |
| `npm run build` | Build the frontend into `client/dist`. |
| `npm run preview` | Preview the frontend build on port 4173 with an `/api` proxy; start the backend separately. |
| `npm start` | Start the API without a watcher; does not serve the frontend. |
| `npm test` | Run client and server tests; database cases require `TEST_MONGODB_URI`. |
| `npm run test:db` | Run the full server suite with a MongoDB test connection. |
| `npm run build:geo` | Regenerate boundaries, location catalogues, and lightning coverage. |
| `npm run build:outline` | Regenerate the landing-page Bangladesh silhouette. |

### Geography

`npm run build:geo` downloads and caches HDX sources in the ignored `scripts/.cache/` directory, simplifies boundaries, joins BMD location codes, resolves unmatched areas, and verifies the lightning circle cover. Use `npm run build:geo -- --refresh` to refresh downloaded sources. Review and commit intentional generated-data changes in `client/public/data/` and `server/data/`.

## Testing

```sh
npm test
npm run test:db
npm run build
```

- Tests use the built-in Node.js test runner. `npm test` runs both workspaces; MongoDB-backed cases are skipped unless `TEST_MONGODB_URI` is set, even if the application database is running.
- `npm run test:db` runs server tests and defaults `TEST_MONGODB_URI` to the configured `MONGODB_URI`. It also preloads `DNS_SERVERS` for Atlas connections. Client tests remain part of `npm test`.
- Each database-backed test file creates and removes its own randomly named `mern_test_*` database. Use a dedicated test MongoDB deployment or user with permission to create and drop those databases; never point tests at a production deployment.
- Provider responses are mocked; tests do not spend Xweather quota or send real Telegram, WhatsApp, or SMS messages.

For verification history and remaining gaps, see [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md). Automated tests do not replace live-provider, accessibility, language, or expert threshold validation.

### Continuous integration

The [GitHub Actions workflow](.github/workflows/ci.yml) runs on pushes to `main`, pull requests, and manual dispatch. It installs locked dependencies, runs both workspace test suites against an isolated MongoDB 8 service, and builds the frontend using Node.js 22. No weather or messaging credentials are required. Actions are pinned to commit SHAs, and workflow permissions are read-only.

## Deployment

The frontend and API are separate deployment artifacts. The Express application does **not** serve `client/dist`, and `vite preview` is for local inspection, not production hosting.

1. Install locked dependencies with `npm ci` and build the frontend with `npm run build`.
2. Host `client/dist` on a static host or web server. Configure SPA fallback to `index.html` for `/map`, `/alert`, `/admin`, and `/admin/login`.
3. Run the backend with `npm start` under a process manager or managed Node.js service with persistent MongoDB access.
4. Prefer one public origin, routing `/api/*` to Express. Frontend requests use relative `/api` paths; serving the API on a different origin requires additional proxy or client configuration.
5. Set `NODE_ENV=production`, `CLIENT_ORIGIN`, `PUBLIC_URL`, a strong `ADMIN_PASSCODE`, and the correct `TRUST_PROXY` value. Keep `ADMIN_AUTH=on` and terminate public traffic with HTTPS.
6. Keep a backend worker running for collection, alerts, and delivery. Monitor `/api/health`, source freshness, logs, provider quota, and delivery failures; arrange database backups.
7. Validate live messaging integrations, data licensing, and the limitations below before any public rollout.

The backend port defaults to 5000. If changing it locally, update the Vite proxy using `API_PROXY_TARGET` in the client environment, for example `API_PROXY_TARGET=http://127.0.0.1:5001`.

## Security and privacy

- **Secrets:** `server/.env` is ignored by Git. Example placeholders are treated as unconfigured credentials. Never expose provider secrets in frontend code, screenshots, issues, or logs; rotate any exposed credential.
- **Anonymous profiles:** subscriber tokens use HttpOnly cookies and SHA-256 hashes at rest. Profiles store selected area codes rather than exact user coordinates; no name or email is required.
- **Request protection:** origin checks, JSON body restrictions, signup rate limits, a honeypot, subscriber caps, and administrator login limits reduce misuse. Rate-limit state is process-local; horizontal deployments need an additional shared or edge-level strategy.
- **Administrator access:** the dashboard uses a shared passcode, not a full multi-user authorization system. Use a long random passcode and appropriate network restrictions.
- **Channel ownership:** Telegram links are one-time and expire after 15 minutes. WhatsApp and SMS require explicit consent and a six-digit verification code, with expiry, attempt limits, and request throttling.
- **Phone storage:** only verified Bangladeshi mobile numbers are accepted, encrypted with AES-256-GCM, and masked in the interface. Changing `CHANNEL_SECRET` makes stored numbers unreadable and requires users to verify again.
- **Message privacy:** external content excludes occupations, profile answers, and selection reasons. Telegram uses a stored chat ID; removing a profile also removes its delivery records.

## Known limitations

- Alert rules and hazard thresholds remain a prototype and need domain-expert review.
- Bangla content requires fluent-speaker review. Physical-device and screen-reader validation is not documented as complete.
- BMD rainfall units are unconfirmed; leave `ALERT_BMD_RAIN_VERIFIED=off` until independently verified. Some BMD gust values are lower than mean wind; bot reports compensate, but the alert engine still uses published gusts.
- Lightning sampling is intermittent and can miss events. Populated Xweather strike, threat, and summary payloads require live validation; threat matching currently uses representative points rather than full administrative polygons.
- River-port, fleet C-90, and unfamiliar bulletin layouts may be reference-only. Official-warning classification still needs validation against live warning documents.
- Some planned scenarios, precise approximate-coverage labels, profile recovery, and rule-editing tools are incomplete.
- Automatic hazard withdrawals may not remain withdrawn if a later forecast creates another qualifying event; use per-hazard switches when a durable detection stop is required.
- Messaging adapters have mocked-provider coverage, not documented live-account validation. Daily digests have no independent subscriber opt-out, and external sends are not exactly-once.
- The shared Xweather budget ledger and administrator budget projections remain incomplete. Monitor actual provider usage rather than assuming complete cross-job accounting.
- MapLibre produces a large production chunk, and software-rendered WebGL may be slow without GPU acceleration.

See [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for the detailed implementation gaps and invariants to preserve.

## Troubleshooting

| Problem | Checks / resolution |
| --- | --- |
| API fails to start | Confirm MongoDB is running or Atlas is reachable; check `MONGODB_URI`, credentials, and Atlas network access rules. |
| Atlas reports `querySrv ECONNREFUSED` | Investigate DNS/network restrictions. If appropriate for your network, set `DNS_SERVERS=8.8.8.8,1.1.1.1` and restart. |
| Forecast layers show no data | Allow the first collection to finish, inspect `/api/health` source states, and confirm `WEATHER_JOBS=on`. Missing data is intentionally not displayed as calm weather. |
| Frontend cannot reach the API | Start the backend and check the Vite `/api` proxy target or production reverse-proxy routing. |
| Vite port is already in use | Ports 5173 and 4173 are strict; stop the conflicting process or explicitly adjust the Vite configuration and allowed origin. |
| Administrator dashboard is disabled | Replace the `ADMIN_PASSCODE` placeholder with a value of at least 8 characters, then restart the backend. |
| Database tests are skipped | Run `npm run test:db`, or explicitly set `TEST_MONGODB_URI` before `npm test`. |
| Messages are not delivered | Confirm `DELIVERY=on`, valid channel credentials, verified connections, severity settings, quiet hours, alert validity, and provider responses. |
| Morning forecast is missing | Check Telegram connection, active profile, saved area, current forecast, digest settings, quiet hours, and the send window. |

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) | Implemented capabilities, verification history, known gaps, and invariants. |
| [`docs/ALERT_ENGINE_PLAN.md`](docs/ALERT_ENGINE_PLAN.md) | Alert architecture, design decisions, thresholds, and reference material. |
| [`docs/AkashSathi_Occupation_Based_Scenario_Catalogue.md`](docs/AkashSathi_Occupation_Based_Scenario_Catalogue.md) | Occupation scenarios and cross-cutting alert requirements. |
| [`docs/BMD_WEATHER_API.md`](docs/BMD_WEATHER_API.md) | Verified BMD endpoint behavior and normalization notes. |
| [`docs/design.md`](docs/design.md) | Visual identity, design tokens, severity colors, and weather ramps. |

## Contributing

Keep changes focused and consistent with the existing workspace structure. Include tests for behavioral changes, update affected documentation, and run `npm test`, `npm run test:db` with a dedicated test database, and `npm run build` before proposing changes.

Preserve the project's core guarantees: no provider fetches from forecast page views, no stale-data escalation, no all-clear wording on expiry or withdrawal, no profile answers in external messages, and no external delivery to demo audiences. Do not change safety thresholds without documenting their source and validation status.

When reporting a problem, include reproduction steps, expected and actual behavior, Node.js version, and sanitized logs. Never include environment files, connection strings, bot tokens, phone numbers, or subscriber cookies.

## License and attribution

No project `LICENSE` file is currently included. Do not assume an open-source license; clarify project reuse and distribution permissions with the maintainers. Third-party data and dependencies retain their respective licenses and usage terms.

- Forecasts and radar: © Bangladesh Meteorological Department.
- Himawari-9 imagery: © Japan Meteorological Agency, via NASA GIBS.
- Supplementary forecasts: Open-Meteo, with CC BY 4.0 attribution and applicable service terms.
- Administrative boundaries: OCHA/HDX COD-AB, CC BY-IGO.
- Basemap: OpenFreeMap, © OpenMapTiles, and © OpenStreetMap contributors.
