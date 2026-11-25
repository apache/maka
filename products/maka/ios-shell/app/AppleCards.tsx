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

import { signal, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { token } from 'nsh';
import { type MessageKey, tr } from './locale';

export type PermissionAction =
  | 'once'
  | 'run'
  | 'session'
  | 'always'
  | 'deny'
  | 'cancel_system_permission';

export type PermissionCardMode = 'permissions' | 'computer_app' | 'binary' | 'unsupported';

export interface PermissionCardItem {
  id: string;
  requestId?: string;
  interactionKind?: string;
  mode: PermissionCardMode;
  title: string;
  subtitle: string;
  command: () => string;
  /** Original grant::Permissions object required by PermissionDecision::Allow. */
  requestedPermissions?: Record<string, unknown>;
  /** True when the request is bound to a specific toolUseId so PermissionScope::Once is legal. */
  canAllowOnce?: boolean;
  allowBlocked?: boolean;
  allowAlways?: boolean;
  unsupportedNotice?: string;
  resolved?: {
    allowed: boolean;
    label: MessageKey;
  };
}

export interface QuestionOptionItem {
  id: string;
  label: string;
  description?: string;
}

export interface SingleQuestionItem {
  id: string;
  index: number;
  prompt: string;
  options: QuestionOptionItem[];
}

export interface QuestionCardItem {
  id: string;
  requestId?: string;
  questions: SingleQuestionItem[];
  answered?: (string | null)[];
}

export interface TurnStepItem {
  id: string;
  kind: 'thinking' | 'edit' | 'command' | 'read';
  title: string;
  detail?: string;
  additions?: number;
  deletions?: number;
  diffPath?: string;
}

export function ApplePermissionCard(props: {
  item: () => PermissionCardItem;
  busy?: () => boolean;
  onDecide: (decision: PermissionAction) => void;
}) {
  const resolved = () => props.item().resolved;
  const primaryLabel = () =>
    props.item().interactionKind === 'session_approval'
      ? tr('Approve child decision')
      : props.item().mode === 'binary'
        ? tr('Allow')
        : tr('Allow once');
  const runLabel = () => tr('Allow for this run');
  const denyLabel = () => tr('Deny');
  const cancelWaitLabel = () => tr('Stop waiting');

  const secondaryAction = (): PermissionAction => {
    const it = props.item();
    if (it.mode === 'computer_app') {
      return it.allowAlways ? 'always' : 'session';
    }
    return 'session';
  };

  const secondaryLabel = (): string => {
    const it = props.item();
    if (it.mode === 'computer_app' && it.allowAlways) return tr('Always allow');
    return tr('Allow for this session');
  };

  return (
    <View style={{ width: '100%' }}>
      <If when={!!resolved()}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 6,
            paddingHorizontal: 2,
          }}
        >
          <Text
            style={{
              fontSize: 12.5,
              fontWeight: '600',
              color: resolved()?.allowed ? token('muted-foreground') : token('destructive'),
            }}
          >
            {resolved()?.allowed ? '✓' : '✕'}
          </Text>
          <Text style={{ fontSize: 12.5, color: token('subdued') }}>
            {tr('{label} · {command}', {
              label: tr(resolved()!.label),
              command: props.item().command(),
            })}
          </Text>
        </View>
      </If>

      <If when={!resolved() && props.item().mode === 'unsupported'}>
        <View
          style={{
            borderRadius: 22,
            backgroundColor: token('card'),
            borderWidth: 1,
            borderColor: token('border'),
            padding: 16,
            gap: 8,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View
              style={{
                width: 30,
                height: 30,
                borderRadius: 15,
                backgroundColor: token('muted'),
                borderWidth: 1,
                borderColor: token('border'),
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '700', color: token('muted-foreground') }}>
                i
              </Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: token('foreground') }}>
                {props.item().title}
              </Text>
              <Text style={{ fontSize: 12.5, color: token('muted-foreground') }}>
                {props.item().unsupportedNotice ??
                  tr('This type of request can only be handled in Maka on desktop.')}
              </Text>
            </View>
          </View>
          <View
            style={{
              borderRadius: 12,
              backgroundColor: token('muted'),
              paddingHorizontal: 12,
              paddingVertical: 9,
            }}
          >
            <Text style={{ fontSize: 12.5, color: token('muted-foreground') }}>
              {props.item().command()}
            </Text>
          </View>
          <If when={props.item().interactionKind === 'system_permission'}>
            <View
              role="button"
              accessibilityLabel={cancelWaitLabel()}
              onPress={() => {
                if (!props.busy?.()) props.onDecide('cancel_system_permission');
              }}
              style={{
                minHeight: 40,
                borderRadius: 20,
                backgroundColor: token('destructive-soft'),
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: 4,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '600', color: token('destructive') }}>
                {cancelWaitLabel()}
              </Text>
            </View>
          </If>
        </View>
      </If>

      <If when={!resolved() && props.item().mode !== 'unsupported'}>
        <View
          style={{
            borderRadius: 22,
            backgroundColor: token('card'),
            borderWidth: 1,
            borderColor: token('border'),
            padding: 16,
            gap: 12,
          }}
        >
          {/* Apple HIG Header — monochrome circular badge + crisp hierarchy, zero warning stripe */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: token('muted'),
                borderWidth: 1,
                borderColor: token('border'),
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '700', color: token('foreground') }}>⌘</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15.5, fontWeight: '600', color: token('foreground') }}>
                {props.item().title}
              </Text>
              <Text style={{ fontSize: 12.5, color: token('muted-foreground') }}>
                {props.item().subtitle}
              </Text>
            </View>
          </View>

          {/* Inset detail well */}
          <View
            style={{
              borderRadius: 13,
              backgroundColor: token('muted'),
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ fontSize: 12.5, lineHeight: 18, color: token('foreground') }}>
              {props.item().command()}
            </Text>
          </View>

          {/* Apple iOS 26 Pill actions */}
          <View style={{ gap: 8 }}>
            <If
              when={
                !props.item().allowBlocked &&
                (props.item().mode !== 'permissions' || props.item().canAllowOnce !== false)
              }
            >
              <View
                role="button"
                accessibilityLabel={primaryLabel()}
                onPress={() => {
                  if (!props.busy?.()) props.onDecide('once');
                }}
                style={{
                  minHeight: 44,
                  borderRadius: 22,
                  backgroundColor: token('primary'),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={{ fontSize: 15, fontWeight: '600', color: token('primary-foreground') }}
                >
                  {primaryLabel()}
                </Text>
              </View>
            </If>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <If when={!props.item().allowBlocked && props.item().mode === 'permissions'}>
                <View
                  role="button"
                  accessibilityLabel={runLabel()}
                  onPress={() => {
                    if (!props.busy?.()) props.onDecide('run');
                  }}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 21,
                    backgroundColor:
                      props.item().canAllowOnce === false ? token('primary') : token('muted'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color:
                        props.item().canAllowOnce === false
                          ? token('primary-foreground')
                          : token('foreground'),
                    }}
                  >
                    {runLabel()}
                  </Text>
                </View>
              </If>

              <If when={!props.item().allowBlocked && props.item().mode !== 'binary'}>
                <View
                  role="button"
                  accessibilityLabel={secondaryLabel()}
                  onPress={() => {
                    if (!props.busy?.()) props.onDecide(secondaryAction());
                  }}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    borderRadius: 21,
                    backgroundColor: token('muted'),
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '600', color: token('foreground') }}>
                    {secondaryLabel()}
                  </Text>
                </View>
              </If>

              <View
                role="button"
                accessibilityLabel={denyLabel()}
                onPress={() => {
                  if (!props.busy?.()) props.onDecide('deny');
                }}
                style={{
                  flex: 1,
                  minHeight: 44,
                  borderRadius: 21,
                  backgroundColor: token('destructive-soft'),
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: token('destructive') }}>
                  {denyLabel()}
                </Text>
              </View>
            </View>
          </View>
        </View>
      </If>
    </View>
  );
}

