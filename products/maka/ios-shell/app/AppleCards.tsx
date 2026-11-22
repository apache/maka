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
import { palette } from './theme';

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
  command: string;
  /** Original grant::Permissions object required by PermissionDecision::Allow. */
  requestedPermissions?: Record<string, unknown>;
  /** True when the request is bound to a specific toolUseId so PermissionScope::Once is legal. */
  canAllowOnce?: boolean;
  allowAlways?: boolean;
  unsupportedNotice?: string;
  resolved?: {
    allowed: boolean;
    label: string;
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
  const secondaryAction = (): PermissionAction => {
    const it = props.item();
    if (it.mode === 'computer_app') {
      return it.allowAlways ? 'always' : 'session';
    }
    return 'session';
  };

  const secondaryLabel = (): string => {
    const it = props.item();
    if (it.mode === 'computer_app' && it.allowAlways) return '始终允许';
    return '本会话允许';
  };

  return (
    <View style={{ width: '100%' }}>
      <If when={!!props.item().resolved}>
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
              color: props.item().resolved?.allowed ? palette().ink2 : palette().danger,
            }}
          >
            {props.item().resolved?.allowed ? '✓' : '✕'}
          </Text>
          <Text style={{ fontSize: 12.5, color: palette().ink3 }}>
            {(props.item().resolved?.label ?? '') + ' · ' + props.item().command}
          </Text>
        </View>
      </If>

      <If when={!props.item().resolved && props.item().mode === 'unsupported'}>
        <View
          style={{
            borderRadius: 22,
            backgroundColor: palette().surface,
            borderWidth: 1,
            borderColor: palette().line,
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
                backgroundColor: palette().surface2,
                borderWidth: 1,
                borderColor: palette().line,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '700', color: palette().ink2 }}>i</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15, fontWeight: '600', color: palette().ink }}>
                {props.item().title}
              </Text>
              <Text style={{ fontSize: 12.5, color: palette().ink2 }}>
                {props.item().unsupportedNotice ?? '此类交互请求仅支持在桌面端 Maka 处理'}
              </Text>
            </View>
          </View>
          <View
            style={{
              borderRadius: 12,
              backgroundColor: palette().surface2,
              paddingHorizontal: 12,
              paddingVertical: 9,
            }}
          >
            <Text style={{ fontSize: 12.5, color: palette().ink2 }}>{props.item().command}</Text>
          </View>
          <If when={props.item().interactionKind === 'system_permission'}>
            <View
              role="button"
              accessibilityLabel="Cancel system permission wait"
              onPress={() => {
                if (!props.busy?.()) props.onDecide('cancel_system_permission');
              }}
              style={{
                minHeight: 40,
                borderRadius: 20,
                backgroundColor: palette().dangerSoft,
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: 4,
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '600', color: palette().danger }}>
                取消等待
              </Text>
            </View>
          </If>
        </View>
      </If>

      <If when={!props.item().resolved && props.item().mode !== 'unsupported'}>
        <View
          style={{
            borderRadius: 22,
            backgroundColor: palette().surface,
            borderWidth: 1,
            borderColor: palette().line,
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
                backgroundColor: palette().surface2,
                borderWidth: 1,
                borderColor: palette().line,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '700', color: palette().ink }}>⌘</Text>
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ fontSize: 15.5, fontWeight: '600', color: palette().ink }}>
                {props.item().title}
              </Text>
              <Text style={{ fontSize: 12.5, color: palette().ink2 }}>{props.item().subtitle}</Text>
            </View>
          </View>

          {/* Inset detail well */}
          <View
            style={{
              borderRadius: 13,
              backgroundColor: palette().surface2,
              paddingHorizontal: 12,
              paddingVertical: 10,
            }}
          >
            <Text style={{ fontSize: 12.5, lineHeight: 18, color: palette().ink }}>
              {props.item().command}
            </Text>
          </View>

          {/* Apple iOS 26 Pill actions */}
          <View style={{ gap: 8 }}>
            <If when={props.item().mode !== 'permissions' || props.item().canAllowOnce !== false}>
              <View
                role="button"
                accessibilityLabel="Allow once"
                onPress={() => {
                  if (!props.busy?.()) props.onDecide('once');
                }}
                style={{
                  minHeight: 44,
                  borderRadius: 22,
                  backgroundColor: palette().primaryBg,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 15, fontWeight: '600', color: palette().primaryText }}>
                  {props.item().mode === 'binary' ? '允许' : '允许本次'}
                </Text>
              </View>
            </If>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <If when={props.item().mode === 'permissions'}>
                <View
                  role="button"
                  accessibilityLabel="Allow for run"
                  onPress={() => {
                    if (!props.busy?.()) props.onDecide('run');
                  }}
                  style={{
                    flex: 1,
                    minHeight: 42,
                    borderRadius: 21,
                    backgroundColor:
                      props.item().canAllowOnce === false
                        ? palette().primaryBg
                        : palette().surface2,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 14,
                      fontWeight: '600',
                      color:
                        props.item().canAllowOnce === false ? palette().primaryText : palette().ink,
                    }}
                  >
                    本轮允许
                  </Text>
                </View>
              </If>

              <If when={props.item().mode !== 'binary'}>
                <View
                  role="button"
                  accessibilityLabel="Allow session"
                  onPress={() => {
                    if (!props.busy?.()) props.onDecide(secondaryAction());
                  }}
                  style={{
                    flex: 1,
                    minHeight: 42,
                    borderRadius: 21,
                    backgroundColor: palette().surface2,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ fontSize: 14, fontWeight: '600', color: palette().ink }}>
                    {secondaryLabel()}
                  </Text>
                </View>
              </If>

              <View
                role="button"
                accessibilityLabel="Deny permission"
                onPress={() => {
                  if (!props.busy?.()) props.onDecide('deny');
                }}
                style={{
                  flex: 1,
                  minHeight: 42,
                  borderRadius: 21,
                  backgroundColor: palette().dangerSoft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: palette().danger }}>
                  拒绝
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
    index === 0 ? 'Question custom option' : 'Question custom option ' + String(index + 1);

  const customInputLabel = (index: number) =>
    index === 0
      ? 'Custom question answer input'
      : 'Custom question answer input ' + String(index + 1);

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
          <Text style={{ fontSize: 12.5, fontWeight: '600', color: palette().ink2 }}>✓</Text>
          <Text style={{ fontSize: 12.5, color: palette().ink3 }}>
            {'已回答 · ' +
              (props.item().answered ?? []).map((a) => (a === null ? '已跳过' : a)).join(' / ')}
          </Text>
        </View>
      </If>

      <If when={!props.item().answered}>
        <View
          style={{
            borderRadius: 22,
            backgroundColor: palette().surface,
            borderWidth: 1,
            borderColor: palette().line,
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
                      backgroundColor: palette().surface2,
                      borderWidth: 1,
                      borderColor: palette().line,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '700', color: palette().ink }}>
                      {props.item().questions.length > 1 ? String(q().index + 1) : '?'}
                    </Text>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ fontSize: 15.5, fontWeight: '600', color: palette().ink }}>
                      {q().prompt}
                    </Text>
                    <If when={q().index === 0}>
                      <Text style={{ fontSize: 12, color: palette().ink2 }}>
                        选择一个方案，或自己输入补充说明
                      </Text>
                    </If>
                  </View>
                </View>

                {/* Apple Inset Grouped Option List */}
                <View
                  style={{
                    borderRadius: 14,
                    backgroundColor: palette().surface2,
                    overflow: 'hidden',
                  }}
                >
                  <Each of={q().options} key={(o) => o.id}>
                    {(opt) => (
                      <View
                        role="button"
                        accessibilityLabel={'Question option ' + opt().label}
                        onPress={() => setSelectedFor(q().id, opt().id)}
                        style={{
                          minHeight: 48,
                          paddingHorizontal: 13,
                          paddingVertical: 11,
                          borderBottomWidth: 1,
                          borderBottomColor: palette().line,
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
                              selectedFor(q()) === opt().id ? palette().primaryBg : palette().ink3,
                            backgroundColor:
                              selectedFor(q()) === opt().id ? palette().primaryBg : 'transparent',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <If when={selectedFor(q()) === opt().id}>
                            <Text
                              style={{
                                fontSize: 11,
                                fontWeight: '700',
                                color: palette().primaryText,
                              }}
                            >
                              ✓
                            </Text>
                          </If>
                        </View>
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text style={{ fontSize: 14.5, fontWeight: '500', color: palette().ink }}>
                            {opt().label}
                          </Text>
                          <If when={!!opt().description}>
                            <Text style={{ fontSize: 12, color: palette().ink2 }}>
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
                            ? palette().primaryBg
                            : palette().ink3,
                        backgroundColor:
                          selectedFor(q()) === CUSTOM_OPTION_ID
                            ? palette().primaryBg
                            : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <If when={selectedFor(q()) === CUSTOM_OPTION_ID}>
                        <Text
                          style={{ fontSize: 11, fontWeight: '700', color: palette().primaryText }}
                        >
                          ✓
                        </Text>
                      </If>
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ fontSize: 14.5, fontWeight: '500', color: palette().ink }}>
                        其他，自己输入…
                      </Text>
                      <Text style={{ fontSize: 12, color: palette().ink2 }}>
                        按你的想法自定义回复内容
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
                        placeholder="输入你的方案或补充说明…"
                        style={{
                          minHeight: 42,
                          borderRadius: 11,
                          backgroundColor: palette().surface,
                          borderWidth: 1,
                          borderColor: palette().line,
                          paddingHorizontal: 12,
                          color: palette().ink,
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
              accessibilityLabel="Skip question"
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
                backgroundColor: palette().surface2,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ fontSize: 14, fontWeight: '600', color: palette().ink2 }}>跳过</Text>
            </View>
            <View
              role="button"
              accessibilityLabel="Submit question answer"
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
                backgroundColor: canSubmit() ? palette().primaryBg : palette().surface2,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: '600',
                  color: canSubmit() ? palette().primaryText : palette().ink3,
                }}
              >
                提交回答
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
        accessibilityLabel={'Toggle work details ' + props.id}
        onPress={() => open.set(!open())}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingVertical: 4,
        }}
      >
        <Text style={{ fontSize: 12.5, color: palette().ink3 }}>{open() ? '▾' : '▸'}</Text>
        <Text style={{ fontSize: 12.5, color: palette().ink2 }}>{props.summary()}</Text>
      </View>

      {/* Level 2: Process steps guided by vertical spatial hairline */}
      <If when={open() && props.steps().length > 0}>
        <View
          style={{
            marginLeft: 6,
            paddingLeft: 12,
            borderLeftWidth: 1,
            borderLeftColor: palette().guideLine,
            gap: 8,
          }}
        >
          <Each of={props.steps()} key={(s) => s.id}>
            {(step) => (
              <View style={{ gap: 4 }}>
                <View
                  role="button"
                  accessibilityLabel={'Step ' + step().title}
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
                    backgroundColor: palette().rowHover,
                  }}
                >
                  <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 7 }}>
                    <Text style={{ fontSize: 11.5, color: palette().ink3 }}>
                      {step().kind === 'thinking'
                        ? '◦'
                        : step().kind === 'edit'
                          ? '±'
                          : step().kind === 'command'
                            ? '›'
                            : '·'}
                    </Text>
                    <Text style={{ fontSize: 13, color: palette().ink }}>{step().title}</Text>
                  </View>

                  <If when={step().kind === 'edit'}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                      <Text
                        style={{ fontSize: 12, fontWeight: '600', color: palette().diffAddInk }}
                      >
                        {'+' + String(step().additions ?? 0)}
                      </Text>
                      <Text
                        style={{ fontSize: 12, fontWeight: '600', color: palette().diffDelInk }}
                      >
                        {'-' + String(step().deletions ?? 0)}
                      </Text>
                      <Text style={{ fontSize: 12, color: palette().ink3 }}>›</Text>
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
                      backgroundColor: palette().surface,
                    }}
                  >
                    <Text style={{ fontSize: 12, lineHeight: 17, color: palette().ink2 }}>
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
