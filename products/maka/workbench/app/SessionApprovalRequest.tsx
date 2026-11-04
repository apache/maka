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
  InteractionAnswer,
  InteractionRecord,
  Permissions,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { CapabilityRequest } from './CapabilityRequest';
import { ComputerAppRequest } from './ComputerAppRequest';
import { SystemPermissionRequest } from './SystemPermissionRequest';
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

function decisionSummary(answer: InteractionAnswer): string {
  switch (answer.kind) {
    case 'session_approval':
      return answer.decision === 'allow' ? tr('Approve child decision') : tr('Deny child decision');
    case 'service_approval':
      return answer.decision === 'allow' ? tr('Tool call allowed') : tr('Tool call denied');
    case 'permissions':
      return answer.decision.decision === 'deny'
        ? tr('Access denied')
        : tr('Access allowed · {scope}', {
            scope:
              answer.decision.scope === 'once'
                ? tr('This call')
                : answer.decision.scope === 'turn'
                  ? tr('This turn')
                  : tr('This session'),
          });
    case 'client_capability':
      return answer.decision === 'allow' ? tr('Capability allowed') : tr('Capability denied');
    case 'computer_app':
      return answer.decision === 'deny'
        ? tr('Application access denied')
        : tr('Application access allowed · {scope}', {
            scope:
              answer.decision === 'once'
                ? tr('This call')
                : answer.decision === 'session'
                  ? tr('This session')
                  : tr('Always'),
          });
    case 'computer_app_cancel':
    case 'system_permission_cancel':
      return tr('Cancel request');
    case 'question':
      return tr('Answers submitted');
    case 'form':
      return answer.action === 'accept'
        ? tr('Submit form')
        : answer.action === 'decline'
          ? tr('Form declined')
          : tr('Form cancelled');
  }
}

export function SessionApprovalRequest(props: {
  child: InteractionRecord;
  answer: InteractionAnswer;
}) {
  const request = props.child.request;
  const answer = props.answer;
  const capability = request.kind === 'client_capability' ? request : null;
  const computerApp = request.kind === 'computer_app' ? request : null;
  const systemPermission = request.kind === 'system_permission' ? request : null;
  const question = request.kind === 'question' ? request : null;
  const form = request.kind === 'form' ? request : null;
  const questionAnswer = answer.kind === 'question' ? answer : null;
  const formAnswer = answer.kind === 'form' && answer.action === 'accept' ? answer : null;
  return (
    <View style={{ gap: 16 }}>
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
      <If when={systemPermission}>
        <SystemPermissionRequest request={systemPermission!} canLocate={false} />
      </If>
      <If when={question}>
        <Each of={question?.questions ?? []}>
          {(item) => (
            <View style={{ gap: 4 }}>
              <Text style={{ ...bodyTextStyle, color: C.text }}>{item().question}</Text>
              <Each of={item().options}>
                {(option) => (
                  <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                    {option().label}
                    {option().description ? ' — ' + option().description : ''}
                  </Text>
                )}
              </Each>
            </View>
          )}
        </Each>
      </If>
      <If when={form}>
        <Text style={{ ...captionTextStyle, color: C.secondary }}>
          {form?.requester.name}
          {form?.requester.source ? ' · ' + form.requester.source : ''}
        </Text>
        <Text style={{ ...bodyTextStyle, color: C.text }}>{form?.message}</Text>
        <Each of={form?.fields ?? []}>
          {(field) => (
            <View style={{ gap: 4 }}>
              <Text style={{ ...bodyTextStyle, color: C.text }}>{field().label}</Text>
              <If when={field().description}>
                <Text style={{ ...bodyTextStyle, color: C.secondary }}>{field().description}</Text>
              </If>
            </View>
          )}
        </Each>
      </If>
      <If when={request.kind === 'session_approval'}>
        <Text style={{ ...bodyTextStyle, color: C.warning }}>
          {tr('Open the child conversation to review its delegated request.')}
        </Text>
      </If>
      <View style={{ gap: 8, padding: 12, backgroundColor: C.background, borderRadius: 8 }}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Proposed child decision')}</Text>
        <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
          {decisionSummary(answer)}
        </Text>
        <If when={answer.kind === 'permissions' && answer.decision.decision === 'allow'}>
          <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
            {answer.kind === 'permissions' && answer.decision.decision === 'allow'
              ? interactionPermissions(answer.decision.permissions)
              : ''}
          </Text>
        </If>
        <Each of={question?.questions ?? []}>
          {(item, index) => (
            <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
              {item().question}
              {'\n'}
              {questionAnswer?.answers[index()] ?? tr('Skip')}
            </Text>
          )}
        </Each>
        <Each of={form?.fields ?? []}>
          {(field) => {
            const value = formAnswer?.values[field().name];
            const display = Array.isArray(value)
              ? value.join(', ')
              : value === undefined
                ? tr('Not included')
                : String(value);
            return (
              <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
                {field().label}
                {': '}
                {display}
              </Text>
            );
          }}
        </Each>
      </View>
      <If when={request.kind === 'system_permission'}>
        <Text style={{ ...bodyTextStyle, color: C.warning }}>
          {tr(
            'Only the proposed cancellation can be confirmed here. System access is granted in OS settings.',
          )}
        </Text>
      </If>
      <If when={props.child.outcome}>
        <Text style={{ ...bodyTextStyle, color: C.warning }}>
          {tr('The child request is already closed. Refresh the parent request.')}
        </Text>
      </If>
    </View>
  );
}
