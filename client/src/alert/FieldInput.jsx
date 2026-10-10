import { useId } from 'react';
import { Icon } from '../components/Icon.jsx';
import { areaLabel, errorMessage, fieldDomId, pick } from '../lib/alertForm.js';
import { AreaPicker } from './AreaPicker.jsx';
import { useAlert } from './context.js';

// One question of the schema, rendered by its type. The page decides which questions show; this only draws one and reports its answer.
function Choices({ field, value, onChange, error, describedBy }) {
  const { lang } = useAlert();
  const name = useId();
  return (
    <div className="alert-choices" role="radiogroup" aria-describedby={describedBy}>
      {field.options.map((option) => (
        <label key={option.value} className={`alert-choice${value === option.value ? ' is-selected' : ''}`}>
          <input type="radio" name={name} value={String(option.value)} checked={value === option.value} onChange={() => onChange(option.value)} aria-invalid={Boolean(error)} />
          <span>{pick(option.label, lang)}</span>
        </label>
      ))}
    </div>
  );
}

function AreaList({ field, value, onChange, error }) {
  const { tr, lang, index } = useAlert();
  const list = Array.isArray(value) ? value : [];
  const full = list.length >= field.max;
  return (
    <div className="alert-arealist">
      {list.length > 0 && (
        <ul className="alert-chips">
          {list.map((pcode) => (
            <li key={pcode}>
              <span className="alert-chip">
                {areaLabel(index, pcode, lang)}
                <button type="button" aria-label={tr('area.remove', { name: areaLabel(index, pcode, lang) })} onClick={() => onChange(list.filter((item) => item !== pcode))}>
                  <Icon name="close" size={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!full && <AreaPicker transient exclude={list} value="" onChange={(pcode) => pcode && onChange([...list, pcode])} error={error} />}
      {full && <p className="alert-muted">{tr('area.max', { max: field.max })}</p>}
    </div>
  );
}

export function FieldInput({ field, value, onChange, errorCode = null }) {
  const { tr, lang } = useAlert();
  const base = useId();
  const path = `occupationData.${field.key}`;
  const domId = fieldDomId(path);
  const label = pick(field.label, lang);
  const help = field.help ? pick(field.help, lang) : null;
  const error = errorCode ? errorMessage(errorCode, lang) : null;
  const describedBy = [error ? `${base}-error` : null, help ? `${base}-help` : null].filter(Boolean).join(' ') || undefined;
  const mark = field.required ? <span className="alert-req"> · {tr('field.required')}</span> : <span className="alert-opt"> · {tr('field.optional')}</span>;

  let control;
  if (field.type === 'select' && field.options.length <= 5) {
    control = <Choices field={field} value={value} onChange={onChange} error={error} describedBy={describedBy} />;
  } else if (field.type === 'select') {
    control = (
      <select id={`${domId}-input`} aria-labelledby={`${base}-label`} value={value ?? ''} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={describedBy}>
        <option value="">{tr('area.choose')}</option>
        {field.options.map((option) => <option key={option.value} value={option.value}>{pick(option.label, lang)}</option>)}
      </select>
    );
  } else if (field.type === 'boolean') {
    control = (
      <Choices
        field={{ options: [{ value: true, label: { en: tr('yes'), bn: tr('yes') } }, { value: false, label: { en: tr('no'), bn: tr('no') } }] }}
        value={typeof value === 'boolean' ? value : null}
        onChange={onChange}
        error={error}
        describedBy={describedBy}
      />
    );
  } else if (field.type === 'time') {
    control = <input id={domId} className="alert-time" type="time" value={value ?? ''} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={describedBy} />;
  } else if (field.type === 'area') {
    return (
      <div className="alert-field" data-field={path}>
        <AreaPicker id={domId} label={<>{label}{mark}</>} value={value ?? ''} onChange={onChange} allowEmpty={!field.required} error={error} help={help ?? (field.defaultHome ? tr('field.areaHelp') : null)} />
      </div>
    );
  } else if (field.type === 'areas') {
    control = <AreaList field={field} value={value} onChange={onChange} error={error} />;
  }

  const grouped = field.type === 'select' || field.type === 'boolean' || field.type === 'areas';
  const Wrapper = grouped ? 'fieldset' : 'div';
  return (
    <Wrapper className="alert-field" data-field={path} id={grouped ? domId : undefined} tabIndex={grouped ? -1 : undefined}>
      {grouped
        ? <legend className="alert-label" id={`${base}-label`}>{label}{mark}</legend>
        : <label className="alert-label" htmlFor={domId}>{label}{mark}</label>}
      {field.type === 'areas' && <p className="alert-help">{tr('field.areasHelp', { max: field.max })}</p>}
      {help && <p className="alert-help" id={`${base}-help`}>{help}</p>}
      {control}
      {error && field.type !== 'areas' && <p className="alert-field-error" id={`${base}-error`} role="alert">{error}</p>}
    </Wrapper>
  );
}
