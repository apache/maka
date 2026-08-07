/**
 * Shared main-session prompt assembly (#2352).
 *
 * Main-session system prompts used to be built only from functional fragments
 * (personalization, skills, AGENTS.md, memory, …) and never opened with a
 * product identity — unlike sub-agents (agent-catalog.ts) and headless, which
 * already have default prompts. This closes that gap.
 *
 * The identity line is pure static text: constant across turns, so it never
 * churns the systemPromptHash / prefix-cache (see request-shape.ts). It is a
 * module-private helper consumed only by assembleMainSessionSystemPrompt; it is
 * intentionally NOT injected into sub-agent (childInstruction) paths, which
 * already carry their own role identities.
 */

/** Product identity line, prepended by the main-session assembler. */
function buildIdentityPromptFragment(): string {
  return "You are Maka, an AI agent operating on the user's machine. You help by reading files, running commands, editing code, and answering questions.";
}

/**
 * Optional fragments a host may supply for a main-session system prompt.
 *
 * `identity` defaults to on so hosts cannot forget to prepend the product
 * identity (the gap noted in #2352). Set it false for paths that already carry
 * their own identity, e.g. the desktop child-instruction path reuses the same
 * fragment assembly but must NOT inject the main-session identity (#2352).
 * All other fields are optional; missing ones are dropped.
 */
export interface MainSessionPromptFragments {
  /** Lead with the product identity. Default true (main session). */
  identity?: boolean;
  personalization?: string;
  skills?: string;
  workspaceInstructions?: string;
  memory?: string;
  /** Desktop-only and deep-research host parts. */
  deepResearch?: string;
  botPlatformHint?: string;
  /** Desktop side-conversation mode declaration (#2428). */
  sideConversation?: string;
  planMode?: string;
}

/**
 * Assemble a main-session system prompt that leads with the product identity
 * (unless `identity: false`), followed by host-supplied fragments in a fixed
 * order.
 *
 * Pure policy: identity text + join order. The identity fragment is constant
 * across turns, so it never churns the systemPromptHash / prefix-cache (see
 * request-shape.ts). Sub-agent (childInstruction) assembly reuses this helper
 * only on Desktop where the same fragments are shared; it passes
 * `identity: false` so the main-session identity is not injected into a child.
 */
export function assembleMainSessionSystemPrompt(parts: MainSessionPromptFragments): string {
  const includeIdentity = parts.identity !== false;
  return [
    includeIdentity ? buildIdentityPromptFragment() : undefined,
    parts.personalization,
    parts.deepResearch,
    parts.botPlatformHint,
    parts.sideConversation,
    parts.skills,
    parts.workspaceInstructions,
    parts.memory,
    parts.planMode,
  ]
    .filter((fragment): fragment is string => Boolean(fragment?.trim()))
    .join('\n\n');
}
