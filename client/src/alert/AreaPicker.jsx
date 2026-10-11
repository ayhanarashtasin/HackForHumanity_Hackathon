import { useId, useMemo, useState } from 'react';
import { Icon } from '../components/Icon.jsx';
import { areaLabel, searchAreas } from '../lib/alertForm.js';
import { useAlert } from './context.js';
import { translate } from '../i18n/index.js';

// Picks one upazila or city thana: division -> district -> upazila selects, plus a search box (English or Bangla).
// `value` is a six-digit location code or ''. With `allowEmpty` an unset value means "same as my home area".
// With `transient` the picker never shows a selection: it reports each pick and resets (used to add areas to a list).
export function AreaPicker({
  id, label, value, onChange, allowEmpty = false, transient = false, error = null, help = null, required = false, exclude = [],
}) {
  const { tr, lang, index, catalogueError } = useAlert();
  const base = useId();
  const location = value ? index?.locationByPcode.get(value) : null;
  const [division, setDivision] = useState('');
  const [district, setDistrict] = useState('');
  const [query, setQuery] = useState('');

  // The selects follow the chosen location; until one is chosen they hold whatever the person has picked so far.
  const currentDistrict = location ? location.district : district;
  const currentDivision = location ? (index.districtByPcode.get(location.district)?.division ?? division) : division;

  const districts = useMemo(() => (index && currentDivision ? index.districtsByDivision.get(currentDivision) ?? [] : []), [index, currentDivision]);
  const locations = useMemo(() => (index && currentDistrict ? index.locationsByDistrict.get(currentDistrict) ?? [] : []), [index, currentDistrict]);
  const results = useMemo(() => (index ? searchAreas(index, query, 8).filter((item) => !exclude.includes(item.pcode)) : []), [index, query, exclude]);

  if (catalogueError) return <p className="alert-field-error" role="alert">{tr('area.catalogueError')}</p>;
  if (!index) return <p className="alert-muted" role="status">{tr('area.loading')}</p>;

  const pick = (pcode) => {
    onChange(pcode);
    setQuery('');
    if (transient) {
      setDivision('');
      setDistrict('');
    }
  };

  const name = (item) => (lang === 'bn' ? (item.nameBn ?? item.name) : item.name);
  const describedBy = [error ? `${base}-error` : null, help ? `${base}-help` : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="alert-area" id={id} aria-describedby={describedBy}>
      {label && <p className="alert-label">{label}{required && <span className="alert-req"> · {tr('field.required')}</span>}</p>}
      {help && <p className="alert-help" id={`${base}-help`}>{help}</p>}

      {!transient && (
        <p className="alert-area-current" aria-live="polite">
          {value ? (
            <>
              <Icon name="pin" size={18} />
              <strong>{tr('area.selected', { name: areaLabel(index, value, lang) })}</strong>
              {allowEmpty && <button type="button" className="alert-link-button" onClick={() => pick('')}>{tr('area.same')}</button>}
            </>
          ) : (allowEmpty ? <span className="alert-muted">{tr('area.same')}</span> : null)}
        </p>
      )}

      <div className="alert-area-selects">
        <label>
          <span>{tr('area.division')}</span>
          <select
            value={currentDivision}
            onChange={(event) => { setDivision(event.target.value); setDistrict(''); if (value) onChange(''); }}
          >
            <option value="">{tr('area.choose')}</option>
            {index.divisions.map((item) => <option key={item} value={item}>{translate(lang, item)}</option>)}
          </select>
        </label>
        <label>
          <span>{tr('area.district')}</span>
          <select
            value={currentDistrict}
            disabled={!districts.length}
            onChange={(event) => { setDistrict(event.target.value); if (value) onChange(''); }}
          >
            <option value="">{tr('area.choose')}</option>
            {districts.map((item) => <option key={item.pcode} value={item.pcode}>{name(item)}</option>)}
          </select>
        </label>
        <label>
          <span>{tr('area.upazila')}</span>
          <select
            value={value && locations.some((item) => item.pcode === value) ? value : ''}
            disabled={!locations.length}
            onChange={(event) => event.target.value && pick(event.target.value)}
          >
            <option value="">{tr('area.choose')}</option>
            {locations.filter((item) => !exclude.includes(item.pcode)).map((item) => <option key={item.pcode} value={item.pcode}>{name(item)}</option>)}
          </select>
        </label>
      </div>

      <label className="alert-area-search">
        <span>{tr('area.search')}</span>
        <input
          type="search"
          value={query}
          placeholder={tr('area.placeholder')}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {query.trim().length >= 2 && (
        results.length ? (
          <ul className="alert-area-results" aria-label={tr('area.search')}>
            {results.map((item) => (
              <li key={item.pcode}>
                <button type="button" onClick={() => pick(item.pcode)}>
                  <span>{name(item)}</span>
                  <small>{areaLabel(index, item.pcode, lang)}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="alert-muted" role="status">{tr('area.none')}</p>
      )}

      {error && <p className="alert-field-error" id={`${base}-error`} role="alert">{error}</p>}
    </div>
  );
}
