import { useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';

export function SearchBox({ catalogue, onPick }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  const index = useMemo(() => {
    if (!catalogue) return [];
    const districtName = new Map(catalogue.districts.map((district) => [district.pcode, district.name]));
    return [
      ...catalogue.districts.map((district) => ({
        level: 'district', id: district.pcode, name: district.name, nameBn: district.nameBn, kind: 'District', parent: district.division, lat: district.lat, lon: district.lon, zoom: 8.5,
      })),
      ...catalogue.locations.map((location) => ({
        level: 'upazila', id: location.pcode, name: location.name, nameBn: location.nameBn, kind: location.kind === 'thana' ? 'City thana' : 'Upazila', parent: districtName.get(location.district), lat: location.lat, lon: location.lon, zoom: 10.5,
      })),
    ].map((item) => ({ ...item, haystack: `${item.name} ${item.nameBn ?? ''}`.toLowerCase() }));
  }, [catalogue]);

  const results = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (text.length < 2) return [];
    return index
      .filter((item) => item.haystack.includes(text) || (item.level === 'upazila' && item.id.startsWith(text)))
      .sort((a, b) => (b.haystack.startsWith(text) - a.haystack.startsWith(text)) || (a.level === 'district' ? -1 : 1) - (b.level === 'district' ? -1 : 1))
      .slice(0, 8);
  }, [index, query]);

  const choose = (item) => {
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
    onPick(item);
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (!results.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive((value) => (value + 1) % results.length); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive((value) => (value - 1 + results.length) % results.length); }
    if (event.key === 'Enter') { event.preventDefault(); choose(results[active] ?? results[0]); }
  };

  return (
    <div className="search">
      <span className="search-icon"><Icon name="search" size={19} /></span>
      <input
        ref={inputRef}
        id="map-location-search"
        type="search"
        role="combobox"
        value={query}
        placeholder="Find an upazila · English / বাংলা"
        aria-label="Search district or upazila"
        aria-expanded={open && results.length > 0}
        aria-controls="search-results"
        aria-autocomplete="list"
        aria-activedescendant={open && results.length ? `search-option-${active}` : undefined}
        autoComplete="off"
        onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {open && results.length > 0 && (
        <ul id="search-results" className="search-results panel" role="listbox">
          {results.map((item, i) => (
            <li id={`search-option-${i}`} key={`${item.level}-${item.id}`} role="option" aria-selected={i === active}>
              <button type="button" tabIndex={-1} className={i === active ? 'active' : ''} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(item)}>
                <span>{item.name}{item.nameBn ? <em lang="bn"> · {item.nameBn}</em> : null}</span>
                <small>{item.kind} · {item.parent}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && query.trim().length >= 2 && !results.length && (
        <p className="search-results search-empty panel" role="status">{catalogue ? 'No matching area. Try a different Bangla or English name.' : 'Loading areas…'}</p>
      )}
    </div>
  );
}
