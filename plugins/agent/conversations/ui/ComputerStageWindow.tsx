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

import { cleanup, computed, effect, signal, untracked, View, type JSX } from 'nsh';
import { currentWindow, Window, type WindowRef } from 'nsh/desktop';
import { computerText } from './computerText';

let nextWindowId = 0;

export type ComputerStageSize = { width: number; height: number };

/** One native viewer per source/binding lifetime. Never focuses an external or NSH window. */
export function createComputerStageWindow(props: {
  owner(): { sessionId: string } | null;
  bindingId(): string | null;
  visible(): boolean;
  hide(): void;
  report(reason: unknown): void;
  render(
    contentSize: (size: ComputerStageSize) => void,
    maxSize: () => ComputerStageSize,
  ): JSX.Element;
}) {
  const parent = currentWindow();
  const visible = computed(props.visible);
  const bindingId = computed(props.bindingId);
  const window = signal<WindowRef | null>(null);
  const size = signal<ComputerStageSize>({ width: 0, height: 0 });
  // Window.open returns before the platform reports its first state.
  const nativeReady = computed(() => window()?.state() != null);
  const maxSize = computed(() => {
    const state = parent.state();
    const area = state?.display?.visibleBounds ?? state?.bounds;
    return {
      width: Math.min(544, Math.max(1, (area?.size.width ?? 544) - 32)),
      height: Math.min(600, Math.max(1, (area?.size.height ?? 600) - 84)),
    };
  });
  let placed: WindowRef | null = null;
  effect(() => {
    const owner = props.owner();
    const binding = bindingId();
    if (!visible() || owner === null) return;
    untracked(() => {
      const alive = signal(true);
      size.set({ width: 0, height: 0 });
      let opened: WindowRef;
      try {
        // The panel first renders transparently at 1pt; presentation supplies its natural size.
        opened = Window.open(
          () => (
            <View style={{ flexGrow: 1, backgroundColor: 'transparent' }}>
              <If when={alive()}>
                {untracked(() =>
                  props.render((next) => {
                    const previous = size();
                    if (
                      alive() &&
                      (next.width !== previous.width || next.height !== previous.height)
                    )
                      size.set(next);
                  }, maxSize),
                )}
              </If>
            </View>
          ),
          {
            id: `computer-stage:${parent.id}:${owner.sessionId}:${binding ?? 'pending'}:${++nextWindowId}`,
            title: computerText('Computer'),
            kind: 'panel',
            parent,
            activate: false,
            focusable: true,
            frame: 'none',
            transparent: true,
            shadow: false,
            level: 'floating',
            taskbar: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            closeOnPress: false,
            closeOnBlur: false,
            restoreBounds: false,
            defaultSize: { width: 1, height: 1 },
            defaultPosition: 'parentCenter',
          },
        );
      } catch (reason) {
        alive.set(false);
        props.hide();
        props.report(reason);
        return;
      }
      window.set(opened);
      const closePress = opened.on('closePress', () => {
        if (alive()) props.hide();
      });
      const closed = opened.on('close', () => {
        if (alive()) props.hide();
      });
      cleanup(() => {
        // Clear the native image tree before the platform settles the close request.
        alive.set(false);
        closePress();
        closed();
        window.set(null);
        size.set({ width: 0, height: 0 });
        opened.close();
      });
    });
  });
  effect(() => {
    const opened = window();
    const next = size();
    if (!opened || !nativeReady()) return;
    const nativeState = untracked(() => opened.state());
    if (!nativeState) return;
    const state = untracked(() => parent.state());
    if (!state || next.width <= 0 || next.height <= 0) return;
    const area = state.display?.visibleBounds ?? state.bounds;
    const nativeSize = {
      width: Math.max(1, Math.ceil(next.width)),
      height: Math.max(1, Math.ceil(next.height)),
    };
    const position =
      placed === opened
        ? nativeState.bounds.origin
        : {
            x: state.bounds.origin.x + state.bounds.size.width - nativeSize.width - 16,
            y: state.bounds.origin.y + state.bounds.size.height - nativeSize.height - 16,
          };
    const bounds = {
      origin: {
        x: Math.max(
          area.origin.x,
          Math.min(position.x, area.origin.x + area.size.width - nativeSize.width),
        ),
        y: Math.max(
          area.origin.y,
          Math.min(position.y, area.origin.y + area.size.height - nativeSize.height),
        ),
      },
      size: nativeSize,
    };
    if (
      nativeState.bounds.origin.x !== bounds.origin.x ||
      nativeState.bounds.origin.y !== bounds.origin.y ||
      nativeState.bounds.size.width !== bounds.size.width ||
      nativeState.bounds.size.height !== bounds.size.height
    )
      opened.setBounds(bounds);
    placed = opened;
  });
}
