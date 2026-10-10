import { useId, useMemo, useState } from 'react';
import { Icon } from '../../components/Icon.jsx';
import {
  addArea, areaCount, emptyAreas, removeArea, searchAreas,
} from '../../lib/adminForm.js';
import { useAdmin } from '../AdminContext.jsx';

// Roles: checkboxes with an "All roles" shortcut.
export function RolePicker({ value, onChange, error, disabled = false, legend = 'Roles' }) {
  const { options } = useAdmin();
  const roles = options.roles;
  const allChosen = roles.length > 0 && roles.every((role) => value.includes(role.value));
  const toggle = (role) => onChange(value.includes(role) ? value.filter((item) => item !== role) : [...value, role]);

  return (
    <fieldset className={`adm-fieldset${error ? ' has-error' : ''}`} disabled={disabled}>
      <legend>{legend}</legend>
      <div className="adm-checks">
        <label className="adm-check adm-check-all">
          <input type="checkbox" checked={allChosen} onChange={() => onChange(allChosen ? [] : roles.map((role) => role.value))} />
          <span>All roles</span>
        </label>
        {roles.map((role) => (
          <label key={role.value} className="adm-check">
            <input type="checkbox" checked={value.includes(role.value)} onChange={() => toggle(role.value)} />
            <span>{role.label.en}</span>
          </label>
        ))}
      </div>
      {error && <p className="adm-field-error" role="alert">{error}</p>}
    </fieldset>
  );
}

function Results({ id, results, onPick, activeIndex }) {
  if (!results.length) return null;
  return (
    <ul id={id} className="adm-results" role="listbox">
      {results.map((item, i) => (
        <li key={`${item.level}-${item.code}`} role="option" aria-selected={i === activeIndex}>
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(item)}>
            <span>{item.name}{item.nameBn ? <em lang="bn"> · {item.nameBn}</em> : null}</span>
            <small>{item.kind} · {item.parent}</small>
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
    ...value.districts.map((code) => ({ level: 'district', code, label: `${names.get(`district:${code}`)?.name ?? code} district` })),
    ...value.upazilas.map((code) => ({ level: 'upazila', code, label: names.get(`upazila:${code}`)?.name ?? code })),
  ];

  return (
    <fieldset className={`adm-fieldset${error ? ' has-error' : ''}`} disabled={disabled}>
      <legend>{legend}</legend>
      {note && <p className="adm-hint">{note}</p>}
      {!note && (
        <>
          <div className="adm-radios">
            <label className="adm-check">
              <input type="radio" name={`${listId}-scope`} checked={!choosing} onChange={() => onChange(emptyAreas())} />
              <span>All Bangladesh</span>
            </label>
            <label className="adm-check">
              <input type="radio" name={`${listId}-scope`} checked={choosing} onChange={() => onChange({ all: false, districts: [], upazilas: [] })} />
              <span>Choose districts or upazilas</span>
            </label>
          </div>
          {choosing && (
            <div className="adm-area-search">
              <div className="adm-search">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  value={query}
                  placeholder="Find a district or upazila · English / বাংলা"
                  aria-label="Search districts and upazilas"
                  aria-controls={listId}
                  autoComplete="off"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <Results id={listId} results={results} onPick={pick} activeIndex={-1} />
              {query.trim().length >= 2 && !results.length && <p className="adm-hint" role="status">No matching area.</p>}
              {chips.length > 0 && (
                <ul className="adm-chips" aria-label="Chosen areas">
                  {chips.map((chip) => (
                    <li key={`${chip.level}-${chip.code}`}>
                      <span>{chip.label}</span>
                      <button type="button" aria-label={`Remove ${chip.label}`} onClick={() => onChange(removeArea(value, chip.level, chip.code))}><Icon name="close" size={14} /></button>
                    </li>
                  ))}
                </ul>
              )}
              {areaCount(value) === 0 && <p className="adm-hint">Search above to add at least one area.</p>}
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
          placeholder="Find an upazila · English / বাংলা"
          aria-label="Search upazilas"
          aria-controls={listId}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <Results id={listId} results={results} onPick={(item) => { onPick(item); setQuery(''); }} activeIndex={-1} />
      {picked && <p className="adm-hint">Chosen: <strong>{picked.name}</strong> · {picked.parent}</p>}
    </div>
  );
}
