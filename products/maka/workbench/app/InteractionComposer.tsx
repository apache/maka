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

import { textTooltip } from './ui';
import {
  createText,
  UiError,
  errorText,
  renderText,
  type UiText,
  message as uiMessage,
} from './text';
import { tr } from './locale';
import { cleanup, effect, inputAction, signal, Scroll, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import type { ViewRef } from 'nsh';
import { useHost } from './host';
import { keymap } from 'nsh';
import { windowSize } from 'nsh';
import { Button } from 'nsh/base';
import type {
  InteractionAnswer,
  AgentInteractionRespond,
  AgentInteractionResult,
  HistoryRowPosition,
  InteractionOutcome,
  InteractionQuestion,
  InteractionRecord,
  InteractionRequest,
  Permissions,
  Scope2 as InteractionScope,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  codeTextStyle,
  compact,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  inputBorderRadius,
  inputTextStyle,
  shortcut,
} from './ui';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import { CapabilityRequest, computerCapability } from './CapabilityRequest';
import { FormRequest } from './FormRequest';
import { ComputerAppRequest } from './ComputerAppRequest';
import { computerAppOptions } from './interaction-computer-app';
import {
  formSubmission,
  initialForm,
  utf8Bytes as interactionBytes,
  type FormDraft,
} from './interaction-form';

type InteractionControl = (
  method: 'respond',
  input: AgentInteractionRespond,
) => Promise<AgentInteractionResult>;
type InteractionOwner = { sessionId: string; requestId: string };
type ApprovalSource = Pick<
  Extract<InteractionRequest, { kind: 'service_approval' }>,
  'kind' | 'through' | 'toolUseId' | 'toolName'
>;
function InteractionAction(props: {
  label: string;
  accessibilityLabel?: string;
  onPress: () => void;
  disabled?: boolean;
  selected?: boolean;
  primary?: boolean;
  kind?: 'radio';
  icon?: 'refresh';
  iconOnly?: boolean;
  tooltip?: string;
}) {
  return (
    <Button
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      selected={props.selected}
      onPress={props.onPress}
      tooltip={textTooltip(() => props.tooltip)}
      style={{
        ...controlStyle,
        minWidth: 32,
        paddingHorizontal: props.iconOnly ? 8 : 12,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: props.primary ? C.accent : props.selected ? C.raised : C.surface,
      }}
      hoverStyle={props.primary ? { backgroundColor: C.accentHover } : controlHoverStyle()}
      focusStyle={props.primary ? { backgroundColor: C.accentHover } : controlFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <If when={props.kind}>
        <ChoiceIndicator kind="radio" checked={!!props.selected} disabled={props.disabled} />
      </If>
      <If when={props.icon}>
        <Icon
          name={props.icon!}
          color={props.disabled ? C.muted : props.primary ? C.background : C.secondary}
        />
      </If>
      <If when={!props.iconOnly}>
        <Text
          style={{
            ...bodyTextStyle,
            flexShrink: 1,
            color: props.disabled ? C.muted : props.primary ? C.background : C.text,
            fontWeight: props.primary ? '600' : '400',
          }}
        >
          {props.label}
        </Text>
      </If>
    </Button>
  );
}
function interactionPermissions(value: Permissions): string {
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

export function interactionOutcomeSummary(outcome: InteractionOutcome): UiText {
  if (outcome.kind === 'form_answer')
    return outcome.action === 'accept'
      ? uiMessage('Form submitted · {count} fields', { count: Object.keys(outcome.values).length })
      : outcome.action === 'decline'
        ? uiMessage('Form declined')
        : uiMessage('Form cancelled');
  if (outcome.kind === 'question_answer') return uiMessage('Answers submitted');
  if (outcome.kind === 'permissions_decision')
    return outcome.decision.decision === 'allow'
      ? uiMessage('Access allowed · {scope}', {
          scope: uiMessage(
            outcome.decision.scope === 'once'
              ? 'This call'
              : outcome.decision.scope === 'turn'
                ? 'This turn'
                : 'This session',
          ),
        })
      : uiMessage('Access denied');
  if (outcome.kind === 'service_approval_decision')
    return outcome.decision === 'allow'
      ? uiMessage('Tool call allowed')
      : uiMessage('Tool call denied');
  if (outcome.kind === 'client_capability_decision')
    return outcome.decision === 'allow'
      ? uiMessage('Capability allowed')
      : uiMessage('Capability denied');
  if (outcome.kind === 'computer_app_decision')
    return outcome.decision === 'deny'
      ? uiMessage('Application access denied')
      : uiMessage('Application access allowed · {scope}', {
          scope: uiMessage(
            outcome.decision === 'once'
              ? 'This call'
              : outcome.decision === 'session'
                ? 'This session'
                : 'Always',
          ),
        });
  return uiMessage('Request closed · {reason}', { reason: outcome.reason.replaceAll('_', ' ') });
}

export function InteractionComposer({
  sessionId,
  requestId,
  control,
  focusComposer,
  confirming,
}: {
  sessionId: string;
  requestId: string;
  control: InteractionControl;
  focusComposer(): void;
  confirming(): boolean;
}) {
  const host = useHost();
  const record = signal<InteractionRecord | null>(null);
  const loading = signal(false),
    busy = signal(false),
    uncertain = signal(false);
  const pending = signal(false),
    error = createText();
  const scope = signal<InteractionScope>('once');
  const answers = signal<Array<{ other: boolean; value: string | null | undefined }>>([]);
  const formDrafts = signal<FormDraft[]>([]);
  let originalForm: string | null = null;
  const argumentsText = signal(''),
    argumentTotal = signal<number | null>(null);
  const argumentBusy = signal(false),
    argumentError = createText();
  let argumentPosition: HistoryRowPosition | null = null;
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const request = () => record()?.request;
  const approvalRequest = () => {
    const current = request();
    return current?.kind === 'service_approval' ? current : null;
  };
  const permissionsRequest = () => {
    const current = request();
    return current?.kind === 'permissions' ? current : null;
  };
  const questionRequest = () => {
    const current = request();
    return current?.kind === 'question' ? current : null;
  };
  const formRequest = () => {
    const current = request();
    return current?.kind === 'form' ? current : null;
  };
  const capabilityRequest = () => {
    const current = request();
    return current?.kind === 'client_capability' ? current : null;
  };
  const computerAppRequest = () => {
    const current = request();
    return current?.kind === 'computer_app' ? current : null;
  };
  const sameRecord = (value: InteractionRecord | null | undefined) =>
    value?.sessionId === sessionId && value?.requestId === requestId;
  const ownsAction = (owner: InteractionOwner) =>
    alive && owner.sessionId === sessionId && owner.requestId === requestId;
  const questionIdentity = () => {
    const current = questionRequest();
    return current ? JSON.stringify(current.questions) : null;
  };
  const responseIdentity = () =>
    formRequest() || capabilityRequest() || computerAppRequest() ? JSON.stringify(request()) : null;
  const form = () => formSubmission(formRequest()?.fields ?? [], formDrafts());
  const changeForm = (
    choice: InteractionOwner & {
      requestJSON: string | null;
      index: number;
      change: Partial<FormDraft>;
    },
  ) => {
    if (
      !ownsAction(choice) ||
      blocked() ||
      !formRequest() ||
      choice.requestJSON !== responseIdentity() ||
      !formRequest()!.fields[choice.index]
    )
      return;
    formDrafts.update((current) =>
      current.map((draft, index) =>
        index === choice.index ? { ...draft, ...choice.change } : draft,
      ),
    );
  };
  const formAction = (index: number, change: Partial<FormDraft>) =>
    inputAction(changeForm, {
      sessionId,
      requestId,
      requestJSON: responseIdentity(),
      index,
      change,
    });
  const editForm = (index: number, requestJSON: string, value: string) =>
    changeForm({ sessionId, requestId, requestJSON, index, change: { value } });
  const sourceIdentity = (
    original: ApprovalSource | InteractionRequest | null | undefined = request(),
  ) =>
    original?.kind === 'service_approval'
      ? JSON.stringify({
          kind: original.kind,
          through: original.through,
          toolUseId: original.toolUseId,
          toolName: original.toolName,
        })
      : null;
  const originalPending = async () =>
    (await host.pendingControls()).some(
      (original: any) =>
        original.method === 'respond' &&
        original.sessionId === sessionId &&
        original.correlation?.requestId === requestId,
    );
  const blocked = () =>
    !alive ||
    confirming() ||
    loading() ||
    busy() ||
    uncertain() ||
    !pending() ||
    !!record()?.outcome;
  const completeArguments = () =>
    argumentTotal() !== null && interactionBytes(argumentsText()) === argumentTotal();
  const questionReady = () =>
    questionRequest() !== null &&
    answers().length === questionRequest()!.questions.length &&
    answers().every(
      (part) => part.value === null || (typeof part.value === 'string' && !!part.value.trim()),
    );
  const choose = (index: number, value: string | null | undefined, other = false) => {
    if (!blocked())
      answers.update((current) =>
        current.map((part, i) => (i === index ? { other, value } : part)),
      );
  };
  const chooseRendered = (
    choice: InteractionOwner & {
      index: number;
      questionJSON: string;
      value: string | null;
      other: boolean;
    },
  ) => {
    if (
      !ownsAction(choice) ||
      !questionRequest() ||
      JSON.stringify(questionRequest()!.questions[choice.index]) !== choice.questionJSON
    )
      return;
    choose(choice.index, choice.value, choice.other);
  };
  const chooseScope = (choice: InteractionOwner & { value: InteractionScope }) => {
    if (
      !ownsAction(choice) ||
      blocked() ||
      !permissionsRequest() ||
      (choice.value === 'once' && permissionsRequest()!.toolUseId === null)
    )
      return;
    scope.set(choice.value);
  };
  const readArguments = async (original: ApprovalSource | null = approvalRequest()) => {
    if (
      !alive ||
      argumentBusy() ||
      completeArguments() ||
      original?.kind !== 'service_approval' ||
      sourceIdentity(original) !== sourceIdentity()
    )
      return;
    argumentBusy.set(true);
    argumentError.set('');
    const offset = interactionBytes(argumentsText());
    try {
      const page = await host.query('agent', 'source', {
        sessionId,
        through: original.through,
        source: { kind: 'tool_use', toolUseId: original.toolUseId },
        field: 'arguments',
        position: offset === 0 ? { kind: 'start' } : { kind: 'after', offset },
      });
      if (!alive || sourceIdentity(original) !== sourceIdentity()) return;
      const source = page.source,
        call = source?.tool?.call;
      const equalPosition = (
        a: HistoryRowPosition | null | undefined,
        b: HistoryRowPosition | null | undefined,
      ) => !!a && !!b && a.sourceSequence === b.sourceSequence && a.itemIndex === b.itemIndex;
      const end = offset + interactionBytes(source?.text ?? '');
      if (
        page.kind !== 'ready' ||
        page.through !== original.through ||
        source?.field !== 'arguments' ||
        source.format !== 'json' ||
        source.path != null ||
        source.offset !== offset ||
        source.tool?.toolUseId !== original.toolUseId ||
        !call ||
        call.name !== original.toolName ||
        !equalPosition(source.position, call.position) ||
        (argumentPosition && !equalPosition(source.position, argumentPosition)) ||
        (argumentTotal() !== null && source.totalBytes !== argumentTotal()) ||
        end > source.totalBytes ||
        (end === offset && end !== source.totalBytes)
      ) {
        throw new UiError(
          'The original call arguments could not be verified. Allow remains disabled.',
        );
      }
      argumentPosition = source.position;
      argumentTotal.set(source.totalBytes);
      argumentsText.set(argumentsText() + source.text);
    } catch (reason) {
      if (alive) argumentError.set(errorText(reason));
    } finally {
      if (alive) {
        argumentBusy.set(false);
        if (!completeArguments() && !argumentError()) void readArguments(original);
      }
    }
  };
  const readRenderedArguments = (owner: InteractionOwner & { sourceJSON: string | null }) => {
    if (!ownsAction(owner) || owner.sourceJSON === null || owner.sourceJSON !== sourceIdentity())
      return;
    void readArguments(JSON.parse(owner.sourceJSON));
  };
  const refresh = async () => {
    if (!alive || loading() || busy()) return;
    loading.set(true);
    error.set('');
    try {
      const [canonical, list, unresolved] = await Promise.all([
        host.query('agent', 'interaction', { sessionId, requestId }),
        host.query('agent', 'pendingInteractions', { sessionId }),
        originalPending(),
      ]);
      if (!alive) return;
      if (!sameRecord(canonical)) throw new UiError('The Host returned a different request.');
      record.set(canonical);
      uncertain.set(unresolved);
      pending.set(list.entries.some((entry) => entry.requestId === requestId));
      if (
        canonical.request.kind === 'permissions' &&
        canonical.request.toolUseId === null &&
        scope() === 'once'
      )
        scope.set('turn');
      if (canonical.request.kind === 'question' && answers().length === 0) {
        answers.set(canonical.request.questions.map(() => ({ other: false, value: undefined })));
      }
      if (
        canonical.request.kind === 'form' &&
        !canonical.outcome &&
        originalForm !== JSON.stringify(canonical.request)
      ) {
        originalForm = JSON.stringify(canonical.request);
        formDrafts.set(initialForm(canonical.request.fields));
      }
      if (canonical.request.kind === 'form' && canonical.outcome) formDrafts.set([]);
      if (canonical.request.kind === 'service_approval' && !canonical.outcome)
        void readArguments(canonical.request);
    } catch (reason) {
      if (alive) {
        uncertain.set(true);
        error.set(errorText(reason));
      }
    } finally {
      if (alive) loading.set(false);
    }
  };
  const refreshRendered = (owner: InteractionOwner) => {
    if (ownsAction(owner)) void refresh();
  };
  const respond = async (answer: InteractionAnswer) => {
    if (
      blocked() ||
      (answer.kind !== request()?.kind &&
        !(answer.kind === 'computer_app_cancel' && computerAppRequest()))
    )
      return;
    busy.set(true);
    error.set('');
    try {
      const result = await control('respond', { sessionId, requestId, answer });
      if (!alive) return;
      if (result?.kind === 'recorded' && sameRecord(result.record) && result.record.outcome) {
        // This is the canonical winner, which can differ from our answer.
        record.set(result.record);
        pending.set(false);
        if (result.record.request.kind === 'form') formDrafts.set([]);
      } else if (result?.kind === 'rejected') {
        error.set(
          uiMessage('Answer was not accepted: {reason}. Refresh the request before trying again.', {
            reason: result.reason,
          }),
        );
        pending.set(false);
      } else {
        uncertain.set(true);
        error.set(
          uiMessage(
            'Answer status is unknown. Recover its original receipt in the main view; do not submit again.',
          ),
        );
      }
    } catch (reason) {
      let unresolved = true;
      try {
        unresolved = await originalPending();
      } catch {
        /* Unknown receipt state stays blocked. */
      }
      if (alive) {
        uncertain.set(unresolved);
        error.set(
          unresolved
            ? uiMessage(
                'Answer status is unknown. Recover its original receipt in the main view. {reason}',
                { reason: errorText(reason) },
              )
            : errorText(reason),
        );
      }
    } finally {
      if (alive) busy.set(false);
    }
  };
  const submissionAnswer = (): InteractionAnswer | null => {
    const current = request();
    if (!current) return null;
    if (current.kind === 'service_approval') {
      if (completeArguments() && !argumentBusy() && !argumentError())
        return { kind: current.kind, decision: 'allow' };
    } else if (current.kind === 'permissions') {
      if (scope() === 'once' && current.toolUseId === null) return null;
      return {
        kind: current.kind,
        decision: { decision: 'allow', scope: scope(), permissions: current.request.permissions },
      };
    } else if (current.kind === 'question') {
      if (questionReady())
        return { kind: 'question', answers: answers().map((part) => part.value as string | null) };
    } else if (current.kind === 'form') {
      return form().answer;
    } else if (current.kind === 'client_capability' && computerCapability(current)) {
      return { kind: 'client_capability', decision: 'allow' };
    } else if (current.kind === 'computer_app') {
      return { kind: 'computer_app', decision: 'once' };
    }
    return null;
  };
  const submit = () => {
    if (blocked()) return;
    if (request()?.kind === 'question' && !questionReady()) {
      error.set(uiMessage('Answer every question or explicitly choose Skip.'));
      return;
    }
    if (request()?.kind === 'form' && !form().answer) {
      error.set(uiMessage('Complete the included fields before submitting.'));
      return;
    }
    const answer = submissionAnswer();
    if (answer) void respond(answer);
  };
  const denialAnswer = (): InteractionAnswer | null => {
    const kind = request()?.kind;
    if (kind === 'service_approval') return { kind, decision: 'deny' };
    if (kind === 'permissions') return { kind, decision: { decision: 'deny' } };
    if (kind === 'form') return { kind, action: 'decline' };
    if (kind === 'client_capability' && computerCapability(capabilityRequest()!))
      return { kind, decision: 'deny' };
    if (kind === 'computer_app') return { kind, decision: 'deny' };
    return null;
  };
  const deny = () => {
    const answer = denialAnswer();
    if (answer) void respond(answer);
  };
  const respondRendered = (
    rendered: InteractionOwner & {
      answerJSON: string;
      questionsJSON: string | null;
      sourceJSON: string | null;
      requestJSON: string | null;
    },
  ) => {
    if (!ownsAction(rendered) || blocked()) return;
    const answer = JSON.parse(rendered.answerJSON) as InteractionAnswer | null;
    if (
      !answer ||
      (answer.kind !== request()?.kind &&
        !(answer.kind === 'computer_app_cancel' && computerAppRequest()))
    )
      return;
    if (answer.kind === 'question' && rendered.questionsJSON !== questionIdentity()) return;
    if (answer.kind === 'service_approval' && rendered.sourceJSON !== sourceIdentity()) return;
    if (
      ['form', 'client_capability', 'computer_app', 'computer_app_cancel'].includes(answer.kind) &&
      rendered.requestJSON !== responseIdentity()
    )
      return;
    if (
      answer.kind === 'computer_app' &&
      !computerAppOptions(computerAppRequest()!).some(
        (option) => JSON.stringify(option.answer) === rendered.answerJSON,
      )
    )
      return;
    if (
      (answer.kind === 'question' ||
        (answer.kind === 'permissions' && answer.decision.decision === 'allow') ||
        (answer.kind === 'form' && answer.action === 'accept') ||
        (answer.kind === 'client_capability' && answer.decision === 'allow') ||
        (answer.kind === 'service_approval' && answer.decision === 'allow')) &&
      rendered.answerJSON !== JSON.stringify(submissionAnswer())
    )
      return;
    // Current state can reject a stale answer; only the presented answer is sent.
    void respond(answer);
  };
  const answerBinding = (answer: InteractionAnswer | null) =>
    inputAction(respondRendered, {
      sessionId,
      requestId,
      answerJSON: JSON.stringify(answer),
      questionsJSON: questionIdentity(),
      sourceJSON: sourceIdentity(),
      requestJSON: responseIdentity(),
    });
  let unbindKeys = () => {};
  cleanup(() => unbindKeys());
  const attach = (node: ViewRef) => {
    unbindKeys();
    const bindings = [
      keymap.bind('mod+enter', submit, { when: 'always', within: node }),
      keymap.bind('mod+r', () => void refresh(), { when: 'always', within: node }),
      keymap.bind('d', deny, { when: 'notEditing', within: node }),
      keymap.bind(
        'escape',
        () => {
          if (alive) focusComposer();
        },
        { when: 'always', within: node },
      ),
    ];
    unbindKeys = () => bindings.forEach((remove) => remove());
  };
  // Start once after construction, without tracking refresh's loading guards
  // as effect dependencies (which would create a request loop).
  effect(() => {
    void Promise.resolve().then(() => {
      if (alive) void refresh();
    });
  });
  const title = () => {
    const current = request();
    return current
      ? {
          service_approval: tr('Review tool call'),
          permissions: tr('Review additional access'),
          question: 'A question for you',
          form: tr('Form request'),
          client_capability: tr('Capability request'),
          computer_app: tr('Application access request'),
        }[current.kind]
      : tr('Review request');
  };
  return (
    <View
      ref={attach}
      accessibilityLabel={tr('Pending request')}
      style={{
        minHeight: 0,
        flexShrink: 1,
        paddingBottom: 8,
      }}
    >
      <View
        style={{
          minHeight: 0,
          flexShrink: 1,
          backgroundColor: C.surface,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: C.line,
        }}
      >
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: C.line,
            flexShrink: 0,
          }}
        >
          <If when={approvalRequest() || permissionsRequest() || capabilityRequest()}>
            <Icon name="shield" color={C.secondary} />
          </If>
          <Text style={{ ...bodyTextStyle, flex: 1, color: C.text, fontWeight: '600' }}>
            {title()}
          </Text>
        </View>
        <Scroll
          accessibilityLabel={tr('Request content')}
          style={{ flexShrink: 1, minHeight: 0, maxHeight: 336 }}
          contentStyle={{ padding: 16, gap: 16 }}
        >
          <If when={!record()}>
            <Text style={{ ...bodyTextStyle, color: C.muted }}>
              {loading() ? tr('Reading the original request…') : tr('Request not available.')}
            </Text>
          </If>
          <If
            when={record()?.outcome}
            else={
              <View style={{ gap: 16 }}>
                <If when={request()?.kind === 'service_approval'}>
                  <View style={{ gap: 4 }}>
                    <Text
                      style={[
                        { ...bodyTextStyle, color: C.text, fontWeight: '600' },
                        { userSelect: 'text' },
                      ]}
                    >
                      {approvalRequest()?.toolName}
                    </Text>
                    <Text style={[{ ...codeTextStyle, color: C.muted }, { userSelect: 'text' }]}>
                      {`${approvalRequest()?.service}.${approvalRequest()?.method}`}
                    </Text>
                  </View>
                  <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                    {tr(
                      'Approve this original call only. This does not grant access to future calls.',
                    )}
                  </Text>
                  <View
                    style={{ gap: 8, padding: 12, backgroundColor: C.background, borderRadius: 8 }}
                  >
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {tr('Original arguments')}
                    </Text>
                    <Text style={[{ ...codeTextStyle, color: C.text }, { userSelect: 'text' }]}>
                      {argumentsText()}
                    </Text>
                  </View>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>
                    {completeArguments()
                      ? tr('Complete original arguments loaded.')
                      : tr('{loaded} of {total} argument bytes loaded. Read all before allowing.', {
                          loaded: interactionBytes(argumentsText()),
                          total: argumentTotal() ?? '?',
                        })}
                  </Text>
                  <If when={argumentError()}>
                    <InteractionAction
                      label={tr('Retry original arguments')}
                      icon="refresh"
                      disabled={argumentBusy()}
                      onPress={inputAction(readRenderedArguments, {
                        sessionId,
                        requestId,
                        sourceJSON: sourceIdentity(),
                      })}
                    />
                    <Text style={{ ...bodyTextStyle, color: C.danger }}>{argumentError()}</Text>
                  </If>
                </If>
                <If when={request()?.kind === 'permissions'}>
                  <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
                    {permissionsRequest()?.request.reason}
                  </Text>
                  <If when={permissionsRequest()?.request.command}>
                    <View
                      style={{
                        gap: 8,
                        padding: 12,
                        backgroundColor: C.background,
                        borderRadius: 8,
                      }}
                    >
                      <Text style={[{ ...codeTextStyle, color: C.text }, { userSelect: 'text' }]}>
                        {permissionsRequest()?.request.command?.command}
                      </Text>
                      <Text
                        style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}
                      >
                        {tr('Working directory: {path}', {
                          path: permissionsRequest()?.request.command?.cwd ?? '',
                        })}
                      </Text>
                    </View>
                  </If>
                  <View style={{ gap: 8 }}>
                    <Text style={{ ...captionTextStyle, color: C.muted }}>
                      {tr('Requested access')}
                    </Text>
                    <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
                      {permissionsRequest()
                        ? interactionPermissions(permissionsRequest()!.request.permissions)
                        : ''}
                    </Text>
                  </View>
                  <View style={{ gap: 8 }}>
                    <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                      {tr('Allow exactly these paths and network destinations for:')}
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                      <Each
                        of={
                          permissionsRequest()?.toolUseId === null
                            ? ['turn', 'session']
                            : ['once', 'turn', 'session']
                        }
                      >
                        {(duration) => (
                          <InteractionAction
                            label={
                              duration() === 'once'
                                ? tr('This call')
                                : duration() === 'turn'
                                  ? tr('This turn')
                                  : tr('This session')
                            }
                            kind="radio"
                            disabled={blocked()}
                            selected={scope() === duration()}
                            onPress={inputAction(chooseScope, {
                              sessionId,
                              requestId,
                              value: duration() as InteractionScope,
                            })}
                          />
                        )}
                      </Each>
                    </View>
                  </View>
                </If>
                <If when={request()?.kind === 'question'}>
                  <Each<InteractionQuestion> of={questionRequest()?.questions ?? []} key="index">
                    {(question, index) => (
                      <View style={{ gap: 8 }}>
                        <Text
                          style={[
                            { ...bodyTextStyle, color: C.text, fontWeight: '600' },
                            { userSelect: 'text' },
                          ]}
                        >{`${index() + 1}. ${question().question}`}</Text>
                        <Each of={question().options} key="index">
                          {(option) => (
                            <Button
                              accessibilityLabel={`${option().label} · ${index() + 1}. ${question().question}`}
                              disabled={blocked()}
                              selected={answers()[index()]?.value === option().label}
                              onPress={inputAction(chooseRendered, {
                                sessionId,
                                requestId,
                                index: index(),
                                questionJSON: JSON.stringify(question()),
                                value: option().label,
                                other: false,
                              })}
                              style={{
                                ...controlStyle,
                                flexDirection: 'row',
                                alignItems: 'flex-start',
                                justifyContent: 'flex-start',
                                gap: 12,
                                backgroundColor:
                                  answers()[index()]?.value === option().label
                                    ? C.raised
                                    : C.surface,
                              }}
                              hoverStyle={controlHoverStyle()}
                              focusStyle={controlFocusStyle()}
                              disabledStyle={controlDisabledStyle}
                            >
                              <ChoiceIndicator
                                kind="radio"
                                checked={answers()[index()]?.value === option().label}
                                disabled={blocked()}
                              />
                              <View
                                style={[
                                  { flex: 1, minWidth: 0, gap: 4 },
                                  { pointerEvents: 'none' },
                                ]}
                              >
                                <Text
                                  style={{ ...bodyTextStyle, color: blocked() ? C.muted : C.text }}
                                >
                                  {option().label}
                                </Text>
                                <If when={option().description}>
                                  <Text style={{ ...bodyTextStyle, color: C.muted }}>
                                    {option().description}
                                  </Text>
                                </If>
                              </View>
                            </Button>
                          )}
                        </Each>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                          <InteractionAction
                            label={tr('Other answer')}
                            accessibilityLabel={`${tr('Other answer {number}', { number: index() + 1 })} · ${question().question}`}
                            kind="radio"
                            disabled={blocked()}
                            selected={answers()[index()]?.other}
                            onPress={inputAction(chooseRendered, {
                              sessionId,
                              requestId,
                              index: index(),
                              questionJSON: JSON.stringify(question()),
                              value: '',
                              other: true,
                            })}
                          />
                          <InteractionAction
                            label={tr('Skip')}
                            accessibilityLabel={`${tr('Skip')} · ${index() + 1}. ${question().question}`}
                            kind="radio"
                            disabled={blocked()}
                            selected={answers()[index()]?.value === null}
                            onPress={inputAction(chooseRendered, {
                              sessionId,
                              requestId,
                              index: index(),
                              questionJSON: JSON.stringify(question()),
                              value: null,
                              other: false,
                            })}
                          />
                        </View>
                        <If when={answers()[index()]?.other}>
                          <Input
                            accessibilityLabel={tr('Other answer {number}', {
                              number: index() + 1,
                            })}
                            value={String(answers()[index()]?.value ?? '')}
                            readonly={blocked()}
                            placeholder={tr('Your answer')}
                            onChange={({ value }) => choose(index(), value, true)}
                            style={{
                              ...inputTextStyle,
                              placeholderColor: C.muted,
                              height: compact() ? 32 : 40,
                              paddingHorizontal: 12,
                              paddingVertical: compact() ? 4 : 8,
                              color: C.text,
                              backgroundColor: C.background,
                              borderRadius: inputBorderRadius,
                              borderWidth: 1,
                              borderColor: C.line,
                            }}
                            focusStyle={{ borderColor: C.accent }}
                          />
                        </If>
                      </View>
                    )}
                  </Each>
                </If>
                <If when={request()?.kind === 'form'}>
                  <FormRequest
                    request={formRequest()!}
                    drafts={formDrafts()}
                    problems={form().problems}
                    blocked={blocked()}
                    action={formAction}
                    edit={editForm}
                  />
                </If>
                <If when={request()?.kind === 'client_capability'}>
                  <CapabilityRequest request={capabilityRequest()!} sessionId={sessionId} />
                </If>
                <If when={computerAppRequest()}>
                  <ComputerAppRequest request={computerAppRequest()!} />
                </If>
              </View>
            }
          >
            <View style={{ gap: 8 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name="check" color={C.accent} />
                <Text
                  style={[
                    {
                      ...bodyTextStyle,
                      flex: 1,
                      minWidth: 0,
                      color: C.text,
                      fontWeight: '600',
                    },
                    { userSelect: 'text' },
                  ]}
                >
                  {record()?.outcome
                    ? renderText(interactionOutcomeSummary(record()!.outcome!))
                    : ''}
                </Text>
              </View>
            </View>
          </If>
          <If when={error()}>
            <Text style={[{ ...bodyTextStyle, color: C.danger }, { userSelect: 'text' }]}>
              {error()}
            </Text>
          </If>
          <If when={uncertain() && !record()?.outcome}>
            <Text style={{ ...bodyTextStyle, color: C.warning }}>
              {tr(
                'An original answer receipt is unresolved. Refresh is read-only; further answers stay disabled.',
              )}
            </Text>
          </If>
          <If when={request()?.kind === 'question' && !record()?.outcome && !questionReady()}>
            <Text style={{ ...captionTextStyle, color: C.muted }}>
              {tr('Choose an option, write another answer, or skip each question.')}
            </Text>
          </If>
          <If when={record() && !record()!.outcome && !pending() && !loading()}>
            <Text style={{ ...bodyTextStyle, color: C.warning }}>
              {tr(
                'This request is no longer listed as pending. Refresh to read its canonical outcome.',
              )}
            </Text>
          </If>
        </Scroll>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: C.line,
            flexShrink: 0,
          }}
        >
          <InteractionAction
            label={tr('Refresh status')}
            icon="refresh"
            iconOnly={windowSize().width < 720}
            tooltip={shortcut(tr('Refresh status'), 'mod+r')}
            disabled={loading() || busy()}
            onPress={inputAction(refreshRendered, { sessionId, requestId })}
          />
          <View
            style={{
              flex: 1,
              flexDirection: 'row',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              gap: 8,
            }}
          >
            <If when={computerAppRequest() && !record()?.outcome}>
              <InteractionAction
                label={tr('Cancel request')}
                disabled={blocked()}
                onPress={answerBinding({ kind: 'computer_app_cancel' })}
              />
              <Each of={computerAppOptions(computerAppRequest()!)}>
                {(option) => (
                  <InteractionAction
                    label={renderText(option().label)}
                    primary={option().answer.decision === 'once'}
                    disabled={blocked()}
                    onPress={answerBinding(option().answer)}
                  />
                )}
              </Each>
            </If>
            <If when={request()?.kind === 'form' && !record()?.outcome}>
              <InteractionAction
                label={tr('Cancel request')}
                disabled={blocked()}
                onPress={answerBinding({ kind: 'form', action: 'cancel' })}
              />
              <InteractionAction
                label={tr('Decline')}
                tooltip={tr('Decline · D')}
                disabled={blocked()}
                onPress={answerBinding(denialAnswer())}
              />
            </If>
            <If
              when={
                !record()?.outcome &&
                (approvalRequest() ||
                  permissionsRequest() ||
                  (capabilityRequest() && computerCapability(capabilityRequest()!)))
              }
            >
              <InteractionAction
                label={tr('Deny')}
                tooltip={tr('Deny · D')}
                disabled={blocked()}
                onPress={answerBinding(denialAnswer())}
              />
            </If>
            <If
              when={
                !record()?.outcome &&
                (approvalRequest() ||
                  permissionsRequest() ||
                  questionRequest() ||
                  formRequest() ||
                  (capabilityRequest() && computerCapability(capabilityRequest()!)))
              }
            >
              <InteractionAction
                primary
                tooltip={
                  request()?.kind === 'form'
                    ? shortcut(tr('Submit form'), 'mod+enter')
                    : request()?.kind === 'question'
                      ? shortcut(tr('Submit answers'), 'mod+enter')
                      : shortcut(tr('Allow'), 'mod+enter')
                }
                label={
                  busy()
                    ? tr('Recording answer…')
                    : request()?.kind === 'form'
                      ? tr('Submit form')
                      : request()?.kind === 'question'
                        ? tr('Submit answers')
                        : tr('Allow')
                }
                disabled={
                  blocked() ||
                  (request()?.kind === 'question' && !questionReady()) ||
                  (request()?.kind === 'form' && !form().answer) ||
                  (request()?.kind === 'service_approval' &&
                    (!completeArguments() || argumentBusy() || !!argumentError()))
                }
                onPress={answerBinding(submissionAnswer())}
              />
            </If>
          </View>
        </View>
      </View>
    </View>
  );
}
