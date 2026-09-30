/**
 * The workspace's icons: one small hand-drawn set on a 24px grid, stroked in
 * the current text colour, so an icon always matches the label beside it and
 * no icon library is added to the bundle.
 */
const PATHS = {
  sparkles: (
    <>
      <path d="M12 3c.45 3.9 2.05 5.5 5.95 5.95C14.05 9.4 12.45 11 12 14.9c-.45-3.9-2.05-5.5-5.95-5.95C9.95 8.5 11.55 6.9 12 3z" />
      <path d="M18.5 14.2c.2 1.75.9 2.45 2.65 2.65-1.75.2-2.45.9-2.65 2.65-.2-1.75-.9-2.45-2.65-2.65 1.75-.2 2.45-.9 2.65-2.65z" />
    </>
  ),
  flow: (
    <>
      <rect x="3" y="3" width="6.5" height="5" rx="1.5" />
      <rect x="14.5" y="3" width="6.5" height="5" rx="1.5" />
      <rect x="8.75" y="16" width="6.5" height="5" rx="1.5" />
      <path d="M6.25 8v2.25a2 2 0 0 0 2 2h7.5a2 2 0 0 0 2-2V8M12 12.25V16" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M3 9h18M9 9v11" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v5.5c0 4.3-3 8-7 9.5-4-1.5-7-5.2-7-9.5V6z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" />,
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  minus: <path d="M6 12h12" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevrons-left': <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />,
  'chevrons-right': <path d="M13 17l5-5-5-5M6 17l5-5-5-5" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  folder: (
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2.2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
      <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  pages: (
    <>
      <rect x="4" y="3" width="13" height="16" rx="2" />
      <path d="M8 21h9a2 2 0 0 0 2-2V7M7.5 8h6M7.5 11.5h6" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="4" width="16" height="6.5" rx="2" />
      <rect x="4" y="13.5" width="16" height="6.5" rx="2" />
      <path d="M8 7.25h.01M8 16.75h.01" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="2.8" />
      <path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  command: <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />,
  branch: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 8.2v7.6M18 10.2a6 6 0 0 1-6 6H8.2" />
    </>
  ),
  external: (
    <path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" />,
  play: <path d="M8 5.5v13l10-6.5z" />,
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  history: <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v4.5H8M12 8v4l3 2" />,
  wand: <path d="M4 20L15 9M13 5l2 2M18 3v3M16.5 4.5h3M19 10v2M18 11h2M9 4v2M8 5h2" />,
  book: (
    <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.5A1.5 1.5 0 0 0 5 20zM5 20a1.5 1.5 0 0 0 1.5 1.5H19M9 7.5h6" />
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  briefcase: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2.5" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18" />
    </>
  ),
  home: <path d="M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H5.5A1.5 1.5 0 0 1 4 19.5z" />,
  cart: (
    <>
      <circle cx="9" cy="20" r="1.3" />
      <circle cx="17" cy="20" r="1.3" />
      <path d="M3 4h2.5l2.2 10.5h10.3L20 7.5H6.6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.8" />
      <path d="M4.5 20.5c1-3.8 4-5.8 7.5-5.8s6.5 2 7.5 5.8" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
  readonly strokeWidth?: number;
}

export function Icon({ name, size = 16, className, strokeWidth = 1.75 }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {PATHS[name]}
    </svg>
  );
}
