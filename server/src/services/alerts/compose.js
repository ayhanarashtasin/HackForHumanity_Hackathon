import { RULE_STATUS, RULE_VERSION } from '../../config/alertRules.js';
import { districts, locationByPcode } from '../geo.js';
import {
  ACTIONS, ADVICE, PROVIDER_LABELS, activityLabelFor, areaText, describeHazard, fill, localizeDigits, pick, reasonText, titleFor, whenText, zoneName,
} from './messages.js';

// Stage 4a: turn (event, subscriber, scenario result) into the stored notification fields, in the subscriber's language.
const districtByPcode = new Map(districts.map((district) => [district.pcode, district]));

// How the event reaches this subscriber's area: an exact upazila, or a whole district (never narrowed to an upazila claim).
export function affectedAreaFor(event, area, lang) {
  if (event.coverage.scope === 'marine-zone') {
    const name = zoneName(event.coverage.marineZone, lang);
    return { scope: 'marine-zone', upazilaPcode: null, districtPcode: null, name, nameBn: zoneName(event.coverage.marineZone, 'bn'), text: areaText({ scope: 'marine-zone', name }, lang) };
  }

  const exact = event.coverage.upazilaPcodes?.includes(area.upazilaPcode);
  if (exact) {
    const location = locationByPcode.get(area.upazilaPcode);
    const district = districtByPcode.get(area.districtPcode);
    const name = lang === 'bn' ? (location?.nameBn ?? location?.name) : location?.name;
    const districtName = lang === 'bn' ? (district?.nameBn ?? district?.name) : district?.name;
    return {
      scope: 'upazila',
      upazilaPcode: area.upazilaPcode,
      districtPcode: area.districtPcode,
      name: location?.name ?? area.upazilaPcode,
      nameBn: location?.nameBn ?? null,
      text: areaText({ scope: 'upazila', name, districtName }, lang),
    };
  }

  const district = districtByPcode.get(area.districtPcode);
  const name = lang === 'bn' ? (district?.nameBn ?? district?.name) : district?.name;
  return {
    scope: 'district',
    upazilaPcode: null,
    districtPcode: area.districtPcode,
    name: district?.name ?? area.districtPcode,
    nameBn: district?.nameBn ?? null,
    text: areaText({ scope: 'district', name }, lang),
  };
}

// The plain place name (no district suffix) in the subscriber's language.
function shortName(affectedArea, lang) {
  if (affectedArea.scope === 'marine-zone') return affectedArea.text;
  return lang === 'bn' ? (affectedArea.nameBn ?? affectedArea.name) : affectedArea.name;
}

function sourceReferences(event) {
  const provider = event.source?.provider ?? 'unknown';
  return [{
    provider,
    product: event.source?.product ?? null,
    observedAt: event.observedAt ?? null,
    forecastIssuedAt: event.forecastIssuedAt ?? null,
    url: event.official?.documentUrl ?? null,
  }];
}

// A compact, user-visible evidence block: the numbers, the rule that produced them, and how well the sources agree.
function evidenceFor(event, result, area) {
  const evidence = event.evidence ?? {};
  return {
    metrics: evidence.metrics ?? null,
    agreement: evidence.agreement ?? null,
    coverage: evidence.coverage ?? null,
    alternatives: evidence.alternatives ?? null,
    rule: evidence.rule ?? null,
    asserted: evidence.asserted ?? null,
    // An official notice is quoted in its own words and linked, never rewritten.
    official: event.official ? { signalText: event.official.signalText ?? null, issuer: event.official.issuer ?? null, issuedAt: event.official.issuedAt ?? null, documentUrl: event.official.documentUrl ?? null } : null,
    validityAssumed: Boolean(evidence.validityAssumed),
    matchedArea: { role: area.role, upazilaPcode: area.upazilaPcode, districtPcode: area.districtPcode, matchMethod: area.matchMethod },
    eventMatch: event.coverage.matchMethod,
    ...(result.evidence ?? {}),
  };
}

