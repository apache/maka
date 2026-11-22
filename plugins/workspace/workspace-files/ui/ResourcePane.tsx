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

import {
  cleanup,
  effect,
  Image,
  inputAction,
  keymap,
  Scroll,
  signal,
  Text,
  View,
  type ViewRef,
} from 'nsh';
import { Button } from 'nsh/base';
import { ChangesStudio } from '../../../../products/maka/workbench/app/ChangesStudio';
import {
  controlsRight,
  PANEL_INSET,
  windowDrag,
} from '../../../../products/maka/workbench/app/chrome';
import { CurrentDiff } from '../../../../products/maka/workbench/app/CurrentDiff';
import { CurrentFile } from '../../../../products/maka/workbench/app/CurrentFile';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import type { ImagePreview } from '../../../../products/maka/workbench/app/ImageThumbnail';
import {
  ImageViewerButton,
  type OpenImageViewer,
} from '../../../../products/maka/workbench/app/ImageViewer';
import { tr } from '../../../../products/maka/workbench/app/locale';
import { PullRequestTab } from '../../../../products/maka/workbench/app/PullRequestTab';
import {
  ReviewBatchBar,
  SymbolLocationsDrawer,
} from '../../../../products/maka/workbench/app/ReviewComposer';
import { basenameLabel } from '../../../../products/maka/workbench/app/reviewState';
import { StageLaunchpad } from '../../../../products/maka/workbench/app/StageLaunchpad';
import { Terminal } from '../../../../products/maka/workbench/app/Terminal';
import {
  AgentTerminals,
  PersonalTerminals,
} from '../../../../products/maka/workbench/app/Terminals';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  shortcut,
  textTooltip,
} from '../../../../products/maka/workbench/app/ui';
import { WorkspaceFiles } from '../../../../products/maka/workbench/app/WorkspaceFiles';
import type { Resources, StageSectionTab } from './resources';

