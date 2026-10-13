"""Trains the heavy-rain Random Forest and proves (or disproves) it against the existing rule on unseen data.

Split by time, never at random (neighbouring districts rain on the same days, so a random split would leak):
  * 2024 and 2025: model selection, decision threshold and calibration, by leave-one-year-out
    (train on 2024 -> score 2025, train on 2025 -> score 2024).
  * 2026: the test set. It is touched once, after every choice above is fixed.

Only features the live server can compute from its Open-Meteo 3-hour blocks are used (see FEATURES).

Usage: .venv/Scripts/python scripts/train.py
Writes models/heavy_rain_rf.joblib, reports/evaluation.json and reports/evaluation.md.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / 'data' / 'processed' / 'heavy_rain_dataset.csv'
MODEL_FILE = ROOT / 'models' / 'heavy_rain_rf.joblib'
REPORTS = ROOT / 'reports'

MODEL_VERSION = 'heavy-rain-rf-0.2.0'
FEATURES = [
    'f_rain24_mm',            # sum of the 3-hour blocks (rule input)
    'f_rain3h_block_max_mm',  # wettest 3-hour block (rule input)
    'f_rh_mean',              # mean of 3-hour mean humidity = hourly mean
    'f_cape_max',             # max of 3-hour max CAPE = hourly max
    'lat', 'lon', 'doy_sin', 'doy_cos', 'lead_day',
]
TEST_FROM = '2026-01-01'
GRID = [{'min_samples_leaf': leaf, 'max_features': 'sqrt'} for leaf in (30, 100, 200, 400, 800)]
TREES = 300
SEED = 42


def forest(params, trees=TREES):
    return RandomForestClassifier(n_estimators=trees, class_weight='balanced_subsample', n_jobs=-1, random_state=SEED, **params)


def counts(pred, label):
    pred, label = np.asarray(pred, bool), np.asarray(label, bool)
    tp, fp, fn = int((pred & label).sum()), int((pred & ~label).sum()), int((~pred & label).sum())
    return {
        'warnings': tp + fp, 'hits': tp, 'false_alarms': fp, 'misses': fn,
        'precision': round(tp / (tp + fp), 3) if tp + fp else None,
        'recall': round(tp / (tp + fn), 3) if tp + fn else None,
        'csi': round(tp / (tp + fp + fn), 3) if tp + fp + fn else None,
    }


def out_of_year_scores(train, params, trees=TREES):
    """Scores for 2024 from a model fitted on 2025 and vice versa."""
    years = train['date'].str[:4]
    scores = pd.Series(np.nan, index=train.index)
    for year in sorted(years.unique()):
        fit, held = train[years != year], train[years == year]
        model = forest(params, trees).fit(fit[FEATURES], fit['label'])
        scores[held.index] = model.predict_proba(held[FEATURES])[:, 1]
    return scores.to_numpy()


def reliability(prob, label, bins=(0, .02, .05, .1, .2, .3, .5, .7, 1.0001)):
    rows = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        mask = (prob >= lo) & (prob < hi)
        if mask.sum():
            rows.append({'from': lo, 'to': min(hi, 1), 'n': int(mask.sum()),
                         'mean_predicted': round(float(prob[mask].mean()), 3), 'observed': round(float(label[mask].mean()), 3)})
    return rows


def bootstrap_by_date(part, threshold, n=1000):
    """95% intervals for ML-minus-baseline differences, resampling whole days (districts on one day are not independent)."""
    rng = np.random.default_rng(SEED)
    groups = [g.index.to_numpy() for _, g in part.groupby('date')]
    ap_diff, csi_diff = [], []
    for _ in range(n):
        idx = np.concatenate([groups[i] for i in rng.integers(0, len(groups), len(groups))])
        s = part.loc[idx]
        y = s['label'].to_numpy()
        if y.sum() == 0:
            continue
        ap_diff.append(average_precision_score(y, s['risk']) - average_precision_score(y, s['rule_score']))
        csi_diff.append((counts(s['risk'] >= threshold, y)['csi'] or 0) - (counts(s['rule_heavy'], y)['csi'] or 0))
    interval = lambda v: [round(float(np.percentile(v, 2.5)), 3), round(float(np.percentile(v, 97.5)), 3)]
    return {'average_precision_gain_95ci': interval(ap_diff), 'csi_gain_same_budget_95ci': interval(csi_diff)}


def main():
    df = pd.read_csv(DATASET, dtype={'district_pcode': str})
    df = df.dropna(subset=FEATURES).reset_index(drop=True)
    train, test = df[df['date'] < TEST_FROM].copy(), df[df['date'] >= TEST_FROM].copy()
    print(f'train {len(train):,} rows ({train.label.sum()} heavy)   test {len(test):,} rows ({test.label.sum()} heavy)')

    # 1. Model selection by leave-one-year-out average precision.
    search = []
    for params in GRID:
        scores = out_of_year_scores(train, params, trees=120)
        ap = average_precision_score(train['label'], scores)
        search.append({**params, 'average_precision': round(ap, 4)})
        print(f'  {params}  AP {ap:.4f}')
    best = max(search, key=lambda row: row['average_precision'])
    params = {k: best[k] for k in ('min_samples_leaf', 'max_features')}

    # 2. Threshold and calibration from out-of-year scores only.
    oof = out_of_year_scores(train, params)
    calibrator = IsotonicRegression(out_of_bounds='clip', y_min=0, y_max=1).fit(oof, train['label'])
    # Thresholds apply to the raw risk score (continuous), one set per forecast lead; the isotonic map is only for the probability shown.
    thresholds = {}
    for lead in sorted(train['lead_day'].unique()):
        mask = (train['lead_day'] == lead).to_numpy()
        scores, y = oof[mask], train['label'].to_numpy()[mask]
        rule_warnings = int(train.loc[mask, 'rule_heavy'].sum())
        thresholds[int(lead)] = {
            # Same number of warnings the rule gave in 2024-2025 at this lead.
            'same_budget': float(np.sort(scores)[::-1][rule_warnings - 1]),
            # The cut-off with the best critical success index in 2024-2025 at this lead.
            'best_csi': float(max(np.quantile(scores, np.linspace(0.9, 0.999, 200)), key=lambda t: counts(scores >= t, y)['csi'] or 0)),
        }

    # Confidence bands for rule alerts (Level >= 2): the risk-score terciles of the 2024-2025 alerts, per lead.
    bands = {}
    for lead in sorted(train['lead_day'].unique()):
        mask = ((train['lead_day'] == lead) & (train['rule_heavy'] == 1)).to_numpy()
        low, high = np.quantile(oof[mask], [1 / 3, 2 / 3])
        bands[int(lead)] = {'medium_from': float(low), 'high_from': float(high)}

    # 3. Final model on all of 2024-2025, then the one and only look at 2026.
    model = forest(params).fit(train[FEATURES], train['label'])
    test['risk'] = model.predict_proba(test[FEATURES])[:, 1]
    test['prob'] = calibrator.predict(test['risk'])
    label = test['label'].to_numpy()
    climatology = float(train['label'].mean())

    # How far the forecast is past the Level 2 line: the rule's own information, as a ranking.
    test['rule_score'] = np.maximum(test['f_rain24_mm'] / 44, test['f_rain3h_block_max_mm'] / 23)
    results = {}
    for lead in sorted(test['lead_day'].unique()):
        part = test[test['lead_day'] == lead]
        y = part['label'].to_numpy()
        rule_warnings = int(part['rule_heavy'].sum())
        # The ML's top-N days in 2026, N = the rule's own warning count: same number of warnings, compare hits.
        top_n = part['risk'] >= np.sort(part['risk'].to_numpy())[::-1][rule_warnings - 1]
        results[int(lead)] = {
            'rows': len(part), 'heavy_days': int(y.sum()),
            'rule': counts(part['rule_heavy'], y),
            'ml_equal_warnings': counts(top_n, y),
            **{f'ml_{name}': counts(part['risk'] >= t, y) for name, t in thresholds[int(lead)].items()},
            'roc_auc': round(roc_auc_score(y, part['risk']), 3),
            'average_precision': round(average_precision_score(y, part['risk']), 3),
            'forecast_only_roc_auc': round(roc_auc_score(y, part['rule_score']), 3),
            'forecast_only_average_precision': round(average_precision_score(y, part['rule_score']), 3),
            'bootstrap': bootstrap_by_date(part, thresholds[int(lead)]['same_budget']),
        }

    lead1 = test[test['lead_day'] == 1]
    y1 = lead1['label'].to_numpy()
    brier = brier_score_loss(label, test['prob'])
    brier_clim = brier_score_loss(label, np.full(len(label), climatology))
    rel = reliability(test['prob'].to_numpy(), label)
    big_gaps = [row for row in rel if row['n'] >= 100 and abs(row['observed'] - row['mean_predicted']) > 0.1]
    calibration_ok = brier < brier_clim and not big_gaps

    t1 = thresholds[1]
    by_division = {}
    for division, part in lead1.groupby('division'):
        y = part['label'].to_numpy()
        by_division[division] = {'heavy_days': int(y.sum()), 'rule': counts(part['rule_heavy'], y),
                                 'ml_same_budget': counts(part['risk'] >= t1['same_budget'], y)}

    missed_by_rule = lead1[(lead1['label'] == 1) & (lead1['rule_heavy'] == 0)]
    false_by_rule = lead1[(lead1['label'] == 0) & (lead1['rule_heavy'] == 1)]
    shadow = {
        'heavy_days_rule_missed': len(missed_by_rule),
        'of_which_ml_flagged_same_budget': int((missed_by_rule['risk'] >= t1['same_budget']).sum()),
        'of_which_ml_flagged_best_csi': int((missed_by_rule['risk'] >= t1['best_csi']).sum()),
        'rule_false_alarms': len(false_by_rule),
        'of_which_ml_below_same_budget': int((false_by_rule['risk'] < t1['same_budget']).sum()),
    }

    band_check = {}
    for lead, cut in bands.items():
        alerts = test[(test['lead_day'] == lead) & (test['rule_heavy'] == 1)]
        named = np.where(alerts['risk'] >= cut['high_from'], 'high', np.where(alerts['risk'] >= cut['medium_from'], 'medium', 'low'))
        band_check[lead] = {name: {'alerts': int((named == name).sum()),
                                   'came_true': round(float(alerts['label'][named == name].mean()), 3) if (named == name).any() else None}
                            for name in ('high', 'medium', 'low')}

    importance = permutation_importance(model, lead1[FEATURES], y1, scoring='average_precision', n_repeats=5, random_state=SEED, n_jobs=-1)
    ranked = sorted(zip(FEATURES, importance.importances_mean), key=lambda item: -item[1])

    report = {
        'model_version': MODEL_VERSION, 'trained_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'provider': 'open-meteo:best_match', 'reference': 'era5',
        'train_period': f"{train['date'].min()} .. {train['date'].max()}", 'test_period': f"{test['date'].min()} .. {test['date'].max()}",
        'features': FEATURES, 'params': params, 'model_search': search,
        'thresholds': {lead: {k: round(v, 4) for k, v in t.items()} for lead, t in thresholds.items()},
        'confidence_bands': {lead: {k: round(v, 4) for k, v in cut.items()} for lead, cut in bands.items()},
        'confidence_bands_2026': band_check,
        'results': results, 'by_division_lead1': by_division, 'shadow_lead1': shadow,
        'calibration': {'brier': round(brier, 5), 'brier_climatology': round(brier_clim, 5),
                        'brier_skill': round(1 - brier / brier_clim, 3), 'reliability': rel, 'validated': calibration_ok},
        'permutation_importance_lead1': [{'feature': f, 'drop_in_average_precision': round(float(v), 4)} for f, v in ranked],
    }

    MODEL_FILE.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({'model': model, 'calibrator': calibrator, 'features': FEATURES, 'thresholds': thresholds, 'bands': bands,
                 'calibration_validated': calibration_ok, 'version': MODEL_VERSION, 'provider': report['provider']}, MODEL_FILE, compress=3)
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / 'evaluation.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    (REPORTS / 'evaluation.md').write_text(markdown(report), encoding='utf-8')
    print(markdown(report))


def pct(value):
    return '–' if value is None else f'{value:.0%}'


def row(name, c):
    return f"| {name} | {c['warnings']} | {c['hits']} | {c['false_alarms']} | {c['misses']} | {pct(c['precision'])} | {pct(c['recall'])} | {c['csi']:.2f} |"


def markdown(r):
    head = '| | Warnings | Hits | False alarms | Misses | Precision | Recall | CSI |\n|---|---|---|---|---|---|---|---|'
    lines = [
        f"# Heavy rain classifier: evaluation ({r['model_version']})", '',
        f"Train {r['train_period']} · Test {r['test_period']} (unseen) · Forecast {r['provider']} · Reference {r['reference']} (reanalysis, not gauges)", '',
        'Label: reference rainfall with wettest 3 h >= 23 mm or 24 h total >= 44 mm (Heavy Rain Level 2).',
        '* `equal warnings`: the ML\'s top N days in 2026, where N is the number of warnings the rule gave. Same alert count, so hits and false alarms compare directly.',
        '* `same budget`: threshold fixed in 2024-2025 so the ML warned as often as the rule did there (what a deployed model would do).',
        '* `best CSI`: threshold with the best CSI in 2024-2025.',
        '* `forecast only`: ranking days by how far the forecast is past the Level 2 line, i.e. the rule\'s own information.', '',
    ]
    for lead, res in r['results'].items():
        lines += [f"## Test 2026, forecast {lead} day(s) ahead: {res['heavy_days']} heavy-rain days in {res['rows']:,}", '', head,
                  row('Existing rule (Level >= 2)', res['rule']), row('ML, equal warnings', res['ml_equal_warnings']),
                  row('ML, same budget', res['ml_same_budget']), row('ML, best CSI', res['ml_best_csi']), '',
                  f"Ranking quality: ML ROC-AUC {res['roc_auc']}, average precision {res['average_precision']} · "
                  f"forecast only ROC-AUC {res['forecast_only_roc_auc']}, average precision {res['forecast_only_average_precision']}", '',
                  f"95% interval (bootstrap over days) for the ML gain: average precision {res['bootstrap']['average_precision_gain_95ci']}, "
                  f"CSI at same budget {res['bootstrap']['csi_gain_same_budget_95ci']}. An interval above 0 means the gain is not luck.", '']
    s = r['shadow_lead1']
    lines += ['## Shadow-mode view (1 day ahead, same-budget threshold)', '',
              f"* The rule missed {s['heavy_days_rule_missed']} heavy-rain days. The ML flagged {s['of_which_ml_flagged_same_budget']} of them "
              f"({s['of_which_ml_flagged_best_csi']} at the best-CSI threshold).",
              f"* The rule gave {s['rule_false_alarms']} false alarms. The ML scored {s['of_which_ml_below_same_budget']} of them below its threshold.", '',
              '## By division (1 day ahead, same budget)', '', '| Division | Heavy days | Rule precision | ML precision | Rule recall | ML recall |', '|---|---|---|---|---|---|']
    for name, d in r['by_division_lead1'].items():
        lines.append(f"| {name} | {d['heavy_days']} | {pct(d['rule']['precision'])} | {pct(d['ml_same_budget']['precision'])} | {pct(d['rule']['recall'])} | {pct(d['ml_same_budget']['recall'])} |")
    lines += ['', '## Forecast confidence on rule alerts (Level >= 2), 2026', '',
              'Bands are the risk-score terciles of the 2024-2025 rule alerts. "Came true" = share of the alerts in that band with real heavy rain.', '',
              '| Lead | High: alerts / came true | Medium | Low |', '|---|---|---|---|']
    for lead, check in r['confidence_bands_2026'].items():
        cells = [f"{check[b]['alerts']} / {pct(check[b]['came_true'])}" for b in ('high', 'medium', 'low')]
        lines.append(f"| {lead} | {' | '.join(cells)} |")
    c = r['calibration']
    lines += ['', '## Calibration (all leads, 2026)', '',
              f"Brier {c['brier']} vs climatology {c['brier_climatology']} (skill {c['brier_skill']}). "
              f"Calibrated probability validated: **{'yes' if c['validated'] else 'no, show a risk score only'}**.", '',
              '| Risk band | Rows | Mean predicted | Observed |', '|---|---|---|---|']
    lines += [f"| {b['from']:.2f}–{b['to']:.2f} | {b['n']:,} | {b['mean_predicted']:.3f} | {b['observed']:.3f} |" for b in c['reliability']]
    lines += ['', '## What the model relies on (permutation importance, 1 day ahead)', '', '| Feature | Drop in average precision |', '|---|---|']
    lines += [f"| {i['feature']} | {i['drop_in_average_precision']} |" for i in r['permutation_importance_lead1']]
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    main()
