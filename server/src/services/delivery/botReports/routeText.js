import { districts } from '../../geo.js';
import { heatCategory } from './readings.js';
import {
  CONDITION, KIND_NAMES, bold, conditionEmoji, esc, fit, freshnessNote, heatName, italic, makeText, nameOf, thunderName,
} from './text.js';

// The words of the /route replies, in English and Bangla (the Bangla is a draft, like the rest of the bot's). The report itself is
// routeReport.js; this only words it. The bot's style rules hold: a forecast is never a measurement, a missing value is never calm
// (⚪, not 🟢), and no line says a road or a time is "safe".
const ROUTE_KINDS = {
  en: {
    ...KIND_NAMES.en, division: 'Division', union: 'Union', paurashava: 'Municipality', ward: 'City ward', 'city-area': 'City area',
    neighbourhood: 'Neighbourhood', landmark: 'Place', osm: 'Map place', here: 'Your location',
  },
  bn: {
    ...KIND_NAMES.bn, division: 'বিভাগ', union: 'ইউনিয়ন', paurashava: 'পৌরসভা', ward: 'সিটি ওয়ার্ড', 'city-area': 'নগর এলাকা',
    neighbourhood: 'এলাকা', landmark: 'স্থান', osm: 'মানচিত্রের স্থান', here: 'আপনার অবস্থান',
  },
};

const HAZARD_NAMES = {
  en: {
    HEAVY_RAIN: 'Heavy rain', HEAT_STRESS: 'Heat stress', STRONG_WIND: 'Strong wind', OBSERVED_LIGHTNING: 'Lightning', LIGHTNING_THREAT: 'Lightning risk',
    STORM_APPROACH: 'Approaching storm', MARINE_WEATHER: 'Rough sea', DRY_SPELL: 'Dry spell', OFFICIAL_NOTICE: 'Official BMD notice', ADMIN_NOTICE: 'Notice',
  },
  bn: {
    HEAVY_RAIN: 'ভারী বৃষ্টি', HEAT_STRESS: 'গরমজনিত ঝুঁকি', STRONG_WIND: 'প্রবল বাতাস', OBSERVED_LIGHTNING: 'বজ্রপাত', LIGHTNING_THREAT: 'বজ্রপাতের ঝুঁকি',
    STORM_APPROACH: 'এগিয়ে আসা ঝড়', MARINE_WEATHER: 'উত্তাল সমুদ্র', DRY_SPELL: 'দীর্ঘ শুষ্ক আবহাওয়া', OFFICIAL_NOTICE: 'বিএমডির সরকারি বিজ্ঞপ্তি', ADMIN_NOTICE: 'বিজ্ঞপ্তি',
  },
};

const DOTS = ['🟢', '🟡', '🟠', '🔴'];
const dot = (level) => (level === null || level === undefined ? '⚪' : DOTS[level]);
const present = (value) => typeof value === 'number' && Number.isFinite(value);
const districtByCode = new Map(districts.map((district) => [district.pcode, district]));

// ---------- names ----------
export function placeLabel(item, T) {
  if (item.here) return T.s(`Your location (near ${item.name})`, `আপনার অবস্থান (${nameOf(item, 'bn')}-এর কাছে)`);
  if (item.level === 'division') return T.s(`${item.name} division`, `${nameOf(item, 'bn')} বিভাগ`);
  return nameOf(item, T.L);
}

// "Durgapur, Puthia, Rajshahi (Union)": a candidate with where it lies and what it is, for lists and buttons.
export function candidateLabel(item, T) {
  const district = item.level === 'district' || item.level === 'division' ? null : districtByCode.get(item.districtCode);
  const where = [item.level === 'area' || item.level === 'neighbourhood' ? item.parentName : null, district ? nameOf(district, T.L) : null]
    .filter((value, index, list) => value && list.indexOf(value) === index);
  return `${placeLabel(item, T)}${where.length ? `, ${where.join(', ')}` : ''} (${ROUTE_KINDS[T.L][item.kind] ?? ''})`;
}

function duration(minutes, T) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return T.s(`${T.n(rest)} min`, `${T.n(rest)} মিনিট`);
  if (!rest) return T.s(`${T.n(hours)} h`, `${T.n(hours)} ঘণ্টা`);
  return T.s(`${T.n(hours)} h ${T.n(rest)} min`, `${T.n(hours)} ঘণ্টা ${T.n(rest)} মিনিট`);
}

