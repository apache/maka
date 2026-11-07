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

import { Text, View } from 'nsh';
import type {
  SessionApprovalAnswer,
  InteractionRecord,
  Permissions,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { CapabilityRequest } from './CapabilityRequest';
import { ComputerAppRequest } from './ComputerAppRequest';
import { tr } from './locale';
import { bodyTextStyle, C, captionTextStyle } from './ui';

export function interactionPermissions(value: Permissions): string {
  const paths = value.filesystem.map(
    (rule) =>
      `${tr(rule.access === 'write' ? 'Read/write' : 'Read')} · ${tr(rule.scope === 'exact' ? 'this exact path' : 'path and descendants')}\n  ${rule.path}`,
  );
  const network =
    value.network === 'allowed'
      ? tr('Network: all destinations')
      : value.network === 'denied'
        ? tr('Network: no additional access')
        : `${tr('Network: listed destinations only')}\n${value.network.restricted.destinations.map((target) => `  ${target.host}:${target.port}`).join('\n')}`;
  return [...(paths.length ? paths : [tr('Filesystem: no additional access')]), network].join(
    '\n\n',
  );
}

function decisionSummary(answer: SessionApprovalAnswer): string {
  switch (answer.kind) {
    case 'service_approval':
      return tr('Tool call allowed');
    case 'permissions':
      return tr('Access allowed · {scope}', {
        scope:
          answer.decision.scope === 'once'
            ? tr('This call')
            : answer.decision.scope === 'turn'
              ? tr('This turn')
              : tr('This session'),
      });
    case 'client_capability':
      return tr('Capability allowed');
    case 'computer_app':
      return tr('Application access allowed · {scope}', {
        scope:
          answer.decision === 'once'
            ? tr('This call')
            : answer.decision === 'session'
              ? tr('This session')
              : tr('Always'),
      });
  }
}

export function SessionApprovalRequest(props: {
  child: InteractionRecord;
  answer: SessionApprovalAnswer;
}) {
  const request = props.child.request;
  const answer = props.answer;
  const capability = request.kind === 'client_capability' ? request : null;
  const computerApp = request.kind === 'computer_app' ? request : null;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 8, padding: 12, backgroundColor: C.panel, borderRadius: 8 }}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Proposed child decision')}</Text>
        <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
          {decisionSummary(answer)}
        </Text>
        <If when={answer.kind === 'permissions'}>
          <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
            {answer.kind === 'permissions'
              ? interactionPermissions(answer.decision.permissions)
              : ''}
          </Text>
        </If>
      </View>
      <If when={capability}>
        <CapabilityRequest
          request={capability!}
          sessionId={props.child.sessionId}
          showSessionId={false}
        />
      </If>
      <If when={computerApp}>
        <ComputerAppRequest request={computerApp!} />
      </If>
      <If when={props.child.outcome}>
        <Text style={{ ...bodyTextStyle, color: C.warning }}>
          {tr('The child request is already closed. Refresh the parent request.')}
        </Text>
      </If>
    </View>
  );
}
