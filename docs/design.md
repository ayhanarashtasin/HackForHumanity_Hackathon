# Design

## Color palette

| Name       | Hex code | Look                            |
| ---------- | -------- | ------------------------------- |
| Soft White | #E8E9DF  | Warm off-white, slightly creamy |
| Sage Green | #A9BE87  | Muted, light leaf green         |
| Deep Olive | #2E3D28  | Very dark green, almost black   |

## Usage rules

- **All UI uses only the three palette colors** (and tints/alpha of them): map basemap, panels, buttons, text, borders, focus rings.
- Deep Olive is the map canvas and the text color on Soft White panels. Soft White is panel/surface and text on Deep Olive. Sage Green is the accent, active state and "calm / no data of concern" color.
- The palette cannot tell heat from rain from thunder, so **weather data layers use the semantic ramps below**. They are the only colors outside the palette and are used *only* for weather data and its legends.
- Never show a calm color for missing data: unknown / stale / unavailable data is a neutral olive-grey (see Data status).

## Data colors (weather layers only)

Defined once in `client/src/lib/scales.js` and mirrored here.

| Layer | Unit | Stops (value → color) |
| --- | --- | --- |
| Temperature | °C | 10 `#5B8DB8` · 18 `#7FB5A3` · 24 `#C9D77A` · 28 `#F2D253` · 32 `#F2A03D` · 36 `#E0662F` · 40 `#B8312B` · 44 `#7F1D2B` |
| Rain | mm / forecast step | 0.1 `#9ED0E6` · 1 `#5FB0D9` · 5 `#3B86C6` · 15 `#2F5FB0` · 40 `#5A3FA0` · 80 `#8A2D8F` |
| Radar rain rate | mm / h | BMD's own radar palette is kept as published (cyan → green → yellow → red) |
| Heat index (computed) | °C | 27 `#F2E394` · 32 `#F2C14E` · 39 `#EE8D3A` · 51 `#D9532B` (NWS category edges: caution / extreme caution / danger / extreme danger) |
| Wind | km/h | 0 `#CFE0C0` · 10 `#A9BE87` · 20 `#D8D36A` · 30 `#F0A63C` · 45 `#D9582B` · 60 `#9B2335` |
| Thunderstorm potential | level 1–3 | 1 `#F5D547` · 2 `#F2A900` · 3 `#D9480F` |
| Lightning summary | state | reported `#FFB800` (solid ring) · none in window `#A9BE87` (dashed) · stale `#8C9A80` · unavailable / not checked `#6B7568` (dotted) |
| Storm cells (satellite tracker) | intensity class | 4 (−58 °C) `#E9B949` · 5 (−66 °C) `#E0703A` · 6 (−72 °C) `#B8322A`; dashed circles at 30 / 60 / 90 minutes in the cell's colour, track and arrow in Soft White |
| Storm warning area | arrival | the WARNING amber `#F2A03D` of the alert ramp, because these are exactly the upazilas a storm warning applies to: within 30 min fill 42 %, within 60 min fill 20 %; arrival times in amber text |
| Live satellite picture (NOAA) | cloud-top °C | warmer than 0 transparent · 0 to −27 grey, fading out toward 0 · −27 cyan · −36 blue · −47 green · −58 yellow · −66 red · −72 dark red (the tracker's class edges, in the colours GIBS gives the same classes) |

### Data status

`OK` = full color · `STALE` = desaturated + "stale" badge with last-update time · `UNAVAILABLE` / `NOT CHECKED` = neutral olive-grey `#6B7568` with "Data unavailable".

## Alert severity

Alerts need a signal a palette of three greens cannot give, so **ADVISORY / WARNING / CRITICAL** have their own small ramp. These are the only colours outside the palette that appear outside weather layers, and they are used **only** for alert severity (chips, card edges, badge counts). Two of them are the temperature-ramp values already in use.

| Severity | Chip fill | Chip text | Icon / shape | Contrast of text on fill |
| --- | --- | --- | --- | --- |
| ADVISORY | Sage `#A9BE87` | Deep Olive `#2E3D28` | circle with "i" | 5.73 : 1 |
| WARNING | amber `#F2A03D` | Deep Olive `#2E3D28` | triangle with "!" | 5.44 : 1 |
| CRITICAL | red `#B8312B` | Soft White `#E8E9DF` | octagon with "!" | 4.88 : 1 |
| Unknown / stale / unavailable | the existing data-status greys `#8C9A80`, `#6B7568` | Soft White | dotted outline | existing rule |

Rules:

- Severity is always **the word + the icon + the colour**, never colour alone.
- Sage and amber on Soft White are only 1.65 : 1 and 1.74 : 1, so they are used **only as filled chips with Deep Olive text**, never as a lone border or icon on a light surface.
- A CRITICAL card adds a 2 px red border, a bold title and `role="alert"`.
- There is **never a green "safe" state**. An empty inbox says "No active alerts from the sources we checked"; a source that is stale or unavailable is grey with its last-checked time.
- Official BMD notices are shown in their own block, in their original wording, and are never recoloured into these levels.

Tokens: `--sev-advisory`, `--sev-warning`, `--sev-critical` (and `-ink` for the text) in `client/src/styles.css`.

## Alert and admin pages

Same three colours and the same paper-first look as the landing page; the severity ramp above is the only addition.

- **Alert page (`/alert`)**: a scrolling document with the landing navbar. A short wizard (one idea per step) for new visitors; the inbox, "what we checked" and the profile for returning ones. Bangla and English labels everywhere the form has them.
- **Admin page (`/admin`)**: a denser desktop layout (left navigation, wide tables) on the same palette. It is never linked from the public site, sends `noindex`, and shows the sender label "Administrator" on everything it sends.
- Interactive targets are at least 44 px; focus rings are Deep Olive on light surfaces; reduced-motion removes transitions.

## Landing page and navbar

Same three colors; the weather ramps never appear here. The only extra colors are the data-status greys, used in the "three states" card.

- **Direction:** paper-first editorial design. Soft White is the dominant canvas, Deep Olive reads as ink, and Sage is a restrained accent in illustrations and small details.
- **Navbar:** a horizontally centred floating pill, up to 960 px wide, detached 24 px from the top edge. A translucent Soft White surface, fine olive border, blur and subtle olive shadow match the paper-first aesthetic. Logo centred, two links on each side in equal columns, **Map** as a Deep Olive pill with Soft White text. The surface becomes 96 % opaque after scrolling. On phones the top gap is 12 px, with a rounded dropdown below, menu button left and Map right. Hero and anchor offsets keep content clear of the floating bar.
- **Hero:** oversized centred typography over a decorative translucent sky sculpture and a fine graph-paper grid. The globe and clouds float slowly, the globe grid turns, and the glass and orbital details drift on 13–80 second CSS transform loops. A small pause/resume control sits in the hero footer. The sculpture uses only palette colors and does not represent live weather data.
- **Sections:** Soft White and 2.5 % Deep Olive tints, with fine 16 % olive rules, numbered section labels, and open spacing. Feature cards form a ruled grid; the closing call to action uses delicate orbital lines on a light surface.
- **Text:** Deep Olive on light surfaces, Soft White on Deep Olive buttons. Muted body text is Deep Olive at 76 % alpha. Sage is never used for body text on Soft White.
- **Focus rings:** Deep Olive on light surfaces. Interactive targets are at least 44 px. Reduced-motion mode disables entrance and background motion, hides the motion control, and disables smooth scrolling.
- **Type:** the same system sans-serif stack as the map UI, with Georgia italic for editorial heading accents. No letter-spacing on Bangla.
- **Bengali typography:** a self-hosted Noto Sans Bengali variable-font subset (SIL OFL in `client/public/fonts/`) provides consistent shaping across devices. Bengali headings use a smaller responsive scale and natural wrapping; body copy keeps a readable 1.6–1.8 line height. Large editorial headings are scoped to `.landing-home`, never the shared alert-page shell. Buttons grow vertically for translated labels, and English alert text keeps its original language/font.
- **Coverage:** an interactive, light-background atlas of all eight divisions, using real boundaries dissolved from the OCHA/HDX district data. Olive boundary lines and categorical Sage/Soft White tints separate regions. Numbered labels match an accessible division list with district counts; hover and keyboard focus highlight the corresponding area. On phones, map numbers pair with the named list to avoid crowded labels. Selecting a region opens a division-scale map view. Each source's existing status colors remain in the three-state note.

## Map extent

The map shows Bangladesh only. Everything outside the national border is the Deep Olive canvas color; the border itself is drawn in Soft White above that mask.

## Weather explorer

- **Layout:** paper-first header, a dedicated scrollable local-weather sidebar, and a rounded map canvas. Weather details and the map timeline occupy separate spaces. On small screens, explicit Local weather / Explore map buttons switch between full-width views.
- **Location flow:** opening the map requests browser location permission once. Coordinates are matched against the actual upazila GeoJSON in the browser; a successful match selects the local forecast and centres the map automatically. Denied, unavailable, timed-out and outside-coverage states offer retry or Bangla/English search. Coordinates are not sent to the weather API.
- **Honest geography:** ordinary upazilas use their containing boundary. City corporations without thana polygons show the nearest member thana with an explicit estimate label. Areas without their own BMD forecast retain their real area name and disclose the nearest forecast source. Low-accuracy positions are labelled.
- **Weather hierarchy:** area name and Bangla name, current-step temperature and conditions, then eight weather metrics. Overview, four-day trends and ten-day outlook use progressive disclosure; upcoming 3-hour steps are selectable. Missing and stale data retain explicit status labels.
- **Map controls:** forecast is the default; radar, satellite and lightning remain available in the compact layer menu. My location, national extent, zoom, legend and time controls use consistent icons and visible focus states. Resizing or changing the mobile view resizes the map; camera movement respects reduced-motion preferences.
- **Lightning summaries:** a wider, scrollable card with a persistent heading and close control. Coverage and campaign state lead into latest/next BST refresh cards, scheduled refresh times, progress, and text-labelled map states. Selecting a circle promotes its sampled counts and cloud-to-ground/intracloud breakdown. Native disclosures hold the full coverage explanation and API budget; the 5-minute sampling and circle-wide scope stay visible. Unknown counts use a dash, and stale samples are labelled. Closing the panel preserves the map overlay and exposes a keyboard-accessible reopen button.