const km = (value, T) => `${T.n(value, value < 10 ? 1 : 0)} ${T.s('km', 'কিমি')}`;

// ---------- the report ----------
function stopLine(stop, T) {
  const name = bold(nameOf(stop, T.L) ?? T.s('On the way', 'পথে'));
  const time = stop.untilMs - stop.etaMs >= 30 * 60_000 ? `${T.hm(stop.etaMs)}–${T.hm(stop.untilMs)}` : T.hm(stop.etaMs);
  if (stop.level === null) return `⚪ ${time} ${name} · ${T.s('no forecast for this time', 'এই সময়ের পূর্বাভাস নেই')}`;
  const bits = [`${conditionEmoji(stop.weatherCode)} ${T.c(stop.temperatureC)}`];
  if (stop.rainMm >= 0.1) bits.push(`${T.s('rain', 'বৃষ্টি')} ${T.mm(stop.rainMm)}`);
  else if (stop.rainChancePct >= 30) bits.push(`${T.s('rain chance', 'বৃষ্টির সম্ভাবনা')} ${T.pct(stop.rainChancePct)}`);
  if (stop.thunderPotential >= 1) bits.push(`${T.s('thunder', 'বজ্রঝড়')} ${esc(thunderName(stop.thunderPotential, T).toLowerCase())}`);
  if (stop.windKph >= 30) bits.push(`${T.s('gust', 'দমকা')} ${T.kph(stop.windKph)}`);
  if (stop.heatIndexC >= 32) bits.push(`${T.s('heat index', 'হিট ইনডেক্স')} ${T.c(stop.heatIndexC)}`);
  return `${dot(stop.level)} ${time} ${name} · ${bits.join(' · ')}`;
}

function watchLine(item, T) {
  const where = esc(nameOf(item.place, T.L));
  const when = `~${T.hm(item.etaMs)}`;
  const more = item.otherPlaces > 0
    ? T.s(` (+${T.n(item.otherPlaces)} more place${item.otherPlaces === 1 ? '' : 's'})`, ` (আরও ${T.n(item.otherPlaces)}টি জায়গায়)`)
    : '';
  switch (item.type) {
    case 'thunder': {
      const level = esc(thunderName(item.value, T));
      return T.s(
        `⛈ ${level} thunderstorm potential${item.hail ? ', hail possible' : ''} near ${where} · ${when}${more}`,
        `⛈ ${where}-এর কাছে বজ্রঝড়ের ${level} সম্ভাবনা${item.hail ? ', শিলাবৃষ্টি হতে পারে' : ''} · ${when}${more}`,
      );
    }
    case 'rain': {
      const word = item.value >= 50 ? T.s('Very heavy rain', 'অতি ভারী বৃষ্টি') : item.level >= 3 ? T.s('Heavy rain', 'ভারী বৃষ্টি') : T.s('Moderate rain', 'মাঝারি বৃষ্টি');
      return T.s(
        `🌧 ${word} near ${where} · ${when} · ${T.mm(item.value)} in 3 h${more}`,
        `🌧 ${where}-এর কাছে ${word} · ${when} · ৩ ঘণ্টায় ${T.mm(item.value)}${more}`,
      );
    }
    case 'wind':
      return T.s(`💨 Gusts up to ${T.kph(item.value)} near ${where} · ${when}${more}`, `💨 ${where}-এর কাছে দমকা হাওয়া ${T.kph(item.value)} পর্যন্ত · ${when}${more}`);
    default: {
      const level = esc(heatName(heatCategory(item.value), T));
      return T.s(`🥵 Heat index ${T.c(item.value)} (${level}) near ${where} · ${when}${more}`, `🥵 ${where}-এর কাছে হিট ইনডেক্স ${T.c(item.value)} (${level}) · ${when}${more}`);
    }
  }
}

