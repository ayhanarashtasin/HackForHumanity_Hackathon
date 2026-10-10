// The shared data-availability vocabulary. Unknown, stale and unavailable are grey with a different outline, never a calm colour.
export const STATUS_LABELS = {
  FRESH: { en: 'Fresh', bn: 'হালনাগাদ' },
  NO_MATCH: { en: 'No match', bn: 'কিছু মেলেনি' },
  STALE: { en: 'Stale', bn: 'পুরোনো' },
  PARTIAL: { en: 'Partial', bn: 'আংশিক' },
  UNAVAILABLE: { en: 'Unavailable', bn: 'অনুপলব্ধ' },
};

// What each status does NOT mean, so an empty or quiet result is never read as "all clear".
export const STATUS_MEANING = {
  FRESH: { en: 'Within its freshness window.', bn: 'নির্ধারিত সময়সীমার মধ্যে হালনাগাদ।' },
  NO_MATCH: { en: 'The check ran and found nothing, for that area and time window only. This is not an all-clear.', bn: 'যাচাই করা হয়েছে এবং শুধু ওই এলাকা ও সময়ে কিছু পাওয়া যায়নি। এটি নিরাপদ থাকার নিশ্চয়তা নয়।' },
  STALE: { en: 'Older than it should be, so it cannot start or raise an alert.', bn: 'প্রয়োজনের চেয়ে পুরোনো, তাই নতুন সতর্কবার্তা শুরু বা বাড়াতে পারে না।' },
  PARTIAL: { en: 'Some of the data is missing or is a fallback.', bn: 'কিছু উপাত্ত নেই বা বিকল্প উপাত্ত ব্যবহার হয়েছে।' },
  UNAVAILABLE: { en: 'Not available. Unknown is not the same as calm.', bn: 'পাওয়া যায়নি। অজানা মানে শান্ত নয়।' },
};

export function DataStatus({ status, lang = 'en', title = true }) {
  const label = STATUS_LABELS[status]?.[lang] ?? status;
  return (
    <span className={`data-chip data-${String(status).toLowerCase().replace('_', '-')}`} title={title ? (STATUS_MEANING[status]?.[lang] ?? undefined) : undefined}>
      <span className="data-chip-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
