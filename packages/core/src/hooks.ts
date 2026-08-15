export const HOOK_CONFIG_VERSION = 1 as const;
export const HOOK_TRUST_VERSION = 1 as const;
export const PRE_TOOL_USE_HOOK_EVENT = 'PreToolUse' as const;

export type HookEventName =
  | 'UserPromptSubmit'
  | 'RunStart'
  | typeof PRE_TOOL_USE_HOOK_EVENT
  | 'PostToolUse'
  | 'RunEnd';
export type HookSource = 'user' | 'project';
export type HookAuditSource = HookSource | 'extension';

export interface HookCommandConfig {
  id: string;
  type: 'command';
  command: string;
  args?: string[];
  timeoutMs?: number;
  enabled?: boolean;
}

export interface HookMatcherGroupConfig {
  matcher?: string;
  hooks: HookCommandConfig[];
}

export interface HookConfigFile {
  version: typeof HOOK_CONFIG_VERSION;
  hooks: {
    PreToolUse?: HookMatcherGroupConfig[];
  };
}

export interface HookTrustRecord {
  definitionHash: `sha256:${string}`;
  source: HookSource;
  projectIdentity: string;
  trustedAt: number;
}

export interface HookTrustFile {
  version: typeof HOOK_TRUST_VERSION;
  trustedDefinitions: HookTrustRecord[];
}

export interface ResolvedHookDefinition {
  id: string;
  eventName: HookEventName;
  matcher: string;
  command: string;
  args: string[];
  timeoutMs: number;
  source: HookSource;
  sourceOrder: number;
  definitionOrder: number;
  projectIdentity: string;
  definitionHash: `sha256:${string}`;
  trusted: boolean;
}

export interface PreToolUseHookInput {
  schema_version: 1;
  hook_event_name: HookEventName;
  session_id: string;
  turn_id: string;
  run_id: string;
  tool_use_id: string;
  tool_name: string;
  tool_input: unknown;
  cwd: string;
  permission_mode: string;
  origin: 'provider' | 'code_mode';
}

export type HookExecutionStatus = 'allowed' | 'denied' | 'failed' | 'skipped_untrusted';

export interface HookCompletedAudit {
  eventName: HookEventName;
  handlerId: string;
  definitionHash: `sha256:${string}`;
  source: HookAuditSource;
  toolUseId: string;
  toolName: string;
  status: HookExecutionStatus;
  durationMs: number;
  message?: string;
}

export function createDefaultHookConfig(): HookConfigFile {
  return { version: HOOK_CONFIG_VERSION, hooks: {} };
}

export function createDefaultHookTrust(): HookTrustFile {
  return { version: HOOK_TRUST_VERSION, trustedDefinitions: [] };
}