const CUSTOM_OPTION_ID = '__custom__';

export function AppleQuestionCard(props: {
  item: () => QuestionCardItem;
  busy?: () => boolean;
  onSubmit: (answers: (string | null)[]) => void;
}) {
  const initSelections = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const q of props.item().questions) {
      out[q.id] = q.options[0]?.id ?? CUSTOM_OPTION_ID;
    }
    return out;
  };
  const selectedIds = signal<Record<string, string>>(initSelections());
  const customDrafts = signal<Record<string, string>>({});

  const selectedFor = (q: SingleQuestionItem): string =>
    selectedIds()[q.id] ?? q.options[0]?.id ?? CUSTOM_OPTION_ID;

  const setSelectedFor = (qId: string, optId: string) => {
    selectedIds.set({ ...selectedIds(), [qId]: optId });
  };

  const setCustomFor = (qId: string, value: string) => {
    customDrafts.set({ ...customDrafts(), [qId]: value });
  };

  const resolvedAnswers = (): string[] =>
    props.item().questions.map((q) => {
      const sel = selectedFor(q);
      if (sel === CUSTOM_OPTION_ID) {
        return (customDrafts()[q.id] ?? '').trim();
      }
      const found = q.options.find((o) => o.id === sel);
      return found ? found.label : '';
    });

  const canSubmit = () => {
    const ans = resolvedAnswers();
    return ans.length > 0 && ans.every((a) => a.length > 0) && !props.busy?.();
  };

  const customOptionLabel = (index: number) =>
    index === 0
      ? tr('Question custom option')
      : tr('Question custom option {number}', { number: index + 1 });

  const customInputLabel = (index: number) =>
    index === 0
      ? tr('Custom question answer input')
      : tr('Custom question answer input {number}', { number: index + 1 });

  return (
    <View style={{ width: '100%' }}>
      <If when={!!props.item().answered}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingVertical: 6,
            paddingHorizontal: 2,
          }}
        >
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: token('muted-foreground') }}>
            ✓
          </Text>
          <Text style={{ fontSize: 12.5, color: token('subdued') }}>
            {tr('Answered · {answers}', {
              answers: (props.item().answered ?? []).map((a) => a ?? tr('Skipped')).join(' / '),
            })}
          </Text>
        </View>
      </If>

      <If when={!props.item().answered}>
        <View
          style={{
            borderRadius: 22,
            backgroundColor: token('card'),
            borderWidth: 1,
            borderColor: token('border'),
            padding: 16,
            gap: 14,
          }}
        >
          <Each of={props.item().questions} key={(q) => q.id}>
            {(q) => (
              <View style={{ gap: 10 }}>
                {/* Header */}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      backgroundColor: token('muted'),
                      borderWidth: 1,
                      borderColor: token('border'),
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: token('foreground') }}>
                      {props.item().questions.length > 1 ? String(q().index + 1) : '?'}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 15.5, fontWeight: '600', color: token('foreground') }}>
                      {q().prompt}
                    </Text>
                    <If when={q().index === 0}>
                      <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
                        {tr('Choose an option or write your own answer.')}
                      </Text>
                    </If>
                  </View>
                </View>

                {/* Apple Inset Grouped Option List */}
                <View
                  style={{
                    borderRadius: 14,
                    backgroundColor: token('muted'),
                    overflow: 'hidden',
                  }}
                >
                  <Each of={q().options} key={(o) => o.id}>
                    {(opt) => (
                      <View
                        role="button"
                        accessibilityLabel={tr('Question option {label}', { label: opt().label })}
                        onPress={() => setSelectedFor(q().id, opt().id)}
                        style={{
                          minHeight: 48,
                          paddingHorizontal: 13,
                          paddingVertical: 11,
                          borderBottomWidth: 1,
                          borderBottomColor: token('border'),
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 11,
                        }}
                      >
                        <View
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: 10,
                            borderWidth: 1.5,
                            borderColor:
                              selectedFor(q()) === opt().id ? token('primary') : token('subdued'),
                            backgroundColor:
                              selectedFor(q()) === opt().id ? token('primary') : 'transparent',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <If when={selectedFor(q()) === opt().id}>
                            <Text
                              style={{
                                fontSize: 11,
                                fontWeight: '700',
                                color: token('primary-foreground'),
                              }}
                            >
                              ✓
                            </Text>
                          </If>
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text
                            style={{
                              fontSize: 14.5,
                              fontWeight: '500',
                              color: token('foreground'),
                            }}
                          >
                            {opt().label}
                          </Text>
                          <If when={!!opt().description}>
                            <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
                              {opt().description ?? ''}
                            </Text>
                          </If>
                        </View>
                      </View>
                    )}
                  </Each>

                  {/* User Custom Free-Text Input Option */}
                  <View
                    role="button"
                    accessibilityLabel={customOptionLabel(q().index)}
                    onPress={() => setSelectedFor(q().id, CUSTOM_OPTION_ID)}
                    style={{
                      minHeight: 48,
                      paddingHorizontal: 13,
                      paddingVertical: 11,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 11,
                    }}
                  >
                    <View
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        borderWidth: 1.5,
                        borderColor:
                          selectedFor(q()) === CUSTOM_OPTION_ID
                            ? token('primary')
                            : token('subdued'),
                        backgroundColor:
                          selectedFor(q()) === CUSTOM_OPTION_ID ? token('primary') : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <If when={selectedFor(q()) === CUSTOM_OPTION_ID}>
                        <Text
                          style={{
                            fontSize: 11,
                            fontWeight: '700',
                            color: token('primary-foreground'),
                          }}
                        >
                          ✓
                        </Text>
                      </If>
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text
                        style={{ fontSize: 14.5, fontWeight: '500', color: token('foreground') }}
                      >
                        {tr('Other answer…')}
                      </Text>
                      <Text style={{ fontSize: 12, color: token('muted-foreground') }}>
                        {tr('Write your own answer.')}
                      </Text>
                    </View>
                  </View>

                  <If when={selectedFor(q()) === CUSTOM_OPTION_ID}>
                    <View
                      style={{
                        paddingHorizontal: 12,
                        paddingBottom: 12,
                        paddingTop: 4,
                      }}
                    >
                      <Input
                        accessibilityLabel={customInputLabel(q().index)}
                        value={customDrafts()[q().id] ?? ''}
                        onChange={({ value }: { value: string }) => setCustomFor(q().id, value)}
                        placeholder={tr('Enter an alternative or add more details…')}
                        style={{
                          minHeight: 44,
                          borderRadius: 11,
                          backgroundColor: token('card'),
                          borderWidth: 1,
                          borderColor: token('border'),
                          paddingHorizontal: 12,
                          color: token('foreground'),
                          fontSize: 14,
                        }}
                      />
                    </View>
                  </If>
                </View>
              </View>
            )}
          </Each>

          {/* Primary Submit + Skip Pills */}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View
              role="button"
              accessibilityLabel={tr('Skip question')}
              onPress={() => {
                if (!props.busy?.()) {
                  props.onSubmit(props.item().questions.map(() => null));
                }
              }}
              style={{
                minWidth: 78,
                minHeight: 44,
                paddingHorizontal: 14,
                borderRadius: 22,
                backgroundColor: token('muted'),
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '600', color: token('muted-foreground') }}>
                {tr('Skip')}
              </Text>
            </View>
            <View
              role="button"
              accessibilityLabel={tr('Submit question answer')}
              onPress={() => {
                const ans = resolvedAnswers();
                if (ans.length > 0 && ans.every((a) => a.length > 0) && !props.busy?.()) {
                  props.onSubmit(ans);
                }
              }}
              style={{
                flex: 1,
                minHeight: 44,
                borderRadius: 22,
                backgroundColor: canSubmit() ? token('primary') : token('muted'),
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: '600',
                  color: canSubmit() ? token('primary-foreground') : token('subdued'),
                }}
              >
                {tr('Submit answers')}
              </Text>
            </View>
          </View>
        </View>
      </If>
    </View>
  );
}

