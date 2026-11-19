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

import { Canvas, signal, Text, View, type ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import {
  composerToolbar,
  computeDropSlot,
  isDefaultComposerToolbarLayout,
  type ComposerToolbarSlot,
  type ComposerToolbarWidget,
  type ContextUsageDisplay,
  type SlotBounds,
} from './composerToolbar';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  SettingsButton,
  SettingsSection,
  SettingsSegmented,
  SettingsSwitch,
  settingsInset,
} from './SettingsPage';
import { C } from './ui';

type MeasuredTrack = {
  left: number;
  width: number;
  slots: SlotBounds[];
  spacer: SlotBounds | null;
};

type DragState = {
  widget: ComposerToolbarWidget;
  targetIndex: number;
  indicatorX: number;
  overSpacer: boolean;
};

function widgetLabel(widget: ComposerToolbarWidget): string {
  switch (widget) {
    case 'permissions':
      return tr('Permissions');
    case 'workspace':
      return tr('Workspace');
    case 'usage':
      return tr('Usage');
    case 'context':
      return tr('Context');
    case 'model':
      return tr('Model');
  }
}

function GripDots(props: { color: string }) {
  return (
    <Canvas
      accessibilityElementsHidden
      style={[{ width: 10, height: 14 }, { pointerEvents: 'none' }]}
      draw={(cx) => {
        cx.fillStyle = props.color;
        for (const x of [3, 7]) {
          for (const y of [3, 7, 11]) {
            cx.beginPath();
            cx.arc(x, y, 1, 0, Math.PI * 2);
            cx.fill();
          }
        }
      }}
    />
  );
}

