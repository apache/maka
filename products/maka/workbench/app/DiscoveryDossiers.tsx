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
import { DiscoveryRuns, ProbeIndicator } from './DiscoveryRuns';
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
  discoveryRuns,
  type WorkerSession,
  formatChoiceDispatch,
  formatRelativeTime,
  leadFilePaths,
  pinDossier,
  pendingActionControls,
  sortDossiers,
  splitArtifactPath,
  splitBubbleBodyAndEvidence,
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
  route(): { topicId: string | null; runId?: string | null } | null;
  snapshot(): DossiersSnapshot | null;
  watchError(): string;
  workers(): readonly WorkerSession[];
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

/** Pure graphical state: eyeOff when unfollowed, green check when done, dot otherwise. */
function StatusGraphic(props: { signal: DossierSummary['signal']; unfollowed?: boolean }) {
  const label = () => (props.unfollowed ? tr('Dossier unfollowed') : tr(signals[props.signal]));
  return (
    <View
      accessibilityLabel={label()}
      tooltip={textTooltip(label)}
      style={{
        width: 16,
        height: 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <If
        when={Boolean(props.unfollowed)}
        else={
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
        }
      >
        <Icon name="eyeOff" size={14} color={C.muted} />
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

function DossierMarkdown(props: {
  rowKey: string;
  text: string;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
}) {
  const row = computed(() => ({
    key: props.rowKey,
    field: 'body',
    role: 'assistant',
    text: props.text,
    prefix: true,
  }));
  return (
    <MarkdownBody
      row={row}
      text={() => props.text}
      sourceId={`dossier/${props.rowKey}`}
      sessionId={null}
      interactiveBlocks={false}
      userScroll={() => {}}
      openLink={props.openLink}
    />
  );
}

function ArtifactPreview(props: { topicId: string; path: string; sha256?: string | null }) {
  const host = useHost();
  const content = signal<string | null>(null);
  const error = createText();
  effect(() => {
    const topicId = props.topicId;
    const path = props.path;
    void props.sha256;
    let alive = true;
    content.set(null);
    error.set('');
    void host.query('agent', 'readDossierArtifact', { topicId, path }).then(
      (text) => {
        if (alive) content.set(text);
      },
      (reason) => {
        if (alive) error.set(errorText(reason, 'Could not preview this artifact.'));
      },
    );
    return () => {
      alive = false;
    };
  });
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
          <ArtifactPreview
            topicId={props.topicId}
            path={props.artifact.path}
            sha256={props.artifact.sha256}
          />
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
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingTop: 2 }}>
            <Each of={indexed()} key={(item) => item.choice.key}>
              {(item) => (
                <Button
                  accessibilityLabel={`${item().badge} ${item().choice.label}`}
                  tooltip={textTooltip(() => item().choice.detail || item().choice.label)}
                  disabled={props.busy}
                  onPress={inputAction(props.onChoose, item().choice)}
                  style={{
                    ...rowStyle,
                    gap: 6,
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: item().choice.recommended ? C.accent + '66' : C.line,
                    backgroundColor: C.surface,
                  }}
                  hoverStyle={{ backgroundColor: C.raised, borderColor: C.accent + '88' }}
                  activeStyle={motionEnabled() ? { transform: [{ scale: 0.98 }] } : undefined}
                  focusStyle={quietFocusStyle()}
                  disabledStyle={controlDisabledStyle}
                >
                  <If when={item().choice.recommended}>
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: C.accent,
                      }}
                    />
                  </If>
                  <Text style={{ ...mutedText(), color: C.text, fontWeight: '500' }}>
                    {item().choice.label}
                  </Text>
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
          borderRadius: 14,
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
        // DossierPane guards actionFeedback and refresh against its own lifetime;
        // PendingActionRow may already have unmounted once the stream drops this row.
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
      if (alive) busy.set(false);
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
  detailsOpen: boolean;
  saving: boolean;
  scrollToLatest(): void;
  toggleDetails(): void;
  resolve(resolved: boolean): void;
  unfollow(unfollowed: boolean): void;
  mute(muted: boolean): void;
}) {
  const unfollowed = () => Boolean(props.detail.unfollowed);
  const resolved = () => !unfollowed() && props.detail.signal === 'done';
  const resolveLabel = () => tr(resolved() ? 'Reopen dossier' : 'Resolve dossier');
  const unfollowLabel = () => tr(unfollowed() ? 'Follow dossier again' : 'Unfollow dossier');
  const muteLabel = () => tr(props.detail.muted ? 'Unmute dossier' : 'Mute dossier');
  const activeWatches = () => (unfollowed() ? 0 : props.detail.watches.length);
  const subtitle = () => {
    const parts = [unfollowed() ? tr('Dossier unfollowed') : tr(signals[props.detail.signal])];
    if (activeWatches() > 0) parts.push(`${activeWatches()} ${tr('Dossier watches and activity')}`);
    if (props.detail.muted && !unfollowed()) parts.push(tr('Dossier muted'));
    return parts.join(' · ');
  };
  return (
    <View
      style={{
        borderBottomWidth: 0.5,
        borderColor: C.line,
        backgroundColor: C.background,
        flexShrink: 0,
      }}
    >
      <View style={{ ...readingColumn, paddingVertical: 11, gap: 4 }}>
        <View style={{ ...rowStyle, gap: 8 }}>
          <Button
            onPress={props.scrollToLatest}
            style={{ ...rowStyle, flex: 1, minWidth: 0, gap: 8, paddingVertical: 2 }}
            focusStyle={quietFocusStyle()}
          >
            <StatusGraphic signal={props.detail.signal} unfollowed={unfollowed()} />
            <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
              <Text
                role="header"
                style={{
                  color: C.text,
                  fontSize: 15,
                  lineHeight: 20,
                  fontWeight: '600',
                  numberOfLines: 1,
                }}
              >
                {props.detail.title}
              </Text>
              <Text style={{ ...mutedText(), fontSize: 11, numberOfLines: 1 }}>{subtitle()}</Text>
            </View>
          </Button>
          <View style={{ ...rowStyle, gap: 4, flexShrink: 0 }}>
            <Button
              accessibilityLabel={tr('Dossier watches and activity')}
              tooltip={textTooltip(() => tr('Dossier details'))}
              selected={props.detailsOpen}
              onPress={() => {
                animateDisclosure();
                props.toggleDetails();
              }}
              style={{ ...rowStyle, gap: 4, paddingHorizontal: 8, height: 28, borderRadius: 14 }}
              selectedStyle={{ backgroundColor: C.surface }}
              hoverStyle={controlHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="readOnly" size={14} color={props.detailsOpen ? C.text : C.muted} />
              <If when={activeWatches() > 0}>
                <Text style={{ ...mutedText(), fontSize: 11, color: C.secondary }}>
                  {activeWatches()}
                </Text>
              </If>
              <DisclosureChevron open={props.detailsOpen} size={11} color={C.muted} />
            </Button>
            <Button
              accessibilityLabel={resolveLabel()}
              tooltip={textTooltip(resolveLabel)}
              disabled={props.saving || unfollowed()}
              onPress={inputAction(props.resolve, !resolved())}
              style={{
                ...rowStyle,
                gap: 4,
                paddingHorizontal: 8,
                height: 28,
                borderRadius: 14,
                backgroundColor: resolved() ? C.success + '18' : 'transparent',
              }}
              hoverStyle={controlHoverStyle()}
              activeStyle={motionEnabled() ? { transform: [{ scale: 0.94 }] } : undefined}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="statusSuccess" size={15} color={resolved() ? C.success : C.muted} />
              <Text
                style={{
                  ...mutedText(),
                  fontSize: 12,
                  color: resolved() ? C.success : C.secondary,
                }}
              >
                {tr('Dossier resolved short')}
              </Text>
            </Button>
            <Button
              accessibilityLabel={unfollowLabel()}
              tooltip={textTooltip(unfollowLabel)}
              disabled={props.saving}
              onPress={inputAction(props.unfollow, !unfollowed())}
              style={{
                ...rowStyle,
                gap: 5,
                paddingHorizontal: 9,
                height: 28,
                borderRadius: 14,
                borderWidth: 0.5,
                borderColor: unfollowed() ? C.warning + '88' : C.line,
                backgroundColor: unfollowed() ? C.warning + '18' : C.surface,
              }}
              hoverStyle={controlHoverStyle()}
              activeStyle={motionEnabled() ? { transform: [{ scale: 0.94 }] } : undefined}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon name="eyeOff" size={14} color={unfollowed() ? C.warning : C.secondary} />
              <Text
                style={{
                  ...mutedText(),
                  fontSize: 12,
                  fontWeight: '500',
                  color: unfollowed() ? C.warning : C.text,
                }}
              >
                {unfollowLabel()}
              </Text>
            </Button>
            <Button
              accessibilityLabel={muteLabel()}
              tooltip={textTooltip(muteLabel)}
              disabled={props.saving || unfollowed()}
              onPress={inputAction(props.mute, !props.detail.muted)}
              style={{
                width: 28,
                height: 28,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 14,
                backgroundColor:
                  props.detail.muted && !unfollowed() ? C.accent + '18' : 'transparent',
              }}
              hoverStyle={controlHoverStyle()}
              activeStyle={motionEnabled() ? { transform: [{ scale: 0.92 }] } : undefined}
              focusStyle={quietFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Icon
                name="muted"
                size={15}
                color={props.detail.muted && !unfollowed() ? C.accent : C.muted}
              />
            </Button>
          </View>
        </View>
      </View>
    </View>
  );
}

function DossierDetailsDrawer(props: {
  detail: DossierDetail;
  session: string | null;
  topicId: string;
  saving: boolean;
  artifactPath: string | null;
  toggleArtifact(path: string): void;
  time(at: number): string;
  close(): void;
  openSession(id: string): void;
  mute(muted: boolean): void;
  unfollow(unfollowed: boolean): void;
}) {
  const unfollowed = () => Boolean(props.detail.unfollowed);
  return (
    <View
      style={{
        width: 268,
        maxWidth: '40%',
        minHeight: 0,
        borderLeftWidth: 1,
        borderColor: C.line,
        backgroundColor: C.chrome,
      }}
    >
      <View
        style={{
          ...rowStyle,
          justifyContent: 'space-between',
          paddingHorizontal: 14,
          paddingVertical: 11,
          borderBottomWidth: 0.5,
          borderColor: C.line,
        }}
      >
        <Text style={titleStyle()}>{tr('Dossier details')}</Text>
        <IconButton compact label={tr('Close')} icon="close" onPress={props.close} />
      </View>
      <Scroll style={{ flex: 1, minHeight: 0 }} contentStyle={{ padding: 14, gap: 14 }}>
        <View style={{ gap: 6 }}>
          <Text style={mutedText()}>
            {tr('Dossier last checked', { time: props.time(props.detail.lastCheckedAt) })}
          </Text>
          <Text style={mutedText()}>
            {tr('Dossier last changed', { time: props.time(props.detail.lastMaterialChangeAt) })}
          </Text>
          <If when={props.detail.windowAt != null || props.detail.linkedTaskIds.length > 0}>
            <View style={{ ...rowStyle, flexWrap: 'wrap', gap: 6, paddingTop: 2 }}>
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
        </View>
        <View style={{ gap: 6, borderTopWidth: 0.5, borderColor: C.line, paddingTop: 10 }}>
          <View style={{ ...rowStyle, justifyContent: 'space-between' }}>
            <Text style={mutedText()}>{tr('Dossier notifications')}</Text>
            <SettingsButton
              label={tr(props.detail.muted ? 'Unmute dossier' : 'Mute dossier')}
              tone="quiet"
              disabled={props.saving || unfollowed()}
              onPress={() => props.mute(!props.detail.muted)}
            />
          </View>
          <View style={{ ...rowStyle, justifyContent: 'space-between' }}>
            <Text style={mutedText()}>{tr('Dossier follow status')}</Text>
            <SettingsButton
              label={tr(unfollowed() ? 'Follow dossier again' : 'Unfollow dossier')}
              tone="quiet"
              disabled={props.saving}
              onPress={() => props.unfollow(!unfollowed())}
            />
          </View>
          <If when={props.session !== null}>
            <SettingsButton
              label={tr('Open full thread')}
              tone="quiet"
              onPress={() => props.openSession(props.session!)}
            />
          </If>
        </View>
        <View style={{ gap: 6, borderTopWidth: 0.5, borderColor: C.line, paddingTop: 10 }}>
          <Text style={eyebrowStyle()}>{tr('Dossier watches and activity')}</Text>
          <If
            when={!unfollowed() && props.detail.watches.length > 0}
            else={
              <Text style={mutedText()}>
                {tr(unfollowed() ? 'Dossier unfollowed preview' : 'Dossier no watches')}
              </Text>
            }
          >
            <Each of={props.detail.watches} key={(watch) => watch.watchId}>
              {(watch) => (
                <View
                  tooltip={textTooltip(() => watch().target)}
                  style={{ ...cardStyle(), paddingHorizontal: 10, paddingVertical: 8, gap: 2 }}
                >
                  <Text style={{ ...mutedText(), fontWeight: '500', color: C.text }}>
                    {tr(watches[watch().kind])}
                  </Text>
                  <Text style={{ ...mutedText(), numberOfLines: 2 }}>{watch().target}</Text>
                </View>
              )}
            </Each>
          </If>
        </View>
        <View style={{ gap: 6, borderTopWidth: 0.5, borderColor: C.line, paddingTop: 10 }}>
          <Text style={eyebrowStyle()}>{tr('Dossier artifacts')}</Text>
          <If
            when={props.detail.artifacts.length > 0}
            else={<Text style={mutedText()}>{tr('Dossier no artifacts')}</Text>}
          >
            <Each
              of={props.detail.artifacts}
              key={(artifact) => JSON.stringify([artifact.path, artifact.sha256])}
            >
              {(artifact) => (
                <ArtifactCard
                  artifact={artifact()}
                  topicId={props.topicId}
                  open={props.artifactPath === artifact().path}
                  toggle={props.toggleArtifact}
                />
              )}
            </Each>
          </If>
        </View>
      </Scroll>
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
  const detailsOpen = signal(false);
  const evidenceOpen = signal<ReadonlySet<number>>(new Set());
  const toggleEvidence = (rev: number) => {
    animateDisclosure();
    const next = new Set(evidenceOpen());
    if (next.has(rev)) next.delete(rev);
    else next.add(rev);
    evidenceOpen.set(next);
  };
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
  const save = async (
    mutate: () => Promise<unknown>,
    fallback: MessageKey = 'Could not update dossier status.',
  ) => {
    if (!alive || saving()) return;
    saving.set(true);
    error.set('');
    try {
      await mutate();
      if (alive) await refresh();
    } catch (reason) {
      if (alive) error.set(errorText(reason, fallback));
    } finally {
      if (alive) saving.set(false);
    }
  };
  const mute = (muted: boolean) =>
    void save(
      () => host.mutateAgent('setDossierMuted', { topicId, muted }),
      'Could not update dossier notifications.',
    );
  const resolve = (resolved: boolean) =>
    void save(() => host.mutateAgent('setDossierResolved', { topicId, resolved }));
  const unfollow = (unfollowed: boolean) =>
    void save(() => host.mutateAgent('setDossierUnfollowed', { topicId, unfollowed }));
  const scope = () => detail()?.threadSessionId ?? props.botSession();
  const openLink = async (target: string, restoreFocus: () => boolean) => {
    try {
      await props.openLink(scope(), target, restoreFocus);
    } catch (reason) {
      if (alive) error.set(errorText(reason, 'The link could not be opened'));
    }
  };
  const threadSession = signal<string | null>(null);

  return (
    <View
      style={[
        { flex: 1, minWidth: 0, minHeight: 0, flexDirection: 'row', backgroundColor: C.background },
        motionEnabled() ? entrance : undefined,
      ]}
    >
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
        <DossierThread
          topicId={topicId}
          ready={detail() !== null}
          threadSessionId={() => detail()?.threadSessionId ?? null}
          openSession={props.openSession}
          header={({ scrollToLatest, session }) => {
            if (threadSession() !== session()) threadSession.set(session());
            return (
              <If when={detail() !== null}>
                <DossierStickyHeader
                  detail={detail()!}
                  detailsOpen={detailsOpen()}
                  saving={saving()}
                  scrollToLatest={scrollToLatest}
                  toggleDetails={() => detailsOpen.set(!detailsOpen())}
                  resolve={resolve}
                  unfollow={unfollow}
                  mute={mute}
                />
              </If>
            );
          }}
          renderStream={({ turns, sendMessage, sending, anchorLatest, onTurnArrival }) => {
            const stream = computed(() =>
              detail() ? buildDossierStream(detail()!, turns()) : null,
            );
            const choose = (revision: number, choice: DossierChoiceItem) => {
              if (sending()) return;
              void save(async () => {
                await host.mutateAgent('chooseDossierOption', {
                  topicId,
                  revision,
                  key: choice.key,
                  resolve: Boolean(choice.resolves),
                });
                if (alive)
                  await sendMessage(formatChoiceDispatch(choice), { elevate: !choice.resolves });
              });
            };
            return (
              <>
                <If when={readError()}>
                  <View style={rowStyle}>
                    <Text style={{ ...mutedText(), flex: 1 }}>{readError()}</Text>
                    <SettingsButton
                      label={tr('Retry')}
                      tone="quiet"
                      onPress={() => void refresh()}
                    />
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
                    <Text
                      style={{ ...mutedText(), fontSize: 11, textAlign: 'center', opacity: 0.7 }}
                    >
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
                          const split = computed(() =>
                            splitBubbleBodyAndEvidence(rev().summaryMd, rev().evidenceMd),
                          );
                          const hasEvidence = () =>
                            Boolean(split().evidence) || artifacts().length > 0;
                          const isEvidenceOpen = () => evidenceOpen().has(rev().revision);
                          return (
                            <View
                              onLayout={revEntry().isLatest ? anchorLatest : undefined}
                              style={{ width: '100%', minWidth: 0, gap: 10 }}
                            >
                              <Text
                                style={{
                                  ...mutedText(),
                                  fontSize: 11,
                                  textAlign: 'center',
                                  opacity: 0.78,
                                }}
                              >
                                {props.time(rev().at)}
                              </Text>
                              <View
                                style={{
                                  alignSelf: 'flex-start',
                                  width: '94%',
                                  maxWidth: '94%',
                                  minWidth: 0,
                                  gap: 8,
                                  opacity: revEntry().isHistorical ? 0.78 : 1,
                                }}
                              >
                                <View
                                  style={{
                                    width: '100%',
                                    minWidth: 0,
                                    borderRadius: 16,
                                    borderBottomLeftRadius: 5,
                                    borderWidth: 0.5,
                                    borderColor: C.line,
                                    backgroundColor: revEntry().isHistorical ? C.surface : C.card,
                                    paddingHorizontal: 15,
                                    paddingVertical: 11,
                                    gap: 8,
                                  }}
                                >
                                  <If when={rev().title !== detail()!.title}>
                                    <Text
                                      style={{
                                        color: C.text,
                                        fontSize: revEntry().isHistorical ? 14 : 15,
                                        lineHeight: 21,
                                        fontWeight: '600',
                                      }}
                                    >
                                      {rev().title}
                                    </Text>
                                  </If>
                                  <DossierMarkdown
                                    rowKey={`${topicId}/${rev().revision}`}
                                    text={split().body}
                                    openLink={openLink}
                                  />
                                  <If when={hasEvidence()}>
                                    <View
                                      style={{
                                        borderTopWidth: 0.5,
                                        borderColor: C.line,
                                        paddingTop: 6,
                                        gap: 8,
                                      }}
                                    >
                                      <Button
                                        accessibilityLabel={tr(
                                          isEvidenceOpen()
                                            ? 'Dossier hide evidence'
                                            : 'Dossier show evidence',
                                        )}
                                        onPress={() => toggleEvidence(rev().revision)}
                                        style={{ alignSelf: 'flex-start', paddingVertical: 2 }}
                                        focusStyle={quietFocusStyle()}
                                      >
                                        <Text style={{ ...mutedText(), color: C.muted }}>
                                          {tr(
                                            isEvidenceOpen()
                                              ? 'Dossier hide evidence'
                                              : 'Dossier show evidence',
                                          )}
                                        </Text>
                                      </Button>
                                      <If when={isEvidenceOpen()}>
                                        <View style={{ gap: 8 }}>
                                          <If when={Boolean(split().evidence)}>
                                            <DossierMarkdown
                                              rowKey={`${topicId}/${rev().revision}/evidence`}
                                              text={split().evidence ?? ''}
                                              openLink={openLink}
                                            />
                                          </If>
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
                                    </View>
                                  </If>
                                  <If
                                    when={
                                      revEntry().isLatest && detail()!.pendingActions.length > 0
                                    }
                                  >
                                    <View style={{ gap: 8, paddingTop: 4 }}>
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
                                </View>
                                <ChoiceCards
                                  choices={revEntry().choices}
                                  chosenKey={rev().chosenKey}
                                  interactive={revEntry().isLatest && !detail()!.unfollowed}
                                  busy={saving() || sending()}
                                  onChoose={(choice) => choose(rev().revision, choice)}
                                />
                              </View>
                            </View>
                          );
                        })()}
                      </If>
                    )}
                  </Each>
                  <If when={Boolean(detail()!.unfollowed)}>
                    <View
                      style={{
                        ...rowStyle,
                        justifyContent: 'space-between',
                        gap: 10,
                        paddingHorizontal: 14,
                        paddingVertical: 10,
                        borderRadius: 12,
                        borderWidth: 0.5,
                        borderColor: C.line,
                        backgroundColor: C.surface,
                      }}
                    >
                      <Text style={{ ...mutedText(), flex: 1 }}>
                        {tr('Dossier unfollowed banner')}
                      </Text>
                      <SettingsButton
                        label={tr('Follow dossier again')}
                        tone="quiet"
                        disabled={saving()}
                        onPress={() => unfollow(false)}
                      />
                    </View>
                  </If>
                </If>
              </>
            );
          }}
        />
      </View>
      <If when={detailsOpen() && detail() !== null}>
        <DossierDetailsDrawer
          detail={detail()!}
          session={threadSession()}
          topicId={topicId}
          saving={saving()}
          artifactPath={artifactPath()}
          toggleArtifact={toggleArtifact}
          time={props.time}
          close={() => detailsOpen.set(false)}
          openSession={props.openSession}
          mute={mute}
          unfollow={unfollow}
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
  const sortMode = signal<DossierSortMode>('recent');
  const showingRuns = signal<{ runId: string | null } | null>(null);
  const runs = computed(() => discoveryRuns(props.workers()));
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
  const relative = (at: number) => formatRelativeTime(at, now(), currentLocale(), tr);
  const rows = computed(() => sortDossiers(props.snapshot()?.dossiers ?? [], sortMode()));
  let alive = true;
  cleanup(() => {
    alive = false;
    clearInterval(clock);
  });
  const select = (topicId: string) => selection.set({ topicId });
  effect(() => {
    const request = props.route();
    if (request?.runId != null) {
      plans.set(null);
      showingRuns.set({ runId: request.runId });
      lead.set(null);
    } else if (request?.topicId != null) {
      selection.set({ topicId: request.topicId, requested: true });
      plans.set(null);
      showingRuns.set(null);
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
            <Button
              accessibilityLabel={tr('Discovery runs')}
              onPress={() => showingRuns.set({ runId: null })}
              style={{ ...rowStyle, paddingHorizontal: 8, minHeight: 28, borderRadius: 6 }}
              hoverStyle={controlHoverStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Text style={mutedText()}>{tr('Discovery runs')}</Text>
              <If when={runs()[0] && runs()[0]!.activity !== 'idle'}>
                <ProbeIndicator />
              </If>
            </Button>
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
            {(row) => {
              const inactive = () => row().signal === 'done' || Boolean(row().unfollowed);
              return (
                <Button
                  accessibilityLabel={[
                    row().title,
                    row().unfollowed ? tr('Dossier unfollowed') : tr(signals[row().signal]),
                    ...(row().muted && !row().unfollowed ? [tr('Dossier muted')] : []),
                  ].join(tr('Discovery list separator'))}
                  selected={selection()?.topicId === row().topicId}
                  onPress={inputAction(select, row().topicId)}
                  style={{
                    ...rowStyle,
                    paddingHorizontal: 11,
                    paddingVertical: 9,
                    marginVertical: 2,
                    borderRadius: 10,
                    gap: 8,
                    opacity: inactive() ? 0.68 : 1,
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
                        backgroundColor: row().unfollowed
                          ? C.muted
                          : statusAccentColor(row().signal),
                        pointerEvents: 'none',
                      }}
                    />
                  </If>
                  <View style={{ alignSelf: 'flex-start', marginTop: 3 }}>
                    <StatusGraphic signal={row().signal} unfollowed={Boolean(row().unfollowed)} />
                  </View>
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <View style={{ ...rowStyle, justifyContent: 'space-between', gap: 6 }}>
                      <Text
                        style={[
                          {
                            ...secondaryTextStyle,
                            flex: 1,
                            minWidth: 0,
                            color: inactive() ? C.muted : C.text,
                            fontWeight: selection()?.topicId === row().topicId ? '600' : undefined,
                          },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {row().title}
                      </Text>
                      <Text style={{ ...mutedText(), fontSize: 11, flexShrink: 0 }}>
                        {row().unfollowed
                          ? tr('Dossier unfollowed short')
                          : relative(row().lastMaterialChangeAt)}
                      </Text>
                    </View>
                    <View style={{ ...rowStyle, gap: 6 }}>
                      <Text style={{ ...mutedText(), flex: 1, minWidth: 0, numberOfLines: 1 }}>
                        {row().unfollowed ? tr('Dossier unfollowed preview') : row().preview}
                      </Text>
                      <If when={row().artifactCount > 0 && !row().unfollowed}>
                        <View style={{ ...rowStyle, gap: 3, flexShrink: 0 }}>
                          <Icon name="paperclip" size={11} color={C.muted} />
                          <Text style={mutedText()}>{row().artifactCount}</Text>
                        </View>
                      </If>
                      <If when={row().muted && !row().unfollowed}>
                        <Icon name="muted" size={13} color={C.muted} />
                      </If>
                    </View>
                  </View>
                </Button>
              );
            }}
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
      <If when={showingRuns() !== null}>
        <DiscoveryRuns
          runs={runs}
          initialRunId={showingRuns()!.runId}
          time={time}
          close={() => showingRuns.set(null)}
        />
      </If>
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
            openWorker={(workerId) => {
              plans.set(null);
              showingRuns.set({ runId: workerId });
            }}
            chooseModel={() => props.chooseModel(id())}
            close={() => plans.set(null)}
          />
        )}
      </Each>
    </View>
  );
}
