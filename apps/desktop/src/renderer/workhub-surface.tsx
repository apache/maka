import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
} from 'react';
import type {
  WorkHubClarificationItem,
  WorkHubCoordinationItem,
  WorkHubDiscussionItem,
  WorkHubItem,
  WorkHubRouteConfidence,
  WorkHubSnapshot,
  WorkHubWorkBlock,
  WorkHubWorkRef,
} from '@maka/core/workhub';
import { presentWorkHubResultText, sameWorkHubWork, workHubWorkKey } from '@maka/core/workhub';
import type { InteractionAnswer, InteractionRequest } from '@maka/core/interaction';
import type { PermissionMode } from '@maka/core/permission';
import { Button, ChatMessage, ChatMessageBubble, ChatMessageList } from '@astryxdesign/core';
import {
  ChatSurfaceLayout,
  Composer,
  getPermissionModeMeta,
  MarkdownBody,
  PromptAnchorRail,
  useToast,
  type PromptAnchorRailTurn,
  useUiLocale,
} from '@maka/ui';
import { useChatLayoutContext } from '@astryxdesign/core/Chat';
import { workHubIdentityColor } from './workhub-identity.js';
import { useAppShellComposerAttachments } from './use-app-shell-composer-attachments.js';
import {
  toRendererIngestItems,
} from './app-shell-chat-actions.js';
import { preflightAttachmentItems } from './attachment-preflight.js';

const EMPTY_SNAPSHOT: WorkHubSnapshot = { revision: 0, items: [] };

type WorkHubSurfaceProps = {
  onOpenWork(work: WorkHubWorkRef): void;
} & Pick<
  ComponentProps<typeof Composer>,
  | 'modelLabel'
  | 'modelChoices'
  | 'newChatModel'
  | 'newChatProviderType'
  | 'renderProviderMark'
  | 'onPickNewChatModel'
  | 'onOpenModelSettings'
  | 'noModelConnection'
  | 'noModelHint'
  | 'mentionSkills'
>;