export function ResourcePane(props: { resources: Resources; docked: boolean }) {
  const resources = props.resources;
  const sessionId = resources.sessionId()!;
  const agent = () => resources.terminalSection() === 'agent-terminals';
  const personal = () => resources.terminalSection() === 'terminals';
  const terminal = () => resources.activeTerminal();
  const inTerminalSurface = () => resources.terminalSection() !== null;

  const showTerminals = (kind: 'terminals' | 'agent-terminals') =>
    inputAction(resources.inventory, {
      sessionId: closeTarget.sessionId,
      kind,
    });

  const nonTerminalTabs = () => resources.tabs().filter((tab) => tab.kind !== 'terminal');
  const closeTarget = {
    sessionId,
    instance: resources.instance(),
  };
  const symbolBatch = () => resources.reviewStore.symbolBatch(sessionId);

  let firstControl: ViewRef | undefined;
  let unbinds: (() => void)[] = [];
  cleanup(() => {
    for (const fn of unbinds) fn();
  });

  effect(() => {
    if (resources.focusRequest() && firstControl) {
      resources.focusHandled();
      if (props.docked) firstControl.focus();
    }
  });

  const sectionMeta = (
    section: StageSectionTab,
  ): { icon: Parameters<typeof Icon>[0]['name']; label: string; a11y: string } => {
    switch (section) {
      case 'launchpad':
        return { icon: 'globe', label: tr('New tab'), a11y: tr('New tab') };
      case 'changes':
        return { icon: 'diff', label: tr('Changes'), a11y: tr('Review workspace changes') };
      case 'files':
        return { icon: 'folder', label: tr('Files'), a11y: tr('Browse files') };
      case 'terminals':
        return {
          icon: 'terminal',
          label: terminal()?.entry().result.cmd
            ? basenameLabel(terminal()!.entry().result.cmd)
            : tr('Terminal'),
          a11y: tr('Terminal'),
        };
    }
  };

  const isSectionSelected = (section: StageSectionTab): boolean => {
    if (section === 'terminals') return inTerminalSurface();
    return resources.active() === section;
  };

  const tabDisplayTitle = (tab: ReturnType<typeof nonTerminalTabs>[number]): string => {
    if (tab.kind === 'pr' || tab.kind === 'image') return tab.title;
    if (tab.kind === 'diff') return basenameLabel(tab.model.target.title);
    return basenameLabel(tab.title) + (tab.kind === 'file' && tab.model.dirty() ? ' •' : '');
  };

  const tabIcon = (
    tab: ReturnType<typeof nonTerminalTabs>[number],
  ): Parameters<typeof Icon>[0]['name'] => {
    if (tab.kind === 'pr') return 'pullRequest';
    if (tab.kind === 'image') return 'image';
    if (tab.kind === 'diff') return 'diff';
    return 'file';
  };

  const paddingRight = () =>
    props.docked ? Math.max(8, controlsRight(true) - PANEL_INSET) : controlsRight(false);

  const inChangesOrPr = () => {
    if (resources.active() === 'changes') return true;
    const t = resources.activeTab();
    return t?.kind === 'pr';
  };

  return (
    <View
      ref={(node) => {
        resources.attach(node);
        for (const fn of unbinds) fn();
        unbinds = [
          keymap.bind(
            'escape',
            () => {
              if (resources.reviewStore.symbolBatch(sessionId) !== null) {
                resources.reviewStore.setSymbolBatch(sessionId, null);
                return;
              }
              if (resources.fullscreen()) {
                resources.setFullscreen(false);
                return;
              }
              resources.close(closeTarget);
            },
            {
              when: 'notEditing',
              within: node,
            },
          ),
          keymap.bind('mod+[', () => resources.goBack(), { within: node }),
          keymap.bind('mod+]', () => resources.goForward(), { within: node }),
        ];
      }}
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: C.panel,
      }}
    >
      {/* Unified Browser-Style Stage Tab Bar (32pt high, centered on 24pt title-bar line) */}
      <View
        desktop={props.docked ? windowDrag : undefined}
        style={{
          height: 36,
          paddingLeft: 8,
          paddingRight: paddingRight(),
          borderBottomWidth: 1,
          borderBottomColor: C.line,
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
          gap: 4,
        }}
      >
        <If when={resources.canGoBack() || resources.canGoForward()}>
          <Button
            accessibilityLabel={tr('Go back')}
            tooltip={textTooltip(() => tr('Go back'))}
            disabled={!resources.canGoBack()}
            onPress={resources.goBack}
            style={{
              ...controlStyle,
              width: 28,
              minHeight: 28,
              height: 28,
              paddingHorizontal: 0,
              paddingVertical: 0,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="back" size={14} color={C.secondary} />
          </Button>
          <Button
            accessibilityLabel={tr('Go forward')}
            tooltip={textTooltip(() => tr('Go forward'))}
            disabled={!resources.canGoForward()}
            onPress={resources.goForward}
            style={{
              ...controlStyle,
              width: 28,
              minHeight: 28,
              height: 28,
              paddingHorizontal: 0,
              paddingVertical: 0,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="right" size={14} color={C.secondary} />
          </Button>
        </If>

        <Scroll horizontal focusable={false} style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            {/* Section Stage Tabs */}
            <Each of={resources.openSections()} key={(sec) => sec}>
              {(sec, idx) => {
                const selected = () => isSectionSelected(sec());
                const meta = () => sectionMeta(sec());
                return (
                  <View
                    style={{
                      height: 28,
                      flexDirection: 'row',
                      alignItems: 'center',
                      borderRadius: 8,
                      backgroundColor: selected() ? C.cardRaised : C.card,
                    }}
                  >
                    <Button
                      ref={
                        idx() === 0
                          ? (node) => {
                              firstControl = node;
                              if (resources.focusRequest()) {
                                resources.focusHandled();
                                if (props.docked) node.focus();
                              }
                            }
                          : undefined
                      }
                      selected={selected()}
                      accessibilityLabel={meta().a11y}
                      onPress={inputAction(resources.inventory, {
                        sessionId,
                        kind: sec(),
                      })}
                      style={{
                        minHeight: 28,
                        height: 28,
                        paddingLeft: 8,
                        paddingRight: 4,
                        borderRadius: 8,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'flex-start',
                        gap: 6,
                        maxWidth: 176,
                      }}
                      hoverStyle={{ opacity: 0.9 }}
                      focusStyle={quietFocusStyle()}
                    >
                      <Icon name={meta().icon} size={13} color={selected() ? C.text : C.muted} />
                      <Text
                        style={[
                          {
                            ...captionTextStyle,
                            color: selected() ? C.text : C.secondary,
                            fontWeight: selected() ? '500' : undefined,
                            flexShrink: 1,
                            minWidth: 0,
                          },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {meta().label}
                      </Text>
                    </Button>
                    <Button
                      accessibilityLabel={tr('Close {name}', { name: meta().label })}
                      onPress={inputAction(resources.closeSection, {
                        sessionId,
                        section: sec(),
                      })}
                      style={{
                        width: 22,
                        height: 22,
                        marginRight: 2,
                        borderRadius: 4,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      hoverStyle={{ backgroundColor: C.line }}
                      focusStyle={quietFocusStyle()}
                    >
                      <Icon name="close" size={12} color={C.muted} />
                    </Button>
                  </View>
                );
              }}
            </Each>

            {/* File / PR / Diff / Image Stage Tabs */}
            <Each of={nonTerminalTabs()} key={(tab) => tab.instance}>
              {(tab, idx) => {
                const selected = () => resources.active() === tab().instance;
                const shortTitle = () => tabDisplayTitle(tab());
                return (
                  <View
                    style={{
                      height: 28,
                      flexDirection: 'row',
                      alignItems: 'center',
                      borderRadius: 8,
                      backgroundColor: selected() ? C.cardRaised : C.card,
                    }}
                  >
                    <Button
                      ref={
                        resources.openSections().length === 0 && idx() === 0
                          ? (node) => {
                              firstControl = node;
                              if (resources.focusRequest()) {
                                resources.focusHandled();
                                if (props.docked) node.focus();
                              }
                            }
                          : undefined
                      }
                      selected={selected()}
                      onPress={inputAction(resources.select, {
                        sessionId: tab().sessionId,
                        instance: tab().instance,
                      })}
                      accessibilityLabel={tr('Preview {name}', {
                        name: tab().title,
                      })}
                      tooltip={textTooltip(() => tab().title)}
                      style={{
                        minHeight: 28,
                        height: 28,
                        paddingLeft: 8,
                        paddingRight: 4,
                        borderRadius: 8,
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'flex-start',
                        gap: 6,
                        maxWidth: 192,
                      }}
                      hoverStyle={{ opacity: 0.9 }}
                      focusStyle={quietFocusStyle()}
                    >
                      <Icon
                        name={tabIcon(tab())}
                        size={13}
                        color={tab().kind === 'pr' ? C.accent : selected() ? C.text : C.muted}
                      />
                      <Text
                        style={[
                          {
                            ...captionTextStyle,
                            color: selected() ? C.text : C.secondary,
                            fontWeight: selected() ? '500' : undefined,
                            flexShrink: 1,
                            minWidth: 0,
                          },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {shortTitle()}
                      </Text>
                    </Button>
                    <Button
                      onPress={inputAction(resources.closeTab, {
                        sessionId: tab().sessionId,
                        instance: tab().instance,
                      })}
                      accessibilityLabel={tr('Close {name}', {
                        name: tab().title,
                      })}
                      tooltip={textTooltip(() => tr('Close {name}', { name: tab().title }))}
                      style={{
                        width: 22,
                        height: 22,
                        marginRight: 2,
                        borderRadius: 4,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      hoverStyle={{ backgroundColor: C.line }}
                      focusStyle={quietFocusStyle()}
                    >
                      <Icon name="close" size={12} color={C.muted} />
                    </Button>
                  </View>
                );
              }}
            </Each>

            {/* + New Tab Button right after the last tab */}
            <Button
              accessibilityLabel={tr('New tab')}
              tooltip={textTooltip(() => tr('New tab'))}
              onPress={inputAction(resources.openLaunchpad, { sessionId })}
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                alignItems: 'center',
                justifyContent: 'center',
              }}
              hoverStyle={quietHoverStyle()}
              activeStyle={quietActiveStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="plus" size={14} color={C.muted} />
            </Button>
          </View>
        </Scroll>

        {/* Right Stage Controls: Fullscreen / Exit Fullscreen + Close */}
        <If
          when={props.docked && resources.fullscreen()}
          else={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <If when={props.docked}>
                <Button
                  accessibilityLabel={tr('Enter fullscreen')}
                  tooltip={textTooltip(() => shortcut(tr('Enter fullscreen'), 'shift+mod+f'))}
                  onPress={() => resources.setFullscreen(true)}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 8,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  hoverStyle={quietHoverStyle()}
                  activeStyle={quietActiveStyle()}
                  focusStyle={quietFocusStyle()}
                >
                  <Icon name="expand" size={14} color={C.muted} />
                </Button>
              </If>
              <Button
                accessibilityLabel={tr('Close workspace preview')}
                onPress={inputAction(resources.close, closeTarget)}
                tooltip={textTooltip(() => tr('Close workspace preview · Esc'))}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                hoverStyle={quietHoverStyle()}
                activeStyle={quietActiveStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Icon name="close" size={14} color={C.muted} />
              </Button>
            </View>
          }
        >
          <Button
            accessibilityLabel={tr('Exit fullscreen')}
            tooltip={textTooltip(() => shortcut(tr('Exit fullscreen'), 'shift+mod+f'))}
            onPress={() => resources.setFullscreen(false)}
            style={{
              height: 28,
              paddingHorizontal: 8,
              borderRadius: 8,
              backgroundColor: C.card,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              flexShrink: 0,
            }}
            hoverStyle={{ backgroundColor: C.cardRaised }}
            activeStyle={quietActiveStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="minimize" size={13} color={C.secondary} />
            <Text style={{ ...captionTextStyle, color: C.text, fontWeight: '500' }}>
              {tr('Exit fullscreen')}
            </Text>
          </Button>
        </If>
      </View>

      {/* New Tab Launchpad */}
      <If when={resources.active() === 'launchpad'}>
        <StageLaunchpad
          sessionId={sessionId}
          reviewStore={resources.reviewStore}
          openTerminals={showTerminals('terminals')}
          openAgentTerminals={showTerminals('agent-terminals')}
          openChanges={(wt) => resources.openChanges({ sessionId, worktreePath: wt })}
          openFiles={() => resources.openFiles({ sessionId })}
          openFile={(target) => resources.openFile(target)}
          openPullRequest={(target) => resources.openPullRequest({ sessionId, ...target })}
        />
      </If>

      {/* Unified Multi-File Changes Studio */}
      <If when={resources.active() === 'changes'}>
        <ChangesStudio
          sessionId={sessionId}
          reviewStore={resources.reviewStore}
          canPrompt={resources.canPrompt}
          deliverPrompt={(text, mode) => resources.deliverPrompt(sessionId, text, mode)}
          openFile={(target) => resources.openFile(target)}
        />
      </If>

      {/* Workspace Files Browser */}
      <If when={resources.active() === 'files'}>
        <View style={{ flex: 1, minHeight: 0, padding: 8 }}>
          <WorkspaceFiles model={resources.files} />
        </View>
      </If>

      {/* Terminal Surface (Personal & Agent Terminals with Sub-Header Switcher) */}
      <If when={inTerminalSurface()}>
        <View
          style={{
            height: 36,
            paddingHorizontal: 12,
            borderBottomWidth: 1,
            borderBottomColor: C.line,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            flexShrink: 0,
          }}
        >
          <Button
            accessibilityLabel={tr('Show conversation terminals')}
            selected={personal()}
            onPress={showTerminals('terminals')}
            style={{
              height: 28,
              paddingHorizontal: 8,
              borderRadius: 8,
              backgroundColor: personal() ? C.card : 'transparent',
              justifyContent: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text
              style={{
                ...captionTextStyle,
                color: personal() ? C.text : C.secondary,
                fontWeight: personal() ? '500' : undefined,
              }}
            >
              {tr('Terminal')}
            </Text>
          </Button>

          <Button
            accessibilityLabel={tr('Agent terminals')}
            selected={agent()}
            onPress={showTerminals('agent-terminals')}
            style={{
              height: 28,
              paddingHorizontal: 8,
              borderRadius: 8,
              backgroundColor: agent() ? C.card : 'transparent',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="bot" size={14} color={agent() ? C.text : C.muted} />
            <Text
              style={{
                ...captionTextStyle,
                color: agent() ? C.text : C.secondary,
                fontWeight: agent() ? '500' : undefined,
              }}
            >
              Agent
            </Text>
            <If when={resources.runningAgentTerminals().length > 0}>
              <Text
                accessibilityLabel={tr('{count} running commands', {
                  count: resources.runningAgentTerminals().length,
                })}
                style={{
                  ...captionTextStyle,
                  color: C.accent,
                  fontWeight: '600',
                }}
              >
                {resources.runningAgentTerminals().length}
              </Text>
            </If>
          </Button>
        </View>
      </If>

      <If when={personal()}>
        <View style={{ flex: 1, minHeight: 0, padding: 8 }}>
          <PersonalTerminals
            model={resources.terminals}
            entries={resources.personalTerminals()}
            selected={terminal()?.target.ref}
            cwd={resources.directory()}
            open={resources.showTerminal}
          />
        </View>
      </If>
      <If when={agent() && !terminal()}>
        <View style={{ flex: 1, minHeight: 0, padding: 8 }}>
          <AgentTerminals
            model={resources.terminals}
            running={resources.runningAgentTerminals()}
            finished={resources.finishedAgentTerminals()}
            open={resources.showTerminal}
          />
        </View>
      </If>

      {/* Active Tab Content: PR / File / Single Diff / Terminal / Image */}
      <Each of={resources.activeTab() ? [resources.activeTab()!] : []} key={(tab) => tab.instance}>
        {(tab) => {
          const current = tab();
          const openImageViewer: OpenImageViewer = (image, restoreFocus) =>
            resources.openImageViewer(
              {
                sessionId: current.sessionId,
                instance: current.instance,
                image,
              },
              restoreFocus,
            );
          if (current.kind === 'pr')
            return (
              <PullRequestTab
                sessionId={current.sessionId}
                repo={current.repo}
                number={current.number}
                reviewStore={resources.reviewStore}
                canPrompt={resources.canPrompt}
                deliverPrompt={(text, mode) =>
                  resources.deliverPrompt(current.sessionId, text, mode)
                }
                openFile={(target) => resources.openFile(target)}
                onTitleResolved={(resolved) => resources.updateTabTitle(current.instance, resolved)}
              />
            );
          if (current.kind === 'file')
            return (
              <View style={{ flex: 1, minHeight: 0, padding: 8 }}>
                <CurrentFile
                  model={current.model}
                  openImageViewer={openImageViewer}
                  navigation={resources.fileNavigation(current.model.target)}
                />
              </View>
            );
          if (current.kind === 'diff')
            return (
              <View style={{ flex: 1, minHeight: 0, padding: 8 }}>
                <CurrentDiff
                  model={current.model}
                  review={resources.diffReview(current.model.target)}
                />
              </View>
            );
          if (current.kind === 'terminal')
            return (
              <View style={{ flex: 1, minHeight: 0, padding: 8, gap: 8 }}>
                <If when={current.model.agentOwned()}>
                  <View
                    style={{
                      flexDirection: 'row',
                      gap: 4,
                      alignItems: 'center',
                    }}
                  >
                    <Button
                      accessibilityLabel={tr('Back to Agent terminals')}
                      onPress={showTerminals('agent-terminals')}
                      tooltip={textTooltip(() => tr('Back to Agent terminals'))}
                      style={{
                        ...controlStyle,
                        flexDirection: 'row',
                        gap: 4,
                        alignItems: 'center',
                      }}
                      hoverStyle={controlHoverStyle()}
                      focusStyle={controlFocusStyle()}
                    >
                      <Icon name="back" size={14} color={C.muted} />
                    </Button>
                    <Text
                      tooltip={textTooltip(() => current.title)}
                      style={[
                        { ...captionTextStyle, flex: 1, color: C.muted },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {current.title}
                    </Text>
                  </View>
                </If>
                <Terminal model={current.model} />
              </View>
            );
          return (
            <View style={{ flex: 1, minHeight: 0, padding: 8 }}>
              <OriginalImage image={current.image} openImageViewer={openImageViewer} />
            </View>
          );
        }}
      </Each>

      <If when={symbolBatch() !== null}>
        <SymbolLocationsDrawer
          batch={symbolBatch()!}
          pathLabel={(loc) => resources.pathLabel(loc.path)}
          onSelect={(loc, idx) => {
            resources.reviewStore.selectSymbolLocation(sessionId, idx);
            resources.navigateToLocation(sessionId, loc);
          }}
          onClose={() => resources.reviewStore.setSymbolBatch(sessionId, null)}
        />
      </If>

      <If when={!inChangesOrPr()}>
        <ReviewBatchBar
          sessionId={sessionId}
          store={resources.reviewStore}
          canPrompt={resources.canPrompt()}
          onJumpToNote={resources.jumpToNote}
          onDeliver={(text, mode) => resources.deliverPrompt(sessionId, text, mode)}
        />
      </If>
    </View>
  );
}

function OriginalImage(props: {
  image: Pick<ImagePreview, 'uri'>;
  openImageViewer: OpenImageViewer;
}) {
  const error = signal('');
  const size = signal<{ width: number; height: number } | null>(null);
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <Text style={{ ...captionTextStyle, color: C.secondary, fontWeight: '500' }}>
        {tr('Image preview')}
      </Text>
      <Image
        src={props.image.uri}
        onLoad={(event) => {
          if (mounted) size.set(event.size);
        }}
        onError={(reason) => {
          if (mounted) error.set(reason.message);
        }}
        style={[{ flex: 1, minHeight: 0, width: '100%' }, { objectFit: 'contain' }]}
      />
      <If when={size()}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ ...captionTextStyle, flex: 1, color: C.muted }}>
            {size()!.width} × {size()!.height} · {tr('Original image')}
          </Text>
          <ImageViewerButton
            open={props.openImageViewer}
            image={{
              uri: props.image.uri,
              width: size()!.width,
              height: size()!.height,
              title: tr('Original image'),
            }}
          />
        </View>
      </If>
      <If when={error()}>
        <Text style={{ ...bodyTextStyle, color: C.danger }}>{error()}</Text>
      </If>
    </View>
  );
}