function destinationLines(report, T) {
  const title = `📍 ${bold(T.s(`${placeLabel(report.to, T)} after you arrive`, `পৌঁছানোর পর ${placeLabel(report.to, T)}`))}`;
  const d = report.destination;
  if (!d?.available || (!d.arrival && !d.next)) return [title, T.s('No forecast for the destination at that time.', 'ওই সময়ে গন্তব্যের পূর্বাভাস নেই।')];
  const lines = [title];
  if (d.arrival) {
    const a = d.arrival;
    const label = CONDITION[T.L][a.weatherCode] ?? null;
    const bits = [`${conditionEmoji(a.weatherCode)} ${label ? `${esc(label)} · ` : ''}${T.c(a.temperatureC)}`];
    if (a.rainMm >= 0.1) bits.push(`${T.s('rain', 'বৃষ্টি')} ${T.mm(a.rainMm)}`);
    if (present(a.rainChancePct)) bits.push(`${T.s('chance', 'সম্ভাবনা')} ${T.pct(a.rainChancePct)}`);
    lines.push(`~${T.hm(report.arriveMs)}: ${bits.join(' · ')}`);
  }
  if (d.next) {
    const n = d.next;
    const bits = [`${T.n(n.low)}–${T.n(n.high)} ${T.s('°C', '°সে.')}`];
    bits.push(n.rain.total === null ? T.s('rain not available', 'বৃষ্টির তথ্য নেই')
      : `${T.s('rain', 'বৃষ্টি')} ${n.rain.partial ? T.s('at least ', 'কমপক্ষে ') : ''}${T.mm(n.rain.total)}`);
    if (present(n.rainChancePct)) bits.push(`${T.s('chance', 'সম্ভাবনা')} ${T.pct(n.rainChancePct)}`);
    if (n.thunderPotential >= 1) bits.push(`${T.s('thunder', 'বজ্রঝড়')}: ${esc(thunderName(n.thunderPotential, T))}`);
    lines.push(`${conditionEmoji(n.weatherCode)} ${T.s('Next 24 h', 'পরের ২৪ ঘণ্টা')}: ${bits.join(' · ')}`);
  }
  // A union, a district or a map point borrows the forecast of the upazila or thana it lies in: say which.
  if (d.place && nameOf(d.place, 'en') !== report.to.name) {
    lines.push(italic(T.s(`Forecast for ${d.place.name}.`, `${nameOf(d.place, 'bn')}-এর পূর্বাভাস।`)));
  }
  return lines;
}

function latestOf(items) {
  const times = items.map((item) => item.pick?.sampledMs).filter(present);
  return times.length ? Math.max(...times) : null;
}

function lightningLine(list, T) {
  if (!list) return null;
  const named = (items) => items.slice(0, 3).map((item) => esc(nameOf(item.place, T.L))).join(', ');
  const reported = list.filter((item) => item.pick?.kind === 'reported');
  if (reported.length) {
    const at = latestOf(reported);
    return T.s(
      `⚡ Lightning recorded near ${named(reported)}${at ? ` · last check ${T.when(at)}` : ''}`,
      `⚡ ${named(reported)}-এর কাছে বজ্রপাত রেকর্ড হয়েছে${at ? ` · সর্বশেষ পরীক্ষা ${T.when(at)}` : ''}`,
    );
  }
  const none = list.filter((item) => item.pick?.kind === 'none');
  if (none.length) {
    const at = latestOf(none);
    return T.s(
      `⚡ No lightning recorded at the last checks near ${named(none)}${at ? ` (${T.when(at)})` : ''}.`,
      `⚡ সর্বশেষ পরীক্ষায় ${named(none)}-এর কাছে বজ্রপাত রেকর্ড হয়নি${at ? ` (${T.when(at)})` : ''}।`,
    );
  }
  return T.s('⚡ No recent lightning check along this road.', '⚡ এই পথে সাম্প্রতিক বজ্রপাত পরীক্ষা নেই।');
}

function stormLine(storm, T) {
  if (!storm) return null;
  if (storm.status !== 'FRESH') return T.s('🛰 Satellite storm tracking is not available right now.', '🛰 স্যাটেলাইটে ঝড় শনাক্তকরণ এখন পাওয়া যাচ্ছে না।');
  const image = T.hm(storm.observedAtMs);
  if (!storm.hit) {
    return T.s(
      `🛰 Satellite (${image}): no tracked storm cloud on the road at your passing times. Storms can still form.`,
      `🛰 স্যাটেলাইট (${image}): আপনার যাওয়ার সময়ে পথে কোনো শনাক্ত ঝড়ের মেঘ নেই। নতুন ঝড় তৈরি হতে পারে।`,
    );
  }
  const where = esc(nameOf(storm.hit.place, T.L));
  const pass = T.hm(storm.hit.passMs);
  if (storm.hit.over) {
    return T.s(
      `🛰 A storm cloud was over ${where} on the satellite image (${image}); you pass about ${pass}.`,
      `🛰 স্যাটেলাইট ছবিতে (${image}) ${where}-এর ওপর ঝড়ের মেঘ ছিল; আপনি প্রায় ${pass}-এ পার হবেন।`,
    );
  }
  return T.s(
    `🛰 A storm cloud may reach ${where} around ${T.hm(storm.hit.arrivalMs)}; you pass about ${pass}.`,
    `🛰 একটি ঝড়ের মেঘ ${T.hm(storm.hit.arrivalMs)} নাগাদ ${where}-এ পৌঁছাতে পারে; আপনি প্রায় ${pass}-এ পার হবেন।`,
  );
}

