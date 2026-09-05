/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

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
