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
  Clipboard,
  Scroll,
  Text,
  View,
  cleanup,
  effect,
  platform,
  reduceMotion,
  signal,
  windowSize,
  type JSX,
  type ViewStyle,
} from 'nsh';
import { Button, Popover } from 'nsh/base';
import { PANEL_INSET, TITLE_BAR_HEIGHT } from './chrome';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  getToastStore,
  type ToastAction,
  type ToastRecord,
  type ToastStore,
  type ToastTone,
} from './toastStore';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  floatingStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';

export interface RegionFeedbackAction {
  readonly label: string;
  readonly onPress: () => void;
  readonly primary?: boolean;
  readonly disabled?: boolean;
}

const MAX_COLLAPSED_TOASTS = 3;
const MAX_EXPANDED_TOASTS = 6;
const STACK_OFFSET_Y = 10;
const STACK_SCALE_STEP = 0.04;
const EXPANDED_GAP = 8;
const DEFAULT_TOAST_HEIGHT = 44;

function toneColor(tone: ToastTone): string {
  switch (tone) {
    case 'danger':
      return C.danger;
    case 'warning':
      return C.warning;
    case 'info':
      return C.muted;
  }
}

function toneIcon(tone: ToastTone): Parameters<typeof Icon>[0]['name'] {
  switch (tone) {
    case 'danger':
      return 'statusError';
    case 'warning':
      return 'warning';
    case 'info':
      return 'info';
  }
}

function CompactFeedbackButton(props: {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Button
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{
        height: 24,
        paddingHorizontal: 8,
        borderRadius: 6,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
      }}
      hoverStyle={quietHoverStyle()}
      activeStyle={quietActiveStyle()}
      focusStyle={quietFocusStyle()}
      disabledStyle={controlDisabledStyle}
    >
      <Text
        style={{
          ...captionTextStyle,
          fontWeight: props.primary ? '500' : '400',
          color: props.primary ? C.accent : C.secondary,
        }}
      >
        {props.label}
      </Text>
    </Button>
  );
}

function CompactDismissButton(props: { label?: string; onPress: () => void }) {
  const label = () => props.label ?? tr('Dismiss');
  return (
    <Button
      accessibilityLabel={label()}
      tooltip={textTooltip(label)}
      onPress={props.onPress}
      style={{
        width: 24,
        height: 24,
        borderRadius: 6,
        justifyContent: 'center',
        alignItems: 'center',
        flexShrink: 0,
      }}
      hoverStyle={quietHoverStyle()}
      activeStyle={quietActiveStyle()}
      focusStyle={quietFocusStyle()}
    >
      <Icon name="close" size={13} color={C.muted} />
    </Button>
  );
}

/**
 * Mode A: Sonner-style stacked floating toast host.
 * Anchored inside the desktop content panel (top-right, directly below the title bar)
 * with box-none hit testing so it never shifts outer chrome, composer, or PTY layouts.
 */
