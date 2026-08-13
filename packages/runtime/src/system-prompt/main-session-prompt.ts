/**
 * Shared main-session prompt assembly (#2352).
 *
 * Main-session system prompts used to be built only from functional fragments
 * (personalization, skills, AGENTS.md, memory, …) and never opened with a
 * product identity. This closes that gap while leaving sub-agent identities to
 * the agent catalog.
 *
 * The assembler is deliberately order-agnostic: it only prepends the identity,
 * drops empty fragments, and joins. It does NOT impose a fixed fragment order,
 * because several fragments are position-semantic and must stay where the host
 * put them — e.g. the Side Chat isolation boundary and the Deep Research mode
 * contract are trailing assertions that constrain everything before them, so
 * moving them earlier weakens them. Each host keeps its existing fragment order.
 *
 * The identity line is pure static text: constant across turns, so it never
 * churns the systemPromptHash / prefix-cache (see request-shape.ts). It is
 * intentionally NOT injected into sub-agent (childInstruction) paths, which
 * already carry their own role identities.
 */

/** Product identity line, prepended by the main-session assembler. */
function buildIdentityPromptFragment(): string {
  return "You are Maka, an AI agent operating on the user's machine. You help by reading files, running commands, editing code, and answering questions.";
}

export interface AssembleMainSessionSystemPromptOptions {
  /**
   * Lead with the product identity. Default true (main session). Set false for
   * paths that already carry their own identity, e.g. the desktop
   * child-instruction path reuses this assembly but must NOT inject the
   * main-session identity (#2352).
   */
  identity?: boolean;
}

/**
 * Prepend the product identity (unless `identity: false`) to a host-supplied
 * fragment list, drop empty/blank fragments, and join with a blank-line
 * separator. The fragment order is the host's responsibility.
 *
 * Pure policy: identity text + filtering. Sub-agent (childInstruction)
 * assembly reuses this helper only on Desktop where the same fragments are
 * shared; it passes `identity: false` so the main-session identity is not
 * injected into a child.
 */
export function assembleMainSessionSystemPrompt(
  fragments: readonly (string | undefined)[],
  options: AssembleMainSessionSystemPromptOptions = {},
): string {
  const includeIdentity = options.identity !== false;
  return [includeIdentity ? buildIdentityPromptFragment() : undefined, ...fragments]
    .filter((fragment): fragment is string => Boolean(fragment?.trim()))
    .join('\n\n');
}
