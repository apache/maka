/**
 * Permission system: PermissionMode + ToolCategory + Mode × Category policy
 * matrix + pure `preToolUse()` evaluator. Runtime owns requestId generation.
 *
 * Purity rule: `preToolUse()` is deterministic given its input — no UUIDs,
 * no clock reads, no I/O. PermissionEngine in runtime wraps it and supplies
 * requestId at the call site.
 */

import { computerUseApprovalScopeKey, computerUseApprovalSummary } from './computer-use.js';

// ============================================================================
// Mode + Tool categories
// ============================================================================

export const PERMISSION_MODES = ['explore', 'ask', 'execute', 'bypass'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const APPROVALS_REVIEWERS = ['user', 'auto_review'] as const;
export type ApprovalsReviewer = (typeof APPROVALS_REVIEWERS)[number];

export const APPROVAL_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type ApprovalRiskLevel = (typeof APPROVAL_RISK_LEVELS)[number];

export interface ActiveApprovalRoutingPolicy {
  readonly reviewer: ApprovalsReviewer;
  readonly sandboxEscalationAllowed: boolean;
}

export function approvalRoutingPolicyForMode(
  mode: PermissionMode,
): ActiveApprovalRoutingPolicy | null {
  switch (mode) {
    case 'ask':
      return { reviewer: 'user', sandboxEscalationAllowed: true };
    case 'execute':
      return { reviewer: 'auto_review', sandboxEscalationAllowed: true };
    case 'explore':
      return { reviewer: 'user', sandboxEscalationAllowed: false };
    case 'bypass':
      return null;
  }
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** Whether a requested mode stays within an immutable creation-time ceiling. */
export function isPermissionModeWithinCeiling(
  mode: PermissionMode,
  ceiling: PermissionMode,
): boolean {
  return PERMISSION_MODES.indexOf(mode) <= PERMISSION_MODES.indexOf(ceiling);
}

/** Canonical category names use Claude SDK terminology. Pi adapter MUST
 *  translate Pi-native tool names into these before they reach the runtime. */
export type ToolCategory =
  | 'read' //              Read, search_files, Grep, Glob, ls
  | 'web_read' //          WebFetch, WebSearch (GET-class)
  | 'file_write' //        Write, Edit, patch (create / append / overwrite)
  | 'fs_destructive' //    rm, rmdir, dd, truncate, shred, mkfs, find -delete, ...
  | 'shell_safe' //        reserved: categorizeBash no longer produces it (no shell is auto-safe); fail-closed in policy
  | 'shell_unsafe' //      default Bash bucket
  | 'git_destructive' //   git reset --hard, push --force, branch -D, ...
  | 'network_send' //      POST / PUT / DELETE
  | 'privileged' //        sudo, chmod, chown, kill, systemctl
  | 'browser' //           embedded-browser observe→act on the user's logged-in sessions
  | 'computer_use' //      host-level observation and input on the user's real applications
  | 'custom_tool' //       our own session-scoped tools without a stricter category hint
  | 'subagent'; //         read-only delegated exploration tools

export const TOOL_CATEGORIES: readonly ToolCategory[] = [
  'read',
  'web_read',
  'file_write',
  'fs_destructive',
  'shell_safe',
  'shell_unsafe',
  'git_destructive',
  'network_send',
  'privileged',
  'browser',
  'computer_use',
  'custom_tool',
  'subagent',
];

export function isToolCategory(value: unknown): value is ToolCategory {
  return typeof value === 'string' && (TOOL_CATEGORIES as readonly string[]).includes(value);
}

export type ToolPermissionRule =
  | {
      effect: 'allow' | 'deny';
      kind: 'category';
      category: ToolCategory;
    }
  | {
      effect: 'allow' | 'deny';
      kind: 'bash_exact';
      command: string;
    }
  | {
      effect: 'allow' | 'deny';
      kind: 'tool';
      toolName: string;
    };

export interface ToolPermissionRuleMatchInput {
  toolName: string;
  args: unknown;
  category: ToolCategory;
  rules: readonly ToolPermissionRule[];
}

/** Explicit deny rules always win over explicit allow rules, regardless of argv order. */
export function matchToolPermissionRules(
  input: ToolPermissionRuleMatchInput,
): 'allow' | 'deny' | undefined {
  if (
    input.rules.some((rule) => rule.effect === 'deny' && toolPermissionRuleMatches(rule, input))
  ) {
    return 'deny';
  }
  if (
    input.rules.some((rule) => rule.effect === 'allow' && toolPermissionRuleMatches(rule, input))
  ) {
    return 'allow';
  }
  return undefined;
}

function toolPermissionRuleMatches(
  rule: ToolPermissionRule,
  input: Omit<ToolPermissionRuleMatchInput, 'rules'>,
): boolean {
  if (rule.kind === 'category') return rule.category === input.category;
  if (rule.kind === 'tool') return rule.toolName === input.toolName;
  const command = (input.args as { command?: unknown } | null)?.command;
  return input.toolName === 'Bash' && typeof command === 'string' && command === rule.command;
}

// ============================================================================
// Tool execution environment facts
// ============================================================================

export type ToolExecutionIsolation = 'none' | 'worktree' | 'container' | 'remote';
export type ToolExecutionWriteBack = 'direct' | 'diff_review';
export type ToolExecutionNetwork = 'host' | 'sandbox' | 'disabled';
export type ToolExecutionSecrets = 'host_env' | 'brokered' | 'none';

export interface ToolExecutionFacts {
  isolation: ToolExecutionIsolation;
  writesAffectHost: boolean;
  writeBack: ToolExecutionWriteBack;
  network: ToolExecutionNetwork;
  secrets: ToolExecutionSecrets;
}

// ============================================================================
// Policy matrix
// ============================================================================

export type PolicyDecision = 'allow' | 'prompt' | 'block';

export const PERMISSION_POLICY: Record<PermissionMode, Record<ToolCategory, PolicyDecision>> = {
  explore: {
    read: 'allow',
    // PR-AGENT-WEB-SEARCH-TOOL-0: explicit network egress (WebSearch
    // via Tavily) prompts in non-autonomous modes. Agent-issued web
    // requests are out-of-process side effects the user must confirm,
    // even in the otherwise read-only `explore` mode.
    web_read: 'prompt',
    // shell_safe is fail-closed like shell_unsafe: categorizeBash no longer
    // produces it (no shell command is provably safe from its string), so this
    // is defence-in-depth — there is no auto-allow path for shell in explore.
    shell_safe: 'block',
    file_write: 'block',
    fs_destructive: 'block',
    shell_unsafe: 'block',
    git_destructive: 'block',
    network_send: 'block',
    privileged: 'block',
    // Driving the user's logged-in browser is an out-of-process effect; explore
    // mode is read-only-local, so block it like other network/write effects.
    browser: 'block',
    computer_use: 'block',
    custom_tool: 'prompt',
    subagent: 'allow',
  },
  ask: {
    read: 'allow',
    web_read: 'prompt',
    shell_safe: 'prompt',
    file_write: 'prompt',
    fs_destructive: 'prompt',
    shell_unsafe: 'prompt',
    git_destructive: 'prompt',
    network_send: 'prompt',
    privileged: 'prompt',
    browser: 'prompt',
    computer_use: 'prompt',
    custom_tool: 'allow',
    subagent: 'prompt',
  },
  execute: {
    read: 'allow',
    web_read: 'allow',
    file_write: 'allow',
    network_send: 'allow',
    custom_tool: 'allow',
    subagent: 'allow',
    // Shell stays prompt in the static table. policyDecisionForInput upgrades
    // shell_unsafe to allow only when runtime proves the active profile can be
    // enforced by a platform sandbox; otherwise this fail-closed default wins.
    shell_safe: 'prompt',
    shell_unsafe: 'prompt',
    // Irreversible ops ALWAYS prompt, even in execute mode.
    fs_destructive: 'prompt',
    git_destructive: 'prompt',
    privileged: 'prompt',
    // Browser act/observe drives the user's logged-in sessions — effectively
    // irreversible (it can post, send, buy). Prompt even in execute so the
    // visible view stays a confirmed safety net, not a default-allow. The
    // user's "allow for this turn" then carries the observe→act loop.
    browser: 'prompt',
    // Computer Use uses target- and action-class scope keys. Remembering a
    // metadata read never authorizes a screenshot or mutation.
    computer_use: 'prompt',
  },
  bypass: {
    read: 'allow',
    web_read: 'allow',
    shell_safe: 'allow',
    file_write: 'allow',
    fs_destructive: 'allow',
    shell_unsafe: 'allow',
    git_destructive: 'allow',
    network_send: 'allow',
    privileged: 'allow',
    browser: 'allow',
    computer_use: 'allow',
    custom_tool: 'allow',
    subagent: 'allow',
  },
};

// ============================================================================
// Tool name → category mapping (Claude SDK canonical names)
// ============================================================================

export const BUILTIN_TOOL_CATEGORY: Record<string, ToolCategory> = {
  // read
  Read: 'read',
  ArchiveRead: 'read',
  search_files: 'read',
  Grep: 'read',
  Glob: 'read',
  // web read
  WebFetch: 'web_read',
  WebSearch: 'web_read',
  // file write
  Write: 'file_write',
  Edit: 'file_write',
  patch: 'file_write',
  // shell — default unsafe; categorizeBash() may downgrade or upgrade
  Bash: 'shell_unsafe',
  WriteStdin: 'shell_unsafe',
};

// ============================================================================
// Shell command categorization
// ============================================================================

// There is no SAFE_SHELL_PREFIXES allowlist: a shell command cannot be proven
// safe from its string. Any prefix that accepts arguments can hide execution
// in them — PowerShell `echo (Set-Content x)` runs Set-Content first; `$(...)`,
// backtick, and `iex` do the same in bash/PowerShell; even "read-only" commands
// like `git status` can trigger fsmonitor helpers. Eight review rounds of
// enumerating dangerous shapes proved the futility of the inverse (deciding a
// Turing-complete shell's runtime effect from a static string is undecidable).
// So categorizeBash never returns shell_safe; read-only needs go through typed
// tools (Read/Glob/Grep — fixed argv, no shell), and every shell command is at
// least shell_unsafe → prompt. The categories below only make the confirmation
// REASON accurate (delete vs elevate vs generic); they are no longer the safety
// boundary, so a missed pattern is a wording nit, not a bypass.

export const PRIVILEGED_SHELL_PREFIXES: readonly string[] = [
  'sudo ',
  'su ',
  'chmod ',
  'chown ',
  'chgrp ',
  'mount ',
  'umount ',
  'kill ',
  'killall ',
  'systemctl ',
  'launchctl ',
  'shutdown',
  'reboot',
];

/** PowerShell/cmd equivalents of the privileged boundary above: process
 *  termination (kill/killall), service control (systemctl), power
 *  (shutdown/reboot), and ACL/ownership (chmod/chown). Case-insensitive
 *  because PowerShell is. */
export const PRIVILEGED_SHELL_PATTERNS: readonly RegExp[] = [
  // kill is PowerShell's default alias for Stop-Process; bare `kill` also
  // shows up as the tail of `Get-Process x | kill`. (POSIX `kill ` prefix is
  // handled separately for the pid-argument form.)
  /^(kill|stop-process|spps|taskkill)\b/i,
  // Elevation intent: -Verb RunAs is the PowerShell form of `runas`. Anchor on
  // the flag itself, not the Start-Process alias, so plain Start-Process stays
  // shell_unsafe while any elevated launch prompts.
  /(^|\s)-verb\s+runas\b/i,
  // Service control mirrors the blanket `systemctl ` prefix above: every
  // mutating verb prompts; read-only queries (sc query, Get-Service) do not.
  // sasv/spsv are the documented default aliases of Start-/Stop-Service.
  /^((start|stop|restart|set|new|remove|suspend|resume)-service|sasv|spsv)\b/i,
  /^sc\s+(stop|start|pause|continue|delete|config|create|failure|sdset)\b/i,
  /^net\s+(stop|start|pause|continue)\b/i,
  /^(stop-computer|restart-computer)\b/i,
  /^(icacls|takeown|set-acl|runas)\b/i,
];

/** Irreversible filesystem operations. `rm` in any form (incl. single-file
 *  `rm foo.txt`) lands here so auto/execute mode still prompts. Anchored to
 *  the start of every statement segment (see commandSegments), not just the
 *  whole command. */
export const FS_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /^dd\s+/,
  /^truncate\b/,
  /^shred\b/,
  /^mkfs\b/,
  /^git\s+restore\s+(\.\s*$|--\s+\S+)/, //          git restore . or git restore -- <path>
  /^git\s+checkout\s+--\s+\S+/, //                  git checkout -- <path>
  // Pipeline / batch destructors via find/xargs
  /^find\s+.*\s-delete\b/,
  /^find\s+.*\s-exec\s+.*\b(rm|shred|truncate|dd)\b/,
  /^xargs\s+.*\b(rm|shred|truncate|dd)\b/,
  // PowerShell / cmd.exe deletes plus the POSIX rm family. On Windows the
  // Bash tool runs PowerShell and steers the model toward its syntax
  // (shell-detect.ts), so these land in fs_destructive to make the confirmation
  // REASON accurate (delete, not generic) — not to gate allow-vs-prompt, which
  // is already closed: shell_unsafe prompts too, so a miss only mislabels the
  // reason. Case-insensitive because PowerShell is (harmless for the POSIX
  // names: an upper-cased rm is still rm-shaped). Applied on POSIX too: the only
  // real collision is Ruby's docs tool `ri`, and the failure mode is an extra
  // prompt, not a bypass.
  /^remove-item\b/i,
  /^(rm|rmdir|ri|del|erase|rd)\b/i,
  /^(clear-content|clc)\b/i,
];

export const PIPE_DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\|\s*xargs\b[^\n;&|]*\b(rm|shred|truncate|dd)\b/,
  /\|\s*(sh|bash|zsh)\b/,
];

