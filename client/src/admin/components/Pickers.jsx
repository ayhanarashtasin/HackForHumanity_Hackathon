import { useId, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon.jsx';
import {
  addArea, areaCount, emptyAreas, removeArea, searchAreas,
} from '../../lib/adminForm.js';
import { useAdmin } from '../AdminContext.jsx';
import { useLanguage } from '../../i18n/index.js';
import { ADMIN } from '../../i18n/admin.js';

// Roles: checkboxes with an "All roles" shortcut.
export function RolePicker({ value, onChange, error, disabled = false, legend = 'Roles' }) {
  const { tr, lang } = useLanguage(ADMIN);
  const { options } = useAdmin();
  const roles = options.roles;
  const allChosen = roles.length > 0 && roles.every((role) => value.includes(role.value));
  const toggle = (role) => onChange(value.includes(role) ? value.filter((item) => item !== role) : [...value, role]);

  return (
    <fieldset className={`adm-fieldset${error ? ' has-error' : ''}`} disabled={disabled}>
      <legend>{tr(legend)}</legend>
      <div className="adm-checks">
        <label className="adm-check adm-check-all">
          <input type="checkbox" checked={allChosen} onChange={() => onChange(allChosen ? [] : roles.map((role) => role.value))} />
          <span>{tr('All roles')}</span>
        </label>
        {roles.map((role) => (
          <label key={role.value} className="adm-check">
            <input type="checkbox" checked={value.includes(role.value)} onChange={() => toggle(role.value)} />
            <span>{role.label[lang] ?? role.label.en}</span>
          </label>
        ))}
      </div>
      {error && <p className="adm-field-error" role="alert">{error}</p>}
    </fieldset>
  );
}

function Results({ id, results, onPick, activeIndex }) {
  const { tr, lang, name } = useLanguage(ADMIN);
  if (!results.length) return null;
  return (
    <ul id={id} className="adm-results" role="listbox">
      {results.map((item, i) => (
        <li key={`${item.level}-${item.code}`} role="option" aria-selected={i === activeIndex}>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(item)}>
            <span>{name(item)}{lang === 'en' && item.nameBn ? <em lang="bn"> · {item.nameBn}</em> : null}</span>
            <small>{tr(item.kind)} · {lang === 'bn' ? item.parentBn || tr(item.parent) : item.parent}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

// Areas: all of Bangladesh, or a chosen set of districts and upazilas found by search (English or Bangla).
export function AreaPicker({
  value, onChange, error, disabled = false, legend = 'Where', note = null,
}) {
  const { tr, name } = useLanguage(ADMIN);
  const { areaIndex } = useAdmin();
  const [query, setQuery] = useState('');
  const listId = useId();
  const results = useMemo(() => searchAreas(areaIndex, query), [areaIndex, query]);
  const names = useMemo(() => new Map(areaIndex.map((item) => [`${item.level}:${item.code}`, item])), [areaIndex]);
  const choosing = !value.all;

  const pick = (item) => {
    onChange(addArea(value, item.level, item.code));
    setQuery('');
  };

  const chips = [
    ...value.districts.map((code) => ({ level: 'district', code, label: `${name(names.get(`district:${code}`)) ?? code} ${tr('District')}` })),
    ...value.upazilas.map((code) => ({ level: 'upazila', code, label: name(names.get(`upazila:${code}`)) ?? code })),
  ];

  return (
    <fieldset className={`adm-fieldset${error ? ' has-error' : ''}`} disabled={disabled}>
      <legend>{tr(legend)}</legend>
      {note && <p className="adm-hint">{note}</p>}
      {!note && (
        <>
          <div className="adm-radios">
            <label className="adm-check">
              <input type="radio" name={`${listId}-scope`} checked={!choosing} onChange={() => onChange(emptyAreas())} />
              <span>{tr('All Bangladesh')}</span>
            </label>
            <label className="adm-check">
              <input type="radio" name={`${listId}-scope`} checked={choosing} onChange={() => onChange({ all: false, districts: [], upazilas: [] })} />
              <span>{tr('Choose districts or upazilas')}</span>
            </label>
          </div>
          {choosing && (
            <div className="adm-area-search">
              <div className="adm-search">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  value={query}
                  placeholder={tr('Find a district or upazila · English / বাংলা')}
                  aria-label={tr('Search districts and upazilas')}
                  aria-controls={listId}
                  autoComplete="off"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Results id={listId} results={results} onPick={pick} activeIndex={-1} />
              {query.trim().length >= 2 && !results.length && <p className="adm-hint" role="status">{tr('No matching area.')}</p>}
              {chips.length > 0 && (
                <ul className="adm-chips" aria-label={tr('Chosen areas')}>
                  {chips.map((chip) => (
                    <li key={`${chip.level}-${chip.code}`}>
                      <span>{chip.label}</span>
                      <button type="button" aria-label={tr('Remove {name}', { name: chip.label })} onClick={() => onChange(removeArea(value, chip.level, chip.code))}><Icon name="close" size={14} /></button>
                    </li>
                  ))}
                </ul>
              )}
              {areaCount(value) === 0 && <p className="adm-hint">{tr('Search above to add at least one area.')}</p>}
            </div>
          )}
        </>
      )}
      {error && <p className="adm-field-error" role="alert">{error}</p>}
    </fieldset>
  );
}

// Picks one upazila (the demo subscribers' home area).
export function UpazilaSearch({ picked, onPick }) {
  const { tr, name, lang } = useLanguage(ADMIN);
  const { areaIndex } = useAdmin();
  const [query, setQuery] = useState('');
  const listId = useId();
  const results = useMemo(() => searchAreas(areaIndex, query, { level: 'upazila' }), [areaIndex, query]);

  return (
    <div className="adm-area-search">
      <div className="adm-search">
        <Icon name="search" size={18} />
        <input
          type="search"
          value={query}
          placeholder={tr('Find an upazila · English / বাংলা')}
          aria-label={tr('Search upazilas')}
          aria-controls={listId}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <Results id={listId} results={results} onPick={(item) => { onPick(item); setQuery(''); }} activeIndex={-1} />
      {picked && <p className="adm-hint">{tr('Chosen: {name}', { name: name(picked) })} · {lang === 'bn' ? picked.parentBn || tr(picked.parent) : picked.parent}</p>}
    </div>
  );
}