export function WorkHubSurface(props: WorkHubSurfaceProps) {
  const locale = useUiLocale();
  const copy = useMemo(() => workHubCopy(locale), [locale]);
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [pending, setPending] = useState<Array<{
    requestId: string;
    text: string;
    workKey?: string;
  }>>([]);
  const [loadError, setLoadError] = useState<string>();
  const [announcement, setAnnouncement] = useState('');
  const [selectedWorkKey, setSelectedWorkKey] = useState<string>();
  const toastApi = useToast();
  const {
    pendingAttachments,
    pickAttachments,
    attachFilePaths,
    removeAttachment,
    clearSubmittedAttachments,
  } = useAppShellComposerAttachments({
    draftKey: selectedWorkKey ? `workhub:${selectedWorkKey}` : 'workhub:unselected',
    toastApi,
  });
  const mounted = useRef(true);
  const latestSnapshot = useRef(EMPTY_SNAPSHOT);
  const openedMetricRecorded = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const result = await window.maka.workHub.handle({ kind: 'inspect' });
      if (mounted.current && result.kind === 'snapshot') {
        latestSnapshot.current = result.snapshot;
        setSnapshot(result.snapshot);
        setLoadError(undefined);
      }
    } catch (error) {
      if (mounted.current) setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!openedMetricRecorded.current) {
      openedMetricRecorded.current = true;
      void window.maka.workHub.handle({ kind: 'record_metric', metric: 'workhub_opened' }).catch(() => {});
    }
    void refresh();
    const unsubscribe = window.maka.workHub.subscribe((event) => {
      if (event.kind !== 'snapshot_changed') return;
      const nextAnnouncement = workHubAnnouncement(
        latestSnapshot.current,
        event.snapshot,
        workHubCopy(locale),
      );
      latestSnapshot.current = event.snapshot;
      setSnapshot(event.snapshot);
      if (nextAnnouncement) setAnnouncement(nextAnnouncement);
      setPending((current) => current.filter(
        ({ requestId }) => !event.snapshot.items.some((item) => item.sourceRequestId === requestId),
      ));
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [locale, refresh]);

  const submit = useCallback(async (text: string, explicitWork?: WorkHubWorkRef) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const attachments = pendingAttachments.length > 0
      ? [...pendingAttachments]
      : undefined;
    if (attachments && !explicitWork) {
      toastApi.info(copy.attachmentTargetTitle, copy.attachmentTargetBody);
      return false;
    }
    if (attachments) {
      try {
        preflightAttachmentItems(attachments, locale);
      } catch (error) {
        toastApi.error(copy.attachmentErrorTitle, errorMessage(error));
        return false;
      }
    }
    const requestId = crypto.randomUUID();
    setPending((current) => [...current, {
      requestId,
      text: trimmed,
      ...(explicitWork ? { workKey: workHubWorkKey(explicitWork) } : {}),
    }]);
    try {
      const result = await window.maka.workHub.handle({
        kind: 'submit',
        requestId,
        text: trimmed,
        ...(explicitWork ? { explicitWork } : {}),
        ...(props.newChatModel ? { modelSelection: props.newChatModel } : {}),
        ...(attachments ? { attachmentItems: toRendererIngestItems(attachments) } : {}),
      });
      if (result.kind === 'work_waiting') {
        setPending((current) => current.filter((item) => item.requestId !== requestId));
        const identity = `${result.block.projectName} / ${result.block.workName}`;
        toastApi.info(copy.workWaitingTitle, copy.workWaitingBody(identity));
        setAnnouncement(copy.workWaitingAnnouncement(identity));
        await refresh();
        return false;
      }
      if (attachments) clearSubmittedAttachments(attachments);
      await refresh();
      return true;
    } catch (error) {
      setPending((current) => current.filter((item) => item.requestId !== requestId));
      setLoadError(errorMessage(error));
      return false;
    }
  }, [
    clearSubmittedAttachments,
    copy.attachmentErrorTitle,
    copy.attachmentTargetBody,
    copy.attachmentTargetTitle,
    locale,
    pendingAttachments,
    props.newChatModel,
    refresh,
    toastApi,
  ]);

  const resolveClarification = useCallback(async (
    item: WorkHubClarificationItem,
    work: WorkHubWorkRef,
  ) => {
    try {
      const result = await window.maka.workHub.handle({
        kind: 'resolve_clarification',
        clarificationId: item.id,
        work,
        ...(props.newChatModel ? { modelSelection: props.newChatModel } : {}),
      });
      if (result.kind === 'work_waiting') {
        const identity = `${result.block.projectName} / ${result.block.workName}`;
        toastApi.info(copy.workWaitingTitle, copy.workWaitingBody(identity));
        setAnnouncement(copy.workWaitingAnnouncement(identity));
        await refresh();
        return false;
      }
      await refresh();
      return true;
    } catch (error) {
      setLoadError(errorMessage(error));
      return false;
    }
  }, [
    copy.workWaitingBody,
    copy.workWaitingTitle,
    copy.workWaitingAnnouncement,
    props.newChatModel,
    refresh,
    toastApi,
  ]);

  const activeWorkCount = useMemo(
    () => snapshot.items.filter(
      (item) => item.kind === 'work' && (item.status === 'running' || item.status === 'waiting_for_user'),
    ).length,
    [snapshot.items],
  );
  const workFilters = useMemo(() => workHubWorkFilters(snapshot.items), [snapshot.items]);
  const selectedWork = useMemo(
    () => [...snapshot.items].reverse().find(
      (item): item is WorkHubWorkBlock =>
        item.kind === 'work' && workHubWorkKey(item.work) === selectedWorkKey,
    ),
    [selectedWorkKey, snapshot.items],
  );
  const selectedWorkIdentity = selectedWork
    ? `${selectedWork.projectName} / ${selectedWork.workName}`
    : undefined;
  const selectedWorkActive = selectedWork?.status === 'running'
    || selectedWork?.status === 'waiting_for_user';
  const visibleItems = useMemo(
    () => selectedWorkKey
      ? snapshot.items.filter(
          (item): item is WorkHubWorkBlock =>
            item.kind === 'work' && workHubWorkKey(item.work) === selectedWorkKey,
        )
      : snapshot.items,
    [selectedWorkKey, snapshot.items],
  );
  const anchorTurns = useMemo(
    () => workHubAnchorTurns(visibleItems, copy),
    [copy, visibleItems],
  );

  useEffect(() => {
    if (selectedWorkKey && !workFilters.some((entry) => entry.key === selectedWorkKey)) {
      setSelectedWorkKey(undefined);
    }
  }, [selectedWorkKey, workFilters]);

  const toggleWorkFilter = useCallback((workKey: string) => {
    setSelectedWorkKey((current) => current === workKey ? undefined : workKey);
  }, []);

  const setSelectedPermission = useCallback(async (mode: PermissionMode) => {
    if (!selectedWork) return;
    await window.maka.workHub.handle({ kind: 'set_permission', work: selectedWork.work, mode });
    await refresh();
  }, [refresh, selectedWork]);

  const stopSelectedWork = useCallback(async () => {
    if (!selectedWork) return;
    await window.maka.workHub.handle({ kind: 'stop_work', work: selectedWork.work });
    await refresh();
  }, [refresh, selectedWork]);

  return (
    <ChatSurfaceLayout
      conversationKey="workhub"
      composer={
        <Composer
          draftKey={selectedWorkKey ? `workhub:${selectedWorkKey}` : 'workhub'}
          streaming={selectedWorkActive}
          onSend={(text) => submit(text, selectedWork?.work)}
          onStop={stopSelectedWork}
          modelLabel={props.modelLabel}
          modelChoices={props.modelChoices}
          newChatModel={props.newChatModel}
          newChatProviderType={props.newChatProviderType}
          renderProviderMark={props.renderProviderMark}
          onPickNewChatModel={props.onPickNewChatModel}
          onOpenModelSettings={props.onOpenModelSettings}
          noModelConnection={props.noModelConnection}
          noModelHint={props.noModelHint}
          mentionSkills={props.mentionSkills}
          pendingAttachments={pendingAttachments}
          onRemoveAttachment={removeAttachment}
          onPickAttachments={selectedWork ? pickAttachments : undefined}
          onAttachFilePaths={selectedWork ? attachFilePaths : undefined}
          permissionMode={selectedWork?.permissionMode}
          onPermissionModeChange={selectedWork ? setSelectedPermission : undefined}
        />
      }
    >
      <main className="maka-main agents-chat-panel agents-chat-view-root workhub-surface">
        <p className="maka-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        <div className="workhub-context-line">
          <span className="workhub-context-title" title={selectedWorkIdentity}>
            {selectedWorkIdentity ? copy.selectedTitle(selectedWorkIdentity) : copy.title}
          </span>
          {activeWorkCount > 0 ? <span>{copy.active(activeWorkCount)}</span> : null}
        </div>
        {workFilters.length > 0 ? (
          <div className="workhub-color-legend" aria-label={copy.colorLegend}>
            <button
              className="workhub-color-filter-all"
              type="button"
              aria-pressed={!selectedWorkKey}
              onClick={() => setSelectedWorkKey(undefined)}
            >
              {copy.allColors}
            </button>
            <div className="workhub-color-scale">
              {workFilters.map((entry) => {
                const selected = selectedWorkKey === entry.key;
                return (
                  <button
                    key={entry.key}
                    className="workhub-color-swatch"
                    type="button"
                    aria-label={copy.filterWork(entry.identity)}
                    aria-pressed={selected}
                    title={entry.identity}
                    style={{ '--workhub-filter-color': entry.color } as CSSProperties}
                    onClick={() => toggleWorkFilter(entry.key)}
                  />
                );
              })}
            </div>
          </div>
        ) : null}
        <div className="maka-chat-shell workhub-chat-shell">
          <WorkHubAnchorRail
            turns={anchorTurns}
            selectedWorkKey={selectedWorkKey}
            onToggleWorkFilter={toggleWorkFilter}
          />
          <ChatMessageList
            className="maka-chat-message-list maka-chatContent workhub-timeline"
            density="compact"
            gap={4}
            emptyState={
              <div className="workhub-empty">
                <h2>{copy.emptyTitle}</h2>
                <p>{copy.emptyBody}</p>
              </div>
            }
          >
            {visibleItems.map((item) => (
              <div className="workhub-anchor-item" data-turn-id={item.id} key={item.id}>
                <WorkHubTimelineItem
                  item={item}
                  selectedWorkKey={selectedWorkKey}
                  onToggleWorkFilter={toggleWorkFilter}
                  onOpenWork={props.onOpenWork}
                  onResolveClarification={resolveClarification}
                  onRefresh={refresh}
                />
              </div>
            ))}
            {pending.filter(
              (item) => !selectedWorkKey || item.workKey === selectedWorkKey,
            ).map((item) => (
              <ChatMessage
                key={item.requestId}
                sender="user"
                aria-label={copy.you}
                className="maka-chat-message maka-user-message workhub-message workhub-message-pending"
              >
                <ChatMessageBubble className="maka-chat-message-bubble maka-chat-message-bubble-user">
                  {item.text}
                </ChatMessageBubble>
              </ChatMessage>
            ))}
            {loadError ? <div className="workhub-error" role="alert">{loadError}</div> : null}
          </ChatMessageList>
        </div>
      </main>
    </ChatSurfaceLayout>
  );
}