export function ComposerToolbarSettings() {
  const selected = signal<ComposerToolbarWidget | null>(null);
  const drag = signal<DragState | null>(null);
  const slotRefs = new Map<ComposerToolbarSlot, ViewRef>();
  let trackRef: ViewRef | null = null;
  let measured: MeasuredTrack | null = null;
  let dragGeneration = 0;

  const isOff = (widget: ComposerToolbarWidget) =>
    (widget === 'context' && composerToolbar.contextUsage() === 'off') ||
    (widget === 'usage' && !composerToolbar.usageLimits());

  const updateDragPosition = (pageX: number) => {
    const active = drag();
    if (!active || !measured || !measured.slots.length) return;
    const { index, indicatorX } = computeDropSlot(
      pageX,
      measured.left,
      measured.width,
      measured.slots,
    );
    const overSpacer =
      measured.spacer !== null &&
      pageX >= measured.spacer.left - 6 &&
      pageX <= measured.spacer.left + measured.spacer.width + 6;
    drag.set({
      widget: active.widget,
      targetIndex: index,
      indicatorX,
      overSpacer,
    });
  };

  const beginDrag = (widget: ComposerToolbarWidget, pageX: number) => {
    const generation = ++dragGeneration;
    const layout = composerToolbar.layout();
    const initialIndex = layout.indexOf(widget);
    selected.set(widget);
    measured = null;
    drag.set({
      widget,
      targetIndex: initialIndex,
      indicatorX: 0,
      overSpacer: false,
    });
    const track = trackRef;
    if (!track) return;
    void Promise.all([
      track.measure(),
      ...layout.map((slot) => slotRefs.get(slot)?.measure() ?? Promise.resolve(null)),
    ]).then(([trackBox, ...slotBoxes]) => {
      if (generation !== dragGeneration || !drag() || !trackBox) return;
      const slots: SlotBounds[] = [];
      let spacer: SlotBounds | null = null;
      for (let i = 0; i < layout.length; i++) {
        const box = slotBoxes[i];
        const bounds: SlotBounds = box
          ? { left: box.pagePosition.x, width: box.bounds.size.width }
          : { left: trackBox.pagePosition.x, width: 0 };
        slots.push(bounds);
        if (layout[i] === 'spacer') spacer = bounds;
      }
      measured = {
        left: trackBox.pagePosition.x,
        width: trackBox.bounds.size.width,
        slots,
        spacer,
      };
      updateDragPosition(pageX);
    });
  };

  const finishDrag = (commit: boolean) => {
    dragGeneration++;
    const active = drag();
    drag.set(null);
    measured = null;
    if (commit && active) {
      composerToolbar.moveWidget(active.widget, active.targetIndex);
    }
  };

  const selectedIndex = () => {
    const current = selected();
    return current ? composerToolbar.layout().indexOf(current) : -1;
  };
  const selectionNote = () => {
    const current = selected();
    const index = selectedIndex();
    if (!current || index === -1) {
      return tr('Drag widgets to reorder, or select one to move with buttons.');
    }
    const spacer = composerToolbar.layout().indexOf('spacer');
    return tr(index < spacer ? '{name} · Left' : '{name} · Right', {
      name: widgetLabel(current),
    });
  };

  return (
    <SettingsSection
      title={tr('Composer')}
      trailing={
        <If when={!isDefaultComposerToolbarLayout(composerToolbar.layout())}>
          <SettingsButton
            label={tr('Reset')}
            tone="quiet"
            onPress={() => {
              selected.set(null);
              composerToolbar.resetLayout();
            }}
          />
        </If>
      }
    >
      <View
        style={{
          paddingHorizontal: settingsInset,
          paddingVertical: 12,
          gap: 10,
        }}
      >
        <View style={{ gap: 2 }}>
          <Text style={{ fontSize: 14, lineHeight: 20, color: C.text }}>
            {tr('Toolbar layout')}
          </Text>
          <Text style={{ fontSize: 12, lineHeight: 16, color: C.muted }}>
            {tr('Drag widgets to change their order or move them across the spacer.')}
          </Text>
        </View>
        <View
          accessibilityLabel={tr('Composer toolbar layout')}
          style={{
            backgroundColor: C.background,
            borderWidth: 1,
            borderColor: C.line,
            borderRadius: 14,
            padding: 6,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            minHeight: 44,
          }}
        >
          <View
            accessibilityElementsHidden
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: C.raised,
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              opacity: 0.7,
            }}
          >
            <Icon name="plus" color={C.muted} />
          </View>
          <View
            ref={(node) => {
              trackRef = node;
            }}
            style={{
              flex: 1,
              minWidth: 0,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              minHeight: 30,
              position: 'relative',
            }}
          >
            <Each<ComposerToolbarSlot>
              of={composerToolbar.layout()}
              key={(slot: ComposerToolbarSlot) => slot}
            >
              {(item) => {
                const slot = item();
                if (slot === 'spacer') {
                  return (
                    <View
                      ref={(node) => {
                        if (node) slotRefs.set('spacer', node);
                        else slotRefs.delete('spacer');
                      }}
                      style={{
                        flex: 1,
                        minWidth: 20,
                        height: 28,
                        borderRadius: 6,
                        borderWidth: 1,
                        borderStyle: 'dashed',
                        borderColor: drag()?.overSpacer ? C.accent : C.line,
                        backgroundColor: drag()?.overSpacer ? C.raised : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingHorizontal: 4,
                      }}
                    >
                      <Text
                        style={[
                          {
                            fontSize: 11,
                            lineHeight: 14,
                            color: drag()?.overSpacer ? C.accent : C.muted,
                          },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {tr('Spacer')}
                      </Text>
                    </View>
                  );
                }
                const widget = slot;
                return (
                  <View
                    ref={(node) => {
                      if (node) slotRefs.set(widget, node);
                      else slotRefs.delete(widget);
                    }}
                    onMoveShouldSetResponder={(_event, gesture) =>
                      Math.hypot(gesture.dx, gesture.dy) > 4
                    }
                    onResponderTerminationRequest={() => false}
                    onResponderGrant={(event) => {
                      beginDrag(widget, event.pageX);
                      return true;
                    }}
                    onResponderMove={(event) => {
                      updateDragPosition(event.pageX);
                    }}
                    onResponderRelease={() => {
                      finishDrag(true);
                    }}
                    onResponderTerminate={() => {
                      finishDrag(false);
                    }}
                  >
                    <Button
                      accessibilityLabel={widgetLabel(widget)}
                      selected={selected() === widget}
                      onPress={() => selected.set(selected() === widget ? null : widget)}
                      style={{
                        height: 30,
                        paddingLeft: 6,
                        paddingRight: 8,
                        borderRadius: 8,
                        backgroundColor: C.surface,
                        borderWidth: 1,
                        borderStyle: isOff(widget) ? 'dashed' : 'solid',
                        borderColor: selected() === widget ? C.accent : C.line,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 4,
                        flexShrink: 0,
                        opacity: drag()?.widget === widget ? 0.35 : isOff(widget) ? 0.5 : 1,
                      }}
                      hoverStyle={{ backgroundColor: C.raised }}
                      focusStyle={{ borderColor: C.accent, backgroundColor: C.raised }}
                    >
                      <GripDots color={C.muted} />
                      <Text
                        style={[
                          { fontSize: 12, lineHeight: 16, fontWeight: '500', color: C.text },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {widgetLabel(widget)}
                      </Text>
                    </Button>
                  </View>
                );
              }}
            </Each>
            <If when={drag() !== null}>
              <View
                style={[
                  {
                    position: 'absolute',
                    top: 2,
                    bottom: 2,
                    left: drag()?.indicatorX ?? 0,
                    width: 2,
                    borderRadius: 1,
                    backgroundColor: C.accent,
                  },
                  { pointerEvents: 'none' },
                ]}
              />
            </If>
          </View>
          <View
            accessibilityElementsHidden
            style={{
              width: 28,
              height: 28,
              borderRadius: 14,
              backgroundColor: C.raised,
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              opacity: 0.7,
            }}
          >
            <Icon name="send" color={C.secondary} />
          </View>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <Text
            style={[
              { fontSize: 12, lineHeight: 16, color: C.muted, flex: 1 },
              { numberOfLines: 1 },
            ]}
          >
            {selectionNote()}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <SettingsButton
              label={tr('Move left')}
              tone="quiet"
              disabled={selectedIndex() <= 0}
              onPress={() => {
                const current = selected();
                if (current) composerToolbar.stepWidget(current, -1);
              }}
            />
            <SettingsButton
              label={tr('Move right')}
              tone="quiet"
              disabled={
                selectedIndex() === -1 || selectedIndex() >= composerToolbar.layout().length - 1
              }
              onPress={() => {
                const current = selected();
                if (current) composerToolbar.stepWidget(current, 1);
              }}
            />
          </View>
        </View>
      </View>
      <SettingsSegmented
        label={tr('Context usage')}
        description={tr('Show how much of the model context window is in use.')}
        value={composerToolbar.contextUsage()}
        choices={[
          { value: 'always', title: tr('Always') },
          { value: 'high', title: tr('70%+') },
          { value: 'off', title: tr('Off') },
        ]}
        change={(value) => composerToolbar.chooseContextUsage(value as ContextUsageDisplay)}
      />
      <SettingsSwitch
        label={tr('Usage limits')}
        description={tr('Show remaining usage when the selected model connection reports it.')}
        checked={composerToolbar.usageLimits()}
        onPress={() => composerToolbar.setUsageLimits(!composerToolbar.usageLimits())}
      />
    </SettingsSection>
  );
}