function hazardLines(items, T) {
  if (!items) return [];
  if (!items.length) return [T.s('🔔 No active AkashSathi alert on this road.', '🔔 এই পথে আকাশসাথীর কোনো সক্রিয় সতর্কবার্তা নেই।')];
  const lines = items.slice(0, 3).map((item) => {
    const area = T.L === 'bn' ? item.areaNameBn || item.areaName : item.areaName;
    return `🔔 ${bold(HAZARD_NAMES[T.L][item.type] ?? item.type)}${area ? ` · ${esc(area)}` : ''} · ${T.s('until', 'মেয়াদ')} ${esc(T.when(item.validUntilMs))}`;
  });
  if (items.length > 3) lines.push(T.s(`…and ${T.n(items.length - 3)} more alerts on this road.`, `…এবং এই পথে আরও ${T.n(items.length - 3)}টি সতর্কবার্তা।`));
  return lines;
}

function alternativeLine(alternative, T) {
  if (!alternative) return null;
  const via = alternative.via ? T.s(` via ${esc(alternative.via.name)}`, ` (${esc(nameOf(alternative.via, 'bn'))} হয়ে)`) : '';
  const words = [T.s('calmer weather', 'তুলনামূলক শান্ত আবহাওয়া'), T.s('similar weather', 'প্রায় একই আবহাওয়া'), T.s('rougher weather', 'বেশি খারাপ আবহাওয়া')];
  const compare = alternative.comparison === null ? '' : ` · ${words[alternative.comparison + 1]}`;
  return `↔️ ${T.s('Other road', 'অন্য পথ')}${via}: ${km(alternative.distanceKm, T)} · ${T.s('about', 'প্রায়')} ${duration(alternative.durationMinutes, T)}${compare}`;
}