function WorkHubAnchorRail(props: {
  turns: readonly PromptAnchorRailTurn[];
  selectedWorkKey?: string;
  onToggleWorkFilter(workKey: string): void;
}) {
  const layout = useChatLayoutContext();
  if (!layout) throw new Error('WorkHubAnchorRail must be rendered inside ChatSurfaceLayout');
  return (
    <PromptAnchorRail
      turns={props.turns}
      scrollRef={layout.scrollContainerRef}
      onNavigateStart={layout.unlockAutoFollow}
      minimumTurns={1}
      selectedGroupId={props.selectedWorkKey}
      onActivate={(turn, activation) => {
        if (activation.repeated && turn.groupId) props.onToggleWorkFilter(turn.groupId);
      }}
    />
  );
}

function workHubAnchorTurns(
  items: readonly WorkHubItem[],
  copy: ReturnType<typeof workHubCopy>,
): PromptAnchorRailTurn[] {
  const replies = new Map(
    items.flatMap((item) =>
      item.kind === 'discussion' && item.role === 'assistant' && item.replyToItemId
        ? [[item.replyToItemId, item.text] as const]
        : []),
  );
  return items.flatMap((item): PromptAnchorRailTurn[] => {
    if (item.kind === 'discussion') {
      return item.role === 'user'
        ? [{ turnId: item.id, label: item.text, reply: replies.get(item.id) }]
        : [];
    }
    if (item.kind === 'clarification') {
      return [{ turnId: item.id, label: item.text, reply: item.question }];
    }
    if (item.kind === 'coordination') {
      return [{
        turnId: item.id,
        label: item.title,
        reply: coordinationStatusLabel(item.status, copy),
      }];
    }
    return [{
      turnId: item.id,
      label: item.requestText,
      reply: item.detail
        ? presentWorkHubResultText(item.detail)
        : statusLabel(item.status, copy),
      contextLabel: item.workName,
      accentColor: workHubIdentityColor(workHubWorkKey(item.work)),
      groupId: workHubWorkKey(item.work),
    }];
  });
}

