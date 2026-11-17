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
import { controlsRight, windowDrag } from '../../../../products/maka/workbench/app/chrome';
import { CurrentDiff } from '../../../../products/maka/workbench/app/CurrentDiff';
import { CurrentFile } from '../../../../products/maka/workbench/app/CurrentFile';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import type { ImagePreview } from '../../../../products/maka/workbench/app/ImageThumbnail';
import {
  ImageViewerButton,
  type OpenImageViewer,
} from '../../../../products/maka/workbench/app/ImageViewer';
import { tr } from '../../../../products/maka/workbench/app/locale';
import {
  ReviewBatchBar,
  SymbolLocationsDrawer,
} from '../../../../products/maka/workbench/app/ReviewComposer';
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
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from '../../../../products/maka/workbench/app/ui';
import { WorkspaceFiles } from '../../../../products/maka/workbench/app/WorkspaceFiles';
import type { Resources } from './resources';
import { WorkspaceChanges } from './WorkspaceChanges';

export function ResourcePane(props: { resources: Resources; docked: boolean }) {
  const resources = props.resources;
  const sessionId = resources.sessionId()!;
  const agent = () => resources.terminalSection() === 'agent-terminals';
  const personal = () => resources.terminalSection() === 'terminals';
  const terminal = () => resources.activeTerminal();
  const showTerminals = (kind: 'terminals' | 'agent-terminals') =>
    inputAction(resources.inventory, { sessionId: closeTarget.sessionId, kind });
  const previews = () => resources.tabs().filter((tab) => tab.kind !== 'terminal');
  const closeTarget = {
    sessionId,
    instance: resources.instance(),
  };
  const symbolBatch = () => resources.reviewStore.symbolBatch(sessionId);

  let control: ViewRef | undefined;
  let unbinds: (() => void)[] = [];
  cleanup(() => {
    for (const fn of unbinds) fn();
  });

  effect(() => {
    if (resources.focusRequest() && control) {
      resources.focusHandled();
      if (props.docked) control.focus();
    }
  });

  return (
    <View
      ref={(node) => {
        resources.attach(node);
        for (const fn of unbinds) fn();
        unbinds = [
          keymap.bind('escape', () => resources.close(closeTarget), {
            when: 'always',
            within: node,
          }),
          keymap.bind('mod+[', () => resources.goBack(), { within: node }),
          keymap.bind('mod+]', () => resources.goForward(), { within: node }),
        ];
      }}
      style={{ flex: 1, minHeight: 0, backgroundColor: C.panel, padding: 8, gap: 8 }}
    >
      <View
        desktop={props.docked ? windowDrag : undefined}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexShrink: 0,
          gap: 4,
          paddingRight: controlsRight(props.docked),
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
              paddingHorizontal: 6,
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
              paddingHorizontal: 6,
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
            <Button
              accessibilityLabel={tr('Review workspace changes')}
              selected={resources.active() === 'changes'}
              onPress={inputAction(resources.inventory, {
                sessionId,
                kind: 'changes',
              })}
              style={{ ...controlStyle, paddingHorizontal: 8 }}
              selectedStyle={{ backgroundColor: C.raised }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: resources.active() === 'changes' ? C.text : C.muted,
                }}
              >
                {tr('Changes')}
              </Text>
            </Button>

            <Button
              accessibilityLabel={tr('Browse files')}
              selected={resources.active() === 'files'}
              ref={(node) => {
                control = node;
                if (resources.focusRequest()) {
                  resources.focusHandled();
                  if (props.docked) node.focus();
                }
              }}
              onPress={inputAction(resources.inventory, {
                sessionId,
                kind: 'files',
              })}
              style={{ ...controlStyle, paddingHorizontal: 8 }}
              selectedStyle={{ backgroundColor: C.raised }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: resources.active() === 'files' ? C.text : C.muted,
                }}
              >
                {tr('Files')}
              </Text>
            </Button>

            <Button
              accessibilityLabel={tr('Show conversation terminals')}
              selected={personal()}
              onPress={showTerminals('terminals')}
              style={{
                ...controlStyle,
                paddingHorizontal: 8,
              }}
              selectedStyle={{ backgroundColor: C.raised }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  color: personal() ? C.text : C.muted,
                }}
              >
                {tr('Terminal')}
              </Text>
            </Button>

            <Each of={previews()} key={(tab) => tab.instance}>
              {(tab) => (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    borderRadius: 8,
                    backgroundColor: resources.active() === tab().instance ? C.cardRaised : C.card,
                  }}
                >
                  <Button
                    selected={resources.active() === tab().instance}
                    onPress={inputAction(resources.select, {
                      sessionId: tab().sessionId,
                      instance: tab().instance,
                    })}
                    accessibilityLabel={tr('Preview {name}', { name: tab().title })}
                    tooltip={textTooltip(() => tab().title)}
                    style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 6 }}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                  >
                    <Icon
                      name={
                        tab().kind === 'image' ? 'image' : tab().kind === 'diff' ? 'code' : 'file'
                      }
                      size={13}
                      color={C.muted}
                    />
                    <Text
                      style={[
                        {
                          ...captionTextStyle,
                          color: resources.active() === tab().instance ? C.text : C.muted,
                          maxWidth: 160,
                        },
                        { numberOfLines: 1 },
                      ]}
                    >
                      {tab().title}
                    </Text>
                  </Button>
                  <Button
                    onPress={inputAction(resources.closeTab, {
                      sessionId: tab().sessionId,
                      instance: tab().instance,
                    })}
                    accessibilityLabel={tr('Close {name}', { name: tab().title })}
                    tooltip={textTooltip(() => tr('Close {name}', { name: tab().title }))}
                    style={{
                      ...controlStyle,
                      width: 28,
                      minHeight: 28,
                      paddingHorizontal: 5,
                      paddingVertical: 5,
                      alignItems: 'center',
                    }}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                  >
                    <Icon name="close" color={C.muted} />
                  </Button>
                </View>
              )}
            </Each>
          </View>
        </Scroll>

        <Button
          accessibilityLabel={tr('Agent terminals')}
          selected={agent()}
          onPress={showTerminals('agent-terminals')}
          style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 4 }}
          selectedStyle={{ backgroundColor: C.raised }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="bot" size={14} color={C.muted} />
          <Text style={{ ...captionTextStyle, color: agent() ? C.text : C.muted }}>Agent</Text>
          <If
            when={
              resources.terminalSection() !== null && resources.runningAgentTerminals().length > 0
            }
          >
            <Text
              accessibilityLabel={tr('{count} running commands', {
                count: resources.runningAgentTerminals().length,
              })}
              style={{ ...captionTextStyle, color: C.accent, fontWeight: '600' }}
            >
              {resources.runningAgentTerminals().length}
            </Text>
          </If>
        </Button>
        <Button
          accessibilityLabel={tr('Close workspace preview')}
          onPress={inputAction(resources.close, closeTarget)}
          tooltip={textTooltip(() => tr('Close workspace preview · Esc'))}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
        >
          <Icon name="close" color={C.muted} />
        </Button>
      </View>

      <If when={personal()}>
        <PersonalTerminals
          model={resources.terminals}
          entries={resources.personalTerminals()}
          selected={terminal()?.target.ref}
          cwd={resources.directory()}
          open={resources.showTerminal}
        />
      </If>
      <If when={agent() && !terminal()}>
        <AgentTerminals
          model={resources.terminals}
          running={resources.runningAgentTerminals()}
          finished={resources.finishedAgentTerminals()}
          open={resources.showTerminal}
        />
      </If>
      <If when={resources.active() === 'changes'}>
        <WorkspaceChanges
          sessionId={sessionId}
          openDiff={(target) => resources.openDiff(target)}
          reviewStore={resources.reviewStore}
          canPrompt={resources.canPrompt()}
          deliverPrompt={(text, mode) => resources.deliverPrompt(sessionId, text, mode)}
        />
      </If>
      <If when={resources.active() === 'files'}>
        <WorkspaceFiles model={resources.files} />
      </If>
      <Each of={resources.activeTab() ? [resources.activeTab()!] : []} key={(tab) => tab.instance}>
        {(tab) => {
          const current = tab();
          const openImageViewer: OpenImageViewer = (image, restoreFocus) =>
            resources.openImageViewer(
              { sessionId: current.sessionId, instance: current.instance, image },
              restoreFocus,
            );
          if (current.kind === 'file')
            return (
              <CurrentFile
                model={current.model}
                openImageViewer={openImageViewer}
                navigation={resources.fileNavigation(current.model.target)}
              />
            );
          if (current.kind === 'diff')
            return (
              <CurrentDiff
                model={current.model}
                review={resources.diffReview(current.model.target)}
              />
            );
          if (current.kind === 'terminal')
            return (
              <>
                <If when={current.model.agentOwned()}>
                  <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
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
              </>
            );
          return <OriginalImage image={current.image} openImageViewer={openImageViewer} />;
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

      <ReviewBatchBar
        sessionId={sessionId}
        store={resources.reviewStore}
        canPrompt={resources.canPrompt()}
        onJumpToNote={resources.jumpToNote}
        onDeliver={(text, mode) => resources.deliverPrompt(sessionId, text, mode)}
      />
    </View>
  );
}

function OriginalImage(props: { image: ImagePreview; openImageViewer: OpenImageViewer }) {
  const error = signal('');
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
        onError={(reason) => {
          if (mounted) error.set(reason.message);
        }}
        style={[{ flex: 1, minHeight: 0, width: '100%' }, { objectFit: 'contain' }]}
      />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ ...captionTextStyle, flex: 1, color: C.muted }}>
          {props.image.width} × {props.image.height} · {tr('Original image')}
        </Text>
        <ImageViewerButton
          open={props.openImageViewer}
          image={{
            uri: props.image.uri,
            width: props.image.width,
            height: props.image.height,
            title: tr('Original image'),
          }}
        />
      </View>
      <If when={error()}>
        <Text style={{ ...bodyTextStyle, color: C.danger }}>{error()}</Text>
      </If>
    </View>
  );
}