export function renderRouteReport(report, { lang, nowMs }) {
  const T = makeText(lang, nowMs);
  const { from, to } = report;
  const leave = report.departure === '0'
    ? T.s(`Leave now (${T.hm(report.departMs)})`, `এখন রওনা (${T.hm(report.departMs)})`)
    : T.s(`Leave ${T.when(report.departMs)}`, `রওনা ${T.when(report.departMs)}`);
  const lines = [
    `🛣 ${bold(`${placeLabel(from, T)} → ${placeLabel(to, T)}`)}`,
    `📏 ${km(report.distanceKm, T)} · 🕒 ${T.s('about', 'প্রায়')} ${duration(report.durationMinutes, T)} · ${T.s('shortest road', 'সবচেয়ে কম দূরত্বের পথ')}`,
    `🕐 ${leave} → ${T.s('arrive about', 'পৌঁছানো আনুমানিক')} ${esc(T.when(report.arriveMs))}`,
  ];
  // A district's road starts at its town; say where, so "Dhaka" is not taken for the middle of the district.
  if (from.pointName || to.pointName) {
    const end = (item) => (item.pointName ? nameOf({ name: item.pointName, nameBn: item.pointNameBn }, T.L) : placeLabel(item, T));
    lines.push(italic(T.s(`Road from ${end(from)} to ${end(to)}.`, `${end(from)} থেকে ${end(to)} পর্যন্ত সড়কপথ।`)));
  }
  if (report.snap.startKm > 2) lines.push(T.s(`⚠ The road starts about ${km(report.snap.startKm, T)} from ${esc(placeLabel(from, T))}.`, `⚠ ${esc(placeLabel(from, T))} থেকে প্রায় ${km(report.snap.startKm, T)} দূরে সড়ক শুরু।`));
  if (report.snap.endKm > 2) lines.push(T.s(`⚠ The road ends about ${km(report.snap.endKm, T)} from ${esc(placeLabel(to, T))}.`, `⚠ সড়ক ${esc(placeLabel(to, T))}-এর প্রায় ${km(report.snap.endKm, T)} আগে শেষ হয়।`));
  lines.push(...new Set(report.infos.map((info) => freshnessNote(T, info)).filter(Boolean)));

  lines.push('', bold(T.s('⚠️ Watch out on this trip', '⚠️ এই যাত্রায় সতর্ক থাকুন')));
  const { covered, total } = report.coverage;
  if (!covered) {
    lines.push(T.s('⚪ No forecast is available for this road at these times.', '⚪ এই সময়ে এই পথের কোনো পূর্বাভাস পাওয়া যাচ্ছে না।'));
  } else if (report.watch.length) {
    lines.push(...report.watch.slice(0, 4).map((item) => watchLine(item, T)));
  } else {
    lines.push(T.s(
      '🟢 No heavy rain, strong gusts, thunderstorm or dangerous heat in the forecast for when you pass.',
      '🟢 যাত্রার সময়ে পথে ভারী বৃষ্টি, প্রবল দমকা হাওয়া, বজ্রঝড় বা বিপজ্জনক গরমের পূর্বাভাস নেই।',
    ));
  }
  if (covered && covered < total) lines.push(italic(T.s(`Forecast for ${T.n(covered)} of ${T.n(total)} points on the road.`, `পথের ${T.n(total)}টি বিন্দুর ${T.n(covered)}টির পূর্বাভাস আছে।`)));

  lines.push('', `${bold(T.s('🗺 Along the way', '🗺 পথে পথে'))} ${italic(T.s('(forecast for when you pass)', '(যখন পার হবেন তখনকার পূর্বাভাস)'))}`);
  lines.push(...report.stops.map((stop) => stopLine(stop, T)));
  if (report.hiddenStops) lines.push(T.s(`…and ${T.n(report.hiddenStops)} more places with calmer weather.`, `…এবং তুলনামূলক শান্ত আবহাওয়ার আরও ${T.n(report.hiddenStops)}টি জায়গা।`));

  lines.push('', ...destinationLines(report, T));

  const live = [lightningLine(report.lightning, T), stormLine(report.storm, T), ...hazardLines(report.hazards, T)].filter(Boolean);
  if (live.length) lines.push('', ...live);
  const other = alternativeLine(report.alternative, T);
  if (other) lines.push('', other);

  lines.push('', T.s('🟢 calm · 🟡 watch · 🟠 caution · 🔴 severe · ⚪ no forecast', '🟢 শান্ত · 🟡 নজর রাখুন · 🟠 সতর্ক থাকুন · 🔴 গুরুতর · ⚪ পূর্বাভাস নেই'));
  if ([from, to].some((item) => item.approx || item.here || item.level === 'osm')) {
    lines.push(italic(T.s('Unions, neighbourhoods and map places use the forecast of the upazila or thana they lie in.', 'ইউনিয়ন, এলাকা ও মানচিত্রের স্থান তাদের উপজেলা বা থানার পূর্বাভাস ব্যবহার করে।')));
  }
  if (report.rainUnverified || report.destination?.rainUnverified) lines.push(`⚠ ${T.s('Rain unit unverified.', 'বৃষ্টির একক যাচাই হয়নি।')}`);
  lines.push(italic(T.s(
    'Forecast for the time you pass each place (model, not station readings). Road and times are estimates. Road and map data © OpenStreetMap contributors.',
    'প্রতিটি জায়গা পার হওয়ার সময়ের পূর্বাভাস (মডেল, স্টেশনের মাপ নয়)। পথ ও সময় আনুমানিক। সড়ক ও মানচিত্রের তথ্য © OpenStreetMap অবদানকারীরা।',
  )));
  return fit(lines.join('\n'));
}

// ---------- buttons ----------
// "t:<from id>:<to id>:<departure>:<language>" (telegramBot.js ROUTE_BUTTON); departure 0 = now, 3 = in three hours, m = tomorrow 07:00.
export const routeButtonData = (fromId, toId, departure, L) => `t:${fromId}:${toId}:${departure}:${L}`;

export function routeButtons({ fromId, toId, departure }, lang) {
  const T = makeText(lang, 0);
  const timing = [];
  if (departure !== '0') timing.push({ text: `▶ ${T.s('Leave now', 'এখন রওনা')}`, data: routeButtonData(fromId, toId, '0', T.L) });
  if (departure !== '3') timing.push({ text: `⏰ ${T.s('Leave in 3 h', '৩ ঘণ্টা পরে')}`, data: routeButtonData(fromId, toId, '3', T.L) });
  if (departure !== 'm') timing.push({ text: `🌅 ${T.s('Tomorrow 07:00', 'আগামীকাল ০৭:০০')}`, data: routeButtonData(fromId, toId, 'm', T.L) });
  return [[{ text: `🔁 ${T.s('Way back', 'ফেরার পথ')}`, data: routeButtonData(toId, fromId, '0', T.L) }], timing];
}