export function Toaster(props: {
  store?: ToastStore;
  top?: number;
  right?: number;
  maxWidth?: number;
  zIndex?: number;
}) {
  const store = props.store ?? getToastStore();
  const items = signal<readonly ToastRecord[]>(store.snapshot());
  const hovered = signal(false);
  const detailsOpenId = signal<string | null>(null);
  const copiedId = signal<string | null>(null);
  const heights = signal<Record<string, number>>({});
  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let pausedByToaster = false;

  const unsubscribe = store.subscribe(() => {
    const next = store.snapshot();
    items.set(next);
    const activeIds = new Set(next.map((record) => record.id));
    const currentDetails = detailsOpenId();
    if (currentDetails !== null && !activeIds.has(currentDetails)) {
      detailsOpenId.set(null);
    }
    const prevHeights = heights();
    let pruned = false;
    const nextHeights: Record<string, number> = {};
    for (const [id, value] of Object.entries(prevHeights)) {
      if (activeIds.has(id)) nextHeights[id] = value;
      else pruned = true;
    }
    if (pruned) heights.set(nextHeights);
  });

  const displayItems = () => {
    const all = items();
    return platform.idiom === 'terminal' ? all.filter((item) => !item.persistent) : all;
  };
  const visibleItems = () => displayItems().slice(0, MAX_EXPANDED_TOASTS);
  const expanded = () => hovered() || detailsOpenId() !== null;
  const hiddenCount = () => Math.max(0, displayItems().length - MAX_COLLAPSED_TOASTS);

  effect(() => {
    const hasItems = displayItems().length > 0;
    if (!hasItems && hovered()) {
      // Unmounting the stack while hovered skips onMouseLeave; clear hover so future
      // toasts start collapsed and auto-dismiss normally.
      hovered.set(false);
    }
    const shouldPause = expanded() && hasItems;
    if (shouldPause && !pausedByToaster) {
      pausedByToaster = true;
      store.pause();
    } else if (!shouldPause && pausedByToaster) {
      pausedByToaster = false;
      store.resume();
    }
  });

  cleanup(() => {
    unsubscribe();
    if (copyTimer !== null) clearTimeout(copyTimer);
    if (pausedByToaster) {
      pausedByToaster = false;
      store.resume();
    }
  });

  const cardWidth = () => Math.min(props.maxWidth ?? 400, Math.max(240, windowSize().width - 32));

  const measureHeight = (id: string, height: number) => {
    if (height <= 0) return;
    const rounded = Math.ceil(height);
    const prev = heights();
    if (prev[id] === rounded) return;
    heights.set({ ...prev, [id]: rounded });
  };

  const cardHeight = (id: string) => heights()[id] ?? DEFAULT_TOAST_HEIGHT;

  const frontHeight = () => {
    const front = visibleItems()[0];
    return front ? cardHeight(front.id) : DEFAULT_TOAST_HEIGHT;
  };

  const collapsedTranslateY = (index: number) => {
    if (index === 0) return 0;
    const depth = Math.min(index, MAX_COLLAPSED_TOASTS - 1);
    return depth * STACK_OFFSET_Y;
  };

  const expandedTranslateY = (index: number) => {
    const list = visibleItems();
    let y = 0;
    for (let i = 0; i < index && i < list.length; i++) {
      y += cardHeight(list[i]!.id) + EXPANDED_GAP;
    }
    return y;
  };

  const stackHeight = () => {
    const list = visibleItems();
    if (list.length === 0) return 0;
    if (expanded()) {
      let total = 0;
      for (let i = 0; i < list.length; i++) {
        total += cardHeight(list[i]!.id);
      }
      return total + (list.length - 1) * EXPANDED_GAP;
    }
    const frontH = cardHeight(list[0]!.id);
    const layers = Math.min(list.length, MAX_COLLAPSED_TOASTS);
    return frontH + (layers - 1) * STACK_OFFSET_Y;
  };

  const copyDetails = async (id: string, value: string) => {
    try {
      await Clipboard.writeText(value);
      copiedId.set(id);
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyTimer = null;
        if (copiedId() === id) copiedId.set(null);
      }, 1500);
    } catch {
      // Clipboard failures are non-fatal inside the diagnostic popover.
    }
  };

  const runAction = (recordId: string, action: ToastAction) => {
    action.onPress();
    if (action.dismissOnPress !== false) {
      store.dismiss(recordId);
    }
  };

  const renderCardContent = (item: () => ToastRecord, index: () => number) => (
    <>
      <View style={{ paddingTop: 1, flexShrink: 0 }}>
        <Icon name={toneIcon(item().tone)} size={14} color={toneColor(item().tone)} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <If when={Boolean(item().title)}>
          <Text
            style={[
              { ...captionTextStyle, fontWeight: '500', color: C.text },
              { numberOfLines: 1 },
            ]}
          >
            {item().title}
          </Text>
        </If>
        <Text
          style={[
            { ...captionTextStyle, color: item().title ? C.secondary : C.text },
            { numberOfLines: 2, userSelect: 'text' },
          ]}
        >
          {item().message}
        </Text>
      </View>
      <If when={platform.idiom !== 'terminal' && !expanded() && index() === 0 && hiddenCount() > 0}>
        <View
          style={{
            paddingHorizontal: 6,
            paddingVertical: 1,
            borderRadius: 999,
            backgroundColor: C.cardRaised,
            flexShrink: 0,
          }}
        >
          <Text style={{ fontSize: 11, lineHeight: 14, color: C.muted }}>+{hiddenCount()}</Text>
        </View>
      </If>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        <If when={item().details !== undefined}>
          <Popover
            open={detailsOpenId() === item().id}
            onOpenChange={({ open }) => {
              const id = item().id;
              if (open) detailsOpenId.set(id);
              else if (detailsOpenId() === id) detailsOpenId.set(null);
            }}
            align="end"
            offset={6}
            margin={8}
            popupStyle={{
              ...floatingStyle(),
              width: Math.min(420, Math.max(260, windowSize().width - 32)),
              padding: 12,
              gap: 8,
            }}
            trigger={
              <Button
                accessibilityLabel={item().details?.label ?? tr('Details')}
                selected={detailsOpenId() === item().id}
                style={{
                  height: 24,
                  paddingHorizontal: 8,
                  borderRadius: 6,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
                selectedStyle={{ backgroundColor: C.floatingRaised }}
                hoverStyle={quietHoverStyle()}
                activeStyle={quietActiveStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Text style={{ ...captionTextStyle, color: C.secondary }}>
                  {item().details?.label ?? tr('Details')}
                </Text>
              </Button>
            }
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ ...captionTextStyle, fontWeight: '500', color: C.text, flex: 1 }}>
                {tr('Diagnostic details')}
              </Text>
              <Button
                accessibilityLabel={copiedId() === item().id ? tr('Copied') : tr('Copy')}
                onPress={() => void copyDetails(item().id, item().details?.text ?? '')}
                style={{
                  height: 24,
                  paddingHorizontal: 8,
                  borderRadius: 6,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 4,
                }}
                hoverStyle={quietHoverStyle()}
                activeStyle={quietActiveStyle()}
                focusStyle={quietFocusStyle()}
              >
                <Icon
                  name={copiedId() === item().id ? 'check' : 'copy'}
                  size={13}
                  color={copiedId() === item().id ? C.accent : C.secondary}
                />
                <Text
                  style={{
                    ...captionTextStyle,
                    color: copiedId() === item().id ? C.accent : C.secondary,
                  }}
                >
                  {copiedId() === item().id ? tr('Copied') : tr('Copy')}
                </Text>
              </Button>
            </View>
            <Scroll style={{ maxHeight: 200 }}>
              <Text style={[{ ...captionTextStyle, color: C.secondary }, { userSelect: 'text' }]}>
                {item().details?.text ?? ''}
              </Text>
            </Scroll>
          </Popover>
        </If>
        <Each of={item().actions.slice(0, 2)} key={(action) => action.label}>
          {(action) => (
            <CompactFeedbackButton
              label={action().label}
              primary={action().primary}
              onPress={() => runAction(item().id, action())}
            />
          )}
        </Each>
        <If when={item().dismissible}>
          <CompactDismissButton onPress={() => store.dismiss(item().id)} />
        </If>
      </View>
    </>
  );

  return (
    <If when={visibleItems().length > 0}>
      <If
        when={platform.idiom !== 'terminal'}
        else={
          <View
            style={[
              {
                position: 'absolute',
                top: 1,
                right: 2,
                gap: 4,
                zIndex: props.zIndex ?? 80,
              },
              { pointerEvents: 'box-none' },
            ]}
          >
            <Each of={visibleItems().slice(0, 2)} key={(item) => item.id}>
              {(item, index) => (
                <View
                  style={{
                    ...floatingStyle(),
                    padding: 0,
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    maxWidth: cardWidth(),
                  }}
                >
                  {renderCardContent(item, index)}
                </View>
              )}
            </Each>
          </View>
        }
      >
        <View
          onMouseEnter={() => hovered.set(true)}
          onMouseLeave={() => hovered.set(false)}
          style={[
            {
              position: 'absolute',
              top: props.top ?? PANEL_INSET + TITLE_BAR_HEIGHT + 8,
              right: props.right ?? PANEL_INSET + 16,
              width: cardWidth(),
              height: stackHeight(),
              zIndex: props.zIndex ?? 80,
            },
            // Sized strictly to the active stack so hovering across expanded gaps stays continuous.
            { pointerEvents: 'auto' },
          ]}
        >
          <Each of={visibleItems()} key={(item) => item.id}>
            {(item, index) => {
              const isCollapsedBack = () => !expanded() && index() > 0;
              const isCollapsedHidden = () => !expanded() && index() >= MAX_COLLAPSED_TOASTS;
              const isInteractive = () => expanded() || index() === 0;
              const translateY = () =>
                expanded() ? expandedTranslateY(index()) : collapsedTranslateY(index());
              const scale = () => {
                if (expanded()) return 1;
                if (index() >= MAX_COLLAPSED_TOASTS) {
                  return 1 - MAX_COLLAPSED_TOASTS * STACK_SCALE_STEP;
                }
                return 1 - index() * STACK_SCALE_STEP;
              };
              const opacity = () => {
                if (expanded()) return 1;
                if (index() === 0) return 1;
                if (index() === 1) return 0.9;
                if (index() === 2) return 0.78;
                return 0;
              };
              const motion = () =>
                reduceMotion()
                  ? {}
                  : {
                      transitionProperty: 'opacity, transform',
                      transitionDuration: 180,
                      transitionTimingFunction: 'ease-out' as const,
                    };
              return (
                <View
                  style={[
                    {
                      ...floatingStyle(),
                      padding: 0,
                      position: 'absolute',
                      top: 0,
                      right: 0,
                      width: cardWidth(),
                      ...(isCollapsedBack() ? { height: frontHeight() } : {}),
                      zIndex: 40 - index(),
                      opacity: opacity(),
                      translate: [0, translateY()],
                      scale: scale(),
                      ...motion(),
                    },
                    { pointerEvents: isInteractive() && !isCollapsedHidden() ? 'auto' : 'none' },
                  ]}
                >
                  <View
                    style={{
                      width: '100%',
                      borderRadius: 11,
                      ...(isCollapsedBack()
                        ? { height: frontHeight(), overflow: 'hidden' as const }
                        : {}),
                    }}
                  >
                    <View
                      onLayout={({ bounds }) => measureHeight(item().id, bounds.size.height)}
                      style={{
                        width: '100%',
                        flexShrink: 0,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      {renderCardContent(item, index)}
                    </View>
                  </View>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
    </If>
  );
}

/**
 * Mode A (panel-scoped persistent capsule): non-intrusive floating notice anchored
 * inside a specific pane (such as a live Terminal) without triggering layout/PTY resize.
 */
export function FloatingNoticeCapsule(props: {
  tone?: ToastTone;
  message: string;
  action?: RegionFeedbackAction;
  secondaryAction?: RegionFeedbackAction;
  onDismiss?: () => void;
  style?: ViewStyle;
}) {
  const tone = () => props.tone ?? 'warning';
  return (
    <View
      style={{
        ...floatingStyle(),
        padding: 0,
        paddingHorizontal: 12,
        paddingVertical: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        maxWidth: 420,
        ...props.style,
      }}
    >
      <Icon name={toneIcon(tone())} size={14} color={toneColor(tone())} />
      <Text
        style={[
          { ...captionTextStyle, color: C.text, flex: 1, minWidth: 0 },
          { numberOfLines: 2, userSelect: 'text' },
        ]}
      >
        {props.message}
      </Text>
      <If when={props.secondaryAction !== undefined}>
        <CompactFeedbackButton
          label={props.secondaryAction!.label}
          primary={props.secondaryAction!.primary}
          disabled={props.secondaryAction!.disabled}
          onPress={props.secondaryAction!.onPress}
        />
      </If>
      <If when={props.action !== undefined}>
        <CompactFeedbackButton
          label={props.action!.label}
          primary={props.action!.primary ?? true}
          disabled={props.action!.disabled}
          onPress={props.action!.onPress}
        />
      </If>
      <If when={props.onDismiss !== undefined}>
        <CompactDismissButton onPress={props.onDismiss!} />
      </If>
    </View>
  );
}

/**
 * Mode C1: Centered region empty-error replacement when a pane/list has no content to display.
 */
export function RegionEmptyError(props: {
  title: string;
  detail?: string;
  tone?: ToastTone;
  icon?: Parameters<typeof Icon>[0]['name'];
  surface?: 'panel' | 'chrome';
  compact?: boolean;
  retry?: () => void;
  retryLabel?: string;
  action?: RegionFeedbackAction;
  secondaryAction?: RegionFeedbackAction;
  style?: ViewStyle;
}) {
  const tone = () => props.tone ?? 'danger';
  const iconName = () => props.icon ?? toneIcon(tone());
  const compact = () => props.compact ?? false;
  const primaryAction = (): RegionFeedbackAction | undefined =>
    props.action ??
    (props.retry
      ? {
          label: props.retryLabel ?? tr('Retry'),
          onPress: props.retry,
          primary: true,
        }
      : undefined);

  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        justifyContent: 'center',
        alignItems: 'center',
        padding: compact() ? 16 : 32,
        gap: compact() ? 8 : 12,
        ...props.style,
      }}
    >
      <If when={platform.idiom !== 'terminal'}>
        <View
          style={{
            width: compact() ? 36 : 48,
            height: compact() ? 36 : 48,
            borderRadius: compact() ? 10 : 12,
            backgroundColor: props.surface === 'chrome' ? C.raised : C.card,
            borderWidth: 1,
            borderColor: C.line,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Icon name={iconName()} size={compact() ? 16 : 20} color={toneColor(tone())} />
        </View>
      </If>
      <Text
        style={[
          {
            ...(compact() ? captionTextStyle : bodyTextStyle),
            color: C.text,
            fontWeight: '500',
            textAlign: 'center',
            maxWidth: compact() ? 220 : 380,
          },
          { userSelect: 'text' },
        ]}
      >
        {props.title}
      </Text>
      <If when={Boolean(props.detail)}>
        <Text
          style={[
            {
              ...captionTextStyle,
              color: C.muted,
              textAlign: 'center',
              maxWidth: compact() ? 220 : 380,
            },
            { userSelect: 'text' },
          ]}
        >
          {props.detail}
        </Text>
      </If>
      <If when={primaryAction() !== undefined || props.secondaryAction !== undefined}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <If when={props.secondaryAction !== undefined}>
            <Button
              accessibilityLabel={props.secondaryAction!.label}
              disabled={props.secondaryAction!.disabled}
              onPress={props.secondaryAction!.onPress}
              style={{
                ...controlStyle,
                height: compact() ? 28 : 32,
                paddingHorizontal: 12,
                borderRadius: 8,
                justifyContent: 'center',
                alignItems: 'center',
                borderWidth: platform.idiom === 'terminal' ? 0 : 1,
                borderColor: C.line,
                backgroundColor: props.surface === 'chrome' ? C.raised : C.card,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>
                {props.secondaryAction!.label}
              </Text>
            </Button>
          </If>
          <If when={primaryAction() !== undefined}>
            <Button
              accessibilityLabel={primaryAction()!.label}
              disabled={primaryAction()!.disabled}
              onPress={primaryAction()!.onPress}
              style={{
                ...controlStyle,
                height: compact() ? 28 : 32,
                paddingHorizontal: 12,
                borderRadius: 8,
                justifyContent: 'center',
                alignItems: 'center',
                borderWidth: platform.idiom === 'terminal' ? 0 : 1,
                borderColor: C.line,
                backgroundColor: props.surface === 'chrome' ? C.raised : C.card,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              disabledStyle={controlDisabledStyle}
            >
              <Text
                style={{
                  ...captionTextStyle,
                  fontWeight: '500',
                  color: primaryAction()!.primary === false ? C.secondary : C.accent,
                }}
              >
                {primaryAction()!.label}
              </Text>
            </Button>
          </If>
        </View>
      </If>
    </View>
  );
}

/**
 * Mode C2: Compact inline callout strip inside a pane/list/dialog that already shows content.
 */
export function InlineCallout(props: {
  tone?: ToastTone;
  surface?: 'panel' | 'chrome';
  icon?: Parameters<typeof Icon>[0]['name'];
  message: string;
  detail?: string;
  action?: RegionFeedbackAction;
  secondaryAction?: RegionFeedbackAction;
  onDismiss?: () => void;
  dismissLabel?: string;
  style?: ViewStyle;
}) {
  const tone = () => props.tone ?? 'danger';
  const iconName = () => props.icon ?? toneIcon(tone());
  const textColor = () => {
    switch (tone()) {
      case 'danger':
        return C.danger;
      case 'warning':
        return C.warning;
      case 'info':
        return C.secondary;
    }
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: platform.idiom === 'terminal' ? 8 : 10,
        paddingVertical: platform.idiom === 'terminal' ? 4 : 6,
        borderRadius: 8,
        ...(platform.idiom === 'terminal'
          ? {}
          : {
              backgroundColor: props.surface === 'chrome' ? C.raised : C.card,
              borderWidth: 1,
              borderColor: C.line,
            }),
        ...props.style,
      }}
    >
      <View style={{ flexShrink: 0 }}>
        <Icon name={iconName()} size={14} color={toneColor(tone())} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[{ ...captionTextStyle, color: textColor() }, { userSelect: 'text' }]}>
          {props.message}
        </Text>
        <If when={Boolean(props.detail)}>
          <Text style={[{ ...captionTextStyle, color: C.muted }, { userSelect: 'text' }]}>
            {props.detail}
          </Text>
        </If>
      </View>
      <If when={props.secondaryAction !== undefined}>
        <CompactFeedbackButton
          label={props.secondaryAction!.label}
          primary={props.secondaryAction!.primary}
          disabled={props.secondaryAction!.disabled}
          onPress={props.secondaryAction!.onPress}
        />
      </If>
      <If when={props.action !== undefined}>
        <CompactFeedbackButton
          label={props.action!.label}
          primary={props.action!.primary ?? true}
          disabled={props.action!.disabled}
          onPress={props.action!.onPress}
        />
      </If>
      <If when={props.onDismiss !== undefined}>
        <CompactDismissButton label={props.dismissLabel} onPress={props.onDismiss!} />
      </If>
    </View>
  );
}

/**
 * Mode B: Unified top-docked shelf sitting flush on the composer's straight top edge.
 * Shared by Conversations (ComposerDetails) and Rooms (RoomComposer).
 */
export function ComposerShelf(props: {
  inset?: number;
  accessibilityLabel?: string;
  style?: ViewStyle;
  children: JSX.Element;
}) {
  const inset = () => props.inset ?? 24;
  return (
    <View
      accessibilityLabel={props.accessibilityLabel}
      style={{
        minHeight: 0,
        flexShrink: 1,
        backgroundColor: C.card,
        overflow: 'hidden',
        ...(platform.idiom === 'terminal'
          ? { marginBottom: 16, borderWidth: 1, borderColor: C.line, borderRadius: 12 }
          : {
              // A docked lip on the composer card rather than a second card stacked above it.
              marginHorizontal: inset(),
              borderTopWidth: 1,
              borderLeftWidth: 1,
              borderRightWidth: 1,
              borderBottomWidth: 0,
              borderColor: C.line,
              borderTopLeftRadius: 12,
              borderTopRightRadius: 12,
            }),
        ...props.style,
      }}
    >
      {props.children}
    </View>
  );
}

/** A single compact status/action row inside a ComposerShelf. */
export function ComposerShelfRow(props: {
  tone?: ToastTone;
  icon?: Parameters<typeof Icon>[0]['name'];
  message: string;
  detail?: string;
  divided?: boolean;
  action?: RegionFeedbackAction;
  secondaryAction?: RegionFeedbackAction;
  onDismiss?: () => void;
  dismissLabel?: string;
}) {
  const tone = () => props.tone ?? 'info';
  const iconName = () => props.icon ?? toneIcon(tone());
  const textColor = () => {
    switch (tone()) {
      case 'danger':
        return C.danger;
      case 'warning':
        return C.warning;
      case 'info':
        return C.secondary;
    }
  };
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 7,
        flexShrink: 0,
        ...(props.divided ? { borderBottomWidth: 1, borderBottomColor: C.line } : {}),
      }}
    >
      <View style={{ flexShrink: 0 }}>
        <Icon name={iconName()} size={14} color={toneColor(tone())} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={[{ ...captionTextStyle, color: textColor() }, { userSelect: 'text' }]}>
          {props.message}
        </Text>
        <If when={Boolean(props.detail)}>
          <Text
            style={[
              { ...captionTextStyle, color: C.muted },
              { numberOfLines: 2, userSelect: 'text' },
            ]}
          >
            {props.detail}
          </Text>
        </If>
      </View>
      <If when={props.secondaryAction !== undefined}>
        <CompactFeedbackButton
          label={props.secondaryAction!.label}
          primary={props.secondaryAction!.primary}
          disabled={props.secondaryAction!.disabled}
          onPress={props.secondaryAction!.onPress}
        />
      </If>
      <If when={props.action !== undefined}>
        <CompactFeedbackButton
          label={props.action!.label}
          primary={props.action!.primary ?? true}
          disabled={props.action!.disabled}
          onPress={props.action!.onPress}
        />
      </If>
      <If when={props.onDismiss !== undefined}>
        <CompactDismissButton label={props.dismissLabel} onPress={props.onDismiss!} />
      </If>
    </View>
  );
}
