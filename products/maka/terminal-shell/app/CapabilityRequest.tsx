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

import { tr } from './locale';
import { Text, View } from 'nsh';
import type { InteractionRequest } from '../../../../packages/plugin-sdk/src/generated/runtime';
import { Icon } from './Icon';
import { bodyTextStyle, C, captionTextStyle, codeTextStyle } from './ui';

type Request = Extract<InteractionRequest, { kind: 'client_capability' }>;
// The Agent's response gate accepts this exact producer-owned Computer target.
// It never turns a generic capability request into a broad client grant.
export function computerCapability(request: Request): boolean {
  const target = request.target;
  const basis = request.basis;
  const binding = basis?.binding;
  if (!basis || !binding) return false;
  return (
    Number.isSafeInteger(basis.boundaryRevision) &&
    basis.boundaryRevision >= 0 &&
    typeof binding.id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(binding.id) &&
    binding.id !== '00000000-0000-0000-0000-000000000000' &&
    Number.isSafeInteger(binding.permissionEpoch) &&
    binding.permissionEpoch >= 0 &&
    target.providerId === 'maka_workspace_computer' &&
    target.contractId === 'maka_workspace_computer_v1' &&
    target.serverId === 'maka_workspace_computer' &&
    target.toolName === 'cua_repl' &&
    target.capability === 'computer_use' &&
    target.scope.kind === 'capability'
  );
}
export function CapabilityRequest(props: { request: Request; sessionId: string }) {
  return (
    <View style={{ gap: 16 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 12,
          padding: 16,
          backgroundColor: C.raised,
          borderRadius: 12,
        }}
      >
        <Icon name="shield" color={C.warning} />
        <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
          <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
            {computerCapability(props.request)
              ? tr('Computer access for this session')
              : tr('Requested client capability')}
          </Text>
          <Text selectable style={{ ...codeTextStyle, color: C.secondary }}>
            {tr('{tool} · Permission boundary: {revision}', {
              tool: props.request.target.toolName,
              revision: props.request.basis?.boundaryRevision ?? tr('unavailable'),
            })}
          </Text>
          <If when={computerCapability(props.request)}>
            <Text selectable style={{ ...bodyTextStyle, color: C.secondary }}>
              {tr(
                "This allows the requesting tool to inspect and control the local computer, including screenshots, keyboard and pointer actions. The grant lasts for this session's current permission boundary.",
              )}
            </Text>
          </If>
        </View>
      </View>
      <View style={{ gap: 8 }}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Scope')}</Text>
        <Text selectable style={{ ...bodyTextStyle, color: C.secondary }}>
          {props.request.target.scope.kind === 'browser_origin'
            ? tr('Browser origin: {origin}', { origin: props.request.target.scope.origin })
            : props.request.target.scope.kind === 'mcp_tool'
              ? tr('Only {server} · {tool}', {
                  server: props.request.target.scope.serverId,
                  tool: props.request.target.scope.toolName,
                })
              : tr('Applies to this capability within the current permission boundary.')}
        </Text>
      </View>
      <If when={!computerCapability(props.request)}>
        <Text style={{ ...bodyTextStyle, color: C.warning }}>
          {tr(
            'This Host cannot answer the requested capability. The original request remains pending.',
          )}
        </Text>
      </If>
      <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 16 }}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Request details')}</Text>
        <Each
          of={[
            [tr('Session'), props.sessionId],
            [tr('Provider'), props.request.target.providerId],
            [tr('Contract'), props.request.target.contractId],
            [tr('Server'), props.request.target.serverId],
            [tr('Tool'), props.request.target.toolName],
            [tr('Capability'), props.request.target.capability],
            [tr('Scope'), JSON.stringify(props.request.target.scope)],
            [
              tr('Permission boundary'),
              String(props.request.basis?.boundaryRevision ?? tr('unavailable')),
            ],
          ]}
        >
          {(detail) => (
            <Text selectable style={{ ...codeTextStyle, color: C.secondary }}>
              {`${detail()[0]}: ${detail()[1]}`}
            </Text>
          )}
        </Each>
      </View>
    </View>
  );
}
