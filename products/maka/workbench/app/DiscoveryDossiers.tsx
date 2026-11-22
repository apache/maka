/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
import {
  batch,
  cleanup,
  computed,
  effect,
  inputAction,
  List,
  type ListRef,
  Scroll,
  signal,
  Text,
  View,
} from 'nsh';
import { Button, Checkbox, Dialog } from 'nsh/base';
import { controlsLeft, controlsRight, TITLE_BAR_HEIGHT, windowDrag } from './chrome';
import { ChoiceIndicator } from './ChoiceIndicator';
import { DiscoveryDialog } from './DiscoveryPanel';
import { DossierThread } from './DossierThread';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import { MarkdownBody } from './MarkdownBody';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsEditor } from './SettingsField';
import { SettingsButton } from './SettingsPage';
import {
  leadFilePaths,
  pinDossier,
  type DossierDetail,
  type DossierSelection,
  type DossierSummary,
  type DossiersSnapshot,
} from './discoveryDossiersCore';
import { useHost } from './host';
import { currentLocale, tr, type MessageKey } from './locale';
import { createText, errorText, message } from './text';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlFocusStyle,
  controlHoverStyle,
  quietFocusStyle,
} from './ui';

type DossiersProps = {
  route(): { topicId: string | null } | null;
  snapshot(): DossiersSnapshot | null;
  watchError(): string;
  botSession(): string | null;
  openBot(): Promise<string>;
  control(method: string, input: unknown): Promise<unknown>;
  openSession(id: string): void;
  chooseModel(id: string): void;
  openLink(id: string | null, target: string, restoreFocus: () => boolean): Promise<void>;
  close(): void;
};

const signals = {
  red: 'Dossier urgent',
  yellow: 'Dossier updated',
  green: 'Dossier monitoring',
  done: 'Dossier done',
} as const satisfies Record<DossierSummary['signal'], MessageKey>;
const statuses = {
  awaiting_confirm: 'Dossier awaiting confirmation',
  stale: 'Dossier action stale',
  executing: 'Dossier action executing',
  done: 'Dossier action done',
  unknown_pending_receipt: 'Dossier awaiting receipt',
} as const satisfies Record<DossierDetail['pendingActions'][number]['status'], MessageKey>;
const watches = {
  file_hash: 'Dossier file watch',
  http_check: 'Dossier web watch',
  deadline: 'Dossier deadline watch',
} as const;

function SignalDot(props: { signal: DossierSummary['signal'] }) {
  const tone = { red: 'danger', yellow: 'warning', green: 'success', done: 'muted' } as const;
  return (
    <View
      accessibilityLabel={tr(signals[props.signal])}
      style={{
        width: 7,
        height: 7,
        borderRadius: 4,
        flexShrink: 0,
        backgroundColor: C[tone[props.signal]],
        opacity: props.signal === 'done' ? 0.5 : 1,
      }}
    />
  );
}

const rowStyle = { flexDirection: 'row', alignItems: 'center', gap: 8 } as const;
const mutedText = () => ({ ...captionTextStyle, color: C.muted });
const titleStyle = () => ({ ...bodyTextStyle, color: C.text, fontWeight: '600' as const });

