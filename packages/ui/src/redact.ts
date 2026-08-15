/**
 * Re-export the shared display-layer redactor from `@maka/core` (#1065).
 *
 * The patterns and `<redacted>` marker are the single source of truth for
 * display redaction, shared by the desktop quiet panel and the TUI.
 * The backend has its own separate redactor (`@maka/core/redaction.ts`)
 * for log/persistence sanitization.
 */
export {
  redactReversibleStreamingSuffix,
  redactSecrets,
  redactStableStreamingSuffix,
} from '@maka/core/display-redaction';
