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
  computed,
  createAnimatedValue,
  cleanup,
  untracked,
  effect,
  inputAction,
  reduceMotion,
  signal,
  windowSize,
  Text,
  View,
  type JSX,
  type ViewStyle,
} from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import {
  C,
  controlFocusStyle,
  controlHoverStyle,
} from '../../../../products/maka/workbench/app/ui';
import { errorMessage } from '../../../../products/maka/workbench/app/text';
import type { ComputerStageController, ComputerTarget } from './computerStageController';
import { computerText } from './computerText';

type Size = { width: number; height: number };
const OFFSET_X = 18;
const OFFSET_Y = 14;

/** The stage has no Computer input capability; clicks only select a presentation. */
export function ComputerStage(props: {
  controller: ComputerStageController;
  frameSize(targetId: string): Size | undefined;
  frameError(targetId: string): string | undefined;
  frameReady(targetId: string): boolean;
  viewport: Size;
  renderFrame(target: () => ComputerTarget, selected: () => boolean): JSX.Element;
  renderExpandedFrame(target: () => ComputerTarget): JSX.Element;
}) {
  const stage = props.controller;
  const label = computerText;
  const candidates = computed(() => stage.targets().filter((target) => props.frameSize(target.id)));
  const hovered = signal(false);
  const focused = signal(false);
  const presented = signal<string | null>(null);
  const ready = computed(() => candidates().filter((target) => props.frameReady(target.id)));
  // Keep the displayed target until its replacement has pixels, never across retirement.
  effect(() => {
    const targets = ready();
    const selected = stage.selected();
    if (targets.some((target) => target.id === selected)) presented.set(selected);
    else if (!targets.some((target) => target.id === presented()))
      presented.set(targets[0]?.id ?? null);
  });
  const expanded = signal<{ id: string; revision: number; bindingId: string | null } | null>(null);
  const expandedTarget = computed(() => {
    const identity = expanded();
    if (!identity || stage.hidden() || stage.snapshot()?.bindingId !== identity.bindingId)
      return undefined;
    return stage
      .targets()
      .find(
        (target) =>
          target.id === identity.id &&
          target.revision === identity.revision &&
          props.frameReady(target.id) &&
          !props.frameError(target.id),
      );
  });
  effect(() => {
    if (expanded() && !expandedTarget()) expanded.set(null);
  });
  const dismissExpanded = () => expanded.set(null);
  const interact = (id: string) => {
    if (presented() !== id) {
      stage.select(id);
      return;
    }
    const target = stage.targets().find((target) => target.id === id)!;
    expanded.set({
      id,
      revision: target.revision,
      bindingId: stage.snapshot()?.bindingId ?? null,
    });
  };
  const expandedSize = computed(() => {
    const target = expandedTarget();
    const original = target && props.frameSize(target.id);
    if (!original) return { width: 0, height: 0 };
    const space = windowSize();
    const scale = Math.min(
      1,
      Math.max(1, space.width - 48) / original.width,
      Math.max(1, space.height - 96) / original.height,
    );
    return { width: original.width * scale, height: original.height * scale };
  });
  const ordered = computed(() => {
    const targets = candidates();
    return [
      ...targets.filter((target) => target.id === presented()),
      ...targets.filter((target) => target.id !== presented()),
    ];
  });
  const layout = computed(() => {
    const count = ordered().length;
    const space = props.viewport;
    const layers = Math.max(0, count - 1);
    const limit = Math.min(
      480,
      Math.max(240, Math.min(space.width * 0.42, space.height * 0.6)),
      Math.max(1, space.width - 48 - OFFSET_X * layers),
      Math.max(1, space.height - 88 - OFFSET_Y * layers),
    );
    const items = new Map<string, Size & { depth: number }>();
    let width = 0;
    let height = 0;
    ordered().forEach((target, depth) => {
      const original = props.frameSize(target.id)!;
      const scale = Math.min(1, limit / original.width, limit / original.height);
      const size = { width: original.width * scale, height: original.height * scale, depth };
      items.set(target.id, size);
      width = Math.max(width, size.width + depth * OFFSET_X);
      height = Math.max(height, size.height + depth * OFFSET_Y);
    });
    return { items, width, height };
  });
  const error = () =>
    stage.fault() !== null
      ? errorMessage(stage.fault())
      : stage
          .targets()
          .map((target) => props.frameError(target.id))
          .find(Boolean);
  const present = () => stage.targets().length > 0 || stage.fault() !== null;
  const content = computed(() =>
    !present()
      ? { width: 0, height: 0 }
      : {
          width: Math.max(stage.hidden() ? 0 : layout().width, error() ? 320 : 128) + 32,
          height:
            (stage.hidden() ? 0 : layout().height) +
            32 +
            (error() ? 80 : candidates().length === 0 ? 40 : 0),
        },
  );
  const offsetX = createAnimatedValue(0);
  const offsetY = createAnimatedValue(0);
  const returnHome = () => {
    if (reduceMotion()) {
      offsetX.set(0);
      offsetY.set(0);
    } else {
      void offsetX.spring(0, { mass: 1, stiffness: 185, damping: 18 });
      void offsetY.spring(0, { mass: 1, stiffness: 185, damping: 18 });
    }
  };
  cleanup(() => {
    void offsetX.stop();
    void offsetY.stop();
  });
  const controls = () => hovered() || focused() || stage.pinned();
  const toolbarMaxWidth = computed(() => {
    const frame = layout().items.get(presented() ?? '');
    return !stage.hidden() && !error() && frame ? Math.max(0, frame.width - 16) : undefined;
  });
  const iconButton: ViewStyle = {
    width: 28,
    height: 28,
    padding: 5,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  };
  return (
    <View
      accessibilityLabel={label('Computer')}
      pan={{ x: offsetX, y: offsetY }}
      onPanEnd={returnHome}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 10,
        translate: [offsetX, offsetY],
        width: content().width,
        height: content().height,
        padding: present() ? 16 : 0,
        pointerEvents: 'box-none',
      }}
    >
      <If when={stage.targets().length > 0 || stage.fault() !== null}>
        <View
          onMouseEnter={() => hovered.set(true)}
          onMouseLeave={() => hovered.set(false)}
          onFocus={() => focused.set(true)}
          onBlur={() => focused.set(false)}
          style={{
            maxWidth: '100%',
            pointerEvents: 'box-none',
          }}
        >
          <If when={!stage.hidden() && candidates().length > 0}>
            <View
              style={{
                width: layout().width,
                height: layout().height,
                position: 'relative',
                pointerEvents: 'box-none',
              }}
            >
              <Each
                of={stage.targets()}
                key={(target) => JSON.stringify([target.id, target.revision])}
              >
                {(target) => {
                  const size = () => layout().items.get(target().id);
                  const selected = () => presented() === target().id;
                  const laidOut = signal(false);
                  let entranceFrame: number | undefined;
                  const startEntrance = () => {
                    if (laidOut() || entranceFrame !== undefined) return;
                    // Layout may run within the initial commit; keep its blur style for one frame.
                    entranceFrame = requestAnimationFrame(() => laidOut.set(true));
                  };
                  const visible = () =>
                    (reduceMotion() || laidOut()) &&
                    presented() !== null &&
                    props.frameReady(target().id);
                  const scale = createAnimatedValue(0.72);
                  effect(() => {
                    if (visible()) {
                      if (reduceMotion()) scale.set(1);
                      else void scale.spring(1, { mass: 1, stiffness: 185, damping: 18 });
                    } else scale.set(0.72);
                  });
                  cleanup(() => {
                    cancelAnimationFrame(entranceFrame);
                    void scale.stop();
                  });
                  return (
                    <If when={size() !== undefined}>
                      <Button
                        accessibilityLabel={target().title}
                        onLayout={startEntrance}
                        onPress={inputAction(interact, target().id)}
                        style={{
                          position: 'absolute',
                          top: (size()?.depth ?? 0) * OFFSET_Y,
                          right: (size()?.depth ?? 0) * OFFSET_X,
                          width: size()?.width,
                          height: size()?.height,
                          zIndex: 5 - (size()?.depth ?? 0),
                          opacity: visible() ? 1 : 0,
                          pointerEvents: visible() ? 'auto' : 'none',
                          transformOrigin: 'top right',
                          transform: [{ scale }],
                          padding: 0,
                          alignItems: 'stretch',
                          backgroundColor: C.background,
                          borderRadius: 16,
                          boxShadow: `0 6px 20px ${C.shadow}`,
                          transitionProperty: 'opacity',
                          transitionDuration: reduceMotion() ? 0 : 200,
                          transitionTimingFunction: 'ease-out',
                        }}
                        hoverStyle={{ opacity: 0.95 }}
                        focusStyle={controlFocusStyle()}
                      >
                        <View
                          style={{
                            flexGrow: 1,
                            borderRadius: 16,
                            overflow: 'hidden',
                            filter: visible() || reduceMotion() ? 'blur(0px)' : 'blur(18px)',
                            transitionProperty: 'filter',
                            transitionDuration: reduceMotion() ? 0 : 280,
                            transitionTimingFunction: 'ease-out',
                          }}
                        >
                          {untracked(() => props.renderFrame(target, selected))}
                        </View>
                      </Button>
                    </If>
                  );
                }}
              </Each>
            </View>
          </If>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 2,
              flexWrap: 'wrap',
              position: 'absolute',
              top: error() || candidates().length === 0 ? layout().height + 8 : 8,
              right: 8,
              maxWidth: toolbarMaxWidth(),
              zIndex: 6,
              padding: 4,
              borderRadius: 10,
              backgroundColor: C.raised,
              opacity: error() || ready().length === 0 || controls() ? 1 : 0,
              transitionProperty: 'opacity',
              transitionDuration: reduceMotion() ? 0 : 150,
              justifyContent: 'flex-end',
              pointerEvents: error() || ready().length === 0 || controls() ? 'auto' : 'none',
            }}
          >
            <If when={stage.hidden() || ready().length === 0 || error()}>
              <View
                style={{
                  maxWidth: 300,
                  gap: 4,
                  padding: 8,
                  borderRadius: 10,
                  backgroundColor: C.raised,
                }}
              >
                <Text style={{ fontSize: 11, color: error() ? C.warning : C.secondary }}>
                  {label(
                    stage.hidden()
                      ? 'Computer'
                      : error()
                        ? 'Live view unavailable'
                        : 'Waiting for live frame…',
                  )}
                </Text>
                <If when={!stage.hidden() && error()}>
                  <Text style={{ fontSize: 10, color: C.secondary, numberOfLines: 3 }}>
                    {error()}
                  </Text>
                </If>
              </View>
            </If>
            <If when={!stage.hidden() && error()}>
              <Button
                accessibilityLabel={label('Retry live view')}
                onPress={stage.retry}
                style={iconButton}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Icon name="refresh" size={14} color={C.secondary} />
              </Button>
            </If>
            <If when={!stage.hidden() && presented() !== null}>
              <Text
                style={{
                  fontSize: 10,
                  color: C.secondary,
                  maxWidth: 120,
                  flexShrink: 1,
                  numberOfLines: 1,
                  textOverflow: 'ellipsis',
                }}
              >
                {stage.targets().find((target) => target.id === presented())?.title}
              </Text>
              <Button
                accessibilityLabel={label(stage.pinned() ? 'Unpin target' : 'Pin target')}
                onPress={inputAction(stage.togglePin, null)}
                style={iconButton}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
              >
                <Icon name="pin" size={14} color={stage.pinned() ? C.accent : C.secondary} />
              </Button>
              <If when={stage.pinned() || stage.selected() !== stage.snapshot()?.activeTargetId}>
                <Button
                  accessibilityLabel={label('Follow agent')}
                  onPress={inputAction(stage.follow, null)}
                  style={iconButton}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                >
                  <Icon name="play" size={14} color={C.secondary} />
                </Button>
              </If>
            </If>
            <Button
              accessibilityLabel={label(stage.hidden() ? 'Show live view' : 'Hide live view')}
              onPress={inputAction(() => stage.hidden.set(!stage.hidden()), null)}
              style={iconButton}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Icon name={stage.hidden() ? 'expand' : 'close'} size={14} color={C.secondary} />
            </Button>
          </View>
        </View>
      </If>
      <Each
        of={expandedTarget() ? [expandedTarget()!] : []}
        key={(target) => JSON.stringify([target.id, target.revision])}
      >
        {(target) => (
          <Dialog
            testID="computer-expanded"
            accessibilityLabel={label('Expanded live view')}
            animation="none"
            onCancel={dismissExpanded}
            backdropTestID="computer-expanded-backdrop"
            backdropStyle={{ backgroundColor: C.scrim }}
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              pointerEvents: 'box-none',
            }}
          >
            <View
              style={{
                width: Math.max(160, expandedSize().width),
                borderRadius: 16,
                overflow: 'hidden',
                backgroundColor: C.background,
                boxShadow: `0 16px 48px ${C.shadow}`,
              }}
            >
              <View
                style={{
                  height: 40,
                  paddingHorizontal: 6,
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: C.raised,
                }}
              >
                <Text
                  style={{
                    fontSize: 12,
                    color: C.secondary,
                    flexShrink: 1,
                    numberOfLines: 1,
                    textOverflow: 'ellipsis',
                  }}
                >
                  {target().title}
                </Text>
                <Button
                  accessibilityLabel={label('Close expanded view')}
                  onPress={dismissExpanded}
                  style={iconButton}
                  hoverStyle={controlHoverStyle()}
                  focusStyle={controlFocusStyle()}
                >
                  <Icon name="close" size={14} color={C.secondary} />
                </Button>
              </View>
              <View
                style={{
                  width: expandedSize().width,
                  height: expandedSize().height,
                  alignSelf: 'center',
                }}
              >
                {untracked(() => props.renderExpandedFrame(target))}
              </View>
            </View>
          </Dialog>
        )}
      </Each>
    </View>
  );
}
