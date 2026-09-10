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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatSurfaceLayout, MakaWordmark, useUiLocale, type ComposerHandle } from '@maka/ui';
import { Button, IconButton } from '@astryxdesign/core';
import { ChevronDown, PictureInPicture2, Undo2, X } from '@maka/ui/icons';
import { WorkHubProgressCard } from './workhub-progress-card.js';
import { WorkHubComposer } from './workhub-composer.js';
import { WorkHubConversation } from './workhub-conversation.js';
import { WorkHubNavigationRail } from './workhub-navigation-rail.js';
import { WorkHubHighlightProvider } from './workhub-work-identity.js';
import { getWorkHubRailCopy } from '../../../locales/workhub-copy.js';
import { useWorkHubController } from '../controller/use-workhub-controller.js';
import type { WorkHubControlSnapshot } from '../../../../shared/workhub-control.js';
import type { WorkHubPresentationSnapshot } from '../../../../shared/workhub-presentation.js';
import { workHubLiveCopy } from '../locales/workhub-live-copy.js';
import { workHubLinkedWork } from '../model/linked-work.js';

function cancelReveal(element: HTMLDivElement | null, content: HTMLDivElement | null) {
  for (const target of [element, content]) for (const animation of target?.getAnimations() ?? []) animation.cancel();
  content?.style.removeProperty('pointer-events');
}

function revealWordmark(element: HTMLDivElement | null, content: HTMLDivElement | null) {
  cancelReveal(element, content);
  if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  element.animate([
    { opacity: 0, transform: 'translateY(6px) scale(0.98)', offset: 0 },
    { opacity: 0.9, transform: 'translateY(0) scale(1)', offset: 0.3 },
    { opacity: 0.9, transform: 'translateY(0) scale(1)', offset: 0.5 },
    { opacity: 0, transform: 'translateY(-3px) scale(1)', offset: 0.85 },
    { opacity: 0, transform: 'translateY(-3px) scale(1)', offset: 1 },
  ], { duration: 1200, easing: 'ease-out' });
  if (content) {
    // Non-compositable properties in the same effect force opacity onto the
    // renderer thread. Keep the interaction gate outside the visual keyframes.
    content.style.pointerEvents = 'none';
    const reveal = content.animate([
      { opacity: 0, offset: 0 },
      { opacity: 0, offset: 0.65 },
      { opacity: 1, offset: 1 },
    ], { duration: 1200, easing: 'ease-in-out' });
    reveal.id = 'workhub-reveal';
    reveal.onfinish = () => {
      if (!content.getAnimations().some((animation) => animation.id === 'workhub-reveal' && animation.playState === 'running')) content.style.removeProperty('pointer-events');
    };
  }
}

