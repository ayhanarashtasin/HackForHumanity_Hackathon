import { formatDhaka, referenceHref } from '../alert/format.js';

// BMD wording stays verbatim (including its original digits/language), in a neutral block separate from AkashSathi's urgency chip.
export function OfficialNotice({ notice, lang = 'en', validityAssumed = false }) {
  if (!notice) return null;
  const bn = lang === 'bn';
  const href = referenceHref(notice.documentUrl);
  return (
    <section className="official-notice" aria-label={bn ? 'বিএমডির মূল বিজ্ঞপ্তি' : 'Original BMD notice'}>
      <h4>{bn ? 'বিএমডির সরকারি বিজ্ঞপ্তি (মূল ভাষায়)' : 'Official BMD notice (quoted)'}</h4>
      {notice.signalText && <blockquote lang={/[\u0980-\u09ff]/u.test(notice.signalText) ? 'bn' : 'en'}>{notice.signalText}</blockquote>}
      <p>{notice.issuer ?? (bn ? 'বিএমডি' : 'BMD')}{notice.issuedAt ? ` · ${bn ? 'বিজ্ঞপ্তির উল্লেখিত সময়' : 'Notice reference time'} ${formatDhaka(notice.issuedAt, lang)} ${bn ? 'বাংলাদেশ সময়' : 'BST'}` : ''}</p>
      {validityAssumed && <p>{bn ? 'বিজ্ঞপ্তিতে মেয়াদ স্পষ্ট নয়; প্রদর্শিত মেয়াদ পরীক্ষামূলক অনুমান। মূল বিজ্ঞপ্তি দেখুন।' : 'The notice has no explicit expiry; the displayed validity is a prototype estimate. Check the original.'}</p>}
      {href && <a href={href} target="_blank" rel="noopener noreferrer">{bn ? 'মূল বিজ্ঞপ্তি পড়ুন (PDF)' : 'Read the original notice (PDF)'}</a>}
    </section>
  );
}
