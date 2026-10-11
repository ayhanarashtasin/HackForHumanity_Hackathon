# HackForHumanity_Hackathon — AkashSathi

**AkashSathi** (আকাশসাথী, "sky companion") turns Bangladesh weather data into something a farmer, fisherman, builder, vendor, student or rickshaw puller can act on.

- **A live weather map** (`/map`) in the style of [Zoom Earth](https://zoom.earth): heat, rain, temperature, wind and thunderstorm signs for every district and upazila, over BMD radar and Himawari satellite imagery.
- **Occupation-aware alerts** (`/alert`): tell it your work and where you do it, and when the weather crosses a threshold that matters for your job an alert appears with the reason, the source, the validity and what to do. English and Bangla. No account.
- **Telegram, WhatsApp and SMS delivery** (optional): a short copy of each alert on the phone, with consent, quiet hours and per-channel limits. The Telegram bot also answers weather commands (`/update`, `/heat`, `/rain`, `/wind`, `/thunderstorm`, `/lightning`, `/forecast`, `/alerts`, `/status`) in English and Bangla.
- **An administrator dashboard** (`/admin`): preview and send alerts, declare a hazard, withdraw, watch the engine and delivery health.

> **This is a prototype, not an official warning service.** Alert thresholds are labelled `prototype`: they are set from published references and have not been reviewed by experts. Unknown, stale or missing data is never shown as calm weather.

Stack: **MongoDB, Express 5, React 19, Node.js**, MapLibre GL, Vite, npm workspaces. UI colors follow [`docs/design.md`](docs/design.md) (Soft White, Sage Green, Deep Olive); weather data layers use the semantic ramps defined there.

## Contents

[How data reaches the screen](#how-data-reaches-the-screen) · [Getting started](#getting-started) · [Pages](#pages) · [Occupation-aware alerts](#occupation-aware-alerts) · [Telegram, WhatsApp and SMS](#telegram-whatsapp-and-sms) · [Telegram weather commands](#telegram-weather-commands) · [The map](#what-the-map-shows) · [Data sources](#data-sources) · [Lightning campaign](#lightning-campaign) · [API](#api) · [Layout and commands](#project-layout) · [Documentation](#documentation) · [Security and privacy](#security-and-privacy)

## How data reaches the screen

**The rule: collect in the background, store in MongoDB, serve from the store.** No page view ever triggers a request to a weather provider.

```text
 BMD forecast ─┐                         ┌─ ForecastSnapshot  latest forecast (restored on restart)
 Open-Meteo ───┤  background jobs        ├─ WeatherRun        compact per-district history of every run
 Xweather ─────┼─► fetch · validate ───► ├─ WeatherSnapshot   Xweather forecast / maritime / lightning, per query
 BMD bulletins ┤   (own schedule,        ├─ Lightning*        the 10-day lightning campaign
 BMD radar ────┘    own token budget)    └─ HazardEvent · Notification · Delivery   alerts and what was sent
                                                     │
                       Express API: reads MongoDB or the in-memory copy only
                                                     │
                                  React pages (map, alerts, admin)
```

Why store first instead of fetching on demand:

- **Provider limits.** The Xweather allowance is about 15,000 tokens per period, shared by the lightning campaign and the alert engine. Fetching per page view would exhaust it; one background fetch is shared by every reader.
- **Outages.** BMD's forecast API is a third-party host with no published uptime. The last good data is kept and clearly labelled `stale`, and Open-Meteo is the fallback.
- **The data is useful afterwards.** The alert engine needs the forecast to evaluate hundreds of subscribers, and earlier runs are kept (compactly) for trends and back-testing.
- **Honest freshness.** Every source has its own status (`ok`, `stale`, `unavailable`, `not-checked`) recorded when it was last checked.

What is stored, and for how long:

| Collection | Contents | Size | Kept |
| --- | --- | --- | --- |
| `forecastsnapshots` | Latest normalised BMD and Open-Meteo forecast (544 locations, 32 three-hourly steps) | about 4 MB | Replaced on every new run |
| `weatherruns` | One row per distinct run: per-district summaries (hottest upazila, heat index, gust, rainfall, humidity, probability, thunder potential) for the next 24 h and the whole horizon | about 20 KB per run | `WEATHER_HISTORY_DAYS` (default 60), then removed by a TTL index |
| `weathersnapshots` | Normalised Xweather forecast, maritime and lightning results, one per query | small | 48 h |
| `lightningcampaigns`, `lightningsamples` | The lightning summary campaign | small | Campaign length |
| `hazardevents`, `notifications`, `deliveries` | Detected hazards, personal alerts, and the log of external messages | small | Until the alert period ends plus 30 days |

Full-resolution history was rejected on purpose: storing every 3 MB run four times a day would add about 12 MB a day and fill a small Atlas tier within weeks. The per-district summary keeps what trends and back-testing need at under 1 % of the size. Read it with `GET /api/weather/history?district=3026&source=bmd&days=7`.

What is deliberately **not** stored: radar PNGs (proxied from BMD on first request and kept in a 400-image memory cache, because the images carry no CORS header; the frame index is re-read every 10 minutes), and satellite and basemap tiles (the browser loads them straight from NASA GIBS and OpenFreeMap, because imagery tiles do not belong in a database).

## Requirements

- Node.js **22.12 or newer**
- A running MongoDB (local service or an Atlas connection string)

## Getting started

```sh
npm install
```

Create `server/.env` from `server/.env.example` (local defaults work as-is). For MongoDB Atlas, set `MONGODB_URI` to your `mongodb+srv://` string with a dedicated database name in the path (for example `/environmental_hackathon`). If startup fails with `querySrv ECONNREFUSED`, Node cannot reach a DNS server: set `DNS_SERVERS=8.8.8.8,1.1.1.1`. Then:

```sh
npm run dev
```

- **Landing page:** http://localhost:5173
- **Map:** http://localhost:5173/map
- **Alerts:** http://localhost:5173/alert
- **API:** http://localhost:5000/api
- **Health and data freshness:** http://localhost:5000/api/health

The server starts collecting data a few seconds after boot (BMD forecast, Open-Meteo, radar, satellite) and keeps the latest snapshot in MongoDB, so a restart serves data immediately.

**Spending the Xweather allowance:** with credentials in `.env` the server starts the lightning campaign and the alert engine's Xweather calls. To run without touching the allowance (UI work, demos), start with `LIGHTNING_ENABLED=off` and `ALERT_XWEATHER=off`; everything else still works from the free BMD and Open-Meteo data.

The boundaries and location catalogue (`client/public/data/`, `server/data/`) are generated files that are committed. Rebuild them only when the sources change: `npm run build:geo` (see [Geography](#geography)).

## Pages

| Route | Page |
| --- | --- |
| `/` | Landing page: floating navbar with Alert and Map actions, hero, interactive Bangladesh division atlas, coverage facts, features, data guidance, occupation sections and attribution footer. |
| `/map` | The weather map below. A lazy-loaded chunk, so the landing page never downloads MapLibre. Old shared links of the form `/#view=...` are redirected here. |
| `/alert` | English/Bangla occupation-aware signup, browser-local alert inbox, profile and activity controls, **Alerts on your phone** (Telegram, WhatsApp, SMS), source coverage and dated official BMD documents. |
| `/admin`, `/admin/login` | Private administrator dashboard: overview (including delivery health), send from cached weather, declare a hazard, free message, history and withdrawal, rules, hold and kill switches, demo tools. |

A tiny History API router (`client/src/lib/router.js`) handles these routes; there is no router dependency. The administrator dashboard is not linked publicly.

## Occupation-aware alerts

Visitors choose one of six occupations, home and work areas, work context and language at `/alert`. No account, name, e-mail address or phone number is required to receive alerts in the inbox. An HttpOnly cookie identifies that browser, and only the token hash is stored. Clearing site data or changing devices starts a new profile. Subscribers can edit, pause, delete, or temporarily override their activity.

The background alert cycle runs every two minutes by default. It detects hazards once per monitored area, applies occupation scenarios, and automatically publishes de-duplicated notifications. Sources, evidence, validity, the reason a person was selected and the prototype-rule status are visible on every card.

- **Weather:** BMD and Open-Meteo cached forecasts, plus capped Xweather hourly forecasts and maritime/WBGT data through a shared token governor. BMD rain amounts stay disabled for alert thresholds until their units are confirmed.
- **Lightning:** forecast-gated probes plus daytime baselines, strike detail and threat polygons, one episode per area, always CRITICAL for eligible scenarios, at most two re-notifications. A check covers the previous five minutes: this is not continuous monitoring, and an unforecast storm can be missed.
- **Official BMD documents:** five product pages checked every 30 minutes. Original quoted text and PDF links appear separately. Verified North Bay marine warnings can create FISH-01 alerts; only a newer, effective, dated no-warning notice can withdraw one and create a FISH-03 reminder. Fleet area C-90, river coverage and unfamiliar PDF layouts remain reference links when their scope or timing cannot be verified. A blank page is never a withdrawal.
- **Honesty invariants** (enforced by tests): unknown or stale is never safe; stale data can only annotate an existing alert, never create, raise or rewrite one; no automatic all-clear on expiry or withdrawal; lightning is always CRITICAL; one card per subscriber, event and rule.

Per-severity **hold** defaults off. Turning it on keeps that severity as a draft until the administrator sends it (including raising an already-live card to a held severity). Per-hazard switches stop automatic detection. `ALERT_ENGINE=off`, `ALERT_XWEATHER=off` and `ALERT_BULLETINS=off` control the engine and provider jobs independently.

### Administrator setup and demo

Set `ADMIN_PASSCODE` (at least 8 characters, not the example placeholder) in `server/.env`, then open `/admin`. For a local loopback demo, `ADMIN_AUTH=off` skips the login; it is ignored in production and the server prints a warning at start-up. State-changing actions are audited.

1. Create an alert profile at `/alert`, for example Farmer → Badda → Harvesting.
2. At `/admin` → Send alerts, choose Farmer and preview cached weather alerts, declare heavy rain for Badda, or compose a free message.
3. Read the preview, then confirm Send. The inbox updates within 30 seconds. Unsupported declarations and CRITICAL sends need an extra confirmation.
4. Use History → Withdraw to demonstrate withdrawal without all-clear wording.
5. Settings can create one demo subscriber per occupation in a chosen upazila; select the demo audience for a demonstration and use its read-only *View as* inbox. Demo alerts never reach live subscribers or external channels.

## Telegram, WhatsApp and SMS

Alerts **always** reach the website inbox. On top of that, a person can connect any of three optional channels under **Alerts on your phone** at `/alert`. The delivery layer reads the stored notifications and sends a short copy; it never evaluates weather itself.

```text
 Notification (the inbox is the source of truth)
        │  every 30 s: queue what is new
        ▼
 Delivery row  ── unique on (notification, channel, stage) ──► at most one message per alert stage per channel
        │  claim · re-check at send time · send
        ▼
 Telegram Bot API   WhatsApp Cloud API (templates)   Twilio or any HTTP SMS gateway
```

| | Telegram | WhatsApp | SMS |
| --- | --- | --- | --- |
| Needs a phone number | No: a one-time link, the bot learns the chat | Yes, verified by a code | Yes, verified by a code |
| Default carries | all alerts | Warning and Critical | Warning and Critical |
| Cost | free | per template conversation | per message |
| Daily cap per person | 20 | 6 | 6 |

**Rules that hold for every channel**

- **Consent and proof of ownership.** Telegram connects only when the person opens their own one-time link (valid once, 15 minutes). WhatsApp and SMS ask for a Bangladeshi mobile number, an explicit consent tick, and a six-digit code sent to that number (valid 10 minutes, at most five tries counted atomically, one request a minute, five an hour per profile and three an hour per number). Nothing is ever sent to an unverified number.
- **Privacy (catalogue CTX-03).** Messages carry the alert, the area, the validity and who sent it. They never contain the occupation, the reason you were selected, or any profile answer. Phone numbers are stored AES-256-GCM encrypted with `CHANNEL_SECRET` and shown masked; Telegram stores only the chat id. Deleting the profile deletes the delivery log. Only Bangladeshi mobile numbers are accepted, which also closes the door on international SMS abuse.
- **Quiet hours (catalogue CTX-04).** A person's quiet hours hold routine ADVISORY and WARNING messages until they end (or drop them if the alert ends first). **CRITICAL alerts such as lightning are never held** by quiet hours or the daily cap.
- **Each alert stage is sent once.** A stage is the severity plus the number of re-notifications, so an escalation or an allowed lightning re-notification is sent again, while a silent evidence refresh is not. A stage that was replaced before it was sent is skipped, and the person gets the newest one.
- **Never a stale start.** Stale or unavailable data does not start a message; withdrawn, expired, draft and demo alerts are never sent; an alert whose latest change is older than 3 hours is not sent to a channel (it is still in the inbox).
- **Failure handling.** Temporary failures retry after 1, 5 and 15 minutes (a provider's own retry-after is honoured, and a retry is never scheduled past the end of the alert). A chat that blocked the bot or a number that cannot receive messages is unlinked and its waiting messages dropped. Rejected credentials pause the channel without failing anyone's alerts. A lease keeps two processes from sending the same message. Provider errors never contain the bot token, an API key, a phone number or a message body.
- **Web page and bot.** `/alert` shows each channel's state (never a chat id or a full number). The bot answers in private chats only: `/start <code>`, `/stop`, `/help` and the weather commands below.

### Setting up Telegram

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. In `server/.env` set `TELEGRAM_BOT_TOKEN=...` and `PUBLIC_URL` (the address of your site), then restart. With no webhook URL the server polls Telegram, which needs no public address and is fine locally.
3. Open `/alert` → **Alerts on your phone** → **Connect Telegram** → **Open Telegram** → **Start**. The page updates by itself.
4. For production, give the server a public HTTPS address and set `TELEGRAM_WEBHOOK_URL=https://your-domain/api/channels/telegram/webhook` and `TELEGRAM_WEBHOOK_SECRET` (16–256 characters of `A-Z a-z 0-9 _ -`). The server registers the webhook at start-up and rejects any request without the secret header.

<a id="telegram-weather-commands"></a>

### Weather commands in Telegram

Anyone who messages the bot can ask for the weather, connected or not; the bot answers from the stored forecast and never calls a weather provider. Typing `/` lists the commands (registered with Telegram in English and Bangla at start-up).

| Command | Reply |
| --- | --- |
| `/update [place]` | The current 3-hour step (condition, temperature, heat index, rain and chance, humidity, wind and gusts, thunderstorm potential), the next 12 hours, the last lightning check, the number of active alerts (connected chats) and the data source and age. Comes with buttons for the reports below. |
| `/heat [place]` | Heat index and temperature now, the highest in the next 24 hours, its category (Caution, Extreme caution, Danger, Extreme danger) and plain advice, and the heat index by time. |
| `/rain [place]` | The next 24 hours in 3-hour steps with amount, class and chance, the total and the wettest step. |
| `/wind [place]` | Wind and gusts now, the strongest gust of the next 24 hours, and the wind by time. |
| `/thunderstorm [place]` | The thunderstorm outlook: potential (None, Low, Moderate, High) per 3-hour step, the peak, and whether the model forecasts a thunderstorm or hail. |
| `/lightning [place]` | What lightning checks recorded, and how old the check is. |
| `/forecast [place]` | The days ahead: temperature range, rain, gusts, chance of rain and thunder. |
| `/alerts` | The active alerts of the connected profile (title, severity, end time). |
| `/status` | How fresh each data source is and when the alert engine last ran. |

- **Place.** An upazila, city thana, district or city corporation, in English or Bangla, for example `/heat Badda`, `/rain বাড্ডা` or `/wind Savar, Dhaka`. A name shared by several places (Kotwali) lists up to five candidates with their districts. Without a place, a connected chat uses the saved area (at most two). Aliases: `/weather`, `/thunder`, `/storm`, `/days`.
- **Language.** A trailing `bn` or `en` wins; then the profile's language; then Bangla if the place was typed in Bangla script; then Telegram's own language; otherwise English.
- **Honest wording.** Every figure is a *model forecast, not a station reading*, and says which source it came from and when it was updated. Stale data is shown with a warning, never as current; missing data says so and never reads as zero or as calm weather; "no active alert" is explicitly not an all-clear. Rain amounts come from Open-Meteo while it is current (its unit is known); BMD's amounts carry a note that their unit is not yet confirmed. BMD's gust is shown no lighter than its own mean wind, because about a third of its steps report a gust below the mean.
- **Privacy.** The only profile fact used is the saved area, to choose where to look. No reply contains the occupation, crop, shift or why an alert was sent, and nothing about the asker is stored: the request limit (`TELEGRAM_COMMAND_LIMIT`, 30 requests per 10 minutes per chat) is kept in memory.
- **Formatting.** Replies are Telegram HTML; if Telegram ever refuses the markup, the same words are sent as plain text.

### Setting up WhatsApp

Uses the WhatsApp Business Cloud API (Meta). A business can only start a conversation with an approved **message template**, so alerts and verification codes are both templates. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and `CHANNEL_SECRET`, then create and get approved:

<a id="whatsapp-templates"></a>

1. **Alert template**, named like `WHATSAPP_ALERT_TEMPLATE` (default `akashsathi_alert`), category *Utility*, in each language you enable (`en`, `bn`; change the codes with `WHATSAPP_TEMPLATE_LANG_EN/BN`). Body, with exactly four variables:
   ```text
   AkashSathi {{1}}: {{2}}

   {{3}}

   Valid until {{4}}. More details on the AkashSathi alerts page.
   ```
   `{{1}}` severity, `{{2}}` title, `{{3}}` the alert text and who sent it, `{{4}}` the end of validity.
2. **Verification template**, named in `WHATSAPP_OTP_TEMPLATE`, category *Authentication* with the copy-code button. The code is sent as both the body variable and the button parameter. Without this template WhatsApp stays unavailable, because there would be no way to prove a number is the person's own.

### Setting up SMS

Set `SMS_PROVIDER` to `twilio` or `http`, and `CHANNEL_SECRET`.

- **Twilio:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and either `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID`.
- **Any HTTP gateway** (most Bangladeshi bulk-SMS providers): `SMS_HTTP_URL`, `SMS_HTTP_METHOD` (`GET` or `POST`), and for POST `SMS_HTTP_CONTENT_TYPE` and `SMS_HTTP_BODY`. Placeholders are `{to}` (`+8801712345678`), `{to_digits}` (`8801712345678`), `{to_local}` (`01712345678`) and `{text}`. JSON bodies are substituted value by value, so quotes and line breaks in a message cannot break the request. Because many gateways answer HTTP 200 for a refused message, set `SMS_HTTP_SUCCESS_MATCH` to a pattern the success reply must match. Examples are in [`server/.env.example`](server/.env.example).
- English SMS text is plain ASCII (one typographic dash would halve the segment size) and limited to 320 characters; Bangla is limited to 200 (three UCS-2 segments). The link and validity always survive truncation. Use your gateway's registered sender ID, as Bangladeshi operators regulate them.

### What is and is not verified

The adapters, the queue, the consent flows, the Telegram bot and the weather commands are covered by 100+ automated tests that use mocked provider responses and a real MongoDB; the weather commands were also run end to end against the real server with live BMD and Open-Meteo data and a mock Telegram that enforces Telegram's strict HTML rules. **They have not been run against live Telegram, WhatsApp or SMS accounts in this repository**, because no credentials were available. Provider details most likely to need a small adjustment on the first live run: WhatsApp error-code classification and template shapes, and the success reply of your SMS gateway. Delivery is *at-least-once*: a crash between a provider accepting a message and the row being marked sent can repeat that one message.

Switch the whole layer off with `DELIVERY=off`; unconfigured channels simply stay idle.

## What the map shows

| Control | What it does |
| --- | --- |
| **Weather signs** (Temperature, Heat index, Rain, Wind, Thunderstorm) | A colored shape and value at every location. Below zoom 8.3 you see the 64 districts, above it the 544 upazilas and city thanas, with place names as room allows. Click or search for any place to open its panel. |
| **Radar** | BMD ground radar (Dhaka + Rangpur, 450 km), 10-minute frames, last 3 hours. |
| **Satellite** | Himawari-9 infrared / visible from NASA GIBS, 10-minute frames (about an hour behind real time). |
| **Lightning summaries** | The Xweather lightning campaign described below. |
| **Live / Forecast** | Live scrubs radar or satellite frames; Forecast scrubs BMD's 3-hour steps for the next 4 days. Play animates either. |
| **Search** | English or Bangla (`বাড্ডা`), flies to the place and opens its panel. |
| **Share** | The URL hash holds the view: `#view=23.64,90.51,8z&layer=rain&o=radar`. |
| **Bangladesh only** | Everything outside the national border is painted over with the canvas color, the camera cannot be dragged away from the country, and zooming out stops just past the zoom that fits it. Lightning circles are the exception: they are drawn whole, because the circle is the area that was counted. |

Honesty rules built into the interface: grey means **no data, never calm weather**; stale sources are muted and labelled; every value names its source; BMD temperature, rain and wind are **model forecasts**, not measurements; thunderstorm signs are **potential**, not strikes; heat index is **computed**, not an on-site WBGT.

## Data sources

| Source | Used for | Notes |
| --- | --- | --- |
| BMD WRF forecast (`api.bdservers.site`, no auth) | Temperature, rain, humidity, wind, gust, cloud for all 544 locations; 32 three-hourly steps and 10 days | Hosted on a third-party domain with no published terms or uptime guarantee. The server probes `updated_at` and pulls only when a new run appears. Step times are Bangladesh time, with the hour stored in the "minutes" field. |
| BMD radar (`radar.bmd.gov.bd`) | Radar frames and their georeferenced bounds | The images carry no CORS header, so the server proxies them (only files listed in BMD's own index). |
| BMD bulletins (`bmd.gov.bd`) | Fishermen, fleet and sea bulletins (PDF) | Parsed for explicit, dated, readable North Bay statements; everything else is a dated link. |
| NASA GIBS / JMA Himawari-9 | Satellite layer | Tiles load straight from GIBS; the server resolves available frame times. |
| Open-Meteo | Thunderstorm potential, precipitation probability, fallback if BMD is down | Free tier is non-commercial. |
| OCHA/HDX COD-AB (CC BY-IGO) | 495 upazila and 12 city-corporation polygons, 64 districts | Joined to BMD's 544 codes by `bmd = hdx.slice(2,6) + hdx.slice(-2)`; 482 match directly. |
| OpenFreeMap / OpenStreetMap | Basemap | Restyled with the palette. |
| Xweather | Forecast rain, probability, WBGT, maritime and gated lightning, plus the map summary campaign | Needs server-side credentials; all calls share the token allowance. |

Things worth knowing: BMD publishes no district forecast, so district values are averages and maxima of their upazilas (labelled). The 62 city thanas of Dhaka, Chattogram, Khulna and Rajshahi have no polygon of their own and appear as markers. Thirteen newer upazilas and seven city corporations have no separate BMD forecast and show the nearest BMD location's forecast, flagged in their map panel. Rainfall units per BMD step are unconfirmed (all zero on the one dry day checked). Canvas map labels are English only: the hosted fonts have no Bengali glyphs and WebGL text cannot shape Bengali; Bangla appears in search, tooltips and panels.

## Lightning campaign

Uses only the Xweather `lightning/summary/closest` endpoint (aggregate counts for a search circle, not strike coordinates). Credentials stay on the server.

1. Put your credentials in `server/.env` (never commit them, never paste them in chat):
   ```dotenv
   XWEATHER_CLIENT_ID=...
   XWEATHER_CLIENT_SECRET=...
   ```
2. Start the server. With credentials present the job creates a 10-day campaign (at most 30 refreshes) and samples at **07:00, 15:00 and 23:00 Asia/Dhaka**.

**The mode is chosen once and then locked.** Mode A (one 20 km search per upazila) is used only if `495 locations × 30 slots × cost` fits the budget after a 100-access reserve; otherwise Mode B (14 circles of 100 km, verified against 1.3 million boundary vertices to leave no gap) is used. With 14,817 accesses and a cost of 1 per request, Mode A needs 14,850, so Mode B runs (about 420 accesses). A 9-day campaign would fit Mode A.

Safeguards: a unique `(campaign, slot, location)` key with leases means reloads, concurrent workers and restarts never repeat a call; budget is reserved before each request and settled from `X-Cost-Tokens`; spending never dips into the reserve; auth failures stop collection; every response class is recorded separately. Each refresh is one 5-minute snapshot, and the interface says so: not continuous monitoring, not a daily total, circle totals are not upazila counts, and overlapping circles are never summed.

The shape of a *populated* summary has not been seen live yet (all probes returned `warn_no_data`). If it differs from the parser's expectation, adjust `parseSummary` in `server/src/services/xweather.js`, the only place that reads it.

## API

All responses use `{ "data": ... }`; errors use `{ "message": "..." }`. Every endpoint reads stored or cached data.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | `200` when MongoDB is connected, plus the freshness of each source |
| `GET /api/weather/snapshot` | Columnar forecast for all locations and districts (about 200 KB gzipped), with per-source status |
| `GET /api/weather/daily` | BMD 10-day values |
| `GET /api/weather/history?district=&source=&days=` | Stored per-district run summaries, newest first (`source` is `bmd` or `openMeteo`, `days` 1–60) |
| `GET /api/radar/frames`, `GET /api/radar/image/:site/:file` | Radar frames and the proxied image |
| `GET /api/satellite/frames` | Himawari frame times and tile URL template |
| `GET /api/lightning/status`, `/summaries`, `/upazila/:pcode` | Campaign state and results |
| `GET /api/alerts/schema`, `POST /api/alerts/subscribe` | Bilingual form definitions and anonymous subscription |
| `GET /api/alerts/session` | "Who am I?": the browser's profile, or `profile: null`. Always 200, so a first visit logs no failed request |
| `GET/PUT/DELETE /api/alerts/me` | Read, edit or delete the browser's profile (401 without one) |
| `PUT /api/alerts/me/activity`, `PUT /api/alerts/me/status` | Temporary activity, pause and resume |
| `GET /api/alerts/inbox`, `POST /api/alerts/inbox/:id/read`, `POST /api/alerts/inbox/read-all` | Inbox and read state |
| `GET /api/alerts/status`, `GET /api/alerts/me/coverage` | Monitoring and bulletin status; personal coverage |
| `GET /api/alerts/me/channels` | Which channels exist, which are connected (masked), what each carries |
| `POST /api/alerts/me/channels/telegram/link` | A one-time Telegram link |
| `POST /api/alerts/me/channels/:channel/start`, `…/verify` | Send and check a verification code (`whatsapp`, `sms`) |
| `DELETE /api/alerts/me/channels/:channel` | Disconnect a channel |
| `POST /api/channels/telegram/webhook` | Telegram updates; answers only requests that carry the webhook secret |
| `GET /api/admin/session` | "Am I signed in?": `closed`, `signed-out` or `signed-in`. Always 200 |
| `/api/admin/*` | Overview, previews and sends, history and withdrawal, rules, settings, demo tools; requires administrator access |

## Project layout

```text
.
├── client/
│   ├── public/data/        generated boundaries and location catalogue
│   ├── test/               client unit tests
│   └── src/
│       ├── pages/          landing, map, alert, admin (the last three are lazy chunks)
│       ├── map/            MapLibre: layers, signs, radar, satellite, lightning, interaction
│       ├── alert/          signup wizard, inbox, profile, channels panel, strings (EN/BN)
│       ├── admin/          dashboard views
│       ├── components/     navbar, legends, panels, search, severity chips
│       ├── lib/            scales, icons, basemap style, time, URL state, forms
│       └── services/       API clients
├── server/
│   ├── data/               generated catalogue and lightning circles
│   ├── test/               server tests (database tests skip without MongoDB)
│   └── src/
│       ├── services/       providers, store, history, campaign
│       │   ├── alerts/     hazard detection, scenarios, notifications, admin
│       │   └── delivery/   queue, policy, formatting, linking, Telegram bot, channel adapters
│       │       └── botReports/   the bot's weather commands: places, readings, wording, router
│       ├── jobs/           scheduler, lightning, alert engine, delivery
│       └── controllers/ routes/ models/ middleware/ config/
├── scripts/                geography builds and the database test preloader
└── docs/                   design, alert-engine plan, implementation status, BMD API notes, scenario catalogue
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | API (auto-reload) and Vite together |
| `npm run build` | Production build of the client into `client/dist` |
| `npm run preview` | Serve the build on :4173 with the same `/api` proxy |
| `npm start` | API without the watcher |
| `npm test` | Server and client tests |
| `npm run test:db` | All server tests including the MongoDB-backed ones, using `TEST_MONGODB_URI` or the configured MongoDB instance and DNS servers |
| `npm run build:geo` | Rebuild boundaries and catalogue (downloads HDX once; `-- --refresh` ignores the cache) |
| `npm run build:outline` | Rebuild the landing-page Bangladesh silhouette from the national boundary |

Set `WEATHER_JOBS=off` to run the API without collecting data, `LIGHTNING_ENABLED=off` to skip the campaign, `DELIVERY=off` to disable external delivery.

## Tests

```sh
npm test            # client + server; database tests skip without MongoDB
npm run test:db     # everything, including MongoDB-backed tests
```

Each database-backed test file creates and removes its own random `mern_test_*` database, independently of the application database. `scripts/test-db.mjs` preloads the application's `DNS_SERVERS` setting for Atlas SRV resolution. Xweather is never called by the tests, and the delivery tests use mocked providers, so no test spends quota or sends a message.

## Geography

`npm run build:geo` downloads the HDX boundaries once (cached in `scripts/.cache/`, which is not committed), reads the BMD location list, simplifies the polygons, resolves polygons that have no BMD code, and computes the lightning circle cover with a geodesic gap check that fails the build on any gap. It prints the counts it produced: 495 upazila polygons, 12 city corporations, 64 districts, 8 divisions, 544 BMD locations (482 with their own polygon).

## Documentation

| Document | What it holds |
| --- | --- |
| [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) | What is built against the plan, what is not, known gaps, and invariants to preserve |
| [`docs/ALERT_ENGINE_PLAN.md`](docs/ALERT_ENGINE_PLAN.md) | The alert engine's design, decisions and threshold references |
| [`docs/AkashSathi_Occupation_Based_Scenario_Catalogue.md`](docs/AkashSathi_Occupation_Based_Scenario_Catalogue.md) | The scenario rules the engine implements |
| [`docs/BMD_WEATHER_API.md`](docs/BMD_WEATHER_API.md) | Verified facts about the BMD endpoints |
| [`docs/design.md`](docs/design.md) | Palette, severity colors and data colors |

## Security and privacy

- Secrets live only in `server/.env`, which is git-ignored. `.env.example` placeholders count as "not configured".
- Subscribers are anonymous: an HttpOnly cookie, only its SHA-256 stored; state-changing requests need a matching `Origin` and a JSON body; sign-up is rate limited, honeypotted and capped. Behind a reverse proxy set `TRUST_PROXY=1` so the per-address limits see real visitors.
- The administrator dashboard uses one shared passcode (prototype). Use a long random value.
- Only area codes are kept, never exact coordinates. Phone numbers exist only for people who chose WhatsApp or SMS, are encrypted at rest, and are removed with the profile.
- Rotate any credential that has ever been pasted into a chat or a log.

## Attribution

Forecast and radar © Bangladesh Meteorological Department. Himawari-9 imagery © JMA, via NASA GIBS. Forecast supplement by Open-Meteo (CC BY 4.0). Boundaries: OCHA/HDX COD-AB (CC BY-IGO). Basemap: OpenFreeMap, © OpenMapTiles, data © OpenStreetMap contributors.
