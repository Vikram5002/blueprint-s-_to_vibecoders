import { useId } from 'react';

export const PRODUCT_NAME = 'VibeCoder';

/**
 * The brand mark: the brand gradient in a rounded square, holding a "V" whose
 * right stroke ends in a spark - an idea turning into something built.
 */
export function LogoMark({ size = 28, className }: { readonly size?: number; readonly className?: string }): JSX.Element {
  // Unique per instance: two marks on one page must not share (and fight over) one gradient id.
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={`vb-${id}`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="0.5" stopColor="#6d6af8" />
          <stop offset="1" stopColor="#0a84ff" />
        </linearGradient>
        <linearGradient id={`vb-shine-${id}`} x1="16" y1="0" x2="16" y2="18" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#vb-${id})`} />
      <rect width="32" height="18" rx="9" fill={`url(#vb-shine-${id})`} />
      <path d="M9.5 10.5l6.5 12 4.2-7.8" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M22.6 7.2c.25 1.9.95 2.6 2.85 2.85-1.9.25-2.6.95-2.85 2.85-.25-1.9-.95-2.6-2.85-2.85 1.9-.25 2.6-.95 2.85-2.85z" fill="#fff" />
    </svg>
  );
}

export function Wordmark(): JSX.Element {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={26} />
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-slate-50">{PRODUCT_NAME}</span>
    </span>
  );
}
