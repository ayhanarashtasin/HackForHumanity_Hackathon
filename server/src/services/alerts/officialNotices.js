import { RULE_STATUS, RULE_VERSION } from '../../config/alertRules.js';
import { HazardEvent } from '../../models/HazardEvent.js';
import { PRODUCTS, bulletinStatus } from '../bmdBulletins.js';
import { withdrawEvent } from './events.js';
import { loadSnapshots } from './snapshots.js';

// Official BMD marine notices as hazard events (FISH-01, FISH-03). Official wording is quoted, never rewritten into AkashSathi levels, and only
// an EXPLICIT statement counts: a warning signal in the text creates an event, a "no warning" statement in a newer dated bulletin withdraws it,
// and a document that could not be read, a blank page or an ambiguous text changes nothing.
const HOUR = 3_600_000;
const TRANSITION_HOURS = 6; // no fixed 12 hour waiting period: a reminder to check the latest official forecast for a few hours
const MARINE = PRODUCTS.filter((product) => product.kind === 'marine');
const rule = () => ({ key: 'OFFICIAL_NOTICE', version: RULE_VERSION, status: RULE_STATUS });

const official = (data, issuer = 'BMD') => ({
  signalText: data.signalText ?? null,
  issuer,
  issuedAt: data.issuedAt ? new Date(data.issuedAt) : null,
  documentUrl: data.documentUrl,
});

export async function officialStage({ nowMs, settings, stats }) {
  if (settings.hazardEnabled?.OFFICIAL_NOTICE === false) return;
  const rows = await loadSnapshots('bmd', 'bulletin', MARINE.map((product) => product.key));
  const now = new Date(nowMs);

  for (const product of MARINE) {
    const row = rows.get(product.key);
    const data = row?.data;
    const active = await HazardEvent.findOne({
      origin: 'detected', hazardType: 'OFFICIAL_NOTICE', lifecycle: 'active', 'evidence.kind': 'warning', 'evidence.productKey': product.key, validUntil: { $gt: now },
    });

    const status = bulletinStatus(row, nowMs);
    const usable = status === 'FRESH' && data?.marineZone === 'north_bay' && data.issuedAt && ['warning', 'no-warning'].includes(data.statement);
    if (!usable) {
      const dataStatus = status === 'FRESH' ? 'PARTIAL' : status;
      if (active && active.dataStatus !== dataStatus) {
        active.dataStatus = dataStatus;
        active.lastUpdatedAt = now;
        active.revision += 1;
        await active.save();
        stats.eventsUpdated += 1;
      }
      continue;
    }

    // A cached older document cannot undo a newer warning or resurrect a withdrawn one.
    const latest = active ?? await HazardEvent.findOne({ origin: 'detected', hazardType: 'OFFICIAL_NOTICE', 'evidence.productKey': product.key }).sort({ 'official.issuedAt': -1 });
    const issuedMs = Date.parse(data.issuedAt);
    const previousMs = latest?.official?.issuedAt ? +latest.official.issuedAt : null;
    if (previousMs !== null && (issuedMs < previousMs || (issuedMs === previousMs && latest.evidence.fileId !== data.fileId))) continue;

    if (data.statement === 'warning') {
      const evidence = {
        kind: 'warning', productKey: product.key, fileId: data.fileId, signals: data.signals, greatDanger: Boolean(data.greatDanger),
        validityAssumed: Boolean(data.validityAssumed), agreement: 'single-source', coverage: 'regional', rule: rule(),
      };
      const validUntil = new Date(data.validUntil);
      if (active) {
        const changed = active.evidence.fileId !== data.fileId || active.dataStatus !== 'FRESH';
        active.evidence = evidence;
        active.official = official(data);
        active.set('source.referenceId', data.fileId);
        active.forecastIssuedAt = new Date(data.issuedAt);
        active.level = data.greatDanger ? 3 : 2;
        active.validUntil = validUntil;
        active.dataStatus = 'FRESH';
        active.lastConfirmedAt = now;
        if (changed) { active.lastUpdatedAt = now; active.revision += 1; stats.eventsUpdated += 1; }
        await active.save();
        continue;
      }
      try {
        await HazardEvent.create({
          eventKey: `bmd:${product.key}:${data.fileId}`,
          hazardType: 'OFFICIAL_NOTICE',
          origin: 'detected',
          source: { provider: 'bmd', product: product.key, referenceId: data.fileId },
          coverage: { scope: 'marine-zone', upazilaPcodes: [], districtPcodes: [], marineZone: 'north_bay', matchMethod: 'marine_zone' },
          level: data.greatDanger ? 3 : 2,
          evidence,
          official: official(data),
          validFrom: new Date(data.validFrom),
          validUntil,
          forecastIssuedAt: new Date(data.issuedAt),
          lifecycle: 'active',
          firstDetectedAt: now,
          lastConfirmedAt: now,
          lastUpdatedAt: now,
          revision: 1,
          dataStatus: 'FRESH',
        });
        stats.eventsCreated += 1;
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
      continue;
    }

    // An explicit "no warning" in a NEWER dated bulletin is an official withdrawal of the earlier warning (and the start of a transition reminder).
    if (data.statement === 'no-warning' && active && previousMs !== null && issuedMs > previousMs && Date.parse(data.validFrom) <= nowMs) {
      await withdrawEvent(active, { source: 'official', reason: 'BMD bulletin states no warning', reference: data.fileId, nowMs });
      try {
        await HazardEvent.create({
          eventKey: `bmd:${product.key}:${data.fileId}:withdrawal`,
          hazardType: 'OFFICIAL_NOTICE',
          origin: 'detected',
          source: { provider: 'bmd', product: product.key, referenceId: data.fileId },
          coverage: { scope: 'marine-zone', upazilaPcodes: [], districtPcodes: [], marineZone: 'north_bay', matchMethod: 'marine_zone' },
          level: 1,
          evidence: {
            kind: 'withdrawal', productKey: product.key, fileId: data.fileId, previousFileId: active.evidence.fileId, validityAssumed: false, agreement: 'single-source', coverage: 'regional', rule: rule(),
          },
          official: official({ ...data, signalText: null }),
          validFrom: now,
          validUntil: new Date(nowMs + TRANSITION_HOURS * HOUR),
          forecastIssuedAt: new Date(data.issuedAt),
          lifecycle: 'active',
          firstDetectedAt: now,
          lastConfirmedAt: now,
          lastUpdatedAt: now,
          revision: 1,
          dataStatus: 'FRESH',
        });
        stats.eventsCreated += 1;
      } catch (error) {
        if (error?.code !== 11000) throw error;
      }
    }
  }
}
