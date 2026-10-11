import { useLanguage } from '../i18n/index.js';
// The shared data-availability vocabulary. Unknown, stale and unavailable are grey with a different outline, never a calm colour.
export const STATUS_LABELS = {
  FRESH: { en: 'Fresh', bn: 'হালনাগাদ' },
  NO_MATCH: { en: 'No match', bn: 'নির্ধারিত শর্ত মেলেনি' },
  STALE: { en: 'Stale', bn: 'পুরোনো' },
  PARTIAL: { en: 'Partial', bn: 'আংশিক' },
  UNAVAILABLE: { en: 'Unavailable', bn: 'তথ্য পাওয়া যাচ্ছে না' },
};

// What each status does NOT mean, so an empty or quiet result is never read as "all clear".
export const STATUS_MEANING = {
  FRESH: { en: 'Within its freshness window.', bn: 'তথ্যটি হালনাগাদের নির্ধারিত সময়সীমার মধ্যে আছে।' },
  NO_MATCH: { en: 'The check ran and found nothing, for that area and time window only. This is not an all-clear.', bn: 'যাচাইয়ে শুধু ওই এলাকা ও সময়সীমায় প্রযোজ্য কোনো ঘটনা পাওয়া যায়নি। এর অর্থ বিপদ কেটে গেছে এমন নয়।' },
  STALE: { en: 'Older than it should be, so it cannot start or raise an alert.', bn: 'তথ্যটি নির্ধারিত সময়ের চেয়ে পুরোনো। তাই এটি দিয়ে নতুন সতর্কবার্তা তৈরি বা গুরুত্ব বাড়ানো যায় না।' },
  PARTIAL: { en: 'Some of the data is missing or is a fallback.', bn: 'কিছু তথ্য নেই অথবা বিকল্প উৎসের তথ্য ব্যবহার করা হয়েছে।' },
  UNAVAILABLE: { en: 'Not available. Unknown is not the same as calm.', bn: 'তথ্য পাওয়া যাচ্ছে না। এর অর্থ শান্ত আবহাওয়া নয়।' },
};

export function DataStatus({ status, lang, title = true }) {
  const { lang: pageLang } = useLanguage();
  const language = lang ?? pageLang;
  const label = STATUS_LABELS[status]?.[language] ?? status;
  return (
    <span className={`data-chip data-${String(status).toLowerCase().replace('_', '-')}`} title={title ? (STATUS_MEANING[status]?.[language] ?? undefined) : undefined}>
      <span className="data-chip-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