export function WorkHubRoot() {
  const controller = useWorkHubController();
  const { services, session, transcript, busy } = controller;
  const locale = useUiLocale();
  const t = workHubLiveCopy[locale];
  const shortcutLabel = navigator.platform.toLowerCase().includes('mac') ? '⌘⇧K' : 'Ctrl+Shift+K';
  const composer = useRef<ComposerHandle>(null);
  const composerSurface = useRef<HTMLDivElement>(null);
  const revealMark = useRef<HTMLDivElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const hasPresented = useRef(false);
  const progressHeader = useRef<HTMLElement>(null);
  const surface = useRef<HTMLElement>(null);
  const [editingProgressRequest, setEditingProgressRequest] = useState<number>();
  const [expandedOverride, setConversationExpanded] = useState<boolean>();
  const hasConversation = transcript.messages.length > 0 || busy || Boolean(controller.liveTurn);
  const conversationExpanded = expandedOverride ?? hasConversation;
  const hasConversationRef = useRef(hasConversation);
  hasConversationRef.current = hasConversation;
  const [expandedLayoutHeight, setExpandedLayoutHeight] = useState(720);
  const [control, setControl] = useState<WorkHubControlSnapshot>();
  const [presentation, setPresentation] = useState<WorkHubPresentationSnapshot>();
  const progress = presentation?.progressRequest !== undefined;
  const editingProgress = progress && editingProgressRequest === presentation.progressRequest;
  const floating = presentation?.placement === 'floating';
  const showConversation = !progress && (!floating || conversationExpanded);
  useLayoutEffect(() => {
    const element = surface.current;
    const unsubscribe = services.presentation.onViewportInset((inset) => {
      element?.style.setProperty('--workhub-viewport-inset', `${inset}px`);
    });
    return () => {
      unsubscribe();
      element?.style.removeProperty('--workhub-viewport-inset');
    };
  }, [services]);
  const dockMotion = useRef<{ floating: boolean; progress: boolean; expanded: boolean; padding: Keyframe; animation?: Animation }>(undefined);
  useLayoutEffect(() => {
    const dock = composerSurface.current?.parentElement?.parentElement;
    if (!dock) return;
    const readPadding = (): Keyframe => {
      const style = getComputedStyle(dock);
      return { paddingInlineStart: style.paddingInlineStart, paddingInlineEnd: style.paddingInlineEnd, paddingBottom: style.paddingBottom };
    };
    const previous = dockMotion.current;
    const from = previous?.animation?.playState === 'running' ? readPadding() : previous?.padding;
    previous?.animation?.cancel();
    const padding = readPadding();
    // Animate only a live expand/collapse. Summoning a parked renderer must
    // paint its final gutter immediately; interrupted motion resumes in place.
    const animation = floating && previous?.floating && !progress && !previous.progress && previous.expanded !== showConversation && from && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? dock.animate([from, padding], { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
      : undefined;
    dockMotion.current = { floating, progress, expanded: showConversation, padding, animation };
  }, [floating, progress, showConversation]);
  useEffect(() => () => dockMotion.current?.animation?.cancel(), []);
  const editProgress = () => {
    if (progress) setEditingProgressRequest(presentation.progressRequest);
  };
  const compactHeight = () => Math.ceil(composerSurface.current?.getBoundingClientRect().height ?? 96);
  useLayoutEffect(() => {
    if (!composerSurface.current) return;
    const resize = () => {
      surface.current?.style.setProperty('--workhub-composer-height', `${compactHeight()}px`);
      if (progress) {
        const height = Math.ceil(progressHeader.current?.getBoundingClientRect().height ?? 80) + compactHeight() + 2;
        void services.presentation.resizeProgress(presentation.progressRequest!, height).catch(controller.report);
        return;
      }
      void services.presentation.setConversationLayout({ expanded: conversationExpanded, compactHeight: compactHeight() }).catch(controller.report);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(composerSurface.current);
    if (progressHeader.current) observer.observe(progressHeader.current);
    resize();
    return () => observer.disconnect();
  }, [services, floating, conversationExpanded, presentation?.progressRequest, editingProgress]);
  const toggleConversation = () => {
    if (conversationExpanded) {
      cancelReveal(revealMark.current, history.current);
      setExpandedLayoutHeight(surface.current?.querySelector('.maka-chat-layout')?.getBoundingClientRect().height ?? 0);
      setConversationExpanded(false);
    } else {
      setConversationExpanded(true);
    }
    composer.current?.focus();
  };
  useEffect(() => {
    let active = true;
    const acceptPresentation = (next: WorkHubPresentationSnapshot) => {
      if (!active) return;
      if (next.progressRequest !== undefined) hasPresented.current = true;
      if (next.progressRequest !== undefined || next.placement !== 'floating' || !next.floatingVisible) {
        cancelReveal(revealMark.current, history.current);
        for (const animation of composerSurface.current?.getAnimations() ?? []) animation.cancel();
      }
      if (!hasConversationRef.current && (next.placement === 'docked' || !next.floatingVisible)) setConversationExpanded(undefined);
      setPresentation(next);
    };
    const unsubscribe = services.presentation.subscribe(acceptPresentation);
    void services.presentation
      .getSnapshot()
      .then(acceptPresentation)
      .catch(controller.report);
    const acceptControl = (next: WorkHubControlSnapshot) => {
      if (active)
        setControl((previous) =>
          !previous || next.revision >= previous.revision ? next : previous,
        );
    };
    const unsubscribeControl = services.control.subscribe(acceptControl);
    void services.control.getSnapshot().then(acceptControl).catch(controller.report);
    const focus = services.presentation.onFocusComposer((expand) => {
      if (expand) setConversationExpanded(true);
      composer.current?.focus();
      // A warm summon must not fade the last painted frame back out.
      if (hasPresented.current) return;
      hasPresented.current = true;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      for (const element of [composerSurface.current]) {
        for (const animation of element?.getAnimations() ?? []) animation.cancel();
      }
      composerSurface.current?.animate([
        { opacity: 0.45, transform: 'translateY(8px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ], { duration: 360, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      revealWordmark(revealMark.current, history.current);
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeControl();
      focus();
    };
  }, [services]);
  const tasks = controller.sessions.filter((candidate) => candidate.id !== controller.sessionId && !candidate.labels.includes('mode:side_conversation') && !candidate.subagent).map((task) => ({
    target: { sessionId: task.id }, projectName: task.cwd?.replace(/[/\\]+$/, '').split(/[/\\]/).at(-1) ?? '',
    sessionName: task.name, archived: task.isArchived, state: task.status,
    updatedAt: task.lastMessageAt ?? task.statusUpdatedAt ?? 0,
  }));
  const links = useMemo(() => workHubLinkedWork(transcript.messages, controller.sessions, getWorkHubRailCopy(locale).work), [transcript.messages, controller.sessions, locale]);
  const delegatedSessionIds = links.map((link) => link.targetSessionId);
  const call = (task: Promise<unknown>) => {
    void task.catch(controller.report);
  };
  return (
    <WorkHubHighlightProvider>
    <section ref={surface} data-progress={progress} data-progress-editing={editingProgress} className="workHubLive workhub-surface" data-placement={presentation?.placement ?? 'docked'} data-conversation-expanded={showConversation} aria-label={t.title}>
      {progress && <WorkHubProgressCard ref={progressHeader} request={presentation.progressRequest!} control={control} liveTurn={controller.liveTurn} messages={transcript.messages} busy={busy} onOpen={() => {
        setConversationExpanded(true);
        call(services.presentation.showConversation(presentation.progressRequest));
      }} />}
      {!progress && floating && conversationExpanded && <div className="workHubWindowControls">
        <IconButton className="workHubCloseButton" type="button" size="sm" variant="ghost" icon={<X size={12} />} label={t.hide} onClick={() => call(services.presentation.hide())} />
        <div className="workHubWindowActions">
          <IconButton type="button" size="sm" variant="ghost" icon={<PictureInPicture2 size={14}><path d="m8 11-4-4m0 4V7h4" /></PictureInPicture2>} label={t.dock} onClick={() => call(services.presentation.dock())} />
          <IconButton type="button" size="sm" variant="ghost" icon={<ChevronDown size={14} style={{ rotate: conversationExpanded ? '0deg' : '180deg' }} />} label={conversationExpanded ? t.collapseConversation : t.expandConversation} aria-expanded={conversationExpanded} onClick={toggleConversation} />
        </div>
      </div>}
      <div className="workHubRevealMark" ref={revealMark} aria-hidden="true"><MakaWordmark width={192} /></div>
      <ChatSurfaceLayout
        scrollButton={showConversation ? undefined : null}
        style={!showConversation ? { height: expandedLayoutHeight, flex: 'none', position: 'absolute', bottom: 0, width: '100%' } : undefined}
        onReturnToTail={transcript.hasNewer ? controller.loadLatest : undefined}
        composer={
          <div className="workHubComposerSurface" ref={composerSurface} onFocusCapture={editProgress} onPointerUpCapture={editProgress}>
            {(controller.error || control?.error) && (
              <div className="workHubLiveError" role="alert">
                {controller.error ?? t.controlFailed}
                {controller.canRetry && (
                  <Button label={t.retry} variant="ghost" onClick={controller.retry} />
                )}
              </div>
            )}
            <WorkHubComposer
              pendingMessages={controller.transientMessages}
              queuedMessages={controller.messageQueue.entries}
              queuedMessageRevision={controller.messageQueue.revision}
              onUpdateQueuedEntry={controller.updateQueuedEntry}
              onDeleteQueuedEntry={controller.deleteQueuedEntry}
              onPromoteQueuedEntry={controller.promoteQueuedEntry}
              onReorderQueuedEntries={controller.reorderQueuedEntries}
              placeholder={progress ? t.progressInput : t.welcome}
              ref={composer}
              sessionId={controller.sessionId}
              streaming={busy}
              sendBlocked={!controller.sessionId || controller.sending || !session?.model}
              allowAttachmentImportWhileStreaming
              stopPending={controller.stopPending}
              onSend={async (text, attachments, followUpMode) => {
                const accepted = await controller.send(text, attachments, followUpMode);
                if (accepted) {
                  setConversationExpanded(true);
                  if (progress) call(services.presentation.showConversation(presentation.progressRequest));
                }
                return accepted;
              }}
              onStop={controller.stop}
              activeSession={session}
              activeModel={session?.model}
              activeModelConnectionId={session?.llmConnectionId}
              activeModelConnectionSlug={session?.llmConnectionSlug}
              modelChoices={controller.choices}
              modelPickerPresentation={showConversation ? 'menu' : 'wheel'}
              maxInputRows={progress && !editingProgress ? 1 : showConversation ? undefined : 6}
              onModelChange={controller.changeModel}
              modelSwitchHasHistory={transcript.messages.length > 0}
              footerAccessory={
                <div className="workHubComposerActions">
                  {control?.canUndo && <IconButton type="button" size="sm" variant="ghost" icon={<Undo2 size={16} />} label={t.undo} isDisabled={busy} onClick={() => call(services.control.undo())} />}
                  {!floating && <IconButton type="button" size="sm" variant="ghost" icon={<PictureInPicture2 size={16} />} label={t.float} tooltip={`${t.float} · ${shortcutLabel}`} onClick={() => call(services.presentation.detach())} />}
                </div>
              }
            />
            {!progress && floating && !conversationExpanded && (
              <IconButton className="workHubExpandButton" type="button" size="sm" variant="ghost" icon={<ChevronDown size={14} style={{ rotate: '180deg' }} />} label={t.expandConversation} aria-expanded={false} onClick={toggleConversation} />
            )}
          </div>
        }
      >
        <div ref={history} className="workHubHistory" aria-hidden={!showConversation} inert={!showConversation}>
        {transcript.hasOlder && (
          <Button
            label={t.older}
            variant="ghost"
            onClick={() => {
              const task = controller.loadOlder();
              if (task) call(task);
            }}
          />
        )}
        <div className="workhub-body">
        <WorkHubNavigationRail locale={locale} sessions={tasks} delegatedSessionIds={delegatedSessionIds} copy={getWorkHubRailCopy(locale)} onOpenSession={(id) => call(services.presentation.openSession(id))} />
        <div className="workhub-conversation-shell">
        <WorkHubConversation
          workLinks={links}
          onReadAttachmentBytes={services.readAttachmentBytes}
          onOpenWork={(id) => call(services.presentation.openSession(id))}
          scrollBehavior="auto"
          onNew={() => composer.current?.focus()}
          messages={[...transcript.messages]}
          transientMessages={controller.transientMessages}
          viewportNavigation={controller.viewportNavigation}
          liveTurn={controller.liveTurn}
          onStreamingSettled={controller.streamingSettled}
          runningStatus={busy}
          messageLoading={!transcript.ready}
          activeSession={session}
          activeModel={session?.model}
          emptyOverride={
            <div className="workHubLiveWelcome">
              <MakaWordmark width={112} />
              <p>{t.hint}</p>
            </div>
          }
        />
        </div></div>
        </div>
      </ChatSurfaceLayout>
    </section></WorkHubHighlightProvider>
  );
}