export const DESTRUCTIVE_GIT_PATTERNS: readonly RegExp[] = [
  /^git\s+reset\s+--hard\b/,
  /^git\s+push\s+(--force|-f)\b/,
  /^git\s+branch\s+-D\b/,
  /^git\s+clean\s+-fd?\b/,
  /^git\s+checkout\s+\.\s*$/,
  /^git\s+rebase\s+-i\b/,
];

/**
 * Positions where a command name can start: the beginning, plus after every
 * statement / pipeline / scriptblock / substitution boundary. Splitting is
 * deliberately quote-naive; quote-AWARE splitting would be strictly worse,
 * because `$( )` and backticks expand INSIDE double quotes in both dialects —
 * not splitting there would hide `echo "$(rm x)"`. Naive splitting never
 * drops content, it only cuts it up: every byte lands in some segment, and
 * normalizeSegmentHead strips unclosed-quote remnants off segment heads
 * (`"del` from a payload cut at an inner `&` still matches). So extra
 * boundaries add scan candidates; they do not hide them.
 */
function commandSegments(cmd: string): string[] {
  return cmd
    .split(/[|;&\n(){}`]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Commands that defer to the real command later in the segment. */
const WRAPPER_COMMANDS = new Set([
  'nohup',
  'nice',
  'time',
  'timeout',
  'env',
  'command',
  'exec',
  'stdbuf',
]);

/** Shell-in-shell heads whose literal payload can be categorized recursively.
 *  Interpreters (python -c, node -e) are deliberately absent: we know these
 *  shells' dialects, we do not parse arbitrary languages. */
const NESTED_SHELL_HEADS: ReadonlyArray<{ head: RegExp; flag: RegExp }> = [
  { head: /^(sh|bash|zsh)$/, flag: /(?:^|\s)-\w*c\s+([\s\S]+)$/ },
  { head: /^(pwsh|powershell)$/i, flag: /\s-c(?:ommand)?\s+([\s\S]+)$/i },
  { head: /^cmd$/i, flag: /\s\/[ck]\s+([\s\S]+)$/i },
];

/**
 * Canonicalize the segment's first token to the command name it resolves to:
 * unwrap quotes (`& 'Remove-Item' x`), drop a leading escape (`\rm`), a path
 * prefix (`/bin/rm`, `C:\...\taskkill.exe`) and the .exe suffix, and skip
 * wrapper commands plus their option-ish arguments (`nohup`, `timeout 30`,
 * `env FOO=bar`). Only the UPGRADE checks (privileged/fs/git) see this
 * normalization — the safe-prefix check keeps the raw command, so a local
 * script named `./ls` can never be upgraded to shell_safe.
 */
function normalizeSegmentHead(segment: string): string {
  let rest = segment;
  for (let hops = 0; hops < 5; hops++) {
    const quoted = /^(['"])(.+?)\1(\s+|$)/.exec(rest);
    const bare = quoted ? null : /^(\S+)(\s*)([\s\S]*)$/.exec(rest);
    if (!quoted && !bare) return rest;
    let head = quoted ? quoted[2]! : bare![1]!;
    const tail = quoted ? rest.slice(quoted[0].length) : bare![3]!;
    head = head
      // Quote chars anywhere in the name: unclosed remnants of a payload cut
      // mid-string (`"del`) and PowerShell quote interruptions (Remove''-Item
      // executes Remove-Item — verified on real pwsh). Caret is cmd.exe's
      // escape char (de^l executes del). Fold them out of the NAME only; the
      // safe-prefix check never sees this normalization.
      .replace(/['"^]/g, '')
      .replace(/^\\/, '')
      .replace(/^.*[\\/]/, '')
      .replace(/\.exe$/i, '');
    if (WRAPPER_COMMANDS.has(head.toLowerCase())) {
      rest = tail.replace(/^((-\S+|\S+=\S*|\d+[smhd]?)\s+)*/, '');
      continue;
    }
    return tail ? `${head} ${tail}` : head;
  }
  return rest;
}

/** Head-normalized segments, plus (recursively) the segments of any literal
 *  shell-in-shell payload: `cmd /c del foo.txt` also yields `del foo.txt`. */
function scanSegments(cmd: string, depth: number): string[] {
  const out: string[] = [];
  for (const raw of commandSegments(cmd)) {
    const segment = normalizeSegmentHead(raw);
    out.push(segment);
    if (depth === 0) continue;
    const payload = nestedShellPayload(segment);
    if (payload) out.push(...scanSegments(payload, depth - 1));
  }
  return out;
}

function nestedShellPayload(segment: string): string | undefined {
  const head = /^\S*/.exec(segment)![0];
  for (const shell of NESTED_SHELL_HEADS) {
    if (!shell.head.test(head)) continue;
    const match = shell.flag.exec(segment);
    if (!match) return undefined;
    const payload = match[1]!.trim();
    const unquoted = /^(['"])([\s\S]*)\1$/.exec(payload);
    return unquoted ? unquoted[2] : payload;
  }
  return undefined;
}

function isPrivilegedSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    PRIVILEGED_SHELL_PREFIXES.some((p) => lower.startsWith(p)) ||
    PRIVILEGED_SHELL_PATTERNS.some((re) => re.test(segment))
  );
}

/**
 * Categorize a shell command into a permission bucket. There is NO shell_safe
 * outcome: no shell command is auto-allowed (see the note above the privileged
 * prefixes). This function's job is only to pick the most accurate confirmation
 * REASON — privileged > fs_destructive > git_destructive > shell_unsafe — by
 * scanning EVERY statement segment (with a canonicalized first token), so
 * `cd /tmp; rm -rf stuff`, `Get-ChildItem . | ForEach-Object { Remove-Item $_ }`,
 * and `& 'Remove-Item' x` all read as destructive. Since the fallback
 * shell_unsafe already prompts, a missed variant only mislabels the reason; it
 * never changes allow-vs-prompt.
 */
export function categorizeBash(cmd: string): ToolCategory {
  const t = cmd.trim();
  // Backtick is BOTH a split boundary (bash command substitution — `rm x` runs
  // even inside double quotes, so it must stay a boundary) AND PowerShell's
  // in-name escape (R`M runs rm, Remove`-Item runs Remove-Item — verified on
  // real pwsh). Splitting alone would leave the PS name as two innocent halves,
  // so scan the split segments AND a backtick-collapsed variant of the command.
  const segments = scanSegments(cmd, 2);
  if (cmd.includes('`')) segments.push(...scanSegments(cmd.replace(/`/g, ''), 2));
  if (segments.some((s) => isPrivilegedSegment(s))) return 'privileged';
  if (segments.some((s) => FS_DESTRUCTIVE_PATTERNS.some((re) => re.test(s))))
    return 'fs_destructive';
  if (PIPE_DESTRUCTIVE_PATTERNS.some((re) => re.test(t))) return 'fs_destructive';
  if (segments.some((s) => DESTRUCTIVE_GIT_PATTERNS.some((re) => re.test(s))))
    return 'git_destructive';
  return 'shell_unsafe';
}

// ============================================================================
// Pre-tool-use 3-step evaluator (pure)
// ============================================================================

export interface PreToolUseInput {
  toolName: string;
  args: unknown;
  mode: PermissionMode;
  turnRemembered: ReadonlySet<string>;
  /** Optional trusted runtime hint for custom tools that map to a canonical category. */
  categoryHint?: ToolCategory;
  /**
   * Trusted runtime facts about where the tool would execute. The current
   * policy accepts this for forward compatibility; sandbox-aware decisions are
   * intentionally introduced in a later policy change.
   */
  executionFacts?: ToolExecutionFacts;
  /**
   * Platform sandbox availability for sandbox-aware policy decisions. Unsafe
   * shell in execute mode is only auto-allowed when the runtime can actually
   * enforce the active profile with a platform sandbox.
   */
  sandbox?: {
    platformSandboxAvailable: boolean;
  };
}

export interface PreToolUseResult {
  proceed: boolean;
  needsPrompt: boolean;
  category: ToolCategory;
  scopeKey: string;
  /** Request shape WITHOUT requestId — runtime PermissionEngine fills it. */
  partialRequest?: Omit<PermissionRequest, 'requestId' | 'toolUseId'>;
  blockReason?: string;
}

export function classifyToolUse(input: {
  toolName: string;
  args: unknown;
  categoryHint?: ToolCategory;
}): ToolCategory {
  let category: ToolCategory =
    input.categoryHint ?? BUILTIN_TOOL_CATEGORY[input.toolName] ?? 'custom_tool';
  if (category === 'shell_unsafe') {
    const cmd = (input.args as { command?: unknown } | null)?.command;
    if (typeof cmd === 'string') category = categorizeBash(cmd);
  }
  return category;
}

export function preToolUse(input: PreToolUseInput): PreToolUseResult {
  // (1) Classify
  const category = classifyToolUse(input);

  // (2) Policy lookup + turn-remembered check
  const decision = policyDecisionForInput(input, category);
  const scopeKey = permissionScopeKey(input.toolName, input.args, category);
  const rememberForTurnAllowed = permissionRememberForTurnAllowed(
    input.toolName,
    input.args,
    category,
  );
  if (decision === 'allow') {
    return { proceed: true, needsPrompt: false, category, scopeKey };
  }
  if (decision === 'block') {
    return {
      proceed: false,
      needsPrompt: false,
      category,
      scopeKey,
      blockReason: `Tool category "${category}" is blocked in mode "${input.mode}"`,
    };
  }
  if (rememberForTurnAllowed && input.turnRemembered.has(scopeKey)) {
    return { proceed: true, needsPrompt: false, category, scopeKey };
  }

  // (3) Prompt — runtime adds requestId + toolUseId at adapter site
  return {
    proceed: false,
    needsPrompt: true,
    category,
    scopeKey,
    partialRequest: {
      kind: 'tool_permission',
      toolName: input.toolName,
      category,
      reason: permissionReasonForCategory(category),
      args: permissionRequestArgs(input.args, category),
      rememberForTurnAllowed,
    },
  };
}

function policyDecisionForInput(input: PreToolUseInput, category: ToolCategory): PolicyDecision {
  const decision = PERMISSION_POLICY[input.mode][category];
  if (input.mode === 'execute' && category === 'shell_unsafe') {
    return input.sandbox?.platformSandboxAvailable === true ? 'allow' : 'prompt';
  }
  return decision;
}

export function permissionScopeKey(
  toolName: string,
  args: unknown,
  category: ToolCategory,
): string {
  // Browser actions share ONE turn-scope across every browser_* tool and its
  // args: "allow for this turn" on the first prompt then carries the whole
  // observe→act loop (snapshot → click → type → navigate …), as the policy
  // comment promises. The visible-conversation lease — not per-call prompts —
  // is the safety net for which page is driven. Other categories stay scoped
  // to the specific tool + args below.
  if (category === 'browser') return 'browser';
  if (category === 'computer_use') return computerUseApprovalScopeKey(args);
  switch (toolName) {
    case 'Write':
    case 'Edit':
    case 'Read':
      return `${category}:${toolName}:${stringArg(args, 'path')}`;
    case 'Glob':
      return `${category}:${toolName}:${stringArg(args, 'cwd')}:${stringArg(args, 'pattern')}`;
    case 'Grep':
      return `${category}:${toolName}:${stringArg(args, 'path')}:${stringArg(args, 'glob')}:${stringArg(args, 'pattern')}`;
    case 'Bash':
      return `${category}:${toolName}:${normalizeScopeText(stringArg(args, 'command'))}`;
    case 'WebSearch':
      return `${category}:${toolName}:${stringArg(args, 'query')}`;
    default:
      return `${category}:${toolName}:${stableScopeJson(args)}`;
  }
}

function stringArg(args: unknown, key: string): string {
  if (!args || typeof args !== 'object') return '';
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? normalizeScopeText(value) : '';
}

function normalizeScopeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 512);
}

function stableScopeJson(value: unknown): string {
  const json = JSON.stringify(normalizeForScope(value, new WeakSet<object>()));
  return (json ?? String(value)).slice(0, 1024);
}

function normalizeForScope(value: unknown, seen: WeakSet<object>): unknown {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((nested) => normalizeForScope(nested, seen));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, normalizeForScope(nested, seen)]),
  );
}

export function permissionReasonForCategory(c: ToolCategory): PermissionRequest['reason'] {
  switch (c) {
    case 'shell_unsafe':
      return 'shell_dangerous';
    case 'file_write':
      return 'file_write';
    case 'fs_destructive':
      return 'fs_destructive';
    case 'network_send':
      return 'network';
    case 'git_destructive':
      return 'git_destructive';
    case 'privileged':
      return 'privileged';
    case 'browser':
      return 'browser';
    case 'computer_use':
      return 'computer_use';
    default:
      return 'custom';
  }
}

// ============================================================================
// Request / Response shapes
// ============================================================================

export interface PermissionRequest {
  kind: 'tool_permission';
  requestId: string;
  toolUseId: string;
  toolName: string;
  category: ToolCategory;
  reason:
    | 'shell_dangerous'
    | 'file_write'
    | 'fs_destructive'
    | 'network'
    | 'git_destructive'
    | 'privileged'
    | 'browser'
    | 'computer_use'
    | 'custom';
  args: unknown;
  hint?: string;
  rememberForTurnAllowed: boolean;
}

export interface AdditionalPermissionRequest {
  kind: 'additional_permissions';
  requestId: string;
  toolUseId: string;
  toolName: string;
  category: ToolCategory;
  reason: 'additional_permissions';
  additionalPermissions: import('./additional-permissions.js').AdditionalPermissionProfile;
  cwd: string;
  justification: string;
  intentHash: string;
  permissionsHash: string;
  risk: import('./additional-permissions.js').AdditionalPermissionRiskSummary;
  alsoApprovesToolExecution: boolean;
  availableDecisions: readonly ['allow_once', 'deny'];
  hint?: string;
}

export interface SandboxEscalationRiskSummary {
  readonly unsandboxedExecution: true;
  readonly unrestrictedFileSystem: true;
  readonly unrestrictedNetwork: true;
  readonly protectedMetadataExposed: true;
}

export interface SandboxEscalationRequest {
  kind: 'sandbox_escalation';
  requestId: string;
  toolUseId: string;
  toolName: 'Bash';
  category: ToolCategory;
  reason: 'sandbox_escalation';
  command: string;
  cwd: string;
  justification: string;
  intentHash: string;
  commandHash: string;
  trigger: 'proactive' | 'sandbox_denial';
  risk: SandboxEscalationRiskSummary;
  alsoApprovesToolExecution: boolean;
  availableDecisions: readonly ['allow_once', 'deny'];
  hint?: string;
}

/** Permission prompt payloads that may be carried by canonical runtime events. */
export type PermissionRequestPayload =
  | PermissionRequest
  | AdditionalPermissionRequest
  | SandboxEscalationRequest;

function permissionRequestArgs(args: unknown, category: ToolCategory): unknown {
  return category === 'computer_use' ? computerUseApprovalSummary(args) : args;
}

function permissionRememberForTurnAllowed(
  toolName: string,
  args: unknown,
  category: ToolCategory,
): boolean {
  if (toolName === 'WriteStdin') return false;
  return category !== 'computer_use' || computerUseApprovalSummary(args).rememberForTurnAllowed;
}

export interface PermissionResponse {
  requestId: string;
  decision: 'allow' | 'deny';
  rememberForTurn?: boolean;
  reviewer?: ApprovalsReviewer;
  rationale?: string;
  riskLevel?: ApprovalRiskLevel;
}