function WorkHubTimelineItem(props: {
  item: WorkHubItem;
  selectedWorkKey?: string;
  onToggleWorkFilter(workKey: string): void;
  onOpenWork(work: WorkHubWorkRef): void;
  onResolveClarification(item: WorkHubClarificationItem, work: WorkHubWorkRef): Promise<boolean>;
  onRefresh(): Promise<void>;
}) {
  if (props.item.kind === 'discussion') return <DiscussionMessage item={props.item} />;
  if (props.item.kind === 'clarification') {
    return (
      <ClarificationMessages
        item={props.item}
        onResolve={props.onResolveClarification}
      />
    );
  }
  if (props.item.kind === 'coordination') {
    return (
      <CoordinationMessage
        item={props.item}
        onOpenWork={props.onOpenWork}
        onRefresh={props.onRefresh}
      />
    );
  }
  return (
    <WorkMessages
      block={props.item}
      selectedWorkKey={props.selectedWorkKey}
      onToggleWorkFilter={props.onToggleWorkFilter}
      onOpenWork={props.onOpenWork}
      onRefresh={props.onRefresh}
    />
  );
}

function CoordinationMessage(props: {
  item: WorkHubCoordinationItem;
  onOpenWork(work: WorkHubWorkRef): void;
  onRefresh(): Promise<void>;
}) {
  const copy = workHubCopy(useUiLocale());
  const active = props.item.status === 'active' || props.item.status === 'waiting_for_user';
  const byId = new Map(props.item.nodes.map((node) => [node.nodeId, node]));
  const completed = props.item.nodes.filter((node) => node.status === 'completed').length;
  const stop = async () => {
    await window.maka.workHub.handle({
      kind: 'stop_coordination',
      coordinationId: props.item.id,
    });
    await props.onRefresh();
  };
  return (
    <ChatMessage
      sender="assistant"
      aria-label={`${copy.coordination}: ${props.item.title}, ${coordinationStatusLabel(props.item.status, copy)}`}
      className="maka-chat-message maka-assistant-answer workhub-message workhub-coordination-message"
    >
      <ChatMessageBubble
        variant="ghost"
        className="maka-chat-message-bubble maka-chat-message-bubble-assistant"
      >
        <section
          className="workhub-coordination"
          aria-label={`${copy.coordination}: ${props.item.title}, ${coordinationStatusLabel(props.item.status, copy)}`}
        >
          <header>
            <div>
              <strong>{props.item.title}</strong>
              <span>{copy.coordinationProgress(completed, props.item.nodes.length)}</span>
            </div>
            <span data-status={props.item.status}>{coordinationStatusLabel(props.item.status, copy)}</span>
          </header>
          <ol>
            {props.item.nodes.map((node) => {
              const predecessors = props.item.edges
                .filter((edge) => edge.toNodeId === node.nodeId)
                .map((edge) => byId.get(edge.fromNodeId)?.workName)
                .filter((name): name is string => Boolean(name));
              return (
                <li key={node.nodeId} data-status={node.status}>
                  <span className="workhub-coordination-node-marker" aria-hidden="true" />
                  <button
                    type="button"
                    aria-label={`${node.projectName} / ${node.workName}, ${coordinationNodeStatusLabel(node.status, copy)}`}
                    onClick={() => props.onOpenWork(node.work)}
                  >
                    <strong>{node.projectName} / {node.workName}</strong>
                    <span>{node.instruction}</span>
                    {predecessors.length > 0 ? (
                      <small>{copy.after(predecessors.join(', '))}</small>
                    ) : null}
                  </button>
                  <span>{coordinationNodeStatusLabel(node.status, copy)}</span>
                </li>
              );
            })}
          </ol>
          {active ? (
            <div className="workhub-actions">
              <Button label={copy.stopCoordination} variant="ghost" size="sm" onClick={() => void stop()} />
            </div>
          ) : null}
        </section>
      </ChatMessageBubble>
    </ChatMessage>
  );
}

