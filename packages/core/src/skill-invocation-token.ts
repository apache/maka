/**
 * The `/skill:<name>` invocation grammar (issue #1148) — one string, because
 * every client that reads or writes a draft has to agree on where a token
 * starts and ends: the TUI's highlighter and autocomplete, the Desktop
 * composer's chips, and Runtime's submit-time parser and stripper.
 *
 * It lives in core rather than in Runtime because the Desktop composer needs
 * it to render a draft, long before anything is sent, and the renderer has no
 * business depending on Runtime for that.
 *
 * A token is valid at the start of the text or after whitespace, so paths and
 * URLs (`a/skill:b`, `https://x/skill:y`) never produce false positives.
 * `<name>` uses the skill id charset; resolution downstream matches by id
 * first, then by display name.
 *
 * Always construct a fresh `RegExp` from this source at the point of use: a
 * shared instance with the `g` flag carries `lastIndex` between calls.
 */
export const SKILL_INVOCATION_TOKEN_SOURCE = String.raw`(?:^|(?<=\s))\/skill:([A-Za-z0-9._-]+)`;
