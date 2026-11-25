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
  createAnimatedValue,
  Easing,
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
import { DossierThread, readingColumn, ThreadBubble } from './DossierThread';
import { Icon } from './Icon';
import { LoadingIndicator } from './Loading';
import { MarkdownBody } from './MarkdownBody';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsEditor } from './SettingsField';
import { SettingsButton } from './SettingsPage';
import {
  buildDossierStream,
  formatChoiceDispatch,
  formatRelativeTime,
  leadFilePaths,
  pinDossier,
  pendingActionControls,
  sortDossiers,
  splitArtifactPath,
  type DossierChoiceItem,
  type DossierDetail,
  type DossierSelection,
  type DossierSortMode,
  type DossierStreamEntry,
  type DossierSummary,
  type DossiersSnapshot,
} from './discoveryDossiersCore';
import { useHost } from './host';
import { currentLocale, tr, type MessageKey } from './locale';
import { motionEnabled, useBreathingStyle } from './roomMotion';
import { createText, createTransientText, errorText, message, type UiText } from './text';
import {
  C,
  DisclosureChevron,
  Header,
  IconButton,
  animateDisclosure,
  bodyTextStyle,
  captionTextStyle,
  codeTextStyle,
  controlHoverStyle,
  controlDisabledStyle,
  quietFocusStyle,
  secondaryTextStyle,
  textTooltip,
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

const watches = {
  file_hash: 'Dossier file watch',
  http_check: 'Dossier web watch',
  deadline: 'Dossier deadline watch',
} as const;

const statusAccentColor = (signal: DossierSummary['signal']) =>
  signal === 'done' || signal === 'green' ? C.success : signal === 'yellow' ? C.warning : C.danger;

function UrgentHalo() {
  const breathe = useBreathingStyle(true);
  return (
    <View
      accessibilityElementsHidden
      style={[
        {
          position: 'absolute',
          top: 1,
          left: 1,
          width: 14,
          height: 14,
          borderRadius: 7,
          backgroundColor: C.danger + '32',
          pointerEvents: 'none',
        },
        breathe,
      ]}
    />
  );
}

/** Pure graphical state: red when awaiting attention/updated, green check when resolved. */
function StatusGraphic(props: { signal: DossierSummary['signal'] }) {
  return (
    <View
      accessibilityLabel={tr(signals[props.signal])}
      tooltip={textTooltip(() => tr(signals[props.signal]))}
      style={{
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <If
        when={props.signal === 'done'}
        else={
          <>
            <If when={props.signal === 'red' && motionEnabled()}>
              <UrgentHalo />
            </If>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: statusAccentColor(props.signal),
              }}
            />
          </>
        }
      >
        <Icon name="statusSuccess" size={15} color={C.success} />
      </If>
    </View>
  );
}

const rowStyle = { flexDirection: 'row', alignItems: 'center', gap: 8 } as const;
const mutedText = () => ({ ...captionTextStyle, fontSize: 12, color: C.muted });
const eyebrowStyle = () => ({ ...mutedText(), fontWeight: '600' as const, letterSpacing: 0.4 });
const titleStyle = () => ({ ...bodyTextStyle, color: C.text, fontWeight: '600' as const });
const cardStyle = () => ({
  backgroundColor: C.background,
  borderWidth: 1,
  borderColor: C.line,
  borderRadius: 12,
});
const previewStyle = () => ({
  backgroundColor: C.surface,
  borderRadius: 8,
  padding: 10,
});

function MetadataChip(props: { text: string }) {
  return (
    <View
      style={{
        maxWidth: '100%',
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 10,
        backgroundColor: C.surface,
      }}
    >
      <Text style={mutedText()}>{props.text}</Text>
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

function ArtifactCard(props: {
  artifact: DossierDetail['artifacts'][number];
  topicId: string;
  open: boolean;
  dimmed?: boolean;
  toggle(path: string): void;
}) {
  const path = computed(() => splitArtifactPath(props.artifact.path));
  return (
    <View style={{ ...cardStyle(), opacity: props.dimmed ? 0.72 : 1 }}>
      <Button
        accessibilityLabel={tr('Preview staged artifact', { path: props.artifact.path })}
        tooltip={textTooltip(() => props.artifact.path)}
        selected={props.open}
        onPress={inputAction(props.toggle, props.artifact.path)}
        style={{
          ...rowStyle,
          gap: 10,
          paddingHorizontal: 12,
          paddingVertical: 9,
          borderRadius: 12,
        }}
        hoverStyle={{ backgroundColor: C.surface }}
        focusStyle={quietFocusStyle()}
      >
        <Icon name="paperclip" size={16} color={C.muted} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ ...rowStyle, gap: 6, flexWrap: 'wrap' }}>
            <Text style={{ ...titleStyle(), maxWidth: '100%', numberOfLines: 1 }}>
              {path().name}
            </Text>
            <If when={path().dir}>
              <Text style={{ ...mutedText(), flexShrink: 1, numberOfLines: 1 }}>{path().dir}</Text>
            </If>
          </View>
          <If when={props.artifact.purpose}>
            <Text style={mutedText()}>{props.artifact.purpose}</Text>
          </If>
        </View>
        <DisclosureChevron open={props.open} size={13} color={C.muted} />
      </Button>
      <If when={props.open}>
        <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
          <ArtifactPreview topicId={props.topicId} path={props.artifact.path} />
        </View>
      </If>
    </View>
  );
}

function ChoiceCards(props: {
  choices: readonly DossierChoiceItem[];
  chosenKey: string | null | undefined;
  interactive: boolean;
  busy: boolean;
  onChoose(choice: DossierChoiceItem): void;
}) {
  const indexed = computed(() =>
    props.choices.map((choice, idx) => ({
      choice,
      badge: String.fromCharCode(65 + idx),
    })),
  );
  const picked = () =>
    props.chosenKey ? indexed().find((item) => item.choice.key === props.chosenKey) : undefined;
  return (
    <If
      when={Boolean(props.chosenKey)}
      else={
        <If when={props.interactive && props.choices.length > 0}>
          <View style={{ gap: 8, paddingTop: 4 }}>
            <Each of={indexed()} key={(item) => item.choice.key}>
              {(item) => (
                <Button
                  accessibilityLabel={`${item().badge} ${item().choice.label}`}
                  disabled={props.busy}
                  onPress={inputAction(props.onChoose, item().choice)}
                  style={{
                    ...rowStyle,
                    gap: 12,
                    paddingHorizontal: 13,
                    paddingVertical: 10,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: C.line,
                    backgroundColor: C.surface,
                  }}
                  hoverStyle={{ backgroundColor: C.raised, borderColor: C.accent + '88' }}
                  activeStyle={motionEnabled() ? { transform: [{ scale: 0.99 }] } : undefined}
                  focusStyle={quietFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <View
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 7,
                      borderWidth: 1,
                      borderColor: C.line,
                      backgroundColor: C.background,
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <Text
                      style={{
                        ...codeTextStyle,
                        fontSize: 12,
                        fontWeight: '600',
                        color: C.text,
                      }}
                    >
                      {item().badge}
                    </Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <View style={{ ...rowStyle, gap: 6 }}>
                      <Text style={{ ...secondaryTextStyle, fontWeight: '600', color: C.text }}>
                        {item().choice.label}
                      </Text>
                      <If when={item().choice.recommended}>
                        <View
                          tooltip={textTooltip(() => tr('Dossier choice recommended'))}
                          style={{
                            width: 6,
                            height: 6,
                            borderRadius: 3,
                            backgroundColor: C.accent,
                          }}
                        />
                      </If>
                    </View>
                    <If when={item().choice.detail}>
                      <Text style={{ ...mutedText(), lineHeight: 18 }}>{item().choice.detail}</Text>
                    </If>
                  </View>
                  <Icon name="nowrap" size={14} color={C.muted} />
                </Button>
              )}
            </Each>
          </View>
        </If>
      }
    >
      <View
        style={{
          ...rowStyle,
          gap: 6,
          alignSelf: 'flex-start',
          paddingHorizontal: 10,
          paddingVertical: 5,
          borderRadius: 12,
          backgroundColor: C.surface,
          borderWidth: 0.5,
          borderColor: C.line,
        }}
      >
        <Icon name="statusSuccess" size={13} color={C.success} />
        <Text style={{ ...mutedText(), color: C.text }}>
          {tr('Dossier chosen option', {
            key: picked()?.badge ?? props.chosenKey!,
            label: picked()?.choice.label ?? props.chosenKey!,
          })}
        </Text>
      </View>
    </If>
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
    <View
      style={{
        ...cardStyle(),
        padding: 12,
        gap: 8,
        borderColor: status() === 'awaiting_confirm' ? C.warning + '66' : C.line,
      }}
    >
      <Text style={titleStyle()}>{props.action().connectorTool}</Text>
      <View style={previewStyle()}>
        <Scroll style={{ maxHeight: 96 }}>
          <Text style={{ ...codeTextStyle, color: C.secondary, userSelect: 'text' }}>
            {JSON.stringify(props.action().params, null, 2)}
          </Text>
        </Scroll>
      </View>
      <If when={controls().notice !== null}>
        <Text style={{ ...mutedText(), color: C.warning }}>{tr(controls().notice!)}</Text>
      </If>
      <If when={controls().showButtons || busy()}>
        <View style={{ ...rowStyle, flexWrap: 'wrap' }}>
          <If when={controls().showButtons}>
            <SettingsButton
              tactile
              label={tr('Confirm dossier action')}
              tone="primary"
              disabled={!controls().confirm}
              onPress={() => void submit(false)}
            />
            <SettingsButton
              tactile
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
        <Text style={mutedText()}>{tr('Dossier action executing')}</Text>
      </If>
      <If when={error()}>
        <Text style={{ ...captionTextStyle, color: C.danger }}>{error()}</Text>
      </If>
    </View>
  );
}

function DossierStickyHeader(props: {
  detail: DossierDetail;
  session: string | null;
  time(at: number): string;
  saving: boolean;
  scrollToLatest(): void;
  openSession(id: string): void;
  resolve(resolved: boolean): void;
  mute(muted: boolean): void;
}) {
  const expanded = signal(false);
  const resolved = () => props.detail.signal === 'done';
  const resolveLabel = () => tr(resolved() ? 'Reopen dossier' : 'Resolve dossier');
  const muteLabel = () => tr(props.detail.muted ? 'Unmute dossier' : 'Mute dossier');
  return (
    <View
      style={{
        borderBottomWidth: 0.5,
        borderColor: C.line,
        backgroundColor: C.background,
        flexShrink: 0,
      }}
    >
      <View style={{ ...readingColumn, paddingVertical: 11, gap: 8 }}>
        <View style={{ ...rowStyle, gap: 8 }}>
          <Button
            onPress={props.scrollToLatest}
            style={{ ...rowStyle, flex: 1, minWidth: 0, gap: 8, paddingVertical: 2 }}
            focusStyle={quietFocusStyle()}
          >
            <StatusGraphic signal={props.detail.signal} />
            <Text
              role="header"
              style={{
                flex: 1,
                minWidth: 0,
                color: C.text,
                fontSize: 15,
                lineHeight: 22,
                fontWeight: '600',
                numberOfLines: 1,
              }}
            >
              {props.detail.title}
            </Text>
          </Button>
          <View style={{ ...rowStyle, gap: 4, flexShrink: 0 }}>
            <If when={props.session !== null}>
              <SettingsButton
                label={tr('Open full thread')}
                tone="quiet"
                onPress={inputAction(props.openSession, props.session!)}
              />
            </If>
            <Button
              accessibilityLabel={tr('Dossier watches and activity')}
              tooltip={textTooltip(() => tr('Dossier watches and activity'))}
              selected={expanded()}
              onPress={() => {
                animateDisclosure();
                expanded.set(!expanded());
              }}
              style={{ ...rowStyle, gap: 3, paddingHorizontal: 7, height: 26, borderRadius: 13 }}
              selectedStyle={{ backgroundColor: C.surface }}
              hoverStyle={controlHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="readOnly" size={14} color={C.muted} />
              <DisclosureChevron open={expanded()} size={11} color={C.muted} />
            </Button>
            <Button
              accessibilityLabel={resolveLabel()}
              tooltip={textTooltip(resolveLabel)}
              disabled={props.saving}
              onPress={inputAction(props.resolve, !resolved())}
              style={{
                width: 26,
                height: 26,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 13,
                backgroundColor: resolved() ? C.success + '18' : 'transparent',
              }}
              hoverStyle={controlHoverStyle()}
              activeStyle={motionEnabled() ? { transform: [{ scale: 0.92 }] } : undefined}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="statusSuccess" size={15} color={resolved() ? C.success : C.muted} />
            </Button>
            <Button
              accessibilityLabel={muteLabel()}
              tooltip={textTooltip(muteLabel)}
              disabled={props.saving}
              onPress={inputAction(props.mute, !props.detail.muted)}
              style={{
                width: 26,
                height: 26,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 13,
              }}
              hoverStyle={controlHoverStyle()}
              activeStyle={motionEnabled() ? { transform: [{ scale: 0.92 }] } : undefined}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="muted" size={15} color={props.detail.muted ? C.accent : C.muted} />
            </Button>
          </View>
        </View>
        <If when={props.detail.windowAt != null || props.detail.linkedTaskIds.length > 0}>
          <View style={{ ...rowStyle, flexWrap: 'wrap', gap: 6 }}>
            <If when={props.detail.windowAt != null}>
              <MetadataChip
                text={tr('Dossier window', { time: props.time(props.detail.windowAt!) })}
              />
            </If>
            <If when={props.detail.linkedTaskIds.length > 0}>
              <MetadataChip
                text={tr(
                  props.detail.linkedTaskIds.length === 1
                    ? 'One linked schedule'
                    : 'Linked schedules count',
                  { count: props.detail.linkedTaskIds.length },
                )}
              />
            </If>
          </View>
        </If>
        <If when={expanded()}>
          <View style={{ borderLeftWidth: 2, borderColor: C.line, paddingLeft: 12, gap: 4 }}>
            <Each of={props.detail.watches} key={(watch) => watch.watchId}>
              {(watch) => (
                <View tooltip={textTooltip(() => watch().target)} style={rowStyle}>
                  <Text style={mutedText()}>{tr(watches[watch().kind])}</Text>
                  <Text
                    style={{ ...mutedText(), color: C.secondary, flexShrink: 1, numberOfLines: 1 }}
                  >
                    {watch().kind === 'file_hash'
                      ? splitArtifactPath(watch().target).name
                      : watch().target}
                  </Text>
                </View>
              )}
            </Each>
            <Text style={mutedText()}>
              {tr('Dossier last checked', { time: props.time(props.detail.lastCheckedAt) })}
            </Text>
            <Text style={mutedText()}>
              {tr('Dossier last changed', { time: props.time(props.detail.lastMaterialChangeAt) })}
            </Text>
          </View>
        </If>
      </View>
    </View>
  );
}

function RevisionDivider(props: { label: string; isLatest: boolean }) {
  return (
    <View style={{ ...rowStyle, gap: 10, paddingTop: 2 }}>
      <View style={{ flex: 1, height: 0.5, backgroundColor: C.line }} />
      <View
        style={{
          paddingHorizontal: 9,
          paddingVertical: 2,
          borderRadius: 10,
          backgroundColor: props.isLatest ? C.surface : 'transparent',
          borderWidth: props.isLatest ? 0.5 : 0,
          borderColor: C.line,
        }}
      >
        <Text
          style={{
            ...captionTextStyle,
            fontSize: 11,
            color: props.isLatest ? C.text : C.muted,
            fontWeight: props.isLatest ? '500' : undefined,
          }}
        >
          {props.label}
        </Text>
      </View>
      <View style={{ flex: 1, height: 0.5, backgroundColor: C.line }} />
    </View>
  );
}

function DossierPane(
  props: Pick<DossiersProps, 'snapshot' | 'botSession' | 'openLink' | 'openSession'> & {
    topicId: string;
    time(at: number): string;
    relative(at: number): string;
  },
) {
  const host = useHost();
  const topicId = props.topicId;
  const detail = signal<DossierDetail | null>(null);
  const artifactPath = signal<string | null>(null);
  const toggleArtifact = (path: string) => {
    animateDisclosure();
    artifactPath.set(artifactPath() === path ? null : path);
  };
  const saving = signal(false);
  const error = createText();
  const readError = createText();
  const actionFeedback = createTransientText();
  const page = motionEnabled() ? createAnimatedValue(0) : undefined;
  const entrance = page && {
    opacity: page.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
    transform: [{ translateY: page.interpolate({ inputRange: [0, 1], outputRange: [5, 0] }) }],
  };
  if (page) {
    void page.timing(1, { duration: 170, easing: Easing.out(Easing.cubic) });
    cleanup(() => page.stop());
  }
  let alive = true,
    reading = false,
    dirty = false,
    lastDetailKey = '';
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
            // Ignore background watch polls that only bump lastCheckedAt without changing visible dossier content.
            const key = value
              ? JSON.stringify({
                  ...value,
                  lastCheckedAt: 0,
                  updatedAt: 0,
                })
              : 'null';
            if (key !== lastDetailKey) {
              lastDetailKey = key;
              detail.set(value);
            }
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
  const resolve = async (resolved: boolean) => {
    if (!alive || saving()) return;
    saving.set(true);
    error.set('');
    try {
      await host.mutateAgent('setDossierResolved', { topicId, resolved });
      if (alive) await refresh();
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'Could not update dossier status.'));
    } finally {
      if (alive) saving.set(false);
    }
  };
  const scope = () => detail()?.threadSessionId ?? props.botSession();
  const hasMultipleRevisions = () => (detail()?.revisions?.length ?? 0) > 1;

  return (
    <View
      style={[
        { flex: 1, minWidth: 0, minHeight: 0, backgroundColor: C.background },
        motionEnabled() ? entrance : undefined,
      ]}
    >
      <DossierThread
        topicId={topicId}
        ready={detail() !== null}
        hasHistory={hasMultipleRevisions}
        threadSessionId={() => detail()?.threadSessionId ?? null}
        openSession={props.openSession}
        header={({ scrollToLatest, session }) => (
          <If when={detail() !== null}>
            <DossierStickyHeader
              detail={detail()!}
              session={session()}
              time={props.time}
              saving={saving()}
              scrollToLatest={scrollToLatest}
              openSession={props.openSession}
              resolve={(next) => void resolve(next)}
              mute={(next) => void mute(next)}
            />
          </If>
        )}
        renderStream={({ turns, sendMessage, sending, anchorLatest, onTurnArrival }) => {
          const stream = computed(() => (detail() ? buildDossierStream(detail()!, turns()) : null));
          const choose = async (revision: number, choice: DossierChoiceItem) => {
            if (!alive || saving() || sending()) return;
            saving.set(true);
            error.set('');
            try {
              await host.mutateAgent('chooseDossierOption', {
                topicId,
                revision,
                key: choice.key,
                resolve: Boolean(choice.resolves),
              });
              await sendMessage(formatChoiceDispatch(choice), { elevate: !choice.resolves });
              if (alive) await refresh();
            } catch (reason) {
              if (alive) error.set(errorText(reason, 'Could not update dossier status.'));
            } finally {
              if (alive) saving.set(false);
            }
          };
          return (
            <>
              <If when={readError()}>
                <View style={rowStyle}>
                  <Text style={{ ...mutedText(), flex: 1 }}>{readError()}</Text>
                  <SettingsButton label={tr('Retry')} tone="quiet" onPress={() => void refresh()} />
                </View>
              </If>
              <If when={error()}>
                <Text style={{ ...mutedText(), color: C.danger }}>{error()}</Text>
              </If>
              <If
                when={stream() !== null}
                else={
                  <If when={!readError()}>
                    <LoadingIndicator />
                  </If>
                }
              >
                <If when={stream()!.hasHistory}>
                  <Text style={{ ...mutedText(), fontSize: 11, textAlign: 'center', opacity: 0.7 }}>
                    {tr('Dossier earlier records')}
                  </Text>
                </If>
                <Each of={stream()!.entries} key={(entry) => entry.key}>
                  {(entry: () => DossierStreamEntry) => (
                    <If
                      when={entry().kind === 'revision'}
                      else={(() => {
                        const turnEntry = () =>
                          entry() as Extract<DossierStreamEntry, { kind: 'turn' }>;
                        return (
                          <ThreadBubble
                            turn={turnEntry().turn}
                            timeLabel={
                              turnEntry().turn.at !== undefined
                                ? props.relative(turnEntry().turn.at!)
                                : undefined
                            }
                            dimmed={turnEntry().isHistorical}
                            onArrival={onTurnArrival}
                          />
                        );
                      })()}
                    >
                      {(() => {
                        const revEntry = () =>
                          entry() as Extract<DossierStreamEntry, { kind: 'revision' }>;
                        const rev = () => revEntry().revision;
                        const artifacts = () => rev().artifacts ?? [];
                        const dividerLabel = () => {
                          const stage =
                            revEntry().index === 0
                              ? tr('Dossier first finding')
                              : tr('Dossier revised finding');
                          const suffix =
                            revEntry().isLatest && revEntry().totalRevisions > 1
                              ? ` · ${tr('Dossier latest badge')}`
                              : '';
                          return `${props.relative(rev().at)} · ${stage}${suffix}`;
                        };
                        const summaryText = computed(() => rev().summaryMd);
                        const markdownRow = computed(() => ({
                          key: `${topicId}/${rev().revision}`,
                          field: 'body',
                          role: 'assistant',
                          text: summaryText(),
                          prefix: true,
                        }));
                        return (
                          <View
                            onLayout={
                              revEntry().isLatest
                                ? ({ bounds }) => anchorLatest(bounds.origin.y)
                                : undefined
                            }
                            style={{ gap: 10 }}
                          >
                            <RevisionDivider
                              label={dividerLabel()}
                              isLatest={revEntry().isLatest}
                            />
                            <View
                              style={{
                                borderRadius: 14,
                                borderWidth: 1,
                                borderColor: C.line,
                                backgroundColor: revEntry().isHistorical ? C.surface : C.background,
                                opacity: revEntry().isHistorical ? 0.78 : 1,
                                paddingHorizontal: 18,
                                paddingVertical: 15,
                                gap: 12,
                              }}
                            >
                              <If when={rev().title !== detail()!.title}>
                                <Text
                                  style={{
                                    color: C.text,
                                    fontSize: revEntry().isHistorical ? 15 : 17,
                                    lineHeight: 24,
                                    fontWeight: '600',
                                  }}
                                >
                                  {rev().title}
                                </Text>
                              </If>
                              <If when={Boolean(rev().changeNote)}>
                                <Text style={{ ...mutedText(), color: C.secondary }}>
                                  {'↳ ' + rev().changeNote}
                                </Text>
                              </If>
                              <MarkdownBody
                                row={markdownRow}
                                text={summaryText}
                                sourceId={`dossier/${topicId}/${rev().revision}`}
                                sessionId={null}
                                interactiveBlocks={false}
                                userScroll={() => {}}
                                openLink={async (target, restoreFocus) => {
                                  try {
                                    await props.openLink(scope(), target, restoreFocus);
                                  } catch (reason) {
                                    if (alive)
                                      error.set(errorText(reason, 'The link could not be opened'));
                                  }
                                }}
                              />
                              <If when={artifacts().length > 0}>
                                <View style={{ gap: 8 }}>
                                  <Text role="header" style={eyebrowStyle()}>
                                    {tr('Dossier artifacts')}
                                  </Text>
                                  <Each
                                    of={artifacts()}
                                    key={(artifact) =>
                                      JSON.stringify([
                                        rev().revision,
                                        artifact.path,
                                        artifact.sha256,
                                      ])
                                    }
                                  >
                                    {(artifact) => (
                                      <ArtifactCard
                                        artifact={artifact()}
                                        topicId={topicId}
                                        dimmed={revEntry().isHistorical}
                                        open={artifactPath() === artifact().path}
                                        toggle={toggleArtifact}
                                      />
                                    )}
                                  </Each>
                                </View>
                              </If>
                              <If when={revEntry().isLatest && detail()!.pendingActions.length > 0}>
                                <View style={{ gap: 8 }}>
                                  <Text role="header" style={eyebrowStyle()}>
                                    {tr('Dossier pending actions')}
                                  </Text>
                                  <Each
                                    of={detail()!.pendingActions}
                                    key={(action) => action.actionId}
                                  >
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
                              <If when={revEntry().isLatest && Boolean(actionFeedback())}>
                                <Text style={mutedText()}>{actionFeedback()}</Text>
                              </If>
                              <ChoiceCards
                                choices={revEntry().choices}
                                chosenKey={rev().chosenKey}
                                interactive={revEntry().isLatest}
                                busy={saving() || sending()}
                                onChoose={(choice) => void choose(rev().revision, choice)}
                              />
                            </View>
                          </View>
                        );
                      })()}
                    </If>
                  )}
                </Each>
              </If>
            </>
          );
        }}
      />
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
  const sortMode = signal<DossierSortMode>('recent');
  const plans = signal<string | null>(null);
  const lead = signal<string[] | null>(null);
  const saving = signal(false);
  const error = createText();
  const formatter = computed(
    () => new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'short', timeStyle: 'short' }),
  );
  const time = (at: number) => formatter().format(at);
  const now = signal(Date.now());
  const clock = setInterval(() => now.set(Date.now()), 60_000);
  const relative = (at: number) => formatRelativeTime(at, now(), currentLocale());
  const rows = computed(() => sortDossiers(props.snapshot()?.dossiers ?? [], sortMode()));
  let alive = true;
  cleanup(() => {
    alive = false;
    clearInterval(clock);
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
            width: 274,
            maxWidth: '44%',
            minHeight: 0,
            borderRightWidth: 1,
            borderColor: C.line,
            backgroundColor: C.chrome,
            paddingHorizontal: 8,
            paddingBottom: 8,
          }}
        >
          <View
            style={{
              ...rowStyle,
              justifyContent: 'space-between',
              paddingHorizontal: 4,
              paddingVertical: 12,
            }}
          >
            <SettingsButton
              tactile
              label={tr('Drop lead')}
              icon="plus"
              onPress={() => lead.set([])}
            />
            <View style={{ ...rowStyle, gap: 6 }}>
              <Button
                accessibilityLabel={tr(
                  sortMode() === 'recent' ? 'Dossier sort recent' : 'Dossier sort priority',
                )}
                onPress={() => sortMode.set(sortMode() === 'recent' ? 'priority' : 'recent')}
                style={{ paddingHorizontal: 7, paddingVertical: 3, borderRadius: 8 }}
                hoverStyle={controlHoverStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Text style={mutedText()}>
                  {'↕ ' +
                    tr(sortMode() === 'recent' ? 'Dossier sort recent' : 'Dossier sort priority')}
                </Text>
              </Button>
              <If when={props.snapshot()}>
                <View
                  accessibilityLabel={tr('Dossier count', { count: rows().length })}
                  tooltip={textTooltip(() => tr('Dossier count', { count: rows().length }))}
                  style={{
                    minWidth: 22,
                    alignItems: 'center',
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 10,
                    backgroundColor: C.surface,
                  }}
                >
                  <Text style={mutedText()}>{rows().length}</Text>
                </View>
              </If>
            </View>
          </View>
          <List
            ref={list.set}
            each={rows()}
            keyExtractor={(row) => row.topicId}
            estimatedItemSize={64}
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
                  paddingHorizontal: 11,
                  paddingVertical: 10,
                  marginVertical: 2,
                  borderRadius: 10,
                  gap: 8,
                }}
                selectedStyle={{ backgroundColor: C.raised }}
                hoverStyle={controlHoverStyle()}
                activeStyle={motionEnabled() ? { transform: [{ scale: 0.985 }] } : undefined}
                focusStyle={quietFocusStyle()}
              >
                <If when={selection()?.topicId === row().topicId}>
                  <View
                    accessibilityElementsHidden
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 9,
                      bottom: 9,
                      width: 2.5,
                      borderRadius: 2,
                      backgroundColor: statusAccentColor(row().signal),
                      pointerEvents: 'none',
                    }}
                  />
                </If>
                <View style={{ alignSelf: 'flex-start', marginTop: 2 }}>
                  <StatusGraphic signal={row().signal} />
                </View>
                <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                  <Text
                    style={[
                      {
                        ...secondaryTextStyle,
                        color: row().signal === 'done' ? C.muted : C.text,
                        fontWeight: selection()?.topicId === row().topicId ? '600' : undefined,
                      },
                      { numberOfLines: 2 },
                    ]}
                  >
                    {row().title}
                  </Text>
                  <View style={{ ...rowStyle, gap: 6 }}>
                    <Text style={{ ...mutedText(), flexShrink: 1, numberOfLines: 1 }}>
                      {relative(row().lastMaterialChangeAt)}
                    </Text>
                    <If when={row().artifactCount > 0}>
                      <View style={{ ...rowStyle, gap: 3 }}>
                        <Icon name="paperclip" size={11} color={C.muted} />
                        <Text style={mutedText()}>{row().artifactCount}</Text>
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
              relative={relative}
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