function DiscussionMessage({ item }: { item: WorkHubDiscussionItem }) {
  const locale = useUiLocale();
  const copy = workHubCopy(locale);
  return (
    <ChatMessage
      sender={item.role}
      aria-label={item.role === 'user' ? copy.you : 'WorkHub'}
      className={`maka-chat-message ${item.role === 'user' ? 'maka-user-message' : 'maka-assistant-answer'} workhub-message`}
    >
      <ChatMessageBubble
        variant={item.role === 'assistant' ? 'ghost' : undefined}
        className={`maka-chat-message-bubble maka-chat-message-bubble-${item.role}`}
      >
        {item.status === 'running' ? <span className="workhub-processing">…</span> : item.text}
      </ChatMessageBubble>
    </ChatMessage>
  );
}

function ClarificationMessages(props: {
  item: WorkHubClarificationItem;
  onResolve(item: WorkHubClarificationItem, work: WorkHubWorkRef): Promise<boolean>;
}) {
  const copy = workHubCopy(useUiLocale());
  const [submitting, setSubmitting] = useState(false);
  const resolvedOption = props.item.resolvedTo
    ? props.item.options.find((option) => sameWorkHubWork(option.work, props.item.resolvedTo!))
    : undefined;
  const resolved = props.item.resolvedTo !== undefined;
  return (
    <section className="workhub-thread" aria-label={copy.clarification}>
      <ChatMessage sender="user" aria-label={copy.you} className="maka-chat-message maka-user-message workhub-message">
        <ChatMessageBubble className="maka-chat-message-bubble maka-chat-message-bubble-user">
          {props.item.text}
        </ChatMessageBubble>
      </ChatMessage>
      <ChatMessage sender="assistant" aria-label="WorkHub" className="maka-chat-message maka-assistant-answer workhub-message">
        <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant">
          <div className="workhub-clarification">
            <span>{props.item.question}</span>
            {resolved ? (
              <span className="workhub-clarification-resolved" role="status">
                {copy.clarificationResolved(
                  resolvedOption
                    ? `${resolvedOption.projectName} / ${resolvedOption.workName}`
                    : copy.selectedWork,
                )}
              </span>
            ) : null}
            <div className="workhub-option-list">
              {props.item.options.map((option) => (
                <Button
                  key={option.candidateId}
                  label={`${option.projectName} / ${option.workName}`}
                  variant="secondary"
                  size="sm"
                  isDisabled={resolved || submitting}
                  onClick={() => {
                    if (resolved || submitting) return;
                    setSubmitting(true);
                    void props.onResolve(props.item, option.work)
                      .finally(() => setSubmitting(false));
                  }}
                />
              ))}
            </div>
          </div>
        </ChatMessageBubble>
      </ChatMessage>
    </section>
  );
}

