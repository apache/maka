/**
 * Stable visual identity for a Work across the WorkHub transcript, filter
 * scale, and ordinary Session rail.
 *
 * The returned value is a CSS custom-property reference rather than a literal
 * colour so the same identity stays legible in both light and dark themes.
 * Routing never reads this value; collisions remain a presentation concern.
 */
export const WORKHUB_IDENTITY_COLOR_COUNT = 8;

export function workHubIdentityColor(key: string): string {
  let hash = 0;
  for (const character of key) {
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  }
  return `var(--workhub-identity-${(hash >>> 0) % WORKHUB_IDENTITY_COLOR_COUNT})`;
}
