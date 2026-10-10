import { PALETTE } from '../lib/palette.js';

// Sun behind a cloud on a Deep Olive tile (the same mark as the favicon). The tile keeps it legible on both
// Deep Olive and Soft White backgrounds, which matters for a transparent navbar that crosses both.
export function LogoMark({ size = 34 }) {
  return (
    <svg className="logo-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill={PALETTE.olive} stroke="rgba(232, 233, 223, 0.28)" />
      <circle cx="12" cy="13" r="6" fill={PALETTE.sage} />
      <path d="M9 24h14a5 5 0 0 0 0-10 7 7 0 0 0-13.3-1.6A5.5 5.5 0 0 0 9 24z" fill={PALETTE.cream} />
    </svg>
  );
}