// One button per candidate place; the other end of the trip is already known (`otherId`).
export function candidateRouteButtons(problem, otherId, lang) {
  const T = makeText(lang, 0);
  return problem.candidates.map((item) => [{
    text: candidateLabel(item, T).slice(0, 60),
    data: problem.side === 'from' ? routeButtonData(item.id, otherId, '0', T.L) : routeButtonData(otherId, item.id, '0', T.L),
  }]);
}

// ---------- questions and problems ----------
export function renderRouteAsk(lang) {
  const T = makeText(lang, 0);
  return [
    `🛣 ${bold(T.s('Where are you going?', 'কোথায় যাবেন?'))}`,
    T.s('Send the start and the destination, for example:', 'শুরু ও গন্তব্যের নাম পাঠান, যেমন:'),
    T.s('/route Dhaka Bandarban', '/route ঢাকা বান্দরবান'),
    T.s("/route Mirpur 10 to Cox's Bazar", "/route Mirpur 10 থেকে Cox's Bazar"),
    T.s('/route here Sylhet — from where you are now', '/route here Sylhet — এখন যেখানে আছেন সেখান থেকে'),
    '',
    T.s(
      'Any division, district, upazila, thana, union, ward or well-known area works. You can also just send the two names now.',
      'যেকোনো বিভাগ, জেলা, উপজেলা, থানা, ইউনিয়ন, ওয়ার্ড বা পরিচিত এলাকার নাম দিতে পারেন। এখনই শুধু দুটি নামও পাঠাতে পারেন।',
    ),
  ].join('\n');
}

export function renderRouteAskStart(lang, to) {
  const T = makeText(lang, 0);
  const name = placeLabel(to, T);
  return [
    `🛣 ${T.s(`Going to ${bold(name)}. Where do you start?`, `${bold(name)} যাবেন। কোথা থেকে রওনা দেবেন?`)}`,
    T.s('Send the place name, or share your location with the button below.', 'জায়গার নাম পাঠান, অথবা নিচের বোতাম দিয়ে আপনার অবস্থান পাঠান।'),
  ].join('\n');
}

export function renderRouteAskEnd(lang, from) {
  const T = makeText(lang, 0);
  return [
    `🛣 ${T.s(`Starting near ${bold(from.name)}. Where are you going?`, `${bold(nameOf(from, 'bn'))}-এর কাছ থেকে রওনা। কোথায় যাবেন?`)}`,
    T.s('Send the destination name, for example Bandarban.', 'গন্তব্যের নাম পাঠান, যেমন বান্দরবান।'),
  ].join('\n');
}

