# AkashSathi — implementation status

Last verified: **11 October 2026**. This document says what is built against [`ALERT_ENGINE_PLAN.md`](ALERT_ENGINE_PLAN.md), what is not, and what to preserve. It was produced by reading the code against the plan (an independent read-only audit, spot-checked by hand) and by running the test suites, not by trusting earlier claims.

## Verification

The table below records earlier verification results. Current installation and test commands are maintained in the [README](../README.md#testing).

| Check | Result |
| --- | --- |
| `npm run test:db` (server, including MongoDB-backed tests, isolated random databases) | **354 passed, 0 failed, 0 skipped** |
| `npm test` (client workspace) | **84 passed, 0 failed** |
| `npm run build` | Passes. Alert, admin and map remain separate lazy chunks; Vite still reports the known large MapLibre chunk. |
| `npm audit` | **0 reported vulnerabilities** at the latest pre-push check. |
| Live provider calls in tests | None. Xweather, Telegram, WhatsApp and SMS are mocked; no test spends quota or sends a message. |

The latest local verification used Node.js **24.14.0**. [GitHub CI](../.github/workflows/ci.yml) is configured to run the workspace tests against an isolated MongoDB 8 service and build the frontend on Node.js 22. The hosted workflow still requires its first run after pushing.

## Milestones against the plan

| Milestone | Verdict | Notes |
| --- | --- | --- |
| **M1** Alert entry: form, profile, device cookie | **Done** | Bilingual five-step wizard, edit/pause/delete, hashed-token cookie, rate limit, honeypot, global cap. |
| **M2** Engine core on BMD data | **Done** | Detection, recipients, scenarios, automatic publishing, de-duplication, expiry, backfill, optional hold. Defects found by the audit are fixed (below). |
| **M3** Admin dashboard | **Done** | Passcode session, preview/send/declare/message/withdraw, idempotency, audit, settings, demo tools. Rate limit is process-wide, not per session. |
| **M4** Xweather forecast and maritime, token governor | **Partial** | Forecast, maritime, governor and quick status exist. Missing: the Overview budget projection, and the lightning campaign writing into the shared ledger (the governor only reads campaign state). WORK-05 is folded into WORK-01. |
| **M5** Lightning | **Partial** | Gate, tiers, episodes, fatigue rules and the critical live region exist. Missing: server-side polygon boundary data (matching uses the representative point). Parsers have only seen synthetic payloads. |
| **M6** Official bulletins | **Partial** | North Bay marine notices create FISH-01/03. River-port, fleet C-90 and general bulletins are dated links only. The warning classifier has only run on synthetic text; the live PDFs inspected so far all said NO STORM WARNING. |
| **M7** Hardening | **Mostly open** | CONS-04 and VEND-03 are now scenarios (14 October 2026). No recovery code or rule editor. Bangla is unreviewed. Quiet hours are now enforced for external channels (see below). |
| **Delivery channels** (plan: "Later") | **Built** | Telegram bot, WhatsApp (templates) and SMS (Twilio or generic HTTP). Mocked-provider tests only; not run against live accounts. See the README. |
| **Stored history** | **Built** | Per-district run summaries with a TTL, and `GET /api/weather/history`. |
| **Satellite storm warnings** | **Built (prototype)** | STORM_APPROACH / PUBLIC-06 from the Himawari-9 storm tracker, Telegram only. See below. |
| **Telegram weather commands** | **Built** | `/update`, `/heat`, `/rain`, `/wind`, `/thunderstorm`, `/lightning`, `/forecast`, `/alerts`, `/status`, with a menu and buttons. See below. |

## FloodSense (27 October 2026)

**Built.** `server/src/services/ffwc.js` reads FFWC's observed, observed-rainfall, three-day rainfall, station registry, and update-date endpoints with the required project key and site headers. `floodSense.js` normalises readings, matches stations to upazilas/districts, classifies levels, and creates one `RIVER_FLOOD` event per area with scenario `FLOOD-01`. `floodShelters.js` parses DDM's embedded shelter list and ranks nearest Flood shelters. The public API is `/api/flood/status`, `/api/flood/stations`, `/api/flood/shelters`, and `/api/flood/demo`; `/flood` is a lazy-loaded bilingual page with a labelled demo mode and no provider calls on load.

**Rules.** `APPROACHING` is within **0.5 m below** FFWC's danger level, `ABOVE` is at/above it, and `SIGNIFICANTLY_ABOVE` is at least 1.0 m above. The approach band and level-3 line are project rules, not FFWC classes. L1 is `ADVISORY`; L2/L3 are `WARNING`. Missing or zero danger levels are `UNAVAILABLE`, never normal. Stale readings cannot create or escalate. Withdrawal requires a fresh snapshot and a fresh gauge back below the band.

**Shelters.** Only Flood shelters with usable Bangladesh coordinates are kept; the nearest three within 50 km are shown. DDM does not publish occupancy or open/closed status. A failed refresh keeps the last list and reports `STALE` (`shelterSnapshotStatus`), rather than pretending no shelters exist.

**Live checks.** FFWC endpoints returned 127 observed rows with 123 placeable readings and 0 unmatched after spelling aliases were fixed. DDM returned 1,950 rows, of which 771 were Flood shelters. Live alerts observed: Companiganj (Companyganj gauge) approaching by 0.23 m and Mongla approaching by 0.45 m.

**Tests.** `server/test/flood.test.js` covers classification boundaries, aliases, grouping, shelter parsing, nearest-shelter ranking, and the stale-list rule. Scenario/message tests include `FLOOD-01` and allow flood wording only for `RIVER_FLOOD`. Full server and client suites pass; the client build emits a separate `FloodPage` chunk. MongoDB-backed tests still require `TEST_MONGODB_URI`.

**Not verified.** No live alert delivery through Telegram/WhatsApp/SMS was triggered for a flood event. FFWC access depends on the project key and headers remaining valid. The page and messages need human review of the Bangla copy and domain review of the flood thresholds.

## What the last pass changed

**Data layer.** Verified that forecasts, lightning and alerts were already collect-then-serve (no request handler calls a weather provider; the radar image proxy is the one disclosed exception). Added the missing piece: compact history (`weatherruns`, about 20 KB per run, `WEATHER_HISTORY_DAYS`), because only the latest 3–4 MB forecast was kept and every earlier run was overwritten.

**Delivery.** `server/src/services/delivery/`: queue with a unique `(notification, channel, stage)` key, send-time re-checks, retry and back-off, lease recovery, per-person serialisation (so the daily cap is exact), Telegram link and bot (polling or webhook), phone verification (consent, atomic attempt counting, per-profile and per-number limits), encrypted phone storage, three channel adapters, a short message format with no profile data, and administrator counts. Consent text is `v4`.

**Engine defects fixed** (each has a regression test in `server/test/alertPipeline.test.js`):

1. Stale or unavailable data could raise and re-notify an existing card, because a rule's own clock (FARM-01 turns ADVISORY into WARNING as the peak nears) escalated regardless of data status. Stale data now only annotates `dataStatus`.
2. A severity hold was bypassed when a live card was raised to the held severity. The rise now waits for the administrator and is applied when released.
3. Someone who joined during a lightning episode that had already re-notified started at stage 0, so the next tick re-flagged their card as new. New cards start at the episode's current stage.
4. `trust proxy` was never set, so behind a reverse proxy every visitor shared one rate-limit bucket. `TRUST_PROXY` now configures it.
5. User-facing 5xx messages (for example "SMS is not set up on this server") were masked as "Internal server error". They can now be marked as exposed.
6. `ADMIN_AUTH=off` now prints a warning at start-up, as the plan required.

## Telegram weather commands (11 October 2026)

`server/src/services/delivery/botReports/`: `places.js` (633 places: 64 districts, 544 BMD locations, 25 boundary areas without a BMD code; English and Bangla; ambiguity lists up to five), `readings.js` (pure calculations over the stored forecast), `text.js` (English and Bangla wording, Telegram HTML), `commands.js` (parsing, language, place, request limit), `data.js` (the few MongoDB reads: lightning checks, active alerts, engine status). `telegramBot.js` routes commands and button presses; `channels/telegram.js` gained HTML mode, inline buttons, `answerCallbackQuery` and `setMyCommands`.

**Verification.** 47 unit tests (`botReports.test.js`: places, readings, wording in both languages for every command and place type, stale and missing data, privacy, buttons, rate limit, HTML fallback, adapter payloads, menu), 2 MongoDB-backed tests (connected chat, lightning), and a full run of the real server against live BMD and Open-Meteo data with a mock Telegram that rejects invalid HTML like the real one (menu registered in both languages, every command, six buttons, a connected chat, a real alert through the admin API and delivery job, and a flood of 34 requests). Not run against a live Telegram chat.

**Decisions worth knowing.**

- *Current weather is the forecast for the current 3-hour step.* The project has no station observations; every reply says "model forecast, not a station reading".
- *Rain amounts come from Open-Meteo while it is current*, because BMD's rainfall unit is still unconfirmed (spike S3, the same reason the alert engine refuses BMD amounts). When BMD's amounts are used the reply says their unit is not independently confirmed.
- *BMD's gust is below BMD's own mean wind in about 30% of stored steps* (measured on 17,408 steps). The bot shows the larger of the two published numbers, so a gust is never lighter than the mean wind. The alert engine is unchanged and still reads BMD's gust as published; if BMD's gust is systematically low, STRONG_WIND alerts under-detect. Worth asking BMD what its gust field is.
- *`/lightning` shows the most recent of two stored checks*: the alert engine's probes of the 100 km circle around monitored areas (hourly 10:00-22:00, every 5 minutes while thunder is forecast or lightning was seen) and the map campaign's samples (07:00, 15:00 and 23:00 for ten days). It never says that no lightning is happening.
- *`/forecast` is derived from the 3-hour steps* (up to five local days, four are stored), so it works for every place type and uses the same rain-source rule. The 10-day BMD outlook stays on the website.
- *Anyone can use the weather commands*, connected or not. The profile is used only to find the saved area and the active alerts; replies never contain occupation, crop, shift or the reason an alert was sent. A typed Bangla place name gets a Bangla reply unless the profile says otherwise.
- *Request limit* 30 per chat per 10 minutes, in memory (`TELEGRAM_COMMAND_LIMIT`); `/start`, `/stop` and `/help` are not limited.

**Not done.** The Bangla text, like all Bangla here, needs a fluent reader; `/forecast` shows no observed values or official extremes.

### Compact report formatting

The Telegram formatting update uses short HTML headings and a maximum of four timeline rows for the next 12 hours, while retaining 24-hour peaks and totals. Routine reports no longer repeat source, prototype, or observation-disclaimer footers; `/status` provides source freshness, stale forecasts show update-time warnings, and unverified BMD rainfall retains a warning. The morning digest still includes its model-forecast disclaimer and update time. Missing values, HTML escaping, language selection, and profile-data privacy remain covered by tests.

## Morning weather message (11 October 2026)

Every day at 06:00 Bangladesh time the bot sends today's weather, unasked, to each Telegram chat connected to a profile with a saved area. Added beside the existing code: `services/delivery/morningDigest.js` (window, claim, send, retry), `jobs/morningDigestJob.js` (a one-minute tick, started with the other delivery jobs), `models/MorningDigest.js` (one row per person per day), `renderMorning` at the end of `botReports/text.js`, `todayIdx` and `dayParts` in `botReports/readings.js`, and three settings (`MORNING_DIGEST`, `MORNING_DIGEST_TIME`, `MORNING_DIGEST_GRACE_HOURS`). Nothing that existed was changed in behaviour: the only edits to existing code are `export` on the two month-name lists in `alerts/messages.js`, new imports in `text.js` and `readings.js`, one line in `scheduler.js` and the model list in `models/index.js`. README: "Morning weather message".

**Verification.** 30 tests in `morningDigest.test.js`: the wording in English and Bangla (every block, the day parts, a late-day send, missing data never zero, the alert rules' forbidden phrases, no Latin digits in Bangla, under the Telegram limit), the send window, and, against a throwaway MongoDB database, once-a-day idempotency (second tick, two servers at the same moment, next day), before and after the window, a changed time, only connected / active / real profiles, a profile without an area, quiet hours, a stale or missing forecast, a place the forecast does not cover, language, two saved areas with a retry that does not repeat the first, a Telegram outage with back-off up to the window's end, a blocked chat, a rejected token, the HTML fallback, nothing added to the alert queue, no profile answers in the text, and the job's own tick and lease. The whole server suite passes (353 tests). The message was also rendered from the forecast the real server had stored (read-only, nothing sent), in both languages, for a thana and a district. Not run against a live Telegram chat.

**Decisions worth knowing.**

- *Everyone who connected Telegram gets it, with no separate opt-in.* They connected for alerts; the morning message is a new kind of message to them. `/stop` ends all messages in the chat; there is no "morning message only off" switch yet (it would need a new command or a profile setting).
- *Outside the alert path on purpose.* It does not use the `Delivery` queue (which is keyed by alert notification), so it cannot delay an alert, does not count against the daily cap and is not shown in the administrator's delivery counts.
- *A forecast that is not current is never sent as today's weather.* It waits until the forecast is current or the window closes. This is the same rule the alert queue applies to alerts built on stale data.
- *Quiet hours hold it, a closed window drops it.* A person whose quiet hours end after the window closes gets no message that day.
- *Retries stay inside the window* so a message about the morning never arrives in the evening.
- *The Bangla text is a draft, like all Bangla here.*

**Not done.** A per-person on/off switch or choice of time; the administrator page does not list morning messages; no live-chat run (needs a real send to a connected chat, which only the person who owns the bot can see).

## Page load, green flash and CPU review (11 October 2026)

Reported: a green flash on every refresh, an error on refresh, and sometimes lag. Measured in headless Edge over the DevTools protocol (frame-by-frame colour, long tasks, layout shift, per-process CPU, request timing), on the production build and on the Vite dev server, against the real server with live data.

| Finding | Cause | Fix |
| --- | --- | --- |
| Green flash on `/`, `/alert`, `/admin` | The root background is Deep Olive (the map's colour); light pages only turned cream after React had started, and the loading splash was olive too. React also holds a revealed lazy page back about 300 ms after showing a fallback, so `/alert` and `/admin` showed olive for about 290 ms on every reload, even with the code cached (0.4-0.8 s on a slow connection) | `index.html` sets `data-page` before the first paint and carries the first-paint colours; `main.jsx` loads the current page's chunk before the first render (`pages/pageLoader.js`), links warm the next one on hover, so no splash is shown; the splash and the `index.html` placeholder are page-coloured and invisible for the first 0.4 s |
| Red `401 Unauthorized` in the console on every `/alert` and `/admin` visit | The "who am I?" checks used a 401 as the answer | New `GET /api/alerts/session` and `GET /api/admin/session` always answer 200 (`profile: null`, `state: closed / signed-out / signed-in`); every endpoint that does something still answers 401. The client falls back to the old calls against an older API (a newer page keeps working until the server restarts) |
| Chrome notice "Password forms should have username fields" | The admin form has one shared passcode and no account name | A hidden, fixed username field |
| Small layout shift on `/alert` (0.039) | The footer sat in view while the page loaded, then jumped away | Footer shown once the page has loaded (0.000) |
| Landing hero used 29% of a CPU core (median) in the GPU process while idle, 31% without a GPU | Five infinite SVG animations inside one SVG, redrawn on every screen refresh (60-144 times a second) for motion of a fraction of a pixel | Each moving part is its own composited layer, and all of them step on one 0.125 s beat: 3.4% with a GPU, 6.5% without. The page's own main thread went from 0.4% to 0.1%. Visually identical, still moving (8 updates a second, 0.2-0.5 px each). The existing "Pause motion" button and `prefers-reduced-motion` still apply. Offscreen the hero already cost about 1% |
| `/api/alerts/status` took ~170-200 ms, `/api/alerts/me/coverage` similar | Three to four database reads one after another | Reads run together: 172 ms to 88 ms |

Checked and fine: the map page is smooth with a GPU (0 dropped frames, worst frame 12-21 ms through slider scrubbing, zoom, pan and play); without a GPU, software WebGL drops frames while panning, which no code change can fix. API latency over three minutes: no stalls (median 5 ms for in-memory endpoints). The three-minute probe also showed the Atlas round trip is 45-100 ms, which is why database-backed endpoints are 45-100 ms and why parallel reads matter.

Not changed: the map page is olive while it loads, by design (it is a dark map). In Vite's dev mode the browser loads about 4 MB of unbundled scripts on the landing page and 9 MB on the map; the production build is 88 KB and 384 KB.

## UI review (11 October 2026)

Method: the real server with mock Telegram, WhatsApp and SMS providers on a throwaway database, driven in headless Edge at 1440×900 and 375×812. Every page (landing, map, alert form, inbox, admin sign-in and overview) was screenshotted and audited in the page for touch-target size, labels, duplicate ids, contrast, tiny text, horizontal overflow, keyboard focus indicators (tabbing through each page) and reduced motion. The channels panel was driven through every state in English and Bangla. The UI/UX Pro Max guidance for forms (visible labels, input types, inline errors tied with `aria-describedby`) was checked against the new panel. Palette and typography were left as defined in `design.md`.

Fixed:

- **Contrast.** The shared muted-text token was 4.1:1 on Soft White (map ticks, legend notes, status chips); it is now 5.2:1. Landing index numbers raised to match.
- **Text size.** 68 declarations below 11px (down to 8px on mobile landing) now have an 11px floor. Checked on both widths: no wrapping or overflow regressions.
- **Targets.** Map Live/Forecast tabs, layer button, Details button, "About this layer" and the brand link reach 44px; the time slider has a 44px hit area with the same footprint; short footer links got a wider hit area without moving.
- **Map footer.** The attribution overlapped the time bar; the bar and legend moved up 6px.
- **Copy bug.** "BMD WRF forecast forecast available".
- **Channels panel.** WhatsApp and SMS now show a Connect button and open their number form on demand, like Telegram, instead of two long forms.

Result: no page overflows at 375px; no control lacks an accessible name; every focusable control shows an indicator; no animations run with reduced motion; no text under 11px. What the audit still lists is understood: disabled controls (exempt from contrast), checkboxes whose 44px label is the target, the MapLibre attribution toggle (library control, 24px), and the "Data"/"Map" footer links whose widened hit area is a pseudo-element the audit cannot measure.

Not done: the site has no dark theme; nothing was tested on a physical phone or with a screen reader; the Bangla strings are unreviewed.

## Satellite storm warnings and the storm-aware /thunderstorm (16 October 2026)

**Data.** The storm tracker (`ml-service/storm/`) now reads JMA's raw Himawari-9 band 13 from NOAA's open-data bucket (`storm/himawari.py`, `STORM_SOURCE=noaa`), which arrives about 15 minutes after each scan instead of 45-60 minutes for the NASA GIBS images, and carries real cloud-top temperatures. The server asks for each new frame every `STORM_MINUTES` (2) instead of waiting for the 30-minute satellite list. Each cell now lists every upazila it may reach (`{pcode, etaMin}`); the old 40-place cut-off dropped hundreds of places for large cells.

**Alert.** `STORM_APPROACH` (`services/alerts/stormEpisodes.js`, rules in `config/alertRules.js`, shared reading in `services/stormOutlook.js`) and scenario **PUBLIC-06** (`scenarios/storm.js`, catalogue row added): a cell with tops colder than -66 °C, not weakening and moving, whose straight-line track reaches a person's saved area or live location within 60 minutes **counted from now** (image age subtracted). One episode per area, WARNING for every occupation with occupation advice, level 3 within 30 minutes, valid until an hour after the expected arrival, ends by time (no all-clear), an image older than 60 minutes is STALE (cannot create or move a warning), at most one warning per area in 3 hours. Delivery: not held by quiet hours (the user's decision: it would expire unsent), Telegram only (`STORM_ALERT_CHANNELS`), daily cap still applies. The same signal opens the Xweather lightning gate (reason `satellite-storm`), so real strikes then raise the existing CRITICAL lightning alert.

**Telegram.** `/thunderstorm` leads with "Right now (satellite)": the soonest cell reaching the place, counted from now, with its cloud-top temperature, movement and trend, or "nothing tracked on this image" (never an all-clear), STALE or unavailable. After "Which place?" (or a not-found or ambiguous name) the bot remembers the command for 5 minutes, so a typed name or a shared location answers it; every command offers the location button; ambiguous names come with a button per place; "Mohammadpur Dhaka" (no comma) and the bot's own "Mohammadpur, Dhaka (City thana)" both resolve.

**Replay of the saved storm day** (22 September 2026, 13:20-18:00, NOAA data, every one of 544 places assumed to have a subscriber): 296 warnings to 283 places, at most 2 to any place; 74% were followed by the storm cloud covering the place within 90 minutes; median 25 minutes between the message and that image; of 310 places a storm cloud reached during the afternoon, 47% were warned beforehand (the rest mostly had storms forming overhead, or weaker cells). One afternoon is a small test.

**Verification.** Server suite with MongoDB-backed tests against a local throwaway MongoDB: 408 passed (new: `stormAlerts.test.js`, `alertStorm.test.js`, storm cases in the bot, message, scenario and delivery tests); client 105 passed; ml-service 15 passed; build passes. One unrelated morning-digest test failed once in a full run and passed in two further full runs and on its own (timing). Not run against a live Telegram chat or during a live storm.

**Map.** The Storm movement layer now shades, in the WARNING amber, the upazilas a storm warning applies to (`GET /api/storms` adds `arrivals`, computed with the alert rule at request time; the replay counts each frame 15 minutes after it was taken), labels each with its name and expected time, draws every moving cell's 30, 60 and 90-minute circles with the clock time on each, and in live mode shows the picture ml-service draws from the NOAA frame (`GET /api/storms/image/:name`, warm ground transparent), so it lines up with the outlines. The panel shows a legend and, for a selected place, the warning and its time counted from now. Features are built in `client/src/lib/stormMap.js` (tested without a map).

**Not done.** WhatsApp and SMS for storm warnings (a config change); storms that form overhead get no advance warning (no growth/cooling detection yet); the separate Satellite map layer is still GIBS (about 45 minutes older than the storm outlines); Bangla needs a fluent reader.

## Declaring a hazard now reaches everyone in the chosen area (16 October 2026)

**Gap.** Admin "Declare a hazard" ran the same catalogue scenarios as the automatic engine: a subscriber in the chosen area and role only received something if their occupation (and its own conditions — crop stage, shift window, site exposure, activity) matched a scenario for that hazard. Some occupations have no scenario at all for some hazards (a fisherman and `HEAVY_RAIN`, for example): choosing an area and sending left them out silently, which did not match what "choose an area, send" implies.

**Fix.** `services/alerts/notify.js`: `applyEvent` now also returns `matchedSubscriberIds` (who the catalogue had something to say to). A new `applyGenericDeclaration` sends everyone else in the chosen area/role/audience the same declaration in generic, occupation-neutral wording — the exact sentence `describeHazard`/`titleFor` already compose for a declaration ("An administrator has declared heavy rain (level 2) for Badda... This was not detected from weather data."), scenario id `ADMIN-GENERAL`, a small hazard-appropriate action set, stored and withdrawn exactly like a normal notification (same `hazardEventId`, so History and withdrawal cover it; updating a declaration leaves an already-sent `ADMIN-GENERAL` row as is, the same limitation the lightning re-declare row above already states). Severity: lightning stays CRITICAL (the whole system's rule); every other hazard stays ADVISORY/WARNING even at a declared level 3, because the catalogue's own scenarios for those hazards never reach CRITICAL either — the fallback must not claim more urgency than the scenarios it stands in for. Wired into both `preview` and `send` for `mode: 'declare'` in `admin.js`.

**Not done.** This only covers the moment the admin sends or re-sends the declaration. A subscriber who signs up, or edits their profile, after the send is not retroactively given the generic notice by the regular 2-minute engine tick (unlike a real scenario match, which the tick does keep backfilling) — reaching them needs the admin to send again. "Send now from weather" and "Free message" are unchanged (the first is scenario-only by design; the second already reached everyone in its area, with no scenario matching at all).

**Verification.** New test in `alertApi.test.js` (`declare a hazard: everyone chosen in the area receives it, even an occupation with no catalogue scenario for this hazard`): a farmer (matches FARM-01) and a fisherman (no `HEAVY_RAIN` scenario) in the same upazila both appear in the preview and both receive a notification on send, the fisherman's labelled `ADMIN-GENERAL`/`admin`/`WARNING`; a second preview of the same declaration shows 0 new, 2 already sent. Full server suite: 412 passed. Client: 110 passed (one `DeclareTab` notice sentence added, English and Bangla).

## A stored alert now reads in either language, not only the one it was sent in (16 October 2026)

**Gap.** `/alert`'s language toggle already saved the choice to the subscriber's profile (a real profile edit), but a Notification document was composed once, in one language, at the moment it was created, and stayed in that language forever (`lang`, plus plain-string `title`/`message`/etc.). Switching the toggle only changed which language *new* alerts would be written in; every card already on screen kept whatever language was current when the server built it. Testing back and forth between English and Bangla while declaring hazards therefore left a mix of cards in different, seemingly random languages, which read as broken rather than as "each alert is fixed at send time" (true of the Telegram/SMS copy, but not obviously true of the web inbox).

**Fix.** `services/alerts/notify.js`: a new `translationsOf(composeFn, args)` calls the relevant compose function (`composeNotification`, `composeAdminMessage` or `composeGenericDeclaration`, all already pure and already parameterised by `lang` for the admin preview's side-by-side sample) in both languages and keeps only the fields that actually vary by language (`title`, `message`, `recommendedActions`, `reasonForSelection`, `affectedArea`; severity, hazard, evidence, times etc. do not). The result is attached to the composed `content` before every insert and before every update (`CONTENT_FIELDS` now includes `'translations'`, so an escalation or a silent refresh keeps both readings current the same way it already keeps everything else current), and stored as `Notification.translations: { en: {...}, bn: {...} }` (`models/Notification.js`, a `Mixed` field — display data only, never queried). `services/alerts/inbox.js` returns it; delivery (Telegram/WhatsApp/SMS) is untouched and still sends the primary, single-language fields exactly as before. Client: `alert/format.js` gets `localized(item, lang)`, used by `AlertCard.jsx` (every place that rendered `item.title`/`.message`/`.reasonForSelection`/`.recommendedActions`/`.affectedArea.text`/`.lang` now reads `view.*` instead) and by `useInbox.js`'s screen-reader announcement for a newly arrived CRITICAL alert. A card from before this existed, or administrator free text left untranslated in one language, has no `translations` for that reading and falls back to the language it was actually composed and sent in, never a silent mistranslation.

**Verification.** `alertApi.test.js`'s declare-a-hazard tests now also assert `translations.en`/`translations.bn` on a real stored Notification (both scenario-based and the `ADMIN-GENERAL` fallback above): the Bangla reading actually contains Bangla text, differs from the English one, and the place itself (`upazilaPcode`) does not change with language. New client test (`alertForm.test.js`) for `localized()`: picks the requested language when `translations` exists, and falls back to the sent language, unchanged, when it does not. Full server suite: 412 passed (one documented pre-existing timing flake in a lightning-episode test, unrelated, passed on its own and on a second full run). Client: 111 passed.

**Not done.** The admin's own preview samples and delivered Telegram/WhatsApp/SMS messages were already effectively bilingual-at-compose-time (the preview already showed both; delivery already fixes one language per send) and are unchanged. Nothing re-translates text the administrator typed by hand in only one language (`composeAdminMessage` already marks a missing Bangla side with "বাংলা অনুবাদ দেওয়া হয়নি" rather than inventing one, in both the primary field and its `translations.bn`).

## Two admin-side idempotency bugs fixed (16 October 2026)

**Found by.** A targeted review of the admin send/withdraw code (preview→confirm→send state machine, the idempotency/claim flow, withdraw paths), asked for directly rather than found in passing. Two confirmed, concrete bugs; everything else traced (preview/send recipient-count parity, role/area normalisation, auth/session/rate-limit logic, settings patching, the client's send-flow state machine) held up.

**Bug 1: a failed send replayed as "already sent", with nothing to show it had actually failed.** `previousSend()` (`services/alerts/admin.js`) replayed *any* stored outcome for an idempotency key, including `'failed'` — it only guarded against `'pending'`. `claim()`'s own race-condition fallback (reached when two inserts collide on the key's unique index) had the identical bug. So: a send that failed partway through (the 20-sends-an-hour rate limit, a transient database error, anything that throws after `claim()` marks the key `'failed'`) could never be retried with the same key. Clicking Send again on the same still-open confirmation (the client never issues a new key there — only re-opening the confirmation does) returned HTTP 200, `{replayed: true, outcome: 'failed', result: null}`. The UI showed "This send had already been made. 0 sent · 0 updated · 0 already sent", worded exactly like a real no-op repeat, with no error and no clear way to tell the alert had never gone out at all.
**Fix.** `previousSend` no longer replays a `'failed'` outcome (treats it as "no prior send"). `claim()` now reclaims a `'failed'` row for the same key — `findOneAndUpdate({idempotencyKey, outcome: 'failed'}, {$set: {..., outcome: 'pending'}})` — instead of only ever trying to insert a new one, so the retry actually happens under the same key rather than being swallowed. The genuine race case (two simultaneous clicks) is unaffected: the loser still finds a `'pending'` row and gets the 409 it got before.

**Bug 2: withdrawing one engine-detected event by its own id had no guard against repeating it.** The `batchId` branch of `withdraw()` (`services/alerts/admin.js`) already filtered on `lifecycle: 'active'`, so a repeated withdrawal of the same batch correctly finds nothing and reports 404. The `eventId` branch (used for History's per-event "Withdraw" button on automatic hazard events) had no such filter: it re-ran `withdrawEvent()` unconditionally, which re-saves the event, silently overwrites `withdrawal.{at,reason,source}` and bumps `revision` again, and still reports a normal `{events: 1, notifications: 0}` success — indistinguishable from a first, real withdrawal. Two tabs open on History (or any retry after the row goes stale) could silently replace who withdrew an event, when, and why.
**Fix.** The `eventId` branch now only adds the event to the list to withdraw when `event.lifecycle === 'active'`; otherwise it falls through to the same "Nothing to withdraw: those alerts have already ended." 404 the batch path already used.

**Verification.** Two new tests in `alertApi.test.js`: a repeated withdrawal by event id now 404s and leaves the original `withdrawal.reason` and `revision` untouched; a send seeded with a pre-existing `'failed'` `AdminAction` row for its key now genuinely retries (`replayed: false`, 1 notification actually created), and only a *second* call after that real send correctly reports `replayed: true`. Full server suite: 414 passed. Client: 111 passed (unchanged by this fix).

## Known gaps (not fixed, so nobody mistakes them for done)

Plan requirements that the code does not meet, with where they live:

| Plan | Gap |
| --- | --- |
| §3, §9: nearest-location forecasts are `PARTIAL` | Thirteen newer upazilas and seven city corporations use a nearest BMD forecast, but alerts for them are labelled `coverage: 'exact'` (`services/alerts/hazards.js`) and `Area.forecastApproximate` is always false. The map flags it; alerts do not. |
| §11.4 timing | `heatPeakLeadHours` and the dry-spell `repeatDays` are defined in `config/alertRules.js` and never used. Heat alerts only require the event to start within the lead window; "once per day per scenario" is not enforced. |
| §14.3 contiguous lightning coverage | Probes are due after at least 5 minutes but the engine ticks every 2, so the real cadence is 6 minutes and each probe covers the previous 5: about one minute per cycle is never observed. The interface already says checks are not continuous. |
| §10.1, §7.4 | `HazardEvent.evaluatedRevision` is defined and never read; the engine re-evaluates every active event each tick. |
| §5.5 expired fisherman status | An expired status is approximated (raised to WARNING with an "update your status" hint), not shown as unknown (`scenarios/fisherman.js`, FISH-04). |
| Plan demo step 5 | Re-declaring lightning at a higher level silently updates the card; declared events carry no `renotifyStage`, so the allowed re-notification does not happen. |
| §11 / admin withdrawal | Withdrawing an automatic event is not durable: the event key embeds the first qualifying start, which slides, so a still-qualifying forecast can create a new event after a withdrawal. The per-hazard kill switch is the durable control. |
| §17 banned-phrase lint | The lint patterns are English only, so the Bangla pass is vacuous. |
| §15 | The subscriber cookie is not refreshed on use (one year from sign-up), and a missing `Origin` header is allowed (non-browser clients). |
| §6.2 | Overview shows monitored areas but not circles, and no budget projection. |
| §12 | FISH-05 and WORK-02/05 are flags inside other rules, not separate notifications; CONS-04 (rain at an open site, inspection advice, including six hours after the rain) and VEND-03 (rain at any market, one card per rain across markets via `oncePerHazard`) exist but VEND-03 has no per-market hours, it uses the 07:00-20:00 vendor default; PUBLIC-04/05 and CTX-01 are cross-cutting rather than rules; the `in_field` activity is consumed by nothing. |
| `Area` collection | Seeded but unused by the hot path; `hasPolygon` and `coastal` do not exist. |
| FloodSense thresholds | The 0.5 m approach band and 1.0 m level-3 line are project rules without FFWC or disaster-agency review; no flood forecast or evacuation claim is made. |
| FloodSense matching | Station-to-upazila matching uses names and a small alias list. New FFWC spellings can appear as unmatched until an alias is added. District fallback can create a separate event if an upazila gauge disappears and later returns. |
| Flood shelter freshness | DDM has no live occupancy/open status. A cached list surviving an outage is labelled `STALE` but can be days old. |
| Admin preview | "Check current weather" runs detection, which can create hazard events; nothing is sent, but the preview is not audited. |

## Open unknowns

- **S2** A populated Xweather lightning payload has never been captured. Parsers follow the documentation and synthetic fixtures; fix `parseSummary` and the strike/threat parsers on the first real payload.
- **S3** BMD rainfall units per step are unconfirmed. `ALERT_BMD_RAIN_VERIFIED` stays off until checked against a rainy forecast.
- **S6** The official river-port and sea-port signal tables were taken from secondary sources; thresholds in `config/alertRules.js` are `prototype` and not expert-validated. Several figures come from news reports (flagged in the plan's reference list).
- BMD's forecast API is a third-party host with no stated terms or uptime.
- Bangla text, including the new channel strings and bot replies, needs review by a fluent speaker (`bnReviewed` is false).
- Telegram, WhatsApp and SMS adapters are unverified against live accounts (see the README).

## Invariants to preserve

- No accounts. An anonymous HttpOnly cookie, only its hash stored. No names, e-mail or exact location. A phone number only for someone who chose WhatsApp or SMS and verified it, encrypted at rest, masked in the interface, deleted with the profile.
- Page views read stored data only; provider requests belong to background jobs. Tests mock every provider.
- Unknown, stale or unavailable is never safe. Stale data may annotate an existing alert but never creates, raises or rewrites one. Expiry and withdrawal are never an all-clear.
- Lightning is always CRITICAL; one episode per area, one card per subscriber and rule, at most two re-notifications, a quiet ending.
- Default automatic publication; optional severity hold and per-hazard kill switches; administrator preview and confirmation; sends are idempotent and audited.
- The bot's weather replies follow the alert wording rules (no "safe", no "all clear", a forecast is never a measurement, missing is never zero) and carry no profile answers; a test lints every command in both languages.
- External messages carry no profile data (CTX-03); CRITICAL messages are never held by quiet hours or the daily cap (CTX-04); each alert stage reaches a channel at most once.
- UI uses Soft White, Sage and Deep Olive; only severity chips use the additional amber and red. English and Bangla, keyboard access, 44 px controls.

## Where things are

- Engine: `server/src/services/alerts/` (`cycle.js`, `engine.js`, `notify.js`, `lightningEpisodes.js`, `officialNotices.js`, `scenarios/`).
- FloodSense: `server/src/services/ffwc.js`, `server/src/services/alerts/floodSense.js`, `floodStations.js`, `floodShelters.js`, `scenarios/flood.js`; public API `server/src/controllers/floodController.js`; page `client/src/pages/FloodPage.jsx`.
- Delivery: `server/src/services/delivery/` (`queue.js`, `linking.js`, `telegramBot.js`, `channels/`), `server/src/jobs/deliveryJob.js`, `server/src/controllers/channelController.js`.
- History: `server/src/services/weatherHistory.js`, `server/src/models/WeatherRun.js`.
- Client: `client/src/alert/` (including `ChannelsPanel.jsx`), `client/src/admin/`.
- Tests: `server/test/` (`delivery*.test.js`, `weatherHistory.test.js`, `alert*.test.js`), `client/test/`.
