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

import type { AgentInteractionRequest } from './bridge';
import { tr } from './locale';

function exactObject(value: unknown, keys: string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  return Object.keys(object).length === keys.length &&
    keys.every((key) => Object.hasOwn(object, key))
    ? object
    : null;
}

// Only grant shapes understood and shown here can be approved on this device.
export function describePermissions(value: unknown): string | null {
  const grants = exactObject(value, ['filesystem', 'network']);
  if (!grants || !Array.isArray(grants.filesystem)) return null;
  const lines: string[] = [];
  for (const item of grants.filesystem) {
    const rule = exactObject(item, ['path', 'scope', 'access']);
    if (
      !rule ||
      typeof rule.path !== 'string' ||
      !rule.path ||
      (rule.scope !== 'exact' && rule.scope !== 'subtree') ||
      (rule.access !== 'read' && rule.access !== 'write')
    )
      return null;
    lines.push(
      tr('{access} · {scope}: {path}', {
        access: rule.access === 'write' ? tr('Read/write') : tr('Read only'),
        scope: rule.scope === 'subtree' ? tr('path and descendants') : tr('this exact path'),
        path: JSON.stringify(rule.path),
      }),
    );
  }
  if (!lines.length) lines.push(tr('Filesystem: no additional access'));
  if (grants.network === 'allowed') lines.push(tr('Network: all destinations'));
  else if (grants.network === 'denied') lines.push(tr('Network: no access'));
  else {
    const network = exactObject(grants.network, ['restricted']);
    const restricted = exactObject(network?.restricted, ['destinations']);
    if (!restricted || !Array.isArray(restricted.destinations)) return null;
    if (!restricted.destinations.length) lines.push(tr('Network: no destinations'));
    for (const item of restricted.destinations) {
      const target = exactObject(item, ['host', 'port']);
      if (
        !target ||
        typeof target.host !== 'string' ||
        !target.host ||
        typeof target.port !== 'number' ||
        !Number.isInteger(target.port) ||
        target.port < 1 ||
        target.port > 65535
      )
        return null;
      lines.push(
        tr('Network: exact host {host}, port {port}', {
          host: JSON.stringify(target.host),
          port: target.port,
        }),
      );
    }
  }
  return lines.join('\n');
}

function scopeLabel(scope: 'once' | 'run' | 'session' | 'always'): string {
  switch (scope) {
    case 'once':
      return tr('This call');
    case 'run':
      return tr('This run');
    case 'session':
      return tr('This session');
    case 'always':
      return tr('Always');
  }
}

export function describeChildDecision(value: unknown): string | null {
  const answer = exactObject(value, ['kind', 'decision']);
  if (!answer) return null;
  if (answer.kind === 'permissions') {
    const decision = exactObject(answer.decision, ['decision', 'permissions', 'scope']);
    if (!decision || decision.decision !== 'allow') return null;
    const scope = decision.scope;
    if (scope !== 'once' && scope !== 'run' && scope !== 'session') return null;
    const detail = describePermissions(decision.permissions);
    return detail === null
      ? null
      : [
          tr('Allow additional permissions · Scope: {scope}', { scope: scopeLabel(scope) }),
          detail,
        ].join('\n');
  }
  if (
    answer.kind === 'computer_app' &&
    (answer.decision === 'once' || answer.decision === 'session' || answer.decision === 'always')
  )
    return tr('Allow control of the desktop application · Scope: {scope}', {
      scope: scopeLabel(answer.decision),
    });
  if (answer.decision !== 'allow') return null;
  if (answer.kind === 'service_approval') return tr('Allow this service call only');
  if (answer.kind === 'client_capability')
    return tr('Allow the requested client capability for this interaction');
  return null;
}

export function approvalDetail(request: AgentInteractionRequest): {
  command?: string;
  permissions?: string;
} {
  switch (request.kind) {
    case 'permissions':
      return {
        command: request.request.command?.command,
        permissions: describePermissions(request.request.permissions) ?? tr('Review on Desktop'),
      };
    case 'session_approval':
      return { permissions: describeChildDecision(request.answer) ?? tr('Review on Desktop') };
    case 'service_approval':
      return { command: request.service + '.' + request.method + ' (' + request.binding + ')' };
    case 'client_capability':
      return {
        permissions: [
          request.target.providerId,
          request.target.contractId,
          request.target.serverId,
          request.target.toolName,
          request.target.capability,
          request.target.scope,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'computer_app':
      return {
        permissions: [
          request.display.appPath,
          request.target?.toolName,
          request.target?.serverId,
          request.display.risk,
          request.display.warning,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    default:
      return {};
  }
}

export function approvalControls(request: AgentInteractionRequest | undefined) {
  if (!request) return {};
  const allow = (label: string, answer: Record<string, unknown>) => ({ label, answer });
  const deny = { kind: request.kind, decision: 'deny' };
  switch (request.kind) {
    case 'permissions': {
      const denied = { kind: request.kind, decision: { decision: 'deny' } };
      if (describePermissions(request.request.permissions) === null) return { deny: denied };
      const answer = (scope: 'once' | 'session') => ({
        kind: request.kind,
        decision: { decision: 'allow', scope, permissions: request.request.permissions },
      });
      return request.toolUseId == null
        ? { primary: allow(tr('This session'), answer('session')), deny: denied }
        : {
            primary: allow(tr('Allow once'), answer('once')),
            session: answer('session'),
            deny: denied,
          };
    }
    case 'session_approval': {
      if (describeChildDecision(request.answer) === null) return { deny };
      const answer =
        request.answer as import('../../../../packages/plugin-sdk/src/generated/runtime').SessionApprovalAnswer;
      const scope =
        answer.kind === 'permissions'
          ? answer.decision.scope
          : answer.kind === 'computer_app'
            ? answer.decision
            : 'once';
      return {
        primary: allow(scope === 'once' ? tr('Allow once') : scopeLabel(scope), {
          kind: request.kind,
          decision: 'allow',
        }),
        deny,
      };
    }
    case 'computer_app':
      return {
        primary: allow(tr('Allow once'), { kind: request.kind, decision: 'once' }),
        session: { kind: request.kind, decision: 'session' },
        deny,
      };
    case 'service_approval':
    case 'client_capability':
      return { primary: allow(tr('Allow'), { kind: request.kind, decision: 'allow' }), deny };
    default:
      return {};
  }
}