// `texts` is what was typed for each end ({ from, to }), for the example at the end.
export function renderRouteProblem(lang, problems, { withButtons = false, searchDown = false, texts = {} } = {}) {
  const T = makeText(lang, 0);
  const lines = [];
  const example = { from: texts.from || T.s('Dhaka', 'ঢাকা'), to: texts.to || T.s('Bandarban', 'বান্দরবান') };
  for (const problem of problems) {
    const side = bold(problem.side === 'from' ? T.s('Start', 'শুরু') : T.s('Destination', 'গন্তব্য'));
    const query = esc(problem.query);
    if (problem.status === 'ambiguous') {
      lines.push(`${side}: ${T.s(`more than one place is called "${query}".`, `"${query}" নামে একাধিক জায়গা আছে।`)}`);
      lines.push(...problem.candidates.map((item) => `• ${esc(candidateLabel(item, T))}`));
      if (problem.total > problem.candidates.length) lines.push(T.s(`…and ${T.n(problem.total - problem.candidates.length)} more.`, `…এবং আরও ${T.n(problem.total - problem.candidates.length)}টি।`));
      if (problem.hidden) {
        lines.push(T.s(
          `${T.n(problem.hidden)} smaller places (unions, wards, neighbourhoods) have the same name: add their upazila or district after a comma.`,
          `একই নামে আরও ${T.n(problem.hidden)}টি ছোট জায়গা (ইউনিয়ন, ওয়ার্ড, এলাকা) আছে: কমা দিয়ে উপজেলা বা জেলার নাম যোগ করুন।`,
        ));
      }
      const district = districtByCode.get(problem.candidates[0]?.districtCode);
      if (district) example[problem.side] = `${problem.query}, ${nameOf(district, T.L)}`;
    } else if (problem.status === 'suggest') {
      lines.push(`${side}: ${T.s(`I could not find "${query}". Did you mean:`, `"${query}" খুঁজে পাইনি। আপনি কি এটি বোঝাতে চেয়েছেন:`)}`);
      lines.push(...problem.candidates.map((item) => `• ${esc(candidateLabel(item, T))}`));
    } else {
      lines.push(`${side}: ${T.s(`I could not find "${query}".`, `"${query}" খুঁজে পাইনি।`)}`);
      lines.push(T.s(
        'Use a division, district, upazila, thana, union, ward or well-known area name.',
        'বিভাগ, জেলা, উপজেলা, থানা, ইউনিয়ন, ওয়ার্ড বা পরিচিত এলাকার নাম দিন।',
      ));
    }
    lines.push('');
  }
  if (searchDown) lines.push(T.s('The map place search is not responding right now.', 'মানচিত্রের স্থান অনুসন্ধান এখন সাড়া দিচ্ছে না।'));
  if (withButtons) {
    lines.push(T.s('Tap the right place below, or send the route again.', 'নিচে সঠিক জায়গাটি বেছে নিন, অথবা আবার পথটি পাঠান।'));
  } else {
    lines.push(T.s('Send the route again, for example:', 'আবার পথটি পাঠান, যেমন:'));
    lines.push(esc(T.s(`/route ${example.from} to ${example.to}`, `/route ${example.from} থেকে ${example.to}`)));
  }
  return fit(lines.join('\n').trimEnd());
}

export function renderRouteUnclear(lang) {
  const T = makeText(lang, 0);
  return T.s(
    'I could not tell where the start ends and the destination begins. Put "to" between them, for example:\n/route Mirpur 10 to Cox\'s Bazar',
    'কোথায় শুরু শেষ আর গন্তব্য শুরু, বুঝতে পারিনি। মাঝে "থেকে" লিখুন, যেমন:\n/route Mirpur 10 থেকে Cox\'s Bazar',
  );
}

// `code`: ROUTE_NO_ROAD, ROUTE_SERVICE, ROUTE_SAME, ROUTE_POINTS or EXPIRED (a button whose place is no longer known).
export function renderRouteFailure(lang, code, { from = null, to = null } = {}) {
  const T = makeText(lang, 0);
  const a = from ? esc(placeLabel(from, T)) : '';
  const b = to ? esc(placeLabel(to, T)) : '';
  switch (code) {
    case 'ROUTE_NO_ROAD':
      return T.s(
        `🛣 No road route was found between ${a} and ${b}.\nAn island or a place without roads may need a boat that the road map does not include. The weather at the destination follows.`,
        `🛣 ${a} ও ${b}-এর মধ্যে কোনো সড়কপথ পাওয়া যায়নি।\nদ্বীপ বা সড়কহীন জায়গায় নৌকা লাগতে পারে, যা সড়কের মানচিত্রে নেই। নিচে গন্তব্যের আবহাওয়া দেওয়া হলো।`,
      );
    case 'ROUTE_SAME':
      return T.s(`🛣 The start and the destination are the same place (${a}). For the weather there: /update`, `🛣 শুরু ও গন্তব্য একই জায়গা (${a})। সেখানকার আবহাওয়া: /update`);
    case 'ROUTE_POINTS':
      return T.s('🛣 That place is outside the area the road search covers. Choose places in Bangladesh.', '🛣 জায়গাটি সড়ক অনুসন্ধানের এলাকার বাইরে। বাংলাদেশের জায়গা বেছে নিন।');
    case 'EXPIRED':
      return T.s('This button has expired. Send the route again, for example /route Dhaka Bandarban', 'এই বোতামের মেয়াদ শেষ। আবার পথটি পাঠান, যেমন /route ঢাকা বান্দরবান');
    default:
      return T.s('🛣 The road-route service is not responding right now. Please try again in a few minutes.', '🛣 সড়কপথের সেবা এখন সাড়া দিচ্ছে না। কয়েক মিনিট পরে আবার চেষ্টা করুন।');
  }
}