export function composeNotification({
  scenarioId, result, event, subscriber, area, nowMs, lang = subscriber.language,
}) {
  const affectedArea = affectedAreaFor(event, area, lang);
  const areaName = affectedArea.text;
  const peakMs = event.evidence?.metrics?.peakStartMs ?? null;
  const builtIn = { peak: peakMs ? whenText(peakMs, nowMs, lang) : '' };

  const advice = result.advice.map((item) => fill(pick(ADVICE[item.key], lang), { ...builtIn, ...(item.params ?? {}) }));
  // Bangla attaches its suffix to the plain place name ("বাড্ডা-এ"), so it gets the short name; English reads best with the district.
  const what = describeHazard(event, { areaName: lang === 'bn' ? shortName(affectedArea, lang) : areaName, nowMs, lang });
  const message = [what, ...advice].filter(Boolean).join(' ');

  const reason = reasonText({
    occupation: subscriber.occupation,
    details: result.details ?? [],
    areaRole: area.role,
    areaName: shortName(affectedArea, lang),
    activityLabel: result.activityKey ? activityLabelFor(result.activityKey, lang) : null,
  }, lang);

  const automatic = event.origin === 'detected';
  const finish = (text) => localizeDigits(text, lang);

  return {
    scenarioId,
    severity: result.severity,
    title: finish(titleFor(event, shortName(affectedArea, lang), lang)),
    message: finish(message),
    recommendedActions: result.actions.map((key) => ({ key, text: finish(pick(ACTIONS[key], lang)) })),
    lang,
    templateKey: scenarioId,
    params: { adviceKeys: result.advice.map((item) => item.key), level: event.level },
    affectedArea: { ...affectedArea, text: finish(affectedArea.text) },
    sourceReferences: sourceReferences(event),
    reasonForSelection: finish(reason),
    evidence: evidenceFor(event, result, area),
    hazardType: event.hazardType,
    hazardLevel: event.level,
    validFrom: event.validFrom,
    validUntil: event.validUntil,
    origin: event.origin === 'admin-declared' ? 'admin-declared' : 'automatic',
    dataStatus: event.dataStatus,
    ruleVersion: automatic ? RULE_VERSION : 'admin',
    ruleStatus: automatic ? RULE_STATUS : 'admin',
  };
}

// Free-text administrator messages (ADMIN-MSG): the text is the administrator's own, nothing is generated from weather data.
export function composeAdminMessage({
  event, subscriber, area, severity, title, text, actions = [], referenceUrl = null, nowMs, lang = subscriber.language,
}) {
  const affectedArea = affectedAreaFor(event, area, lang);
  const finish = (value) => localizeDigits(value, lang);
  const heading = pick(title, lang) || (lang === 'bn' ? 'প্রশাসকের বিজ্ঞপ্তি' : 'Notice from the administrator');
  const body = pick(text, lang);

  return {
    scenarioId: 'ADMIN-MSG',
    severity,
    title: finish(heading),
    message: lang === 'bn' && !text.bn ? `${finish(text.en)} (বাংলা অনুবাদ দেওয়া হয়নি।)` : finish(body),
    recommendedActions: actions.map((key) => ({ key, text: finish(pick(ACTIONS[key], lang)) })),
    lang,
    templateKey: 'ADMIN-MSG',
    params: { referenceUrl },
    affectedArea: { ...affectedArea, text: finish(affectedArea.text) },
    sourceReferences: [{ provider: 'admin', product: 'message', observedAt: null, forecastIssuedAt: null, url: referenceUrl }],
    reasonForSelection: finish(lang === 'bn'
      ? `প্রশাসক ${affectedArea.text}-এ নিবন্ধিত এই পেশার ব্যক্তিদের এই বিজ্ঞপ্তি পাঠিয়েছেন; আপনি এই এলাকা ও পেশায় নিবন্ধিত।`
      : `The administrator sent this notice to people registered for this role in ${affectedArea.text}; you are registered for this role and area.`),
    evidence: { asserted: event.evidence?.asserted ?? null, matchedArea: { role: area.role, upazilaPcode: area.upazilaPcode, districtPcode: area.districtPcode, matchMethod: area.matchMethod } },
    hazardType: event.hazardType,
    hazardLevel: 0,
    validFrom: event.validFrom,
    validUntil: event.validUntil,
    origin: 'admin-message',
    dataStatus: 'FRESH',
    ruleVersion: 'admin',
    ruleStatus: 'admin',
  };
}
