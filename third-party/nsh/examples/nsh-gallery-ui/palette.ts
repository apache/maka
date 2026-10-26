import { token } from "nsh";
import { alpha, colors, finish } from "./theme";

/** The shared palette and finishes under the documentation demos' role names. */
export const ui = () => ({
  page: colors.background,
  text: colors.text,
  muted: colors.muted,
  faint: colors.faint,
  border: colors.border,
  line: colors.line,
  accent: colors.accent,
  onAccent: colors.onAccent,
  onPrimary: colors.onLight,
  up: colors.up,
  down: colors.down,
  info: colors.info,
  warn: colors.warn,
  danger: colors.danger,
  violet: token("violet"),
  card: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, ...finish.card },
  row: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, ...finish.card },
  inset: { backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line, ...finish.inset },
  raised: { backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border, ...finish.raised },
  primary: { backgroundColor: colors.light, ...finish.light },
  accentFill: { backgroundColor: colors.accentFill, borderWidth: 1, borderColor: colors.accent, ...finish.accent },
});

export const tint = alpha;
