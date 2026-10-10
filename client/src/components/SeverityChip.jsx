import { Icon } from './Icon.jsx';

// The alert level as a word + an icon + a colour (design.md "Alert severity"): never colour alone.
export const SEVERITY_LABELS = {
  ADVISORY: { en: 'Advisory', bn: 'পরামর্শ' },
  WARNING: { en: 'Warning', bn: 'সতর্কতা' },
  CRITICAL: { en: 'Critical', bn: 'জরুরি' },
};

const ICONS = { ADVISORY: 'info', WARNING: 'warning', CRITICAL: 'critical' };

export function SeverityChip({ severity, lang = 'en', size = 'md' }) {
  const label = SEVERITY_LABELS[severity]?.[lang] ?? severity;
  return (
    <span className={`sev sev-${String(severity).toLowerCase()} sev-${size}`} data-severity={severity}>
      <Icon name={ICONS[severity] ?? 'info'} size={size === 'sm' ? 14 : 16} />
      <span>{label}</span>
    </span>
  );
}
