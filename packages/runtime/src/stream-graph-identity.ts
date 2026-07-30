/**
 * Locale-independent strict total order for opaque graph identities.
 *
 * JavaScript relational comparison uses UTF-16 code-unit order and, unlike
 * localeCompare(), cannot collapse distinct strings such as precomposed and
 * decomposed Unicode spellings into an ordering tie.
 */
export function compareAgentGraphIdentity(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
