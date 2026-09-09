const PATHS = {
  book: "M3 2.5h6a2 2 0 0 1 2 2v9H5a2 2 0 0 0-2 2v-13Zm0 0h10v11",
  file: "M4 1.5h5l3 3v10H4v-13Zm5 0v3h3",
  search: "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm3.4-1.1 3.1 3.1",
  chevronRight: "m6 4 4 4-4 4",
  chevronDown: "m4 6 4 4 4-4",
  chevronLeft: "m10 4-4 4 4 4",
  plus: "M8 3.5v9M3.5 8h9",
  close: "m4 4 8 8M12 4l-4 4-4 4",
  check: "m3.5 8.5 3 3 6-7",
  send: "M2 8h11m-4.5-4.5L13 8l-4.5 4.5",
  sun: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM8 1.5v1.5M8 13v1.5M1.5 8H3m10 0h1.5M3.4 3.4l1 1m7.2 7.2 1 1m-9.2 0 1-1m7.2-7.2 1-1",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z",
  panelLeft: "M2 3h12v10H2V3Zm4 0v10",
  panelRight: "M2 3h12v10H2V3Zm8 0v10",
  trash: "M3 5h10M6 5V3.5h4V5m-5 0 .5 8.5h5L11 5",
  warn: "M8 2 1.5 13.5h13L8 2Zm0 4v3.5m0 2v.5",
  info: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm0 3v.5m0 2v3",
  quote:
    "M6 4.5C4 5.5 3 7 3 9v2.5h3V8H4.6C4.8 6.8 5.3 6 6 5.5V4.5Zm6 0C10 5.5 9 7 9 9v2.5h3V8h-1.4C10.8 6.8 11.3 6 12 5.5V4.5Z",
  upload: "M8 12.5V3.5m-3.5 3L8 3l3.5 3.5M3 13.5h10",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...(className ? { className } : {})}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
