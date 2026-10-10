# AkashSathi — Alert Engine: Implementation Plan

**Version:** 1.0 (final plan, all decisions resolved) · **Date:** 10 October 2026 · **Status:** implementation present; see [`IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) for what is built, what is not, and verified results. This document retains the original design decisions; delivery over Telegram, WhatsApp and SMS (listed under "Later" below) has since been built as described in the README.

Companion documents: [`AkashSathi_Occupation_Based_Scenario_Catalogue.md`](AkashSathi_Occupation_Based_Scenario_Catalogue.md) (rule IDs this plan implements, unchanged), [`BMD_WEATHER_API.md`](BMD_WEATHER_API.md) (verified data facts), [`design.md`](design.md), [`README.md`](../README.md).

---

## 0. Summary

| Part | What happens | Milestone |
| --- | --- | --- |
| **Alert entry** | **Alert** button in the navbar → `/alert` → occupation-aware form → "Your alert profile is saved" (no account). | M1 |
| **Automatic engine** | Fetch → validate → detect hazard → find subscribers by role and area → apply occupation scenario → **send automatically as soon as a threshold is met**, one deduplicated notification per subscriber and rule. | M2 |
| **Inbox** | Badge, alert cards with *why you got this*, "what we checked" with last-checked times. | M2 |
| **Admin (one admin)** | `/admin`, light passcode. A button **sends alerts now** for chosen roles/areas from current weather, **declares a hazard**, or sends a **free message**; history, withdraw, thresholds view, settings. | M3 |
| **Data providers** | Xweather forecast/WBGT/maritime, then lightning, then BMD bulletins, behind a token governor. | M4–M6 |

**Why this order:** the form first (your request), then an engine on **BMD data only** (free, all 544 locations, no Xweather quota) that already sends automatically, then the admin dashboard (so the whole story is demonstrable: subscriber fills the form → the engine or the admin sends → the alert appears in the inbox), then the quota-constrained providers.

---

## 1. Principles that bind every design choice

1. **Detect the hazard once, personalise afterwards.** Hazard events know nothing about occupations; scenarios turn an event into advice.
2. **Location first.** No personal alert before the affected district/upazila/water area is matched. A district-wide notice is never narrowed to an upazila claim without supporting data.
3. **Active activity beats occupation** (CTX-01).
4. **Unknown ≠ safe.** `UNAVAILABLE`, `STALE`, `PARTIAL` never produce a calm state. `NO_MATCH` describes that query window only. **No automatic all-clear**, including when an alert expires or an admin withdraws one.
5. **Hazards stay separate.** A rain advisory never hides a lightning warning. Official BMD signals appear in their own block with their original wording; AkashSathi never relabels them.
6. **No false certainty.** Rain ≠ flooding, dry days ≠ drought, observed lightning ≠ a prediction of the next strike, provider WBGT ≠ an on-site measurement.
7. **Say who said it.** Every alert is labelled *Automatic (prototype rules)*, *Administrator*, or *Official BMD notice (quoted)*. An administrator cannot publish something labelled as BMD.
8. **Prototype rules are labelled.** Every threshold carries `status: prototype`; the UI says so (§11).
9. **Page views never call providers.** Inbox, status and admin reads use MongoDB/memory only.
10. **Collect the minimum.** Area codes, not coordinates; no names, phone or email; counts-only views for admins.

---

## 2. Decision log (all resolved)

| ID | Decision | Where it lands |
| --- | --- | --- |
| D1 | **No sign-in or sign-up.** Completing the form makes you a subscriber (anonymous device token); the inbox lives in that browser. | §5, §7.1, §15 |
| D2 | Navbar: **Alert** (outlined) + **Map** (solid) on the right; "Data" moves to the footer. | §5.1 |
| D3 | A **severity colour ramp** is added to `design.md`. | §13.2 |
| D4–D6 | BMD primary for rain/temperature/wind, Xweather for WBGT and `pop`; gated lightning monitoring; English + Bangla from the start. | §9, §14.3 |
| D7 | **I set the thresholds**, from published references where they exist. They are `prototype` rules, not expert-validated. | §11 |
| D8 | The engine **sends automatically** to role-based subscribers when a threshold is hit. **One admin** can additionally send by clicking a button. | §6, §10.4 |
| D9 | A prototype, so admin protection stays **light**: one shared passcode in `server/.env`, plus `ADMIN_AUTH=off` for local demos. *(My reading of "no problem, it's a prototype"; removing even the passcode is a one-line change if you meant that.)* | §6.1, §15 |
| D10 | **Lightning is always CRITICAL**, observed or threat, because it signals thunderstorm danger. **Alarm fatigue is controlled by the episode rules in §11.2 and §11.4**, never by downgrading the severity. | §11.2, §11.4 |

Automatic sending on `prototype` thresholds is accepted, so safety rests on: the visible `prototype` label on every alert, conservative episode and de-duplication rules, the admin's **Withdraw** and per-hazard **kill switch**, and an optional **hold** setting that makes a severity wait for the admin (§10.4). Hold is off by default.

---

## 3. What already exists and will be reused

| Capability | Where | Used for |
| --- | --- | --- |
| 544 locations (`pcode`, `district`, `kind` upazila/thana, lat/lon, Bangla names), 64 districts | `server/data/locations.json`, `services/geo.js` | Area picker, matching, representative points |
| Polygon **geometry** only on the client (`client/public/data/`); the server catalogue has polygon metadata only | | Boundary matching needs the GeoJSON server-side (M5) |
| BMD forecast: 3-hourly × 32 steps + 10-day daily (`temp, rf, rh, ws, wd, wg, cc, hi`), source status | `services/weatherStore.js` | Rain / heat / wind detection in M2 |
| Open-Meteo `pop`, `wmo`, `ts` (thunder potential) | via `weatherStore` | Probability and the thunder gate |
| Xweather client (summary only), error classes, header parsing, `redactSecrets` | `services/xweather.js` | Extended with new endpoints |
| 14 lightning circles (100 km), `haversineKm`, Dhaka-time helpers | `data/lightning-circles.json`, `services/lightningCampaign.js` | Shared lightning queries |
| Non-overlapping job helper `every()` | `jobs/scheduler.js` | Alert job |
| History-API router, lazy pages, `Link`, `usePolled` | `client/src/lib/router.js`, … | `/alert`, `/admin`, polling |
| `node --test`, mocked Xweather client, `TEST_MONGODB_URI`-gated DB tests | `server/test/` | New tests |

**Facts the plan respects**

- `config/thresholds.js` says its values are *display* thresholds, **not** alert rules. Alert rules get their own file `config/alertRules.js`.
- BMD rainfall **units per step are unconfirmed** (zero on the one dry day checked). Spike S3.
- No **populated** Xweather lightning payload has ever been seen; `parseSummary` guesses keys.
- BMD warning pages were blank and the mobile warning feed is labelled demo; official bulletins are PDFs found by scraping.
- Thirteen newer upazilas and seven city corporations use a *nearest* BMD forecast → carried as `coverage: nearest-location`, data status `PARTIAL`.
- The Xweather allowance is shared with the existing lightning campaign (≈ 420 tokens planned).

---

## 4. Architecture overview

```text
 PROVIDERS                         EXPRESS PROCESS (prototype: one process)                       CLIENTS
                       ┌───────────────────────────────────────────────────────────────┐
 BMD forecast  ───────►│ weatherStore (existing)                                       │
 Open-Meteo    ───────►│                                                               │
 Xweather wx/mar/ltg ─►│ WeatherSnapshots ◄── token governor (budget, gate, headers)   │
 BMD bulletins ───────►│                                                               │
                       │ alertJob (every 2 min, non-overlapping)                       │
                       │  0 validate → 1 detect → 2 recipients → 3 scenarios           │
                       │        │                                  │                   │
                       │   HazardEvents                    4 compose + dedupe          │
                       │        ▲                                  │                   │
                       │        │                    ┌─────────────┴────────────┐      │
                       │  admin "declare"            │ PUBLISH (default: auto)  │      │
                       │  / "send now"               │ auto → status 'active'   │      │
                       │        │                    │ hold → status 'draft'    │      │
                       │        │                    │ (optional, per severity) │      │
                       │        │                    └─────────────┬────────────┘      │
                       └────────┼──────────────────────────────────┼───────────────────┘
                                │            MongoDB               │
  /admin  ──── /api/admin/* (passcode session) ── send now, declare, free message, withdraw, settings
  /alert  ──── /api/alerts/* (device-token cookie) ── subscribe, inbox (reads Mongo only, polled 30 s)
```

**New server code**

```text
server/src/
  config/alertRules.js        thresholds, versions, status (prototype/validated), basis notes
  models/                     Subscriber, HazardEvent, Notification, WeatherSnapshot, RuleSetting,
                              EngineSettings, JobState, AdminSession, AdminAction, Area
  services/
    xweatherForecast.js, xweatherMaritime.js, xweatherLightning.js, xweatherBudget.js
    bmdBulletins.js
    alerts/
      schema.js               occupation form definitions (client form + server validation)
      normalize.js            AreaForecast assembly + data statuses
      hazards.js              Stage 1 (pure)
      recipients.js           Stage 2 (+ admin audience filters)
      scenarios/              Stage 3: one file per occupation, catalogue rule IDs
      compose.js              EN/BN templates, reason, actions, source labels
      notify.js               Stage 4: dedupe, escalate, expire, withdraw, publish (auto / hold)
      engine.js               one tick
      admin.js                preview / send / declare / message / withdraw (shared by admin routes)
  jobs/alertJob.js
  controllers/alertController.js, adminController.js
  routes/alertRoutes.js, adminRoutes.js
  middleware/subscriber.js, middleware/admin.js, middleware/rateLimit.js
```

**New client code**

```text
client/src/
  pages/AlertPage.jsx, pages/AdminPage.jsx (+ loaders; both lazy chunks)
  alert/        form wizard, inbox, status panel, alert.css (scoped under .app like map.css)
  admin/        overview, send, history, rules, settings, admin.css
  lib/alertForm.js, services/alertApi.js, services/adminApi.js
```

---

## 5. Subscriber experience (no accounts)

### 5.1 Navbar (`Navbar.jsx`, `landing.css`)

- **Alert** = outlined pill with a bell icon (add `bell` to the icon set if absent), immediately left of the solid **Map** pill. Prefetch the chunk on hover/focus like `loadMapPage`.
- **Unread badge** ("9+" cap, `aria-label` "Alerts, 3 unread"). The device cookie is HttpOnly and unreadable from JavaScript, so a non-sensitive hint `localStorage['akashsathi.alert'] = { armed: true }` decides whether to poll. Visitors who never completed the form cause **no requests**. If the server answers "no subscriber", the hint is cleared.
- ≤ 860 px: menu button left; right side = bell icon button (44 px, badge) + Map pill; the dropdown also lists Alert.
- "Data" stays in the footer and the phone menu. No link to `/admin` anywhere.

### 5.2 Route

`/alert` only; the view follows state.

| State | `/alert` shows |
| --- | --- |
| No subscriber cookie | Intro + the **form wizard** |
| Subscriber, active | **Inbox** + "What we checked" + "My profile" (edit, pause, delete) |
| Subscriber, paused | "Alerts paused" banner + profile |

### 5.3 The form (wizard, keyboard-operable, EN/BN)

| Step | Content | Notes |
| --- | --- | --- |
| 1. Who you are | Six occupation cards + language | Drives steps 2–3. |
| 2. Where | **Home upazila** (required) and the work/activity area where relevant, via division → district → upazila selects with search. Optional "Use my location" resolves to the **nearest upazila** and discards the coordinates | CTX-02: manual selection always works. Record `matchMethod: manual \| gps_nearest`. |
| 3. Your work | Conditional fields (table below) | Rendered from the server schema. |
| 4. Preferences | Quiet hours, optional "heat-sensitive" (voluntary, no medical detail), channels you would want later (stored as interest only) | In-app text says quiet hours apply to SMS/push when those exist. |
| 5. Review and start | "Alerts you can receive" (rule IDs + one line each), consent text (what is stored, why, not an official warning service), **Start alerts** | No password, phone or email. |

**Conditional fields** (your table expanded; option lists are proposals for review, the keys are what scenarios read)

| Occupation (role) | Fields | Consumed by |
| --- | --- | --- |
| **Farmer** | `cropType`: rice (aman/aus/boro), jute, wheat, maize, vegetables, pulses, other · `cropStage`: planting / growing / harvesting / post-harvest · `irrigationAccess`: none (rain-fed) / pump / canal-surface / other · `fieldAreaPcode` (default home) · `outdoorHours`: <4 / 4–8 / >8 · `workload`: light / moderate / heavy | FARM-01…05 |
| **Fisherman** | `waterBody`: river / coastal / marine · `operatingAreaPcodes[]` (river/coastal) or `marineZone` (marine) · `status`: ashore / pre_departure / on_water with `statusUpdatedAt` | FISH-01…05 |
| **Construction worker** | `activityType`: ground / roof / scaffolding / other elevated · `workload` · `ppeHeatBurden`: none / light / heavy · `siteAreaPcode` · `siteExposure`: open / partly covered / indoor · `shiftStart`, `shiftEnd` | CONS-01…04 |
| **Vendor** | `marketAreaPcode` + up to 2 saved markets · `outdoorStall`: yes / no · `shelterAccess`: none / partial / full · `hoursOutdoor`: <4 / 4–8 / >8 | VEND-01…03 |
| **Student / general public** | `commuteStart`, `commuteEnd` (default 07:00–09:00) · `schoolOrWorkAreaPcode` · `outdoorPlay`: yes / no · `guardianManaged`: yes / no | PUBLIC-01…04, CTX-03 |
| **Rickshaw puller / day labourer** | `shiftStart`, `shiftEnd` · `workload` · `outdoorExposure`: on road / open site / mixed · `workAreaPcode`. `urbanExposure` is **derived** from the area, never asked | WORK-01…05 |

`services/alerts/schema.js` is the single definition (fields, options, EN/BN labels, conditional rules, `schemaVersion`). The server exposes it, the client renders from it, the server validates against it with strict whitelists. Pure conditional logic lives in `client/src/lib/alertForm.js` so `node --test` can cover it.

### 5.4 After "Start alerts"

1. `POST /api/alerts/subscribe` creates the **Subscriber**, returns an opaque token in an HttpOnly cookie (`as_sub`); only its SHA-256 is stored.
2. **Backfill:** the new profile is evaluated against *currently active* hazard events (database only, no provider call), so someone who subscribes during a storm sees today's alert at once. Backfilled alerts follow the same publish rule as any other (automatic, unless a hold is on).
3. The confirmation screen shows: your areas, the sources checked and how often, last-checked time, the monitoring limits (lightning, §14.3), **and how alerts are sent**: *"Alerts are sent to you automatically when a rule's threshold is met for your role and area. An administrator can also send alerts. The rules are prototype rules and are not yet expert-reviewed."* If the admin has turned on **hold** for a severity, the text says that severity is reviewed by an administrator first.
4. It also says plainly: *"Your alerts are saved in this browser. Clearing site data, or using another device, means you start again."*
5. Editing the profile re-evaluates; notifications that no longer apply become `withdrawn` with reason `profile-changed`. **Delete my profile** removes the subscriber and their notifications and clears the cookie.

### 5.5 Inbox and "What we checked"

- **Active now** (severity, then recency) and **Earlier**. Multiple hazards are separate cards; nothing collapses to "highest only".
- Card: severity chip (word + icon + colour), hazard chip, **sender label** (Automatic / Administrator / Official BMD quoted), title, **affected area and scope**, **validity**, **source and observation/forecast time**, **why you received this**, **recommended actions**. Details: evidence, data status, rule ID + version + `prototype`/`validated`, official-notice block, "View on map" (existing `#view=` state).
- **Quick status**: "Right now I am: on the water / pre-departure / on the road / on a roof…" sets `activeActivity` with expiry (default 12 h) and reverts afterwards; an expired status is **unknown**, never a guess.
- **What we checked** per hazard for the user's areas: provider, `FRESH / NO_MATCH / STALE / PARTIAL / UNAVAILABLE`, last checked, one sentence on what that status does *not* mean. An empty inbox says "No active alerts from the sources we checked", never "You are safe".
- Polling `usePolled(…, 30_000)`; marking read is a `POST`. Accessibility: never colour alone, 44 px targets, live region for new CRITICAL alerts, reduced motion respected.

---

## 6. Admin dashboard (`/admin`)

### 6.1 Access

- `/admin` redirects (history `replace`) to `/admin/login` when there is no admin session, and back to `/admin` after login.
- **One admin, deliberately light** (D9: this is a prototype). Login = the shared **admin passcode** from `server/.env` (`ADMIN_PASSCODE`; placeholder or empty = admin disabled, the page says so). Constant-time comparison of SHA-256 digests; **5 attempts / 15 min / IP**; cookie `as_admin`: HttpOnly, `SameSite=Strict`, `Secure` in production, 8 h absolute, token hash in `AdminSessions` (TTL + application check).
- `ADMIN_AUTH=off` skips the login for local demos; it is honoured only outside production **and** on loopback, and logs a warning at start-up. There are no admin accounts, roles or password reset in v1.
- The admin chunk is lazy (never shipped to the public bundle), the page sends `noindex`, `/api/admin/*` sends `X-Robots-Tag: noindex`, and there is no link from the public site.
- Every state-changing admin call is audited (`AdminActions`).

### 6.2 Screens

| Screen | Purpose |
| --- | --- |
| **Overview** | Subscribers by role and division (counts only), monitored areas and circles, per-source status and last-checked, Xweather budget (remaining, projection, spend by class), engine health (last tick, last error), alerts sent automatically in the last 24 h by role and severity, and **held alerts** with their age (only when a hold is on; a held CRITICAL older than 10 minutes is highlighted). |
| **Send alerts** | The core screen (below). |
| **History** | Everything that was sent: automatic engine alerts (grouped by hazard event) and admin sends. When, origin, roles, areas, severity, recipients, how many have read it, **Withdraw**. |
| **Rules** | Read-only table of thresholds with version, basis tag and `prototype`/`validated` (§11). Editing in v1 = change `config/alertRules.js` (versioned); a UI editor is a later item. |
| **Settings** | Per-hazard **kill switch** (stop automatic alerts for one hazard type), per-severity **hold** (wait for the admin; default off), demo-subscriber tools. |

### 6.3 Send alerts — three tabs

The engine already sends automatically every 2 minutes (D8). The admin tabs exist to send **now**, to send what the data has not caught up with, and to speak to one role.

```text
┌ Send alerts ──────────────────────────────────────────────────────────────────────────┐
│ [Send now from weather]   [Declare a hazard]   [Free message]                         │
│ Roles: ☑ Farmer ☐ Fisherman ☐ Construction ☐ Vendor ☐ Student/public ☐ Rickshaw/labourer  (All) │
│ Area: [All Bangladesh ▾]   Audience: (• Live subscribers) (○ Demo subscribers only)   │
│ [ Check current weather ]                         (nothing is sent by this button)    │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ NEW, will be sent now                                                                 │
│   Farmer    FARM-01  Heavy rain L2      WARNING   Badda          12 people  FRESH     │
│   Labourer  WORK-04  Rain L1            ADVISORY  Dhaka district 31 people  FRESH     │
│ ALREADY SENT automatically (no duplicate will be created)                             │
│   Construction  CONS-03  Strong wind L1  WARNING  Savar   7 people   sent 14:02       │
│ HELD (a hold is on for this severity)       …                                         │
│ NOTHING DETECTED: Fisherman. BMD forecast FRESH 14:10; lightning not monitored        │
├───────────────────────────────────────────────────────────────────────────────────────┤
│ [Send these now]   [Send only Farmer alerts]   [Send only Labourer alerts]            │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**Tab 1 — Send now from weather (role-based).** The admin ticks one or more roles, optionally narrows the area, and presses **Check current weather**. The server runs one engine pass for exactly those roles and areas against the cached data and shows four groups: **new** (will be sent), **already sent automatically** (so the click cannot duplicate), **held** (only if a hold is on), and **nothing detected**, with the reason (no hazard, source stale, data unavailable) and never an "all clear". The admin then presses **Send these now**, or a per-role button such as **Send only Farmer alerts** (your "button per role"). Sending publishes the *new* group immediately instead of waiting for the next 2-minute tick, and releases the *held* group. *Preview* of any row shows the exact EN/BN message, actions, reason, sources, validity and recipient count.

**Tab 2 — Declare a hazard.** The admin asserts a hazard (type, level 1–3, area, validity, roles). The engine then writes **role-specific wording from the catalogue scenarios** exactly as for a detected hazard, labelled *"Declared by administrator, not detected from weather data"*. The preview also shows whether current cached data **supports** the declaration (Yes / No / Unknown); sending an unsupported declaration needs a typed confirmation. Declaring the same hazard type for the same area while a declared event is still active **updates that event** (level, validity) instead of creating a second one, and the normal re-notify rules apply. Used for a real situation the data has not caught up with, or for demonstrations (with *Demo subscribers only*).

**Tab 3 — Free message.** Severity, roles, areas, validity (default 6 h, max 72 h), text EN (required) and BN (optional; if missing the EN text is shown with "Bangla not provided"), optional actions from the catalogue's action keys, optional reference link (http/https only, shown as "Reference supplied by administrator"). Rule ID `ADMIN-MSG`. A soft lint warns about phrases like "safe", "all clear", "guarantee" and does not block.

**Safeguards on every send**

- **Preview is mandatory**: the Send button stays disabled until a preview of the same parameters has been viewed. The confirmation shows recipient count by role and area.
- **CRITICAL** needs a second confirmation ("Send to N people").
- **Idempotency key** per click (unique in `AdminActions`), plus the unique `(subscriber, event, scenario)` index: a double click or retry cannot double-send.
- Rate limit: 20 sends/hour/session.
- **Withdraw** (from History): marks every notification of that batch `withdrawn` with the admin's reason; recipients see *"Withdrawn by the administrator at 16:03. This is not an all-clear."* It is recorded as an **administrator** withdrawal, separate from an official BMD withdrawal.
- **Demo audience**: subscribers flagged `isDemo` (created from Settings: one per role in a chosen upazila). The admin can open a read-only **"view as"** inbox for them, which lets the dashboard be demonstrated without a second device.
- Admin sees **counts only**. There is no list of individual subscribers (there are no names or contacts to show).

### 6.4 Admin API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/admin/login` · `POST /api/admin/logout` · `GET /api/admin/me` | Session |
| `GET /api/admin/overview` | Counts, source status, budget, engine health, automatic sends, held alerts |
| `POST /api/admin/preview` | Dry run for any of the three tabs: new / already sent / held / nothing detected, recipients by role and area, sample messages, data-support check |
| `POST /api/admin/send` | `{ mode: weather \| declare \| message, roles, areas, audience, …, idempotencyKey, confirm }` |
| `POST /api/admin/held/discard` | Discard held alerts (only exists while a hold is on) |
| `POST /api/admin/alerts/:batchId/withdraw` | `{ reason }`: also accepts the id of an automatic hazard event |
| `GET /api/admin/history` | Sends and audit entries |
| `GET /api/admin/rules` · `GET/PUT /api/admin/settings` | Thresholds (read-only), kill switches, hold |
| `POST /api/admin/demo/subscribers` · `DELETE /api/admin/demo/subscribers` | Demo tools |

---

## 7. Data model (MongoDB)

All collections use `versionKey: false`. Times are UTC `Date`; Bangladesh is a fixed UTC+06:00 (reuse the Dhaka helpers, ideally extracted into `services/time.js`).

### 7.1 Subscribers — your "Users" collection without authentication

```text
tokenHash (unique)   SHA-256 of the cookie token; the token itself is never stored
occupation           'farmer' | 'fisherman' | 'construction' | 'vendor' | 'student_public' | 'rickshaw_labourer'
occupationData       object validated by schema.js, schemaVersion
areas[]              ≤ 5: { role: home|work|field|site|market|operating, upazilaPcode, districtPcode, matchMethod }
relevantUpazilas[], relevantDistricts[]      denormalised from areas on every save
activeActivity       { key, since, expiresAt } | null
language             'bn' | 'en'
isHeatSensitive, guardianManaged
preferences          { quietHours: { enabled, start, end }, channelInterest: [] }
consent              { version, at }
status               'active' | 'paused'
isDemo, createdAt, updatedAt, lastSeenAt, expiresAt     (sliding 90 days of inactivity; lastSeenAt written at most once an hour, not on every poll)
```

Indexes: `{ occupation, relevantUpazilas }` and `{ occupation, relevantDistricts }` (your two required indexes), unique `tokenHash`, TTL on `expiresAt` **plus** an application check.

### 7.2 AdminSessions, AdminActions, EngineSettings

- `AdminSessions`: `{ tokenHash (unique), createdAt, expiresAt }`, TTL + application check.
- `AdminActions` (audit): `{ at, action, mode, roles[], areas, severity, recipientCount, batchId, eventKey?, idempotencyKey (unique), outcome, reason? }`. No admin identity beyond "admin" (single passcode).
- `EngineSettings` (one document): `{ hold: { ADVISORY: false, WARNING: false, CRITICAL: false }, hazardEnabled: { HEAVY_RAIN: true, … }, updatedAt }`. Defaults per D8: automatic sending on, no hold, every hazard enabled.

### 7.3 Areas, WeatherSnapshots, JobState

- **Areas**: seeded idempotently from `locations.json`: `{ pcode, kind, name, nameBn, parentPcode, lat, lon, hasPolygon, forecastApproximate, urban, coastal, lightningCircleIds[] }`. The hot path keeps using in-memory `geo.js`.
- **WeatherSnapshots** (new Xweather and bulletin products; BMD/Open-Meteo stay in `ForecastSnapshot`): `{ provider, product, queryKey (unique together), scope, fetchedAt, issuedAt?, validFrom?, validTo?, status: FRESH|NO_MATCH|STALE|PARTIAL|UNAVAILABLE, costTokens, httpStatus, errorClass, data (normalised only), expiresAt (TTL 48 h; readers still check freshness) }`.
- **JobState** (not in your list; needed for "record the last completed fetch"): `{ key, lastStartedAt, lastCompletedAt, lastStatus, lastError, leaseUntil }`.

### 7.4 HazardEvents

```text
eventKey (unique)    see §10.1
hazardType           HEAVY_RAIN | HEAT_STRESS | STRONG_WIND | OBSERVED_LIGHTNING | LIGHTNING_THREAT | MARINE_WEATHER | ADMIN_NOTICE  (AQI later)
origin               'detected' | 'admin-declared' | 'admin-message'
source               { provider, product, referenceId }
coverage             { scope: upazila|district|circle|marine-zone|polygon, upazilaPcodes[], districtPcodes[], marineZone?, matchMethod }
level                0..3 (hazard magnitude; user severity is decided by scenarios)
evidence             { metrics…, rule: { key, version, status }, agreement: agree|differ|single-source, coverage: exact|nearest-location|regional, asserted?: { by:'administrator', at } }
official             { signalText, issuer, issuedAt, documentUrl } | null      original wording only
validFrom, validUntil, observedAt | forecastIssuedAt
lifecycle            active | expired | withdrawn | superseded
withdrawal           { at, source: 'official'|'administrator', reference?, reason? } | null
firstDetectedAt, lastConfirmedAt, lastUpdatedAt, revision, evaluatedRevision
dataStatus, isDemo
```

Indexes: `eventKey` unique; `{ 'coverage.upazilaPcodes', validUntil }`; `{ 'coverage.districtPcodes', validUntil }`; `{ lifecycle, validUntil }`.

### 7.5 Notifications (your fields plus what the honesty and admin rules need)

```text
subscriberId, hazardEventId, scenarioId (catalogue rule ID or ADMIN-MSG), ruleVersion
severity             ADVISORY | WARNING | CRITICAL
title, message, recommendedActions[], lang, templateKey + params
affectedArea         { scope, upazilaPcode?, districtPcode?, name, nameBn, text }
sourceReferences[]   { provider, product, observedAt|forecastIssuedAt, url? }
reasonForSelection
validFrom, validUntil, createdAt, updatedAt, readAt, isDemo
+ origin             automatic | admin-declared | admin-message         (drives the sender label)
+ status             active | expired | withdrawn  (normal path);  draft | discarded | expired_unsent  only while a hold is on
+ publishedAt, publishedBy ('engine' | 'admin'), batchId
+ ruleStatus         prototype | validated | admin   (admin = declared or free-message alerts, no rule involved)
+ dataStatus, revision, lifecycle[] (created / updated / escalated / published / expired / withdrawn, capped)
```

Indexes: **unique** `{ subscriberId, hazardEventId, scenarioId }`; `{ subscriberId, status, createdAt: -1 }` (the inbox only returns `active`/`expired`/`withdrawn`, **never** `draft`); `{ subscriberId, status, readAt }` (unread badge); `{ status, batchId }`, `{ status, scenarioId, 'affectedArea.upazilaPcode' }` (admin grouping); TTL `purgeAfter` (validUntil + 30 days).

### 7.6 RuleSettings

`{ key, kind: hazard|scenario, version, status: prototype|validated, enabled, params, basis, validatedBy?, validatedAt?, notes }`, unique `{ key, version }`. Defaults live in `config/alertRules.js` and are seeded; a changed rule never rewrites old notifications because each stores its `ruleVersion`.

---

## 8. Subscriber API (all GETs read cached data; none calls a provider)

| Endpoint | Purpose |
| --- | --- |
| `GET /api/alerts/schema` | Occupations, fields, options (EN/BN), `schemaVersion` |
| `POST /api/alerts/subscribe` | Create subscriber + profile, set cookie, backfill |
| `GET /api/alerts/me` · `PUT /api/alerts/me` · `DELETE /api/alerts/me` | Profile, edit (re-evaluates), delete |
| `PUT /api/alerts/me/activity` | Quick status with expiry |
| `GET /api/alerts/inbox?status=&before=&limit=` | Notifications + unread count (never drafts) |
| `POST /api/alerts/inbox/:id/read` · `POST /api/alerts/inbox/read-all` | Read state |
| `GET /api/alerts/me/coverage` | Per-hazard data status for my areas |
| `GET /api/alerts/status` | Public: monitored-area count, per-source freshness and cadence, last completed checks, whether any severity is on hold, budget summary |

Cross-cutting: `{ data }` / `{ message }` envelope; `cors({ origin, credentials: true })` (Vite proxies `/api`, so dev is same-origin); `subscribe` is rate-limited (10/hour/IP) with a honeypot field and a global cap (`ALERT_MAX_SUBSCRIBERS`, default 5000); body limit stays 10 kB.

---

## 9. Weather-data layer

Each provider service fetches, **validates**, and converts to one internal shape; nothing downstream sees provider fields.

| Service | Source | Gives | Cost | Notes |
| --- | --- | --- | --- | --- |
| *existing* BMD forecast | `api.bdservers.site` | temp, rf, rh, wind, gust, cloud per upazila, 3-hourly + daily | free | `rf` unit pending S3 |
| `bmdBulletins.js` | BMD content pages → PDF | marine, fleet, sea, inland river-port, general forecast; validity, area, signal text | free | rediscover the link each time; BST vs UTC; **parser status** |
| `xweatherForecast.js` | `/forecasts/{lat},{lon}?filter=1hr` | `pop`, `precipMM`, `wetBulbGlobeTempC`, `feelslikeC`, wind, gust, weather code | 1 / area (verify with a longer `limit`) | align `pop` and `precipMM` to the **same** period |
| `xweatherLightning.js` | `/lightning/summary/closest` · `/lightning/closest` · `/lightning/threats/closest` | counts · strikes · threat polygons | **1 · 10 · 10** | standard strike access = previous 5 min, ≤ 100 km |
| `xweatherMaritime.js` | `/maritime/{lat},{lon}` (+ a forecast call at the same point for wind) | wave, swell, current, tide, surge, SST | 1 + 1 | ~6-hourly model; North Bay verified |
| *existing* radar / satellite | BMD / GIBS | context | free | alerts deep-link to the map; no hazard logic |

**Normalised shapes**

```text
ForecastPeriod  { start, end, rainMm|null, rainProb|null, tempC|null, feelsLikeC|null, wbgtC|null, heatIndexC|null,
                  humidity|null, windKph|null, gustKph|null, thunderPotential|null, provider, coverage }
LightningStrike { id, at, lat, lon, type: ic|cg|unknown }          // distance is computed by us against each area point
LightningThreat { id, issuedAt, periods: [{ start, end, polygon }], movement|null }
MarineRecord    { at, waveM, swellM, currentMps, tideM, surgeM, sstC }
Bulletin        { product, pageUrl, documentUrl, fetchedAt, issuedAt|null, validFrom|null, validUntil|null, tz, area, signalText|null, rawText, parserStatus }
```

`null` means "not provided", never `0`. Units: mm, °C, km/h, % (knots × 1.852). Every value keeps its provider; timestamps carry `+06:00` or `Z`.

**Data status (shared vocabulary)**

| Status | Rule |
| --- | --- |
| `FRESH` | Within its freshness policy (§11.1) |
| `NO_MATCH` | Successful query, no events: true for **that scope and window only** |
| `STALE` | Older than the freshness window. May annotate an existing alert; never creates or escalates one |
| `PARTIAL` | Coverage or fields incomplete (nearest-location forecast, missing WBGT, unparsed bulletin) |
| `UNAVAILABLE` | Failed request, missing source, unusable data |

Mapping from today's map statuses: `ok → FRESH`, `stale → STALE`, `unavailable`/`not-checked → UNAVAILABLE`.

---

## 10. Alert-processing pipeline

One `engine.tick()` per run: **0 validate/normalise → 1 detect → 2 recipients → 3 scenarios → 4 compose, dedupe, publish, store**. When a threshold is met, the notification is published to the subscriber **automatically** (D8). Stages 1 and 3 are pure functions and are table-tested.

### 10.1 Stage 1 — hazard detection and event identity

Hazard types, metrics and the numeric rules are in **§11**. Event identity (a clarification of your spec):

| Event | Key | Validity |
| --- | --- | --- |
| Forecast hazard | `fc:{provider}:{pcode}:{HAZARD}:{firstQualifyingStart}` | contiguous qualifying periods |
| Lightning **episode** (observed strikes and threat polygons together, one per area) | `ltg:{areaPcode}:{episodeStart}` | until 30 min after the last strike **and** no threat period still ahead |
| Marine | `mar:{zone}:{firstQualifyingStart}` | qualifying periods |
| Official bulletin | `bmd:{notice-or-file-id}` | as stated in the notice |
| Admin-declared / message | `adm:{batchId}` | as set by the admin |

- A forecast key uses the *first* qualifying start. A later run whose qualifying run **overlaps** an active event updates its `validUntil`, level and evidence instead of creating another, so a sliding window never mints a new key each hour.
- Lightning is **one episode per area**, not one event per strike or per threat. It opens at the first covering threat period or the first strike, whichever comes first; later threat periods and strikes only update its evidence (`evidence.threat`, `evidence.observed`: count, nearest distance, last strike time, a capped list of provider strike ids, the first strike's id). Its `hazardType` shows the strongest current signal (`LIGHTNING_THREAT`, becoming `OBSERVED_LIGHTNING` once a strike matches). It closes 30 minutes after the last strike when no threat period is still ahead; anything after that opens a new episode. *This keeps your "stable key" rule (the provider's strike id is stored as evidence) while avoiding two CRITICAL notifications for one storm.*
- An official cancellation sets `lifecycle: withdrawn, withdrawal.source: official`. Expiry by time sets `expired`. Neither is an all-clear.
- A source turning `STALE`/`UNAVAILABLE` leaves the lifecycle alone but changes `dataStatus`, and the inbox says so.
- Each detection records `evidence.agreement` (BMD vs Xweather vs Open-Meteo: `agree` / `differ` / `single-source`).

### 10.2 Stage 2 — recipients

```text
scope upazila   → subscribers where relevantUpazilas ∋ pcode
scope district  → relevantDistricts ∋ districtPcode   (message says "district-wide"; never "your upazila")
scope circle / polygon → resolve to upazilas by point-in-polygon or distance, then as upazila
scope marine-zone → fishermen with that marineZone
narrowed by the occupations that have a rule for the hazard (index: occupation + area)
admin sends add an audience filter: roles[], areas[], live vs demo
```

Record how the match was made: `representative_point | boundary | district` (event side) and `manual | gps_nearest` (subscriber side). Boundary matching needs the polygons server-side (M5); until then lightning uses `representative_point` within a stated radius and the message says so.

### 10.3 Stage 3 — occupation scenarios

A scenario is `{ id, hazards[], occupations[], applies(subscriber, ctx), severity(level, metrics, ctx), leadHours, template, actions[] }`.

- **Context order:** `activeActivity` (unexpired) → profile field → unknown. A missing mandatory input means *limited advice* or *no alert*.
- **Time overlap:** `recurringWindowOverlap(userWindow, hazardWindow)` for commute and shift windows (PUBLIC-01, WORK-01/04/05, CONS-02).
- **Heat load class** (§11.3) turns `workload`, PPE, shelter and sensitivity into one of light / moderate / heavy.
- **Spam control:** at most 3 new ADVISORY notifications per subscriber per day; WARNING/CRITICAL exempt.
- Catalogue outputs `UNKNOWN`, `CONTEXT`, `PRIVACY`, `POLICY` are **not severities**: they map to `dataStatus`/the unknown state, the activity override (CTX-01), message composition (CTX-03) and delivery rules (CTX-04).

### 10.4 Stage 4 — compose, deduplicate, publish, store

```text
for each (subscriber, event, scenario) that applies:
  content = compose(...)                       // EN + BN, sender label, sources, validity, reason, actions
  upsert on unique (subscriberId, hazardEventId, scenarioId):
    none yet                            → insert, lifecycle 'created'
    exists, no material change          → touch lastConfirmedAt only
    exists, material change             → update fields, revision++, lifecycle 'updated' (silent)
    exists, re-notify condition (§11.4) → update, readAt = null, lifecycle 'escalated' (shows as new again)
  PUBLISH (default):  status 'active', publishedBy 'engine', publishedAt now          ← automatic sending
  PUBLISH (only if EngineSettings.hold[severity] is on):  status 'draft', invisible until the admin sends it
  validUntil passed: active → 'expired' ("This alert period has ended. This is not an all-clear."); draft → 'expired_unsent'
  event withdrawn: 'withdrawn'
```

**Material change** = severity or level change, validity extended by more than 3 h, an evidence metric moving by 25 % or more, or a data-status change. Admin-initiated sends (declare, free message, send now) are published immediately: the admin's click is the approval.

**Hold** exists as a safety valve while the rules are `prototype`: if the admin turns it on for a severity, that severity waits for the admin, with the delay that implies for safety messages, so the Overview highlights held CRITICAL alerts older than 10 minutes. Hold is **off by default**. The per-hazard **kill switch** stops the engine from creating events of one hazard type at all (existing alerts of that type are left alone until the admin withdraws them).

---

## 11. Threshold set (prototype v1)

Rule version **`prototype-1`**. Every value is tagged with its basis:

- **[B]** BMD figure as published or quoted in BMD bulletins/news reports of BMD statements
- **[A]** ACGIH / NIOSH occupational heat guidance
- **[M]** AMS or NWS convention
- **[P]** **project choice**: no published criterion found; chosen to be conservative and explainable

**What "prototype" means:** thresholds are set from the references in §19, marked as not yet reviewed by BMD, the Department of Agricultural Extension, an occupational-health reviewer or disaster-management staff, and shown as such on every alert. Nothing is `validated` until a reviewer, date and notes are recorded in `RuleSettings`. Several sources I could reach were news reports or secondary summaries and are flagged **(secondary)**.

### 11.1 Freshness policy (when a source becomes STALE)

| Source | Normal cadence | FRESH while | Effect of STALE |
| --- | --- | --- | --- |
| BMD forecast | probe 30 min, new run a few times a day | last check ≤ 3 h and data age ≤ 36 h (existing) | no new or escalated alerts |
| Xweather forecast | 3 h | last check ≤ 9 h | same |
| Xweather maritime | 6 h | last check ≤ 18 h | same |
| Lightning probe | 5 min (gate open); 60 min (baseline) | ≤ 15 min (gate open); ≤ 3 h (baseline) | same; an open episode shows "source stale" |
| Lightning threats | 10 min | ≤ 30 min | same |
| Bulletins | 30 min | last check ≤ 3 h and notice still in validity | same |

### 11.2 Hazard detection rules

**HEAVY_RAIN** (type name per your spec; level 1 is a moderate-rain level that scenarios such as harvest and commute need)

| Level | Rule | Basis |
| --- | --- | --- |
| L1 "Rain" | `rain3h` ≥ 7.5 mm **and** (`pop` ≥ 50 or `pop` not available) | [M] AMS "moderate" starts at 2.5 mm/h × 3 h; `pop` cut-off [P] |
| L2 "Heavy rain" | `rain3h` ≥ 23 mm **or** `rain24h` ≥ 44 mm | [M] AMS "heavy" = 7.6 mm/h × 3 h; [B] BMD "heavy" = 44–88 mm per 24 h |
| L3 "Very heavy rain" | `rain24h` ≥ 89 mm **or** `rain3h` ≥ 50 mm | [B] BMD "very heavy" = more than 88 mm per 24 h; 3 h figure [P] |

`rain3h` = highest rolling 3-hour forecast total, `rain24h` = rolling 24-hour total, within the next 24 h. BMD's classes are 24-hour totals; the 3-hour figures are project-derived. Context: BMD's other bands are moderate 11–22 and moderately heavy 23–43 mm. **BMD amounts are used only after S3 confirms their unit**; until then amounts come from Xweather/Open-Meteo, and an event built from a single source is marked `single-source`.

**HEAT_STRESS** (indicator priority: Xweather WBGT, then computed heat index, with BMD air temperature recorded as evidence)

| Indicator | L1 | L2 | L3 | Basis |
| --- | --- | --- | --- | --- |
| WBGT, peak in next 24 h (°C) | ≥ 23 | ≥ 28 | ≥ 31 | [A] L2/L3 are the ACGIH acclimatized screening values for moderate (28) and light (31) work; L1 is the heavy-work advisory line (§11.3) |
| Heat index, computed (°C) | ≥ 27 | ≥ 32 | ≥ 39 | [M] NWS category edges "caution", "extreme caution", "danger" (already in `thresholds.js`) |
| BMD max air temperature (°C), evidence only | ≥ 36 | ≥ 38 | ≥ 40 | [B] BMD heat-wave classes: mild 36–37.9, moderate 38–39.9, severe 40–41.9, very severe ≥ 42 |

Provider WBGT is a model estimate and may not include direct sun; the message says "estimated". The heat index is labelled "computed from BMD temperature and humidity".

**STRONG_WIND** (highest gust in next 12 h, km/h; BMD `wg` is derived from GFS, Xweather `windGustKPH`)

| L1 | L2 | L3 | Basis |
| --- | --- | --- | --- |
| ≥ 40 | ≥ 60 | ≥ 80 | L1 [P] start of Beaufort force 6; L2 [B] BMD river-port signal 2 and Kalbaishakhi squalls are quoted at 60–80 km/h; L3 [P] top of that band. BMD river-port signal 1 (45–60 km/h) falls inside L1 |

**Lightning is always CRITICAL (D10).** Every lightning scenario (FARM-04, FISH-02, WORK-03, CONS-01, PUBLIC-02) outputs CRITICAL for both observed strikes and threat polygons, as the catalogue says. The lightning *level* below changes only the wording and the re-notify rule, never the severity. Alarm fatigue is handled by the episode rules that follow, not by downgrading.

**OBSERVED_LIGHTNING** (distance is computed by us from each strike to the area's representative point)

| Level | Rule | Basis |
| --- | --- | --- |
| L2 | at least 1 strike within **16 km** in the episode | [P] about 10 miles: industry stand-down radii are 8–10 miles to leave evacuation time (secondary) |
| L3 | at least 1 strike within **10 km**, or at least 5 within 16 km | [M] a 30-second flash-to-thunder gap is about 6 miles ≈ 10 km (NWS rule of thumb, secondary) |
| Episode closes | 30 minutes after the last strike, when no threat period is still ahead | [M] "30 minutes after the last thunder" (NWS guidance via secondary sources) |

Intracloud and cloud-to-ground pulses both count (intracloud often precedes ground strikes) [P]. Matching is against a representative point, not an exact position.

**LIGHTNING_THREAT** (Xweather threat polygon periods, a nowcast up to 60 minutes ahead; a potential area, not a prediction for a place)

| Level | Rule | Wording |
| --- | --- | --- |
| L3 | a polygon period covers the area point and starts ≤ 30 min from now | "Lightning is expected near you within about 30 minutes" |
| L2 | covers it and starts 30–60 min from now | "Lightning is possible near you within the next hour" |

**Alarm-fatigue controls for lightning** (the first notice of an episode is never suppressed; these rules only reduce repeats)

1. **One card per subscriber per lightning episode and scenario.** A threat and the strikes that follow it are the same episode, so they update one card instead of creating two.
2. **At most two re-notifications per episode**, each putting the card back to unread with a visible reason: (a) the first confirmed strike in an episode that began as a threat; (b) the first strike within 10 km. Individual pulses never re-notify.
3. **Spatial precision:** observed = within 16 km of the subscriber's area point; threat = the polygon covers that point. Not the whole 100 km circle and not the whole district.
4. **Only subscribers with a lightning scenario that applies** are notified (for example outdoor play for PUBLIC-02, roof or scaffolding work for CONS-01).
5. **Quiet ending:** when the episode closes the card is marked expired with "This alert period has ended. This is not an all-clear." and does **not** create a new unread notification.
6. **Tuning view:** the admin Overview shows lightning episodes in the last 24 hours and notifications sent per episode.

**MARINE_WEATHER** (coastal and marine fishermen; river fishermen use STRONG_WIND and the river-port bulletins)

| Metric | L1 | L2 | L3 | Basis |
| --- | --- | --- | --- | --- |
| Significant wave height (m) | ≥ 1.5 | ≥ 2.1 | ≥ 3.0 | [M] NWS small-craft seas criteria start at about 5–7 ft; no BMD wave criterion found. Small country boats may be at risk well below this [P] |
| Gust (km/h) | ≥ 40 | ≥ 51 | ≥ 62 | [B] BMD sea-port local cautionary signal 3 (≈ 40–50) and warning signal 4 (≈ 51–61) as reported (secondary: official table not retrieved) |

The level is the higher of the two. Official BMD fisherman/sea bulletins always take precedence in wording and are shown separately.

**Dry spell (FARM-03)**: a *forecast* dry day = BMD daily rain < 2.5 mm [M] (IMD convention; no Bangladesh standard found). Trigger: ≥ 7 consecutive forecast dry days from today **and** mean forecast maximum ≥ 32 °C [P], for `cropStage` planting or growing. Observed past rainfall is not available, so the message says "forecast", never "drought".

### 11.3 Heat load class and per-class lines (scenario level)

The hazard event is occupation-neutral. A subscriber is mapped to a class, and the class sets where ADVISORY and WARNING begin.

**Class:** start from `workload` (light / moderate / heavy). Move **one class heavier** (cap at heavy) if `ppeHeatBurden = heavy`, or vendor `shelterAccess = none`, or `hoursOutdoor` > 8. General public = light; `isHeatSensitive` = at least moderate.

| Class | WBGT ADVISORY / WARNING (°C) | Heat-index ADVISORY / WARNING (°C) | Basis |
| --- | --- | --- | --- |
| Light | ≥ 28 / ≥ 31 | ≥ 39 / ≥ 51 | WARNING = [A] ACGIH acclimatized value; ADVISORY = WARNING − 3 °C |
| Moderate | ≥ 25 / ≥ 28 | ≥ 32 / ≥ 39 | same |
| Heavy | ≥ 23 / ≥ 26 | ≥ 27 / ≥ 32 | WARNING = [P] 26 °C: ACGIH gives no screening value for heavy work (recommends detailed assessment) and one secondary table estimates 26; ADVISORY = WARNING − 3 °C |

The 3 °C margin reflects NIOSH's finding that limits for unacclimatized workers run about 2–3.5 °C below acclimatized ones. The heat-index column steps one NWS category per class [P]. Heat never produces CRITICAL (the catalogue assigns WARNING at most).

### 11.4 Scenario timing and de-duplication

| Item | Value | Basis |
| --- | --- | --- |
| Rain lead time (FARM-01/02, PUBLIC-01, WORK-04) | event starts within 12 h; harvest WARNING only if it starts within 6 h | [P] |
| Heat lead time | worker scenarios speak up to 6 h before the shift or outdoor window and ≥ 2 h before the forecast peak; never before 06:00 local; once per day per scenario | [P] |
| Wind lead time | within 12 h | [P] |
| Lightning | observed: now; threat: ≤ 60 min | provider nowcast horizon |
| Marine | within 24 h | [P] |
| Dry spell | at most once per 3 days | [P] |
| Re-notify | Lightning: at most 2 per episode (first strike after a threat; first strike within 10 km). Every other hazard: only when the severity escalates | [P] |
| Daily ADVISORY cap | 3 per subscriber | [P] |
| Quick-status expiry | 12 h; `on_water` older than 6 h = `scope_uncertain` (FISH-05) | [P] |

### 11.5 Path to "validated"

| Group | Who to ask | What they must confirm |
| --- | --- | --- |
| Rain, wind, marine, heat-wave bands | BMD | 3 h figures, gust bands, sea-port and river-port signal table, wave guidance |
| Dry spell, crop-stage advice | Department of Agricultural Extension | dry-day definition, crop-specific days, wording |
| WBGT lines and workload classes | an occupational-health reviewer | heavy-work line, sun adjustment, PPE class shift |
| Lightning radii and episode length | disaster-management / lightning-safety staff | 16 km / 10 km radii, 30-minute rule for Bangladesh, whether threat polygons deserve CRITICAL |

---

## 12. Rule coverage matrix (catalogue IDs → data → milestone)

Thresholds refer to §11. "Unknown" is a state, not a severity.

| Rule | Hazard | Needs from profile | Severity logic | Phase |
| --- | --- | --- | --- | --- |
| FARM-01 Rain at harvest | HEAVY_RAIN | `cropStage=harvesting` | ADV at L1 (≤ 12 h); WARN at L≥2 starting ≤ 6 h; states amount and uncertainty | M2 |
| FARM-02 Planting vs harvesting | HEAVY_RAIN | `cropStage` | ADV; planting = planning wording | M2 |
| FARM-03 Dry days and irrigation | dry spell | `irrigationAccess`, `cropStage` | ADV; "check your field", no volume; soil moisture **not used** (scaling unverified) | M4 |
| FARM-04 Lightning in open field | OBSERVED_LIGHTNING, LIGHTNING_THREAT | `fieldAreaPcode` | CRITICAL for observed or threat; one card per lightning episode | M5 |
| FARM-05 Midday heat | HEAT_STRESS | `workload`, `outdoorHours` | class lines: ADV / WARN | M2 (heat index), M4 (WBGT) |
| FISH-01 River vs marine | bulletin | `waterBody`, areas | WARN / CRITICAL by signal; official text verbatim | M6 |
| FISH-02 Lightning on water | OBSERVED_LIGHTNING | `status=on_water` | CRITICAL | M5 |
| FISH-03 After withdrawal | bulletin lifecycle | `waterBody` | ADV / WARN `transition_caution`, no fixed 12 h | M6 |
| FISH-04 Pre-departure vs on-water | MARINE_WEATHER, STRONG_WIND | `status` | pre-departure WARN at L1+; on-water WARN at L1–2, CRITICAL at L3 | M4 |
| FISH-05 Moving, no coverage | any | `statusUpdatedAt` | unknown state `scope_uncertain`; recheck on reconnect | M4 |
| WORK-01 Midday heat spike | HEAT_STRESS | shift | class lines; early ADV before peak, WARN when urgent | M2 |
| WORK-02 Urban heat | HEAT_STRESS | derived `urbanExposure` | ADV precaution sentence; **no threshold shift** | M2 |
| WORK-03 Storm on the road | lightning | `outdoorExposure=on_road` or active activity | CRITICAL; "not under trees" | M5 |
| WORK-04 Rain in busy hours | HEAVY_RAIN | shift | ADV at L1 overlapping the shift; `flood_claim=false` | M2 |
| WORK-05 Long shifts | HEAT_STRESS | shift length, `workload` | ADV; one reminder per shift day | M4 |
| CONS-01 Lightning at height | lightning | `activityType` roof/scaffolding | CRITICAL | M5 |
| CONS-02 Heavy work + PPE | HEAT_STRESS | `workload=heavy`, `ppeHeatBurden` | class lines (PPE shifts the class); WARN; asks supervisor to review | M4 |
| CONS-03 Wind at height | STRONG_WIND | elevated `activityType` | WARN at L≥1; "does not replace an engineering assessment" | M2 |
| CONS-04 Slippery after rain | recent rain | `siteExposure` | ADV; needs a recent-rain source | M7 |
| VEND-01 Wind at stalls | STRONG_WIND | `outdoorStall` | WARN at L≥1; "secure early, never go out in the storm" | M2 |
| VEND-02 Heat in market | HEAT_STRESS | `hoursOutdoor`, `shelterAccess` | class lines | M4 |
| VEND-03 Several markets | any | saved markets | ADV; no repeat for the same hazard | M7 |
| PUBLIC-01 Commute rain | HEAVY_RAIN | commute window | ADV at L1 overlapping the window | M2 |
| PUBLIC-02 Outdoor play, lightning | lightning | `outdoorPlay` | CRITICAL; "wait 30 min after the last thunder" as general guidance | M5 |
| PUBLIC-03 Heat-sensitive | HEAT_STRESS | `isHeatSensitive` | moderate-class lines | M2 / M4 |
| PUBLIC-04 Home/work/current | any | `areas[]` roles | every alert names its area | M2 |
| PUBLIC-05 No green on no data | all | none | unknown state per hazard; matches the map | M2 |
| CTX-01 Multi-occupation | all | `activeActivity` | activity override with expiry | M4 |
| CTX-02 GPS unavailable | all | `matchMethod` | states "precise location unavailable" | M1 |
| CTX-03 Shared phone/child | delivery | `guardianManaged` | minimal text; no names in SMS | M1 stores; later enforces |
| CTX-04 Quiet hours | delivery | `quietHours` | non-urgent deferred; CRITICAL follows consent | stored M1; enforced with SMS/push |

---

## 13. Notification contract and severity colours

### 13.1 Contract

Internal levels ADVISORY, WARNING, CRITICAL are AkashSathi's own. Official BMD signals are shown **separately in their original wording**.

**Every alert exposes:** affected area · hazard and severity · source and observation/forecast time · validity period · why this subscriber received it · recommended action · **who sent it**.

**Message structure:** *what* → *where and when* → *why you* → *what to do* → *source, time, validity*. A template test enforces: no "safe", "all clear", "guarantee", "flooded", "waterlogged"; lightning wording distinguishes observed from threat; rain wording carries uncertainty; heat wording never diagnoses.

```json
{
  "scenarioId": "CONS-01", "ruleVersion": "prototype-1", "ruleStatus": "prototype",
  "origin": "automatic", "status": "active", "publishedBy": "engine",
  "severity": "CRITICAL",
  "title": "Lightning detected near Badda",
  "message": "Lightning was detected within 16 km of Badda, Dhaka at 15:42 (Xweather, last 5 minutes). ...",
  "reasonForSelection": "You work on a roof or scaffolding at a site in Badda.",
  "recommendedActions": ["stop_elevated_work", "move_inside_building"],
  "affectedArea": { "scope": "upazila", "upazilaPcode": "302604", "name": "Badda", "text": "Badda, Dhaka" },
  "sourceReferences": [{ "provider": "xweather", "product": "lightning", "observedAt": "2026-10-10T15:42:00+06:00" }],
  "validUntil": "2026-10-10T16:12:00+06:00", "dataStatus": "FRESH", "isDemo": false
}
```

### 13.2 Severity colours (to be added to `design.md`)

These are the only non-palette colours allowed outside weather layers, used **only** for alert severity. They reuse values already in the temperature ramp.

| Severity | Chip fill | Chip text | Icon / shape | Contrast (computed) |
| --- | --- | --- | --- | --- |
| ADVISORY | Sage `#A9BE87` | Deep Olive `#2E3D28` | circle with "i" | 5.73 : 1 |
| WARNING | amber `#F2A03D` | Deep Olive `#2E3D28` | triangle with "!" | 5.44 : 1 |
| CRITICAL | red `#B8312B` | Soft White `#E8E9DF` | octagon with "!" | 4.88 : 1 |
| Unknown / stale / unavailable | existing greys (`#8C9A80`, `#6B7568`) | — | dotted outline | existing rule |

Rules: severity is always **word + icon + colour**. Sage and amber on Soft White are only 1.65 : 1 and 1.74 : 1, so they are used as **filled chips with olive text**, never as a lone border or icon on a light surface. CRITICAL cards add a 2 px red border, a bold title and `role="alert"`. There is never a green "safe" state.

---

## 14. Scheduling, caching and the Xweather quota

### 14.1 Principles

Fetch **by shared area/query**, evaluate many subscribers against the cached result. One background job in the Express process; it never overlaps itself (the existing `every()` guard) and records `lastCompletedAt` per task in `JobState`. A Mongo lease protects against a second process later.

### 14.2 Refresh policy (prototype)

| Data | Cadence | Cost | Scope |
| --- | --- | --- | --- |
| BMD forecast | existing 30-min probe, full pull only on a new run | free | all 544 |
| BMD bulletins | 30 min | free | 5 products |
| Xweather forecast | 3 h | 1 / area | **monitored areas only**, capped (default 10) |
| Xweather maritime + wind | 6 h | 1 + 1 / point | marine points of monitored fishermen (default ≤ 4) |
| Lightning | gated, §14.3 | 1 / 10 / 10 | monitored circles |
| Radar / satellite | existing | free | — |
| Alert engine tick | 2 min | none | memory + Mongo |

"Monitored area" = an upazila with at least one active subscriber. The Alert page and the admin Overview show the **monitoring scope** and last-checked times.

### 14.3 Lightning: tiered and gated

```text
Gate for a circle opens when ANY: thunder potential ≥ 1 for a monitored upazila in that circle within 3 h (Open-Meteo/BMD),
   Xweather forecast code indicates thunder, a probe in the last 60 min was positive, or the daytime baseline is due.
Tier 1  summary probe, 100 km circle, from=-5minutes        1 token    every 5 min while the gate is open (contiguous 5-minute coverage)
Tier 2  /lightning/closest, ONE call per positive circle   10 tokens   at most once per 5 min; distances to every monitored upazila in the circle are computed locally
Tier 3  /lightning/threats/closest                          10 tokens   every 10 min while the gate is open and subscribers are inside
Baseline  Tier 1 only, hourly 10:00–22:00 Dhaka, monitored circles
```

UI wording: *"Lightning is checked when forecasts indicate thunderstorm potential and hourly in daytime. A check covers the previous 5 minutes only, so this is not continuous monitoring and an unforecast storm can be missed."* Tier 1's populated response is **not verified**; until spike S2 a positive probe counts as "reported, count unknown" and still triggers Tier 2.

### 14.4 Budget (corrected)

Observed: allowance 15,000 per period; period resets 2026-11-09 00:00 GMT; 14,816 remaining after probing; summary 1 token, strikes and threats 10, forecast/conditions/maritime 1, air quality 5. Existing campaign ≈ 420 (Mode B); reserve 100 → **usable ≈ 14,296**.

| Spend over 30 days | Assumption | Tokens |
| --- | --- | --- |
| Forecast | 10 areas × 8/day × 30 | 2,400 |
| Maritime | 4 points × 4/day × 30 | 480 |
| Marine wind forecast | 4 points × 4/day × 30 | 480 |
| Lightning baseline | 3 circles × 12/day × 30 | 1,080 |
| Gated probes | ≤ 100 gate-circle-hours × 12 | 1,200 |
| Strike detail (Tier 2) | ≤ 150 calls × 10 | 1,500 |
| Threats (Tier 3) | ≤ 60 gate-hours × 6 × 10 | 3,600 |
| **Alert engine total** | | **10,740** |
| **Headroom** | 14,296 − 10,740 | **≈ 3,556 (≈ 25 %)** |

These are planning numbers, not measurements. The **token governor** (`xweatherBudget.js`) enforces them:

- Every call passes `spend({ class, cost })`, which refuses when `remaining − reserve − campaignOutstanding` would go negative. Priority when tight: lightning Tier 1 > forecast > maritime > Tier 3 > extra Tier 2.
- Daily soft cap = usable remaining ÷ days left until reset, split by class; unspent budget rolls forward, overspend is refused rather than borrowed.
- Prefers `x-cost-tokens` and `x-ratelimit-remaining-period|minute` from responses over its own arithmetic (the client already parses them). The lightning campaign reports into the same ledger (a two-line change in its `settle`).
- Per-minute limit respected (100/min observed; existing code uses 80 %).
- On `quota`, `rate-limit` or `auth` the affected product pauses and its snapshots become `UNAVAILABLE`; the status panel says why.

---

## 15. Security and privacy

- **Subscribers:** random 32-byte token, only its hash stored; cookie `HttpOnly`, `SameSite=Lax`, `Secure` in production, one year, refreshed on use. State-changing requests require `Content-Type: application/json` and a matching `Origin` (CSRF guard). Cookie parsing is ten lines or the tiny `cookie` package. Anonymous means: rate limit (10 profiles/hour/IP), honeypot, global cap, 90-day inactivity expiry.
- **Admin:** §6.1. One shared passcode, so it is only as strong as that secret: use a long random value, keep it in `server/.env`, rotate it if it leaks. No per-admin identity in v1; `AdminActions` therefore says "admin".
- **Input:** server-side schema validation with whitelists; unknown fields rejected; strings length-limited; admin free text is rendered as text, never HTML; reference links restricted to http/https.
- **Data minimisation:** area codes only; GPS used once client-side and discarded; no names, phone or email; no medical detail; admins see counts only; **delete my profile** removes everything.
- **Logs and errors:** reuse `redactSecrets`; never log tokens, the passcode or credentials. The Xweather credentials were pasted into this session earlier, so rotation is still advisable.
- **SMS/WhatsApp later:** built from the stored notification with no profile data (CTX-03); they would need a phone number, which is a new consent step.

---

## 16. Delivery plan

Sizes are relative (S ≈ a day, M ≈ 2–3 days, L ≈ a week of focused work).

### M0 — Verification spikes (S) · before the dependent parts

| ID | Spike | Output |
| --- | --- | --- |
| S1 | Xweather forecast cost with `filter=1hr&limit=12/24/48`; confirm WBGT, `pop`, `precipMM`, gust and weather-code fields | cost table in `BMD_WEATHER_API.md` |
| S2 | Capture a **populated** summary / strikes / threats payload when one occurs; until then parsers from documentation, fixtures marked `synthetic` | parsers + fixtures |
| S3 | BMD `rf` units against a rainy forecast and Xweather `precipMM` | unit note; unlocks BMD rain amounts |
| S4 | Re-check whether BMD warning pages populate; capture one real bulletin's text structure | parser notes |
| S5 | Marine zones and coordinates (only North Bay is verified) | `marineZones` constant |
| S6 | Retrieve the **official** BMD river-port and sea-port signal tables (the §11 figures are from news reports) | verified signal table |

### M1 — Alert entry: button → form → saved (L) · *your immediate request*

| Task | Files |
| --- | --- |
| Navbar Alert button, mobile variant, bell icon, route, lazy page | `Navbar.jsx`, `landing.css`, `router.js`, `App.jsx`, `pages/AlertPage.jsx`, `loadAlertPage.js`, `lib/icons.js` |
| Form schema (six roles, EN/BN) + server validator | `services/alerts/schema.js`, `controllers/alertController.js` |
| Wizard with conditional fields, area picker, review step | `client/src/alert/*`, `lib/alertForm.js` |
| `Subscriber` + `Area` models, subscribe / me / edit / delete, device-token cookie, rate limit | `models/`, `middleware/subscriber.js`, `routes/alertRoutes.js` |
| "Saved" screen with monitoring scope and how alerts are sent; honest empty inbox | `AlertPage.jsx` |
| Severity ramp in `design.md`; README | docs |

**Exit:** a visitor can click Alert, complete the form for each of the six roles, reload and still see their profile; invalid input is rejected by the server; no provider is called; clearing the cookie returns them to the form.

### M2 — Engine core on BMD data (L)

Hazards: rain (amount per S3, else Open-Meteo `pop`/Xweather only), heat via computed heat index, strong wind. Models: `HazardEvent`, `Notification`, `RuleSetting`, `EngineSettings`, `JobState`. Pipeline stages 0–4 with **automatic publishing**, the optional hold/draft path, deduplication, expiry, backfill. Scenarios: FARM-01/02/05(HI), WORK-01/02/04, CONS-03, VEND-01, PUBLIC-01/03/04/05. Inbox with badge, cards, sender label, "what we checked".

**Exit:** a BMD-derived event that crosses a §11 threshold reaches exactly the right subscribers **without any admin action**, once; running the tick twice creates no duplicates; stale BMD data stops new alerts and is shown as stale; turning a hold on keeps that severity invisible to subscribers until it is released.

### M3 — Admin dashboard (L)

Admin auth (passcode, session, rate limit, `ADMIN_AUTH=off` guard), `AdminSession` / `AdminAction`, `adminController`, `services/alerts/admin.js`; `/admin` and `/admin/login` routes, lazy chunk; screens: Overview, **Send alerts** (Send now from weather, Declare a hazard, Free message), History with Withdraw, Rules (read-only), Settings (kill switches, hold, demo subscribers, "view as"). Preview-before-send, confirmations, idempotency, rate limit, audit.

**Exit (the demo):** a subscriber completes the form → the admin opens `/admin`, ticks **Farmer**, presses **Check current weather** then **Send only Farmer alerts** (or declares a hazard) → the subscriber's inbox shows it within 30 s; pressing it again creates no duplicate; **Withdraw** marks it withdrawn without any all-clear wording.

### M4 — Xweather weather and maritime, token governor (M)

`xweatherForecast`, `xweatherMaritime`, `WeatherSnapshots`, governor + shared ledger, per-area scheduling with the cap, WBGT-based heat, quick-status control (CTX-01), FISH-04/05, FARM-03, WORK-05, CONS-02, VEND-02.

**Exit:** the admin Overview shows spend by class and the projection; the governor refuses spend that would breach the reserve (tested with a mock).

### M5 — Lightning (L)

Gate, tiers, parsers, boundary data on the server, **lightning episodes** with lifecycle and the §11.2 fatigue controls, FARM-04, FISH-02, WORK-03, CONS-01, PUBLIC-02, critical-alert UI (live region), honest-monitoring copy.

**Exit:** a fixture threat followed by fixture strikes creates **one** CRITICAL card per eligible subscriber and episode, with at most the two allowed re-notifications; further pulses update evidence silently; the episode closes after 30 minutes with the "not an all-clear" wording and no new unread notification.

### M6 — Official bulletins and withdrawal (M)

`bmdBulletins`, parser status, official-notice block, FISH-01/03, explicit official withdrawal. Until a parser is trustworthy, surface the dated PDF link and metadata only and mark the alert "official notice updated" without asserting a warning.

### M7 — Hardening (M)

Quiet-hours hook for future delivery, VEND-03 saved markets, CONS-04 (needs a recent-rain source), optional recovery code for moving a profile to another device, Bangla review, accessibility pass, README, rule editor UI if wanted.

### Demo script (for the hackathon presentation)

1. A visitor opens the landing page, clicks **Alert**, completes the form as a **farmer at harvest in Badda, Dhaka**, and sees "Alerts are sent automatically".
2. **Automatic path:** when the BMD forecast crosses the rain threshold for Badda, FARM-01 appears in that inbox within about two minutes, with source, time, validity, *why you got this*, and the `prototype` label. (If the weather does not cooperate, use step 3.)
3. **Admin path:** open `/admin`, **Declare a hazard** (heavy rain, level 2, Dhaka district, roles Farmer + Rickshaw/labourer). If the cached data does not support the declaration, the preview says so and asks for a typed confirmation; send it. Each role gets its own wording.
4. **Send now:** tick **Construction**, press **Check current weather**, read the four groups (new, already sent, held, nothing detected), press **Send only Construction alerts**.
5. **Lightning drill:** declare lightning level 2 in Badda for Construction, Farmer and Student; each gets one CRITICAL card; declare it again at level 3 for the same area (it updates the same event) to show the allowed re-notification; **Withdraw** it and show the "not an all-clear" text.
6. Show **What we checked** with a stale source: the cards say "source stale" and nothing turns green.

### Later

~~SMS / WhatsApp~~ (built: a delivery service reading stored notifications, see the README), browser push, AQI hazard, per-admin accounts, expert validation of thresholds (§11.5), flood data if a verified dataset appears.

---

## 17. Testing

Same tooling as today (`node --test`, mocked Xweather client, DB tests gated by `TEST_MONGODB_URI`; Xweather is never called by tests).

- **Schema and form:** every role accepts a valid profile and rejects missing required fields, unknown keys and out-of-list options; `alertForm.js` conditional logic table-tested.
- **Threshold table tests:** for each §11 rule, values just below, at and above each edge produce the expected level; class mapping (§11.3) tested for every combination.
- **Scenario golden tests:** every rule ID in §12 has a positive and a negative case (FARM-01 with `cropStage=planting` never uses harvest wording; WORK-04 never contains a flood claim).
- **Pipeline invariants:** two ticks → zero new rows; escalation re-notifies; evidence change updates silently; expiry flips status; overlapping forecast windows update one event; **with the default settings a met threshold is published to the subscriber without admin action; with a hold on, the notification is a draft that the inbox endpoint never returns until released**.
- **Lightning fatigue rules:** a threat then strikes in one area produce one card per subscriber; at most two re-notifications per episode; individual pulses never re-notify; episode close creates no unread notification; severity is CRITICAL for observed and for threat at every level; a new episode after a 30-minute quiet gap produces a new first notice.
- **Honesty invariants:** `NO_MATCH` never produces an all-clear; `STALE` never creates or escalates; `UNAVAILABLE` yields the unknown state; district events never claim upazila precision; withdrawal and expiry text never says "all clear".
- **Admin:** wrong passcode rate-limited; admin disabled without a passcode; `ADMIN_AUTH=off` ignored in production; send by role reaches only that role; "send now" never duplicates what the engine already sent and reports it as already sent; idempotency key and unique index prevent double sends; withdraw updates the batch; declare-hazard shows the data-support check; free-message links restricted to http/https; demo audience never reaches live subscribers.
- **Subscribers:** cookie token round-trip, only the hash stored, delete removes everything, rate limit and cap enforced, inactivity expiry (TTL *and* application check).
- **Message lint:** banned-phrase test over every template in both languages.
- **Governor:** budget never dips below reserve; class priority under pressure; header values override arithmetic; quota/auth classes pause products.
- **End to end (demo mode):** subscriber → admin send → inbox card, for every role, so the demonstration does not depend on real weather (real lightning is rare and the account has only returned no-match results).

---

## 18. Risks and open unknowns

| Risk / unknown | Effect | Mitigation |
| --- | --- | --- |
| Populated Xweather lightning shapes never seen | Parsers may be wrong | S2; defensive parsing; synthetic fixtures; fix on first real payload |
| Quota exhausted by lightning | Lightning silently stops | Governor, gating, visible budget, `UNAVAILABLE` rather than silence |
| Gated lightning misses an unforecast storm | Missed critical alert | Baseline probes; explicit UI limitation; never "continuous" |
| BMD `rf` units unknown | Wrong rain levels | S3 first; until then other sources for amounts |
| Some §11 figures come from news reports (BMD signal ranges, 30-minute rule, radii) | Wrong numbers | Tagged (secondary); S6; §11.5 expert path |
| Alerts are sent **automatically** on prototype thresholds (D8) | A wrong or over-sensitive threshold reaches many people | Visible `prototype` label; conservative de-duplication; daily ADVISORY cap; admin **Withdraw**, per-hazard **kill switch**, optional **hold**; §11.5 path to validation |
| Lightning is always CRITICAL (D10) | Alarm fatigue from repeated critical alerts | Episode model, two-re-notification cap, spatial precision (16 km / polygon), quiet ending; tuning view in the admin Overview |
| Single shared admin passcode | Leak = anyone can broadcast | Long random secret, short sessions, rate limit, audit, preview + confirm, withdraw; per-admin accounts later |
| Admin free text could mislead | Harm from a wrong message | Sender label, validity cap, soft lint, preview, withdraw; cannot claim to be BMD |
| Anonymous subscribers can be spammed in | Junk data, inflated monitoring scope | Rate limit, honeypot, global cap, inactivity expiry; monitored-area cap |
| Cookie lost = inbox lost | Missed alerts after clearing data | Stated plainly in the UI; recovery code in M7 |
| BMD third-party host has no stated terms or uptime | Source disappears | Open-Meteo fallback; statuses surface it |
| Bulletin PDFs change layout or pages stay blank | No official alerts | Parser status; link-only fallback; a blank page is never a withdrawal |
| Bangla safety text unreviewed | Misleading wording | Review flag; human review before any public demo |
| `design.md` forbade non-palette colours outside weather | Severity colours | Amendment (D3), scoped to severity |
| Single Express process | One failure stops checks | Lease + `JobState` ready for more workers |
| Shared allowance with the lightning campaign | Double spending | Shared ledger |

---

## 19. Configuration and references

**New environment variables** (all optional unless noted): `ADMIN_PASSCODE` (**required to enable `/admin`**), `ADMIN_AUTH=on|off` (off only outside production, loopback only), `ALERT_ENGINE=on|off`, `ALERT_TICK_MINUTES=2`, `ALERT_MAX_SUBSCRIBERS=5000`, `ALERT_MAX_FORECAST_AREAS=10`, `ALERT_MAX_MARINE_POINTS=4`, `ALERT_LIGHTNING_BASELINE=on`, `ALERT_ACTIVITY_TTL_HOURS=12`, `ALERT_DAILY_ADVISORY_CAP=3`. Thresholds are **not** environment variables: they live in `config/alertRules.js` and `RuleSettings`, versioned.

The catalogue stays the authority on scenarios. When a rule is added or changed there, update `services/alerts/scenarios/*`, the matrix in §12 and the golden tests together.

**References used for §11** (retrieved 10 October 2026; *(secondary)* = news report, blog or third-party table, not the standard itself)

- BMD rainfall classes (light 1–10, moderate 11–22, moderately heavy 23–43, heavy 44–88, very heavy > 88 mm / 24 h): BAMIS publishes BMD bulletins, e.g. <https://www.bamis.gov.bd/res/public/weather_table/pdf/2024-06-23.pdf>
- BMD heat-wave classes: <https://thefinancialexpress.com.bd/national/mild-to-moderate-heatwave-sweeps-dhaka-21-districts> *(secondary)*, <https://en.prothomalo.com/environment/lsjp2c74gu> *(secondary)*
- BMD Kalbaishakhi squalls 60–80 km/h: <https://server6.bmd.gov.bd/file/2026/05/04/pdf/203619.pdf>
- River-port signals 1 (45–60 km/h) and 2 (60–80 km/h): <https://www.dhakatribune.com/bangladesh/378958/weather-river-ports-asked-to-hoist-signal-1>, <https://www.tbsnews.net/node/633810> *(secondary)*
- Sea-port signals 3 and 4 (≈ 40–50 and ≈ 51–61 km/h): <https://www.dhakatribune.com/bangladesh/310995/what-does-each-marine-signal-mean> *(secondary)*
- ACGIH WBGT screening values (light 31, moderate 28 acclimatized; no heavy-work value): <https://www.dli.mn.gov/sites/default/files/pdf/STD_5-1.3_indoor_ventilation_and_temperature.pdf>, <https://health.usf.edu/-/media/v3/usf-health/COPH/Thomas-Bernard/Heat-Stress/HSSTLVScreen22.ashx> *(heavy-work 26 estimate: secondary table)*
- NIOSH unacclimatized limit 2–3.5 °C below acclimatized: <https://www.cdc.gov/mmwr/volumes/67/wr/mm6726a1.htm>
- AMS rain intensity (light ≤ 2.5, moderate 2.6–7.6, heavy > 7.6 mm/h): <https://glossary.ametsoc.org/wiki/Rain>
- NWS small-craft criteria: <https://www.weather.gov/marine/cwd>
- Dry day < 2.5 mm (IMD convention): <https://mausamsankalp.imd.gov.in/rfdry>
- Lightning 30-minute rule, flash-to-bang distance, 8–10 mile stand-down radius *(secondary)*: <https://www.hseblog.com/lightning-safety-at-work/>; confirm at weather.gov/safety/lightning