function WorkMessages(props: {
  block: WorkHubWorkBlock;
  selectedWorkKey?: string;
  onToggleWorkFilter(workKey: string): void;
  onOpenWork(work: WorkHubWorkRef): void;
  onRefresh(): Promise<void>;
}) {
  const locale = useUiLocale();
  const copy = workHubCopy(locale);
  const permissionMeta = getPermissionModeMeta(locale);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const workKey = workHubWorkKey(props.block.work);
  const color = workHubIdentityColor(workKey);
  const workSelected = props.selectedWorkKey === workKey;
  const active = props.block.status === 'running' || props.block.status === 'waiting_for_user';
  const identity = `${props.block.projectName} / ${props.block.workName}`;
  const workFilterLabel = copy.filterWork(identity);
  const correctionOptions = props.block.routing?.correctedTo
    ? []
    : props.block.routing?.alternatives ?? [];
  const canCorrect = props.block.routing?.source !== 'explicit' && correctionOptions.length > 0;
  const resultText = props.block.detail
    ? presentWorkHubResultText(props.block.detail)
    : undefined;
  const answerText = resultText || (props.block.interaction
    ? undefined
    : statusLabel(props.block.status, copy));
  const runCommand = async (command: Parameters<typeof window.maka.workHub.handle>[0]) => {
    await window.maka.workHub.handle(command);
    await props.onRefresh();
  };
  return (
    <section
      className="workhub-thread"
      aria-label={copy.workRegion(identity, statusLabel(props.block.status, copy))}
      style={{ '--workhub-accent': color } as CSSProperties}
    >
      <ChatMessage sender="user" aria-label={`${copy.you}, ${identity}`} className="maka-chat-message maka-user-message workhub-message workhub-work-message">
        <button
          className="workhub-work-color-filter workhub-work-color-filter-user"
          type="button"
          aria-label={workFilterLabel}
          aria-pressed={workSelected}
          title={workFilterLabel}
          onClick={() => props.onToggleWorkFilter(workKey)}
        />
        <ChatMessageBubble className="maka-chat-message-bubble maka-chat-message-bubble-user">
          {props.block.requestText}
        </ChatMessageBubble>
      </ChatMessage>
      <div className="workhub-response-group">
        <ChatMessage sender="assistant" aria-label={`WorkHub, ${identity}`} className="maka-chat-message maka-assistant-answer workhub-message workhub-work-message">
          <button
            className="workhub-work-color-filter workhub-work-color-filter-assistant"
            type="button"
            aria-label={workFilterLabel}
            aria-pressed={workSelected}
            title={workFilterLabel}
            onClick={() => props.onToggleWorkFilter(workKey)}
          />
          <ChatMessageBubble variant="ghost" className="maka-chat-message-bubble maka-chat-message-bubble-assistant">
            {answerText ? (
              resultText
                ? <div className="workhub-answer-text"><MarkdownBody text={answerText} density="compact" /></div>
                : <div className="workhub-answer-text">{answerText}</div>
            ) : null}
            {props.block.interaction ? (
              <WorkHubInteractionCard
                key={props.block.interaction.interactionId}
                interaction={props.block.interaction}
                onAnswer={(answer) => runCommand({
                  kind: 'answer_interaction',
                  work: props.block.work,
                  interactionId: props.block.interaction!.interactionId,
                  answer,
                })}
              />
            ) : null}
            {active ? (
              <div className="workhub-actions">
                <Button
                  label={copy.stop}
                  variant="ghost"
                  size="sm"
                  onClick={() => void runCommand({ kind: 'stop_work', work: props.block.work })}
                />
              </div>
            ) : null}
          </ChatMessageBubble>
        </ChatMessage>
        <div className="workhub-message-meta">
          <button
            className="workhub-work-link"
            type="button"
            aria-label={copy.openWork(identity)}
            title={identity}
            onClick={() => props.onOpenWork(props.block.work)}
          >
            {identity}
          </button>
          <label className="workhub-permission">
            <span>{copy.permission}</span>
            <select
              value={props.block.permissionMode === 'execute' ? 'ask' : props.block.permissionMode}
              onChange={(event) => void runCommand({
                kind: 'set_permission',
                work: props.block.work,
                mode: event.currentTarget.value as 'ask' | 'bypass',
              })}
            >
              {props.block.permissionMode === 'explore' ? (
                <option value="explore" disabled>{permissionMeta.explore.label}</option>
              ) : null}
              <option value="ask">{permissionMeta.ask.label}</option>
              <option value="bypass">{permissionMeta.bypass.label}</option>
            </select>
          </label>
          <span className="workhub-status-line">{statusLabel(props.block.status, copy)}</span>
          {props.block.routing ? (
            <span className="workhub-route-confidence">
              {copy.routeConfidence(props.block.routing.confidence)}
            </span>
          ) : null}
          {canCorrect ? (
            <button
              className="workhub-route-correct-toggle"
              type="button"
              aria-expanded={correctionOpen}
              onClick={() => setCorrectionOpen((open) => !open)}
            >
              {copy.correctRoute}
            </button>
          ) : null}
        </div>
        {correctionOpen ? (
          <div className="workhub-route-correction" role="group" aria-label={copy.correctRoute}>
            <span>{copy.correctRoutePrompt}</span>
            {correctionOptions.map((option) => (
              <button
                key={option.candidateId}
                type="button"
                onClick={() => void runCommand({
                  kind: 'correct_route',
                  blockId: props.block.id,
                  work: option.work,
                }).then(() => setCorrectionOpen(false))}
              >
                {option.projectName} / {option.workName}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function WorkHubInteractionCard(props: {
  interaction: { interactionId: string; request: InteractionRequest };
  onAnswer(answer: InteractionAnswer): Promise<void>;
}) {
  const copy = workHubCopy(useUiLocale());
  const [answers, setAnswers] = useState<Array<string | null>>(() =>
    props.interaction.request.kind === 'question'
      ? props.interaction.request.questions.map(() => null)
      : [],
  );
  const [submitting, setSubmitting] = useState(false);
  const request = props.interaction.request;

  if (request.kind === 'permission') {
    return (
      <div className="workhub-interaction-card">
        <strong>{copy.permissionRequest(request.prompt.toolName)}</strong>
        <span>{permissionReviewText(request.prompt.review)}</span>
        <div className="workhub-option-list">
          <Button
            label={copy.allowOnce}
            variant="primary"
            size="sm"
            onClick={() => void props.onAnswer({
              kind: 'permission', decision: 'allow', rememberForTurn: false,
            })}
          />
          {request.prompt.kind === 'tool_permission' && request.prompt.rememberForTurnAllowed ? (
            <Button
              label={copy.allowTurn}
              variant="secondary"
              size="sm"
              onClick={() => void props.onAnswer({
                kind: 'permission', decision: 'allow', rememberForTurn: true,
              })}
            />
          ) : null}
          <Button
            label={copy.deny}
            variant="ghost"
            size="sm"
            onClick={() => void props.onAnswer({
              kind: 'permission', decision: 'deny', rememberForTurn: false,
            })}
          />
        </div>
      </div>
    );
  }

  if (request.kind === 'sandbox_boundary') {
    return (
      <div className="workhub-interaction-card">
        <strong>{copy.sandboxRequest}</strong>
        <span>{request.justification}</span>
        <div className="workhub-option-list">
          <Button
            label={copy.allow}
            variant="primary"
            size="sm"
            onClick={() => void props.onAnswer({ kind: 'sandbox_boundary', decision: 'allow' })}
          />
          <Button
            label={copy.deny}
            variant="ghost"
            size="sm"
            onClick={() => void props.onAnswer({ kind: 'sandbox_boundary', decision: 'deny' })}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="workhub-interaction-card" aria-busy={submitting || undefined}>
      {request.questions.map((question, questionIndex) => (
        <fieldset key={`${props.interaction.interactionId}-${questionIndex}`}>
          <legend>{question.question}</legend>
          <div className="workhub-question-options">
            {question.options.map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={answers[questionIndex] === option.label}
                data-selected={answers[questionIndex] === option.label ? 'true' : undefined}
                disabled={submitting}
                onClick={() => setAnswers((current) => current.map(
                  (answer, index) => index === questionIndex ? option.label : answer,
                ))}
              >
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <div className="workhub-interaction-footer">
        <span className="workhub-interaction-progress" aria-live="polite">
          {copy.answersSelected(answers.filter((answer) => answer !== null).length, answers.length)}
        </span>
        <Button
          label={submitting ? copy.submitting : copy.answer}
          variant="primary"
          size="sm"
          isDisabled={submitting || answers.some((answer) => answer === null)}
          onClick={() => {
            if (submitting || answers.some((answer) => answer === null)) return;
            setSubmitting(true);
            void props.onAnswer({ kind: 'question', answers }).finally(() => setSubmitting(false));
          }}
        />
      </div>
    </div>
  );
}

function permissionReviewText(
  review: Extract<InteractionRequest, { kind: 'permission' }>['prompt']['review'],
): string {
  switch (review.kind) {
    case 'command': return review.cwd ? `${review.command}\n${review.cwd}` : review.command;
    case 'path': return `${review.operation}: ${review.path}`;
    case 'search': return `${review.operation}: ${review.pattern} · ${review.root}`;
    case 'web': return review.target;
    case 'stdin': return review.input?.text ?? review.ref ?? 'stdin';
    case 'browser': return `Browser: ${review.action}`;
    case 'computer_use': return `${review.app ?? 'Computer'}: ${review.action}`;
    case 'additional_permissions': return review.paths.map((path) => path.path).join('\n');
    case 'tool': return review.arguments.text;
  }
}

function workHubWorkFilters(items: readonly WorkHubItem[]): Array<{
  key: string;
  color: string;
  identity: string;
}> {
  const byWork = new Map<string, {
    key: string;
    color: string;
    identity: string;
  }>();
  for (const item of items) {
    if (item.kind !== 'work') continue;
    const key = workHubWorkKey(item.work);
    if (byWork.has(key)) continue;
    byWork.set(key, {
      key,
      color: workHubIdentityColor(key),
      identity: `${item.projectName} / ${item.workName}`,
    });
  }
  return [...byWork.values()];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLabel(status: WorkHubWorkBlock['status'], copy: ReturnType<typeof workHubCopy>): string {
  return copy.status[status];
}

function coordinationStatusLabel(
  status: WorkHubCoordinationItem['status'],
  copy: ReturnType<typeof workHubCopy>,
): string {
  return copy.coordinationStatus[status];
}

function coordinationNodeStatusLabel(
  status: WorkHubCoordinationItem['nodes'][number]['status'],
  copy: ReturnType<typeof workHubCopy>,
): string {
  return copy.coordinationNodeStatus[status];
}

function workHubAnnouncement(
  previous: WorkHubSnapshot,
  next: WorkHubSnapshot,
  copy: ReturnType<typeof workHubCopy>,
): string {
  const priorStatuses = new Map(
    previous.items
      .filter((item): item is WorkHubWorkBlock => item.kind === 'work')
      .map((item) => [item.id, item.status]),
  );
  const changed = [...next.items].reverse().find(
    (item): item is WorkHubWorkBlock =>
      item.kind === 'work' &&
      priorStatuses.has(item.id) &&
      priorStatuses.get(item.id) !== item.status,
  );
  if (!changed) return '';
  return copy.announcement(
    `${changed.projectName} / ${changed.workName}`,
    statusLabel(changed.status, copy),
  );
}

function workHubCopy(locale: 'zh' | 'en') {
  return locale === 'zh'
    ? {
        title: 'WorkHub · 所有工作', selectedTitle: (identity: string) => `WorkHub · ${identity}`,
        active: (count: number) => `${count} 项处理中`, you: '你',
        colorLegend: '按标识色筛选', allColors: '全部',
        filterWork: (identity: string) => `选择并只显示 Work：${identity}`,
        emptyTitle: '从这里开始任何工作', emptyBody: '直接提问、继续已有工作，或提出一个明确任务。WorkHub 会在需要时帮你选择对应的 Work。',
        attachmentTargetTitle: '请先选择目标 Work', attachmentTargetBody: '附件必须绑定到一项明确的工作。先按标识色筛选 Work，再添加并发送附件。', attachmentErrorTitle: '附件无法发送',
        workWaitingTitle: '这项工作正在等待你的决定', workWaitingBody: (identity: string) => `${identity} 还有一张待处理的交互卡片。请先完成该决定，再发送新请求。`, workWaitingAnnouncement: (identity: string) => `${identity} 正在等待你的决定，新请求尚未发送。`,
        openWork: (identity: string) => `打开 ${identity}`, permission: '权限', stop: '停止',
        routeConfidence: (confidence: WorkHubRouteConfidence) => `路由${{ high: '高', medium: '中', low: '低' }[confidence]}置信度`,
        correctRoute: '更正目标', correctRoutePrompt: '这条消息应该属于：',
        permissionRequest: (tool: string) => `${tool} 请求权限`, sandboxRequest: '请求扩展工作范围',
        allowOnce: '允许一次', allowTurn: '本轮允许', allow: '允许', deny: '拒绝', answer: '提交回答', submitting: '正在提交…',
        answersSelected: (selected: number, total: number) => `已选择 ${selected}/${total}`,
        coordination: '跨 Work 协调', coordinationProgress: (done: number, total: number) => `${done}/${total} 项完成`,
        clarification: '选择目标 Work', clarificationResolved: (identity: string) => `已选择：${identity}`, selectedWork: '目标 Work',
        workRegion: (identity: string, status: string) => `${identity}，${status}`,
        announcement: (identity: string, status: string) => `${identity}：${status}`,
        after: (names: string) => `等待：${names}`, stopCoordination: '停止全部协调',
        status: { running: '处理中…', waiting_for_user: '等待你的决定', completed: '已完成', failed: '失败', stopped: '已停止' },
        coordinationStatus: { active: '协调中…', waiting_for_user: '等待你的决定', completed: '已完成', failed: '未全部完成', stopped: '已停止' },
        coordinationNodeStatus: { pending: '等待前置工作', running: '处理中…', waiting_for_user: '等待你', completed: '完成', failed: '失败', stopped: '停止', blocked: '被阻塞' },
      }
    : {
        title: 'WorkHub · All work', selectedTitle: (identity: string) => `WorkHub · ${identity}`,
        active: (count: number) => `${count} in progress`, you: 'You',
        colorLegend: 'Filter by work color', allColors: 'All',
        filterWork: (identity: string) => `Select and only show Work: ${identity}`,
        emptyTitle: 'Start any work here', emptyBody: 'Ask a question, continue existing work, or state a task. WorkHub will choose the right Work when needed.',
        attachmentTargetTitle: 'Choose a target Work first', attachmentTargetBody: 'Attachments must belong to one specific Work. Filter to a Work before adding and sending files.', attachmentErrorTitle: 'Attachment could not be sent',
        workWaitingTitle: 'This Work is waiting for you', workWaitingBody: (identity: string) => `${identity} has a pending interaction. Resolve it before sending another request.`, workWaitingAnnouncement: (identity: string) => `${identity} is waiting for your decision. The new request was not sent.`,
        openWork: (identity: string) => `Open ${identity}`, permission: 'Permission', stop: 'Stop',
        routeConfidence: (confidence: WorkHubRouteConfidence) => `${{ high: 'High', medium: 'Medium', low: 'Low' }[confidence]} confidence`,
        correctRoute: 'Correct target', correctRoutePrompt: 'This message belongs to:',
        permissionRequest: (tool: string) => `${tool} requests permission`, sandboxRequest: 'Workspace expansion requested',
        allowOnce: 'Allow once', allowTurn: 'Allow for turn', allow: 'Allow', deny: 'Deny', answer: 'Submit answer', submitting: 'Submitting…',
        answersSelected: (selected: number, total: number) => `${selected}/${total} selected`,
        coordination: 'Cross-Work coordination', coordinationProgress: (done: number, total: number) => `${done}/${total} complete`,
        clarification: 'Choose a target Work', clarificationResolved: (identity: string) => `Selected: ${identity}`, selectedWork: 'target Work',
        workRegion: (identity: string, status: string) => `${identity}, ${status}`,
        announcement: (identity: string, status: string) => `${identity}: ${status}`,
        after: (names: string) => `After: ${names}`, stopCoordination: 'Stop coordination',
        status: { running: 'Working…', waiting_for_user: 'Waiting for you', completed: 'Completed', failed: 'Failed', stopped: 'Stopped' },
        coordinationStatus: { active: 'Coordinating…', waiting_for_user: 'Waiting for you', completed: 'Completed', failed: 'Incomplete', stopped: 'Stopped' },
        coordinationNodeStatus: { pending: 'Waiting', running: 'Working…', waiting_for_user: 'Waiting for you', completed: 'Done', failed: 'Failed', stopped: 'Stopped', blocked: 'Blocked' },
      };
}
