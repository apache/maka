/** Hopper Lab's palette: cool graphite with teal, amber and rose signals.
 * Every color the app draws comes from here. */
export const color = {
  page: "#0d1014",
  card: "#151a20",
  inset: "#10141a",
  raised: "#1d232b",
  line: "#242b34",
  lineStrong: "#323b46",
  grid: "#1a2028",
  text: "#e8edf2",
  muted: "#8794a3",
  faint: "#566271",
  accent: "#3dd6c6",
  accentDim: "rgba(61,214,198,0.14)",
  caution: "#f5b041",
  cautionDim: "rgba(245,176,65,0.14)",
  alert: "#f0607a",
  alertDim: "rgba(240,96,122,0.15)",
  bar: "#3f4a57",
  ink: "#0d1014",
  light: "#e8edf2",
} as const;

/** Monospaced digits and labels (the system's monospaced font). */
export const mono = "monospace";

export const radius = { card: 20, control: 12, pill: 999 } as const;
