export const ORCHESTRATION_MODES = ['default', 'swarm', 'graph'] as const;

export type OrchestrationMode = (typeof ORCHESTRATION_MODES)[number];

export const TURN_ORCHESTRATION_SOURCES = ['slash_command', 'host_api'] as const;

export type TurnOrchestrationSource = (typeof TURN_ORCHESTRATION_SOURCES)[number];

export interface TurnOrchestration {
  mode: OrchestrationMode;
  source: TurnOrchestrationSource;
}

export const EFFECTIVE_ORCHESTRATION_SOURCES = ['session', 'turn_override'] as const;

export type EffectiveOrchestrationSource = (typeof EFFECTIVE_ORCHESTRATION_SOURCES)[number];

export const AGENT_SWARM_AUTHORIZATION_SOURCES = ['none', 'session_mode', 'turn_override'] as const;

export type AgentSwarmAuthorizationSource = (typeof AGENT_SWARM_AUTHORIZATION_SOURCES)[number];

/** Trusted runtime snapshot carried by one AgentRun and every backend send. */
export interface EffectiveOrchestration {
  mode: OrchestrationMode;
  source: EffectiveOrchestrationSource;
  agentSwarmAuthorization: AgentSwarmAuthorizationSource;
}

export function isOrchestrationMode(value: unknown): value is OrchestrationMode {
  return typeof value === 'string' && (ORCHESTRATION_MODES as readonly string[]).includes(value);
}

export function isTurnOrchestrationSource(value: unknown): value is TurnOrchestrationSource {
  return (
    typeof value === 'string' && (TURN_ORCHESTRATION_SOURCES as readonly string[]).includes(value)
  );
}

export function isEffectiveOrchestrationSource(
  value: unknown,
): value is EffectiveOrchestrationSource {
  return (
    typeof value === 'string' &&
    (EFFECTIVE_ORCHESTRATION_SOURCES as readonly string[]).includes(value)
  );
}

export function isAgentSwarmAuthorizationSource(
  value: unknown,
): value is AgentSwarmAuthorizationSource {
  return (
    typeof value === 'string' &&
    (AGENT_SWARM_AUTHORIZATION_SOURCES as readonly string[]).includes(value)
  );
}

export function resolveEffectiveOrchestration(
  sessionMode: OrchestrationMode | undefined,
  override: TurnOrchestration | undefined,
): EffectiveOrchestration {
  if (override) {
    return {
      mode: override.mode,
      source: 'turn_override',
      agentSwarmAuthorization: override.mode === 'swarm' ? 'turn_override' : 'none',
    };
  }
  const mode = sessionMode ?? 'default';
  return {
    mode,
    source: 'session',
    agentSwarmAuthorization: mode === 'swarm' ? 'session_mode' : 'none',
  };
}