export function TurnPanel(props: {
  id: string;
  summary: () => string;
  steps: () => TurnStepItem[];
  onOpenDiff: (path?: string) => void;
}) {
  const open = signal(false);
  const expandedStepId = signal<string | null>(null);

  return (
    <View style={{ width: '100%', gap: 6 }}>
      {/* Level 1: Minimal inline disclosure */}
      <View
        role="button"
        accessibilityLabel={tr('Toggle work details {id}', { id: props.id })}
        onPress={() => open.set(!open())}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: 4,
        }}
      >
        <Text style={{ fontSize: 12.5, color: token('subdued') }}>{open() ? '▾' : '▸'}</Text>
        <Text style={{ fontSize: 12.5, color: token('muted-foreground') }}>{props.summary()}</Text>
      </View>

      {/* Level 2: Process steps guided by vertical spatial hairline */}
      <If when={open() && props.steps().length > 0}>
        <View
          style={{
            marginLeft: 6,
            paddingLeft: 12,
            borderLeftWidth: 1,
            borderLeftColor: token('separator'),
            gap: 8,
          }}
        >
          <Each of={props.steps()} key={(s) => s.id}>
            {(step) => (
              <View style={{ gap: 4 }}>
                <View
                  role="button"
                  accessibilityLabel={tr('Step {title}', { title: step().title })}
                  onPress={() => {
                    if (step().kind === 'edit') {
                      props.onOpenDiff(step().diffPath);
                    } else {
                      expandedStepId.set(expandedStepId() === step().id ? null : step().id);
                    }
                  }}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    paddingVertical: 5,
                    paddingHorizontal: 8,
                    borderRadius: 10,
                    backgroundColor: token('hover'),
                  }}
                >
                  <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                    <Text style={{ fontSize: 11.5, color: token('subdued') }}>
                      {step().kind === 'thinking'
                        ? '◦'
                        : step().kind === 'edit'
                          ? '±'
                          : step().kind === 'command'
                            ? '›'
                            : '·'}
                    </Text>
                    <Text style={{ fontSize: 13, color: token('foreground') }}>{step().title}</Text>
                  </View>

                  <If when={step().kind === 'edit'}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: '600',
                          color: token('diff-add-foreground'),
                        }}
                      >
                        {'+' + String(step().additions ?? 0)}
                      </Text>
                      <Text
                        style={{
                          fontSize: 12,
                          fontWeight: '600',
                          color: token('diff-delete-foreground'),
                        }}
                      >
                        {'-' + String(step().deletions ?? 0)}
                      </Text>
                      <Text style={{ fontSize: 12, color: token('subdued') }}>›</Text>
                    </View>
                  </If>
                </View>

                {/* Level 3: Step detail preview */}
                <If when={expandedStepId() === step().id && !!step().detail}>
                  <View
                    style={{
                      marginLeft: 8,
                      paddingHorizontal: 10,
                      paddingVertical: 8,
                      borderRadius: 10,
                      backgroundColor: token('card'),
                    }}
                  >
                    <Text
                      style={{ fontSize: 12, lineHeight: 17, color: token('muted-foreground') }}
                    >
                      {step().detail ?? ''}
                    </Text>
                  </View>
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
