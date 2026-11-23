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
import { Button, Checkbox } from 'nsh/base';
import { LocalMessageCopy } from './CompactReplyFooter';
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
  pendingActionControls,
  type DossierDetail,
  type DossierSelection,
  type DossierSummary,
  type DossiersSnapshot,
} from './discoveryDossiersCore';
import { useHost } from './host';
import { currentLocale, tr, type MessageKey } from './locale';
import { createText, createTransientText, errorText, message, type UiText } from './text';
import {
  C,
  Disclosure,
  DisclosureChevron,
  Header,
  IconButton,
  animateDisclosure,
  bodyTextStyle,
  captionTextStyle,
  codeTextStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlDisabledStyle,
  quietFocusStyle,
  secondaryTextStyle,
  type BrowserHeader,
} from './ui';

type DossiersProps = {
  browser: BrowserHeader;
  commands(): void;
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
const readingColumn = {
  width: '100%',
  maxWidth: 760,
  alignSelf: 'center',
  paddingHorizontal: 16,
} as const;
const cardStyle = () => ({
  backgroundColor: C.card,
  borderWidth: 1,
  borderColor: C.line,
  borderRadius: 10,
  paddingHorizontal: 12,
  paddingVertical: 10,
  gap: 8,
});
const previewStyle = () => ({
  backgroundColor: C.background,
  borderWidth: 1,
  borderColor: C.line,
  borderRadius: 8,
  padding: 10,
});

function Badge(props: { text: string; warning?: boolean }) {
  return (
    <View
      style={{
        alignSelf: 'flex-start',
        maxWidth: '100%',
        backgroundColor: C.card,
        borderWidth: 1,
        borderColor: props.warning ? C.warning : C.line,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}
    >
      <Text style={{ ...captionTextStyle, color: props.warning ? C.warning : C.secondary }}>
        {props.text}
      </Text>
    </View>
  );
}

function ArtifactPreview(props: { topicId: string; path: string }) {
  const host = useHost();
  const content = signal<string | null>(null);
  const error = createText();
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  void host
    .query('agent', 'readDossierArtifact', {
      topicId: props.topicId,
      path: props.path,
    })
    .then(
      (text) => {
        if (alive) content.set(text);
      },
      (reason) => {
        if (alive) error.set(errorText(reason, 'Could not preview this artifact.'));
      },
    );
  const preview = computed(() => {
    const text = content() ?? '';
    return text.length > 4096 ? text.slice(0, 4096).replace(/[\uD800-\uDBFF]$/, '') + '…' : text;
  });
  return (
    <View style={{ ...previewStyle(), gap: 4 }}>
      <If
        when={content() !== null}
        else={
          <If when={error()} else={<LoadingIndicator />}>
            <Text style={mutedText()}>{error()}</Text>
          </If>
        }
      >
        <Scroll style={{ maxHeight: 160 }}>
          <Text style={{ ...codeTextStyle, color: C.text, userSelect: 'text' }}>{preview()}</Text>
        </Scroll>
        <View style={{ alignSelf: 'flex-end' }}>
          <LocalMessageCopy label={tr('Copy staged artifact')} text={() => content()!} />
        </View>
      </If>
    </View>
  );
}

function PendingActionRow(props: {
  action(): DossierDetail['pendingActions'][number];
  refresh(): Promise<void>;
  feedback(text: UiText): void;
}) {
  const host = useHost();
  const busy = signal(false);
  const settled = signal<DossierDetail['pendingActions'][number]['status'] | null>(null);
  const error = createText();
  const status = () => settled() ?? props.action().status;
  const controls = () =>
    pendingActionControls({ status: status(), receipt: props.action().receipt }, busy());
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const submit = async (dismiss: boolean) => {
    if (dismiss ? !controls().dismiss : !controls().confirm) return;
    const actionId = props.action().actionId;
    busy.set(true);
    error.set('');
    props.feedback('');
    try {
      if (dismiss) {
        await host.mutateAgent('dismissPendingAction', { actionId });
        if (alive) settled.set('done');
        props.feedback(message('Dossier action dismissed'));
      } else {
        const result = await host.mutateAgent('confirmPendingAction', { actionId });
        if (result.outcome === 'done') props.feedback(message('Dossier action done'));
        if (result.outcome === 'failed')
          props.feedback(
            result.error === 'discovery_action_expired'
              ? message('Dossier action expired')
              : result.error,
          );
        if (alive)
          settled.set(
            result.outcome === 'failed'
              ? result.error === 'discovery_action_expired'
                ? 'stale'
                : 'done'
              : result.outcome,
          );
      }
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Dossier action failed'));
    } finally {
      await props.refresh();
      if (alive) {
        busy.set(false);
      }
    }
  };
  return (
    <View style={cardStyle()}>
      <Text style={titleStyle()}>{props.action().connectorTool}</Text>
      <View style={previewStyle()}>
        <Scroll style={{ maxHeight: 96 }}>
          <Text style={{ ...codeTextStyle, color: C.secondary, userSelect: 'text' }}>
            {JSON.stringify(props.action().params, null, 2)}
          </Text>
        </Scroll>
      </View>
      <If when={controls().notice !== null}>
        <Badge warning text={tr(controls().notice!)} />
      </If>
      <If when={controls().showConfirm || controls().showDismiss || busy()}>
        <View style={{ ...rowStyle, flexWrap: 'wrap' }}>
          <If when={controls().showConfirm}>
            <SettingsButton
              label={tr('Confirm dossier action')}
              tone="primary"
              disabled={!controls().confirm}
              onPress={() => void submit(false)}
            />
          </If>
          <If when={controls().showDismiss}>
            <SettingsButton
              label={tr('Dismiss dossier action')}
              tone="quiet"
              disabled={!controls().dismiss}
              onPress={() => void submit(true)}
            />
          </If>
          <If when={busy()}>
            <LoadingIndicator />
          </If>
        </View>
      </If>
      <If when={status() === 'executing'}>
        <Text style={mutedText()}>{tr(statuses[status()])}</Text>
      </If>
      <If when={error()}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
      </If>
    </View>
  );
}

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
  const artifactPath = signal<string | null>(null);
  const saving = signal(false);
  const error = createText();
  const readError = createText();
  const actionFeedback = createTransientText();
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
    <View style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: C.background }}>
      <Scroll style={{ flex: 1, minHeight: 0 }}>
        <View style={{ ...readingColumn, paddingVertical: 16, gap: 16 }}>
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
            <View style={{ gap: 8 }}>
              <View style={rowStyle}>
                <SignalDot signal={detail()!.signal} />
                <Text role="header" style={{ ...titleStyle(), flex: 1, minWidth: 0, fontSize: 18 }}>
                  {detail()!.title}
                </Text>
                <Button
                  accessibilityLabel={tr(detail()!.muted ? 'Unmute dossier' : 'Mute dossier')}
                  disabled={saving()}
                  onPress={inputAction((next) => void mute(next), !detail()!.muted)}
                  style={{
                    ...rowStyle,
                    minHeight: 28,
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderWidth: 1,
                    borderColor: C.line,
                    borderRadius: 8,
                    backgroundColor: C.card,
                  }}
                  hoverStyle={{ backgroundColor: C.cardRaised }}
                  focusStyle={quietFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <Text style={{ ...captionTextStyle, color: C.secondary }}>
                    {tr(detail()!.muted ? 'Unmute dossier' : 'Mute dossier')}
                  </Text>
                </Button>
              </View>
              <If when={detail()!.windowAt != null || detail()!.linkedTaskIds.length > 0}>
                <View style={{ ...rowStyle, flexWrap: 'wrap' }}>
                  <If when={detail()!.windowAt != null}>
                    <Badge text={tr('Dossier window', { time: props.time(detail()!.windowAt!) })} />
                  </If>
                  <If when={detail()!.linkedTaskIds.length > 0}>
                    <Badge
                      text={tr(
                        detail()!.linkedTaskIds.length === 1
                          ? 'One linked schedule'
                          : 'Linked schedules count',
                        { count: detail()!.linkedTaskIds.length },
                      )}
                    />
                  </If>
                </View>
              </If>
            </View>
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
              <View style={{ gap: 8 }}>
                <Text role="header" style={titleStyle()}>
                  {tr('Dossier artifacts')}
                </Text>
                <Each
                  of={detail()!.artifacts}
                  key={(artifact) => JSON.stringify([artifact.path, artifact.sha256])}
                >
                  {(artifact) => (
                    <View style={cardStyle()}>
                      <Button
                        accessibilityLabel={tr('Preview staged artifact', {
                          path: artifact().path,
                        })}
                        selected={artifactPath() === artifact().path}
                        onPress={inputAction(
                          (path) => artifactPath.set(artifactPath() === path ? null : path),
                          artifact().path,
                        )}
                        style={{ ...rowStyle, minHeight: 32, borderRadius: 6 }}
                        hoverStyle={{ backgroundColor: C.cardRaised }}
                        focusStyle={quietFocusStyle()}
                      >
                        <Icon name="file" color={C.muted} />
                        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <Text style={{ ...bodyTextStyle, color: C.text }}>{artifact().path}</Text>
                          <Text style={mutedText()}>{artifact().purpose}</Text>
                        </View>
                        <DisclosureChevron open={artifactPath() === artifact().path} size={14} />
                      </Button>
                      <If when={artifactPath() === artifact().path}>
                        <ArtifactPreview topicId={topicId} path={artifact().path} />
                      </If>
                    </View>
                  )}
                </Each>
              </View>
            </If>
            <If when={detail()!.pendingActions.length > 0}>
              <View style={{ gap: 8 }}>
                <Text role="header" style={titleStyle()}>
                  {tr('Dossier pending actions')}
                </Text>
                <Each of={detail()!.pendingActions} key={(action) => action.actionId}>
                  {(action) => (
                    <PendingActionRow
                      action={action}
                      refresh={refresh}
                      feedback={(text) => {
                        if (alive) actionFeedback.set(text);
                      }}
                    />
                  )}
                </Each>
              </View>
            </If>
            <If when={actionFeedback()}>
              <Text style={mutedText()}>{actionFeedback()}</Text>
            </If>
            <View style={{ gap: 4 }}>
              <Disclosure
                label={tr('Dossier watches and activity')}
                open={expanded()}
                onPress={() => {
                  animateDisclosure();
                  expanded.set(!expanded());
                }}
              >
                <Text style={{ ...secondaryTextStyle, color: C.secondary }}>
                  {tr('Dossier watches and activity')}
                </Text>
              </Disclosure>
              <If when={expanded()}>
                <View style={cardStyle()}>
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
                    {tr('Dossier last changed', {
                      time: props.time(detail()!.lastMaterialChangeAt),
                    })}
                  </Text>
                </View>
              </If>
            </View>
          </If>
        </View>
      </Scroll>
      <View style={{ flexShrink: 0, borderTopWidth: 1, borderColor: C.line }}>
        <View style={{ ...readingColumn, paddingVertical: 12 }}>
          <DossierThread
            topicId={topicId}
            ready={detail() !== null}
            threadSessionId={() => detail()?.threadSessionId ?? null}
            openSession={props.openSession}
          />
        </View>
      </View>
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
    <View style={{ flex: 1, minWidth: 0, minHeight: 0, backgroundColor: C.background }}>
      <Header
        title={tr('Discovery dossiers')}
        commands={props.commands}
        browser={props.browser}
        actions={
          <View style={{ ...rowStyle, gap: 4 }}>
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
              style={{ ...rowStyle, gap: 6, paddingHorizontal: 6, minHeight: 28, borderRadius: 8 }}
              hoverStyle={controlHoverStyle()}
              focusStyle={quietFocusStyle()}
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
            <IconButton compact label={tr('Close')} icon="close" onPress={props.close} />
          </View>
        }
      />
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
            width: 268,
            maxWidth: '44%',
            minHeight: 0,
            borderRightWidth: 1,
            borderColor: C.line,
            backgroundColor: C.chrome,
            paddingVertical: 8,
            paddingHorizontal: 6,
          }}
        >
          <List
            ref={list.set}
            each={rows()}
            keyExtractor={(row) => row.topicId}
            estimatedItemSize={54}
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
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                  borderRadius: 8,
                }}
                selectedStyle={{ backgroundColor: C.raised }}
                hoverStyle={controlHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <SignalDot signal={row().signal} />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text
                    style={[
                      {
                        ...secondaryTextStyle,
                        color: row().signal === 'done' ? C.muted : C.text,
                        fontWeight: selection()?.topicId === row().topicId ? '500' : undefined,
                      },
                      { numberOfLines: 2 },
                    ]}
                  >
                    {row().title}
                  </Text>
                  <View style={{ ...rowStyle, gap: 6 }}>
                    <Text style={{ ...mutedText(), fontSize: 12, flexShrink: 1, numberOfLines: 1 }}>
                      {time(row().windowAt ?? row().lastMaterialChangeAt)}
                    </Text>
                    <If when={row().artifactCount > 0}>
                      <View
                        style={{
                          ...rowStyle,
                          gap: 3,
                          paddingHorizontal: 4,
                          borderRadius: 4,
                          backgroundColor: C.card,
                        }}
                      >
                        <Icon name="file" size={12} color={C.muted} />
                        <Text style={{ ...mutedText(), fontSize: 12 }}>{row().artifactCount}</Text>
                      </View>
                    </If>
                    <If when={row().muted}>
                      <Icon name="muted" size={13} color={C.muted} />
                    </If>
                  </View>
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
    </View>
  );
}
