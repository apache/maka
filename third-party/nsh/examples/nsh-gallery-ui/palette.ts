import { token } from "nsh";
import { alpha, colors, finish } from "./theme";
import { sectionSurface } from "./look/surface";

/** The shared palette and finishes under the documentation demos' role
 * names. `card` (and its old name `row`) is a section's flat surface,
 * `sectionSurface()`'s, its corners included; `inset` is the colors of a
 * well, without corners (`insetSurface()` is a well with its corners). */
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
  // Its fill spelled out as well, so demos reading `ui().card.backgroundColor` get a color.
  card: { ...sectionSurface(), backgroundColor: colors.surface },
  row: { ...sectionSurface(), backgroundColor: colors.surface },
  inset: { backgroundColor: colors.inset, borderWidth: 1, borderColor: colors.line, ...finish.inset },
  raised: { backgroundColor: colors.raised, borderWidth: 1, borderColor: colors.border, ...finish.raised },
  primary: { backgroundColor: colors.light, borderWidth: 1, ...finish.light },
  accentFill: { backgroundColor: colors.accentFill, borderWidth: 1, borderColor: colors.accent, ...finish.accent },
});

export const tint = alpha;