function DossierPane(
  props: Pick<DossiersProps, 'snapshot' | 'botSession' | 'openLink' | 'openSession'> & {
    topicId: string;
    time(at: number): string;
  },
) {
  const host = useHost();
  const topicId = props.topicId;
  const detail = signal<DossierDetail | null>(null);
  const expanded = signal(false);
  const saving = signal(false);
  const error = createText();
  const readError = createText();
  let alive = true,
    reading = false,
    dirty = false;
  cleanup(() => {
    alive = false;
  });
  const refresh = async () => {
    dirty = true;
    if (reading) return;
    reading = true;
    try {
      while (alive && dirty) {
        dirty = false;
        try {
          const value = await host.query('agent', 'dossier', { topicId });
          if (alive) {
            detail.set(value);
            readError.set(value ? '' : message('Dossier unavailable'));
          }
        } catch (reason) {
          if (alive) readError.set(errorText(reason, 'Could not load the dossier.'));
        }
      }
    } finally {
      reading = false;
    }
  };
  effect(() => {
    // Thread bindings, watches and routine check times can change without a new material revision.
    props.snapshot();
    void refresh();
  });
  const mute = async (muted: boolean) => {
    if (!alive || saving()) return;
    saving.set(true);
    error.set('');
    try {
      await host.mutateAgent('setDossierMuted', { topicId, muted });
      if (alive) await refresh();
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not update dossier notifications.'));
    } finally {
      if (alive) saving.set(false);
    }
  };
  const scope = () => detail()?.threadSessionId ?? props.botSession();
  const markdownRow = () => ({
    key: topicId,
    field: 'body',
    role: 'assistant',
    text: detail()!.summaryMd,
    prefix: true,
  });
  return (
    <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
      <If when={readError()}>
        <View style={rowStyle}>
          <Text style={{ ...mutedText(), flex: 1 }}>{readError()}</Text>
          <SettingsButton label={tr('Retry')} tone="quiet" onPress={() => void refresh()} />
        </View>
      </If>
      <If
        when={detail() !== null}
        else={
          <If when={!readError()}>
            <LoadingIndicator />
          </If>
        }
      >
        <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 14, gap: 12 }}>
          <View style={rowStyle}>
            <SignalDot signal={detail()!.signal} />
            <Text role="header" style={{ ...titleStyle(), flex: 1, minWidth: 0, fontSize: 17 }}>
              {detail()!.title}
            </Text>
            <SettingsButton
              label={tr(detail()!.muted ? 'Unmute dossier' : 'Mute dossier')}
              tone="quiet"
              disabled={saving()}
              onPress={inputAction((next) => void mute(next), !detail()!.muted)}
            />
          </View>
          <If when={detail()!.windowAt != null || detail()!.linkedTaskIds.length > 0}>
            <View style={{ ...rowStyle, flexWrap: 'wrap' }}>
              <If when={detail()!.windowAt != null}>
                <Text style={mutedText()}>
                  {tr('Dossier window', { time: props.time(detail()!.windowAt!) })}
                </Text>
              </If>
              <If when={detail()!.linkedTaskIds.length > 0}>
                <Text style={mutedText()}>
                  {tr(
                    detail()!.linkedTaskIds.length === 1
                      ? 'One linked schedule'
                      : 'Linked schedules count',
                    { count: detail()!.linkedTaskIds.length },
                  )}
                </Text>
              </If>
            </View>
          </If>
          <If when={error()}>
            <Text style={{ ...mutedText(), color: C.danger }}>{error()}</Text>
          </If>
          <MarkdownBody
            row={markdownRow}
            text={() => detail()!.summaryMd}
            sourceId={`dossier/${topicId}/${detail()!.revision}`}
            sessionId={scope()}
            interactiveBlocks={false}
            userScroll={() => {}}
            openLink={async (target, restoreFocus) => {
              try {
                await props.openLink(scope(), target, restoreFocus);
              } catch (reason) {
                if (alive) error.set(errorText(reason, 'The link could not be opened'));
              }
            }}
          />
          <If when={detail()!.artifacts.length > 0}>
            <View style={{ gap: 4 }}>
              <Text style={titleStyle()}>{tr('Dossier artifacts')}</Text>
              <Each of={detail()!.artifacts} key={(_, index) => index}>
                {(artifact) => (
                  <View style={{ gap: 2 }}>
                    <Text style={{ ...bodyTextStyle, color: C.text, userSelect: 'text' }}>
                      {artifact().path}
                    </Text>
                    <Text style={mutedText()}>{artifact().purpose}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <If when={detail()!.pendingActions.length > 0}>
            <View style={{ gap: 4 }}>
              <Text style={titleStyle()}>{tr('Dossier pending actions')}</Text>
              <Each of={detail()!.pendingActions} key={(action) => action.actionId}>
                {(action) => (
                  <View style={rowStyle}>
                    <Text
                      style={{
                        ...captionTextStyle,
                        color: C.secondary,
                        backgroundColor: C.card,
                        paddingHorizontal: 6,
                        paddingVertical: 2,
                        borderRadius: 4,
                      }}
                    >
                      {tr(statuses[action().status])}
                    </Text>
                    <Text style={{ ...captionTextStyle, flexShrink: 1, color: C.text }}>
                      {action().connectorTool}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
          <Button
            accessibilityLabel={tr('Dossier watches and activity')}
            selected={expanded()}
            onPress={() => expanded.set(!expanded())}
            style={{ ...rowStyle, alignSelf: 'flex-start', paddingVertical: 4 }}
            focusStyle={quietFocusStyle()}
          >
            <Icon name={expanded() ? 'down' : 'right'} color={C.muted} size={13} />
            <Text style={mutedText()}>{tr('Dossier watches and activity')}</Text>
          </Button>
          <If when={expanded()}>
            <View style={{ gap: 5 }}>
              <Each of={detail()!.watches} key={(watch) => watch.watchId}>
                {(watch) => (
                  <Text style={mutedText()}>
                    {tr(watches[watch().kind])} · {watch().target}
                  </Text>
                )}
              </Each>
              <Text style={mutedText()}>
                {tr('Dossier last checked', { time: props.time(detail()!.lastCheckedAt) })}
              </Text>
              <Text style={mutedText()}>
                {tr('Dossier last changed', { time: props.time(detail()!.lastMaterialChangeAt) })}
              </Text>
            </View>
          </If>
        </Scroll>
        <DossierThread
          topicId={topicId}
          threadSessionId={() => detail()!.threadSessionId ?? null}
          openSession={props.openSession}
        />
      </If>
    </View>
  );
}

function DropLead(props: { paths: string[]; dropped(topicId: string): void; close(): void }) {
  const host = useHost();
  const text = signal('');
  const paths = signal(props.paths);
  const saving = signal(false);
  const error = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const close = () => {
    if (!saving()) props.close();
  };
  const submit = async () => {
    if (saving() || (!text().trim() && !paths().length)) return;
    saving.set(true);
    error.set('');
    try {
      const { topicId } = await host.mutateAgent('dropDiscoveryLead', {
        text: text().trim(),
        paths: paths(),
      });
      if (alive) props.dropped(topicId);
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not drop the lead.'));
    } finally {
      if (alive) saving.set(false);
    }
  };
  return (
    <ModalDialog size="form" onCancel={close}>
      <DialogHeader title={tr('Drop lead')} />
      <View
        onFileDrop={({ uris }) => {
          if (!saving()) paths.set(leadFilePaths(uris, paths()));
        }}
        style={{ gap: 6 }}
      >
        <View style={{ height: 100 }}>
          <SettingsEditor
            label={tr('Discovery lead input')}
            placeholder={tr('Discovery lead input')}
            value={text()}
            change={text.set}
            disabled={saving()}
            autoFocus
          />
        </View>
        <Scroll style={{ maxHeight: 100 }}>
          <Each of={paths()} key={(path) => path}>
            {(path) => <Text style={mutedText()}>{path()}</Text>}
          </Each>
        </Scroll>
      </View>
      <If when={error()}>
        <Text style={{ ...mutedText(), color: C.danger }}>{error()}</Text>
      </If>
      <DialogFooter>
        <SettingsButton label={tr('Cancel')} disabled={saving()} onPress={close} />
        <SettingsButton
          label={tr('Add lead')}
          tone="primary"
          disabled={saving() || (!text().trim() && !paths().length)}
          onPress={() => void submit()}
        />
      </DialogFooter>
    </ModalDialog>
  );
}

export function DiscoveryDossiers(props: DossiersProps) {
  const host = useHost();
  const list = signal<ListRef | null>(null);
  const selection = signal<DossierSelection>(null);
  const plans = signal<string | null>(null);
  const lead = signal<string[] | null>(null);
  const saving = signal(false);
  const error = createText();
  const formatter = computed(
    () => new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'short', timeStyle: 'short' }),
  );
  const time = (at: number) => formatter().format(at);
  const rows = () => props.snapshot()?.dossiers ?? [];
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const select = (topicId: string) => selection.set({ topicId });
  effect(() => {
    const request = props.route();
    if (request?.topicId != null) {
      selection.set({ topicId: request.topicId, requested: true });
      plans.set(null);
      lead.set(null);
    }
  });
  effect(() => {
    const selected = selection();
    const dossiers = rows();
    const next = pinDossier(dossiers, selected);
    if (selected?.requested && next && !next.requested) {
      const node = list();
      if (!node) return;
      node.scrollToIndex({
        index: dossiers.findIndex((d) => d.topicId === next.topicId),
        viewPosition: 0.5,
        animated: false,
      });
    }
    selection.set(next);
  });
  const action = async (run: () => Promise<void>, fallback: MessageKey) => {
    if (saving()) return;
    error.set('');
    saving.set(true);
    try {
      await run();
    } catch (reason) {
      if (alive) error.set(errorText(reason, fallback));
    } finally {
      if (alive) saving.set(false);
    }
  };
  const openPlans = () =>
    void action(async () => {
      const route = props.route();
      const id = await props.openBot();
      if (alive && route === props.route()) plans.set(id);
    }, 'Could not load the discovery plan.');
  const toggle = ({ checked }: { checked: boolean }) =>
    void action(async () => {
      await host.mutateAgent('setDiscoveryNotifications', { enabled: checked });
    }, 'Could not update dossier notifications.');
  return (
    <Dialog
      animation="none"
      closeOnEscape={false}
      closeOnBackdropPress={false}
      closeOnSwipe={false}
      onCancel={props.close}
      style={{ flex: 1, minHeight: 0, backgroundColor: C.panel }}
    >
      <View
        desktop={windowDrag}
        style={{
          ...rowStyle,
          flexWrap: 'wrap',
          minHeight: TITLE_BAR_HEIGHT,
          paddingLeft: Math.max(16, controlsLeft(true)),
          paddingRight: Math.max(12, controlsRight(true)),
        }}
      >
        <Text role="header" style={{ ...titleStyle(), flexGrow: 1, fontSize: 17 }}>
          {tr('Discovery dossiers')}
        </Text>
        <Checkbox
          accessibilityLabel={tr('{label}: {state}', {
            label: tr('Discovery desktop notifications'),
            state: tr(props.snapshot()?.notificationsEnabled ? 'On' : 'Off'),
          })}
          checked={props.snapshot()?.notificationsEnabled ?? false}
          disabled={!props.snapshot() || saving()}
          onChange={toggle}
          indicator={
            <ChoiceIndicator
              kind="switch"
              checked={props.snapshot()?.notificationsEnabled ?? false}
            />
          }
          style={rowStyle}
        >
          <Text style={mutedText()}>{tr('Dossier notifications')}</Text>
        </Checkbox>
        <SettingsButton
          label={tr('Drop lead')}
          icon="plus"
          tone="quiet"
          onPress={() => lead.set([])}
        />
        <SettingsButton
          label={tr('Discovery plans')}
          tone="quiet"
          disabled={saving()}
          onPress={openPlans}
        />
        <Button
          accessibilityLabel={tr('Close')}
          onPress={props.close}
          style={{ padding: 5, borderRadius: 6 }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="close" color={C.muted} size={15} />
        </Button>
      </View>
      <If when={error() || props.watchError()}>
        <Text style={{ ...mutedText(), color: C.danger }}>{error() || props.watchError()}</Text>
      </If>
      <View
        onFileDrop={({ uris }) => lead.set(leadFilePaths(uris))}
        style={{
          flex: 1,
          minHeight: 0,
          flexDirection: 'row',
          borderTopWidth: 1,
          borderColor: C.line,
        }}
      >
        <View
          style={{
            width: '32%',
            maxWidth: 300,
            minHeight: 0,
            borderRightWidth: 1,
            borderColor: C.line,
            paddingTop: 6,
            paddingHorizontal: 6,
          }}
        >
          <List
            ref={list.set}
            each={rows()}
            keyExtractor={(row) => row.topicId}
            estimatedItemSize={44}
            style={{ flex: 1, minHeight: 0 }}
          >
            {(row) => (
              <Button
                accessibilityLabel={[
                  row().title,
                  tr(signals[row().signal]),
                  ...(row().muted ? [tr('Dossier muted')] : []),
                ].join(tr('Discovery list separator'))}
                selected={selection()?.topicId === row().topicId}
                onPress={inputAction(select, row().topicId)}
                style={{
                  ...rowStyle,
                  minHeight: 40,
                  padding: 7,
                  borderRadius: 7,
                  backgroundColor: selection()?.topicId === row().topicId ? C.card : undefined,
                }}
                hoverStyle={controlHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <SignalDot signal={row().signal} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text
                    style={[
                      { ...bodyTextStyle, color: row().signal === 'done' ? C.muted : C.text },
                      { numberOfLines: 1 },
                    ]}
                  >
                    {row().title}
                  </Text>
                  <If when={row().windowAt != null || row().muted}>
                    <Text style={mutedText()}>
                      {[
                        row().windowAt != null ? time(row().windowAt!) : '',
                        row().muted ? tr('Dossier muted') : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </If>
                </View>
              </Button>
            )}
          </List>
        </View>
        <If when={!selection()}>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <If
              when={props.snapshot()}
              else={
                <If when={!props.watchError()}>
                  <LoadingIndicator />
                </If>
              }
            >
              <Text style={mutedText()}>{tr('No discovery dossiers yet')}</Text>
            </If>
          </View>
        </If>
        <Each of={selection() ? [selection()!.topicId] : []} key={(id) => id}>
          {(id) => (
            <DossierPane
              topicId={id()}
              snapshot={props.snapshot}
              botSession={props.botSession}
              openLink={props.openLink}
              openSession={props.openSession}
              time={time}
            />
          )}
        </Each>
      </View>
      <If when={lead() !== null}>
        <DropLead
          paths={lead()!}
          close={() => lead.set(null)}
          dropped={(topicId) =>
            batch(() => {
              selection.set({ topicId, requested: true });
              lead.set(null);
            })
          }
        />
      </If>
      <Each of={plans() ? [plans()!] : []} key={(id) => id}>
        {(id) => (
          <DiscoveryDialog
            host={host}
            sessionId={id()}
            control={props.control}
            openWorker={props.openSession}
            chooseModel={() => props.chooseModel(id())}
            close={() => plans.set(null)}
          />
        )}
      </Each>
    </Dialog>
  );
}
