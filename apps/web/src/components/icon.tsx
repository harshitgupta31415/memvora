import type { CSSProperties } from 'react';

export type IconName =
  | 'grid'
  | 'repo'
  | 'terminal'
  | 'spark'
  | 'settings'
  | 'arrow'
  | 'plus'
  | 'search'
  | 'check'
  | 'clock'
  | 'close'
  | 'copy'
  | 'menu'
  | 'refresh'
  | 'alert'
  | 'chevron'
  | 'code'
  | 'link';

const paths: Record<IconName, React.ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  repo: (
    <>
      <path d="M4 19V5a2 2 0 0 1 2-2h14v18H6a2 2 0 0 1 0-4h14M8 7h7M8 10h4" />
      <path d="M8 17v5l2-1 2 1v-5" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m7 9 3 3-3 3m6 0h4" />
    </>
  ),
  spark: (
    <>
      <path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z" />
      <path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5L20 2Z" />
    </>
  ),
  settings: (
    <>
      <path d="m9 3-.7 2.1-2 .9-2-.5L2.8 8l1.4 1.7-.2 2.2-1.5 1.5 1.4 2.8 2.1-.2 1.8 1.2.5 2.2h3.1l.9-2 2.1-.7 1.9.7 1.9-2.5-1.2-1.8.4-2.2 1.7-1.3-1-3-2.1-.2-1.6-1.5-.2-2.2H9Z" />
      <circle cx="10.5" cy="11" r="3" />
    </>
  ),
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  refresh: (
    <>
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
    </>
  ),
  alert: (
    <>
      <path d="m12 3 10 18H2L12 3Z" />
      <path d="M12 9v5m0 3h.01" />
    </>
  ),
  chevron: <path d="m9 5 7 7-7 7" />,
  code: (
    <>
      <path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 20" />
    </>
  ),
  link: (
    <>
      <path d="m10 13 4-4m-6 5-2 2a3 3 0 0 0 4 4l4-4a3 3 0 0 0 0-4m-4 0a3 3 0 0 1 0-4l4-4a3 3 0 0 1 4 4l-2 2" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
