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

import { keymap, Scroll, signal, Text, View, type JSX } from 'nsh';
import { Button, Popover } from 'nsh/base';
import type { AgentSession } from '../../../../packages/plugin-sdk/src/index.js';
import { Icon } from './Icon';
import { tr } from './locale';
import { LoadingIndicator } from './Loading';
import { sessionStatusCaption } from './sessionStatus';
import { familySummary, sortFamilySessions, workspaceDifferenceLabel } from './sessionFamilyState';
import {
  C,
  captionTextStyle,
  floatingStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  radius,
  textTooltip,
} from './ui';

export type FamilyParent = {
  id: string;
  title: string;
  workspacePath: string;
  hasGrandparent: boolean;
  rootId?: string | null;
};

function FamilyPopover(props: {
  open(): boolean;
  onOpenChange(open: boolean): void;
  align: 'start' | 'end';
  shrink?: boolean;
  trigger: JSX.Element;
  parent?: () => FamilyParent | null;
  items(): readonly AgentSession[];
  currentId?: () => string | null;
  parentWorkspacePath(): string;
  openSession(id: string): void;
}) {
  const ordered = () => sortFamilySessions(props.items());
  const openTarget = (id: string) => {
    props.onOpenChange(false);
    props.openSession(id);
  };
  const statusWord = (activity: AgentSession['activity']) => sessionStatusCaption[activity];
  const prevKey = () => keymap.label('mod+[');
  const nextKey = () => keymap.label('mod+]');

  return (
    <Popover
      open={props.open()}
      onOpenChange={({ open }) => props.onOpenChange(open)}
      placement="bottom"
      align={props.align}
      offset={6}
      margin={8}
      style={props.shrink ? { minWidth: 0, flexShrink: 1 } : undefined}
      popupStyle={{ ...floatingStyle(), width: 336, padding: 6 }}
      trigger={props.trigger}
    >
      <View style={{ gap: 2 }}>
        <If when={Boolean(props.parent?.())}>
          <View>
            <Button
              accessibilityLabel={tr('Open parent conversation')}
              onPress={() => {
                const parent = props.parent?.();
                if (parent) openTarget(parent.id);
              }}
              style={{
                paddingHorizontal: 8,
                paddingVertical: 7,
                borderRadius: radius(7),
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
              hoverStyle={{ backgroundColor: C.floatingRaised }}
              activeStyle={quietActiveStyle()}
              focusStyle={quietFocusStyle()}
            >
              <Icon name="send" size={13} color={C.muted} />
              <Text
                style={[
                  { ...captionTextStyle, color: C.secondary, flex: 1, minWidth: 0 },
                  { numberOfLines: 1 },
                ]}
              >
                {props.parent?.()?.title || tr('Untitled conversation')}
              </Text>
              <Text style={{ fontSize: 11.5, lineHeight: 16, color: C.muted }}>{tr('Parent')}</Text>
            </Button>
            <View
              style={{ height: 1, backgroundColor: C.line, marginVertical: 4, marginHorizontal: 4 }}
            />
          </View>
        </If>
        <If when={!props.parent?.()}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 8,
              paddingTop: 3,
              paddingBottom: 5,
            }}
          >
            <Text
              style={{
                fontSize: 11,
                lineHeight: 14,
                fontWeight: '500',
                color: C.muted,
                textTransform: 'uppercase',
              }}
            >
              {tr('{count} subagents', { count: ordered().length })}
            </Text>
          </View>
        </If>
        <Scroll style={{ maxHeight: 360 }}>
          <View style={{ gap: 2 }}>
            <Each of={ordered()} key={(child) => child.id}>
              {(child) => {
                const isCurrent = () => props.currentId?.() === child().id;
                const diffWorkspace = () =>
                  workspaceDifferenceLabel(child().workspace.path, props.parentWorkspacePath());
                const presetName = () => child().appliedPreset?.name ?? '';
                const isWaiting = () => child().activity === 'waiting';
                const isWorking = () => child().activity === 'working';
                const rowAccessibilityLabel = () =>
                  [
                    child().title || tr('Untitled conversation'),
                    statusWord(child().activity),
                    presetName(),
                    diffWorkspace(),
                  ]
                    .filter(Boolean)
                    .join(', ');
                return (
                  <Button
                    accessibilityLabel={rowAccessibilityLabel()}
                    selected={isCurrent()}
                    onPress={() => openTarget(child().id)}
                    style={{
                      paddingHorizontal: 8,
                      paddingVertical: 7,
                      borderRadius: radius(7),
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: 10,
                      backgroundColor: isCurrent() ? C.floatingRaised : 'transparent',
                    }}
                    hoverStyle={{ backgroundColor: C.floatingRaised }}
                    activeStyle={quietActiveStyle()}
                    focusStyle={quietFocusStyle()}
                  >
                    <View
                      style={{
                        width: 14,
                        height: 18,
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <If
                        when={isWorking()}
                        else={
                          <If
                            when={isWaiting()}
                            else={
                              <View
                                style={{
                                  width: 6,
                                  height: 6,
                                  borderRadius: 3,
                                  backgroundColor: C.muted,
                                }}
                              />
                            }
                          >
                            <View
                              style={{
                                width: 7,
                                height: 7,
                                borderRadius: 4,
                                backgroundColor: C.accent,
                              }}
                            />
                          </If>
                        }
                      >
                        <LoadingIndicator size={12} label={tr('Working')} />
                      </If>
                    </View>
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text
                        style={[
                          {
                            fontSize: 13,
                            lineHeight: 18,
                            color: C.text,
                            fontWeight: isCurrent() ? '500' : undefined,
                          },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {child().title || tr('Untitled conversation')}
                      </Text>
                      <View
                        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 }}
                      >
                        <If when={Boolean(presetName())}>
                          <Text
                            style={[
                              { fontSize: 12, lineHeight: 16, color: C.muted, flexShrink: 1 },
                              { numberOfLines: 1 },
                            ]}
                          >
                            {`${presetName()} ·`}
                          </Text>
                        </If>
                        <Text
                          style={{
                            fontSize: 12,
                            lineHeight: 16,
                            color: isWaiting() ? C.accentText : C.muted,
                            fontWeight: isWaiting() ? '500' : undefined,
                            flexShrink: 0,
                          }}
                        >
                          {statusWord(child().activity)}
                        </Text>
                        <If when={Boolean(diffWorkspace())}>
                          <Text
                            style={[
                              { fontSize: 12, lineHeight: 16, color: C.muted, flexShrink: 2 },
                              { numberOfLines: 1 },
                            ]}
                          >
                            {`· ${diffWorkspace()}`}
                          </Text>
                        </If>
                      </View>
                    </View>
                    <If when={isCurrent()}>
                      <View style={{ alignSelf: 'center', flexShrink: 0 }}>
                        <Icon name="check" size={13} color={C.muted} />
                      </View>
                    </If>
                  </Button>
                );
              }}
            </Each>
          </View>
        </Scroll>
        <If when={Boolean(props.parent?.()) && ordered().length > 1}>
          <View
            style={{
              marginTop: 4,
              paddingTop: 6,
              paddingBottom: 2,
              paddingHorizontal: 8,
              borderTopWidth: 1,
              borderTopColor: C.line,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text style={{ fontSize: 11.5, lineHeight: 16, color: C.muted }}>
              {tr('Switch sibling')}
            </Text>
            <Text style={{ fontSize: 11, lineHeight: 16, color: C.muted, fontFamily: 'monospace' }}>
              {`${prevKey()}  ${nextKey()}`}
            </Text>
          </View>
        </If>
      </View>
    </Popover>
  );
}

/**
 * Compact header status entry for a parent conversation that has subagents.
 * Renders nothing when the conversation has no children.
 */
export function SessionFamilyTrigger(props: {
  children(): readonly AgentSession[];
  workspacePath(): string;
  openSession(id: string): void;
}) {
  const open = signal(false);
  const stats = () => familySummary(props.children());
  const triggerAccessibilityLabel = () => {
    const summary = stats();
    return [
      tr('{count} subagents', { count: summary.total }),
      summary.waiting > 0 ? tr('{count} waiting', { count: summary.waiting }) : '',
      summary.working > 0
        ? `${summary.working}/${summary.total} ${sessionStatusCaption.working}`
        : '',
    ]
      .filter(Boolean)
      .join(', ');
  };

  return (
    <If when={stats().total > 0}>
      <FamilyPopover
        open={open}
        onOpenChange={(next) => open.set(next)}
        align="end"
        items={props.children}
        parentWorkspacePath={props.workspacePath}
        openSession={props.openSession}
        trigger={
          <Button
            accessibilityLabel={triggerAccessibilityLabel()}
            style={{
              height: 28,
              minHeight: 28,
              paddingHorizontal: 8,
              borderRadius: radius(7),
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              backgroundColor: open() ? C.card : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            activeStyle={quietActiveStyle()}
            focusStyle={quietFocusStyle()}
          >
            <If when={stats().waiting > 0}>
              <Text
                style={{
                  ...captionTextStyle,
                  color: C.accentText,
                  fontWeight: '500',
                }}
              >
                {tr('{count} waiting', { count: stats().waiting })}
              </Text>
            </If>
            <If when={stats().waiting > 0 && stats().working > 0}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>·</Text>
            </If>
            <If when={stats().working > 0}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <LoadingIndicator size={12} label={tr('Working')} />
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {tr('{count} running', { count: stats().working })}
                </Text>
              </View>
            </If>
            <If when={stats().waiting === 0 && stats().working === 0}>
              <Text style={{ ...captionTextStyle, color: C.muted }}>
                {tr('{count} subagents', { count: stats().total })}
              </Text>
            </If>
            <Icon name="down" size={12} color={C.muted} />
          </Button>
        }
      />
    </If>
  );
}

/**
 * Header breadcrumb for a child conversation: click parent to go back, or click
 * the current child title to open the sibling switcher popover.
 */
export function SessionFamilyBreadcrumb(props: {
  sessionId: string;
  title(): string;
  parent(): FamilyParent;
  siblings(): readonly AgentSession[];
  openSession(id: string): void;
}) {
  const open = signal(false);

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        minWidth: 0,
        flexShrink: 1,
      }}
    >
      <If when={props.parent().hasGrandparent && Boolean(props.parent().rootId)}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          <Button
            accessibilityLabel={tr('Open root conversation')}
            tooltip={textTooltip(() => tr('Open root conversation'))}
            onPress={() => {
              const rootId = props.parent().rootId;
              if (rootId) props.openSession(rootId);
            }}
            style={{
              height: 28,
              minHeight: 28,
              paddingHorizontal: 6,
              borderRadius: radius(7),
              justifyContent: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            activeStyle={quietActiveStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.muted }}>…</Text>
          </Button>
          <Text style={{ ...captionTextStyle, color: C.muted }}>/</Text>
        </View>
      </If>
      <Button
        accessibilityLabel={tr('Open parent conversation')}
        tooltip={textTooltip(() => props.parent().title || tr('Untitled conversation'))}
        onPress={() => props.openSession(props.parent().id)}
        style={{
          height: 28,
          minHeight: 28,
          paddingHorizontal: 6,
          borderRadius: radius(7),
          flexDirection: 'row',
          alignItems: 'center',
          gap: 3,
          maxWidth: 180,
          minWidth: 0,
          flexShrink: 2,
        }}
        hoverStyle={quietHoverStyle()}
        activeStyle={quietActiveStyle()}
        focusStyle={quietFocusStyle()}
      >
        <If when={!props.parent().hasGrandparent}>
          <Icon name="back" size={13} color={C.muted} />
        </If>
        <Text
          style={[
            { ...captionTextStyle, color: C.muted, flexShrink: 1, minWidth: 0 },
            { numberOfLines: 1 },
          ]}
        >
          {props.parent().title || tr('Untitled conversation')}
        </Text>
      </Button>
      <Text style={{ ...captionTextStyle, color: C.muted, paddingHorizontal: 2 }}>/</Text>
      <FamilyPopover
        open={open}
        onOpenChange={(next) => open.set(next)}
        align="start"
        shrink
        parent={props.parent}
        items={props.siblings}
        currentId={() => props.sessionId}
        parentWorkspacePath={() => props.parent().workspacePath}
        openSession={props.openSession}
        trigger={
          <Button
            accessibilityLabel={props.title()}
            style={{
              height: 28,
              minHeight: 28,
              paddingHorizontal: 8,
              borderRadius: radius(7),
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              minWidth: 0,
              flexShrink: 1,
              backgroundColor: open() ? C.card : 'transparent',
            }}
            hoverStyle={quietHoverStyle()}
            activeStyle={quietActiveStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text
              style={[
                { color: C.text, fontWeight: '600', minWidth: 0, flexShrink: 1 },
                { numberOfLines: 1 },
              ]}
            >
              {props.title()}
            </Text>
            <Icon name="down" size={12} color={C.muted} />
          </Button>
        }
      />
    </View>
  );
}
