# AkashSathi — implementation status

Last verified: **11 October 2026**. This document says what is built against [`ALERT_ENGINE_PLAN.md`](ALERT_ENGINE_PLAN.md), what is not, and what to preserve. It was produced by reading the code against the plan (an independent read-only audit, spot-checked by hand) and by running the test suites, not by trusting earlier claims.

## Verification

| Check | Result |
| --- | --- |
| `npm run test:db` (server, including MongoDB-backed tests, isolated random databases) | **273 passed, 0 failed, 0 skipped** |
| `npm test` client | **72 passed, 0 failed** |
| `npm run build` | Passes. Alert, admin and map remain separate lazy chunks; Vite still reports the known large MapLibre chunk. |
| Live provider calls in tests | None. Xweather, Telegram, WhatsApp and SMS are mocked; no test spends quota or sends a message. |

## Milestones against the plan

| Milestone | Verdict | Notes |
| --- | --- | --- |
| **M1** Alert entry: form, profile, device cookie | **Done** | Bilingual five-step wizard, edit/pause/delete, hashed-token cookie, rate limit, honeypot, global cap. |
| **M2** Engine core on BMD data | **Done** | Detection, recipients, scenarios, automatic publishing, de-duplication, expiry, backfill, optional hold. Defects found by the audit are fixed (below). |
| **M3** Admin dashboard | **Done** | Passcode session, preview/send/declare/message/withdraw, idempotency, audit, settings, demo tools. Rate limit is process-wide, not per session. |
| **M4** Xweather forecast and maritime, token governor | **Partial** | Forecast, maritime, governor and quick status exist. Missing: the Overview budget projection, and the lightning campaign writing into the shared ledger (the governor only reads campaign state). WORK-05 is folded into WORK-01. |
| **M5** Lightning | **Partial** | Gate, tiers, episodes, fatigue rules and the critical live region exist. Missing: server-side polygon boundary data (matching uses the representative point). Parsers have only seen synthetic payloads. |
| **M6** Official bulletins | **Partial** | North Bay marine notices create FISH-01/03. River-port, fleet C-90 and general bulletins are dated links only. The warning classifier has only run on synthetic text; the live PDFs inspected so far all said NO STORM WARNING. |
| **M7** Hardening | **Mostly open** | No VEND-03 saved-market handling, CONS-04, recovery code, or rule editor. Bangla is unreviewed. Quiet hours are now enforced for external channels (see below). |
| **Delivery channels** (plan: "Later") | **Built** | Telegram bot, WhatsApp (templates) and SMS (Twilio or generic HTTP). Mocked-provider tests only; not run against live accounts. See the README. |
| **Stored history** | **Built** | Per-district run summaries with a TTL, and `GET /api/weather/history`. |

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
| §12 | FISH-05 and WORK-02/05 are flags inside other rules, not separate notifications; CONS-04 and VEND-03 have no implementation; PUBLIC-04/05 and CTX-01 are cross-cutting rather than rules; the `in_field` activity is consumed by nothing. |
| `Area` collection | Seeded but unused by the hot path; `hasPolygon` and `coastal` do not exist. |
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
- External messages carry no profile data (CTX-03); CRITICAL messages are never held by quiet hours or the daily cap (CTX-04); each alert stage reaches a channel at most once.
- UI uses Soft White, Sage and Deep Olive; only severity chips use the additional amber and red. English and Bangla, keyboard access, 44 px controls.

## Where things are

- Engine: `server/src/services/alerts/` (`cycle.js`, `engine.js`, `notify.js`, `lightningEpisodes.js`, `officialNotices.js`, `scenarios/`).
- Delivery: `server/src/services/delivery/` (`queue.js`, `linking.js`, `telegramBot.js`, `channels/`), `server/src/jobs/deliveryJob.js`, `server/src/controllers/channelController.js`.
- History: `server/src/services/weatherHistory.js`, `server/src/models/WeatherRun.js`.
- Client: `client/src/alert/` (including `ChannelsPanel.jsx`), `client/src/admin/`.
- Tests: `server/test/` (`delivery*.test.js`, `weatherHistory.test.js`, `alert*.test.js`), `client/test/`.
