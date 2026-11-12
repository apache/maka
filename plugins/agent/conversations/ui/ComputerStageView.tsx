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

import { cleanup, computed, effect, signal, untracked, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import { currentWindow } from 'nsh/desktop';
import { LiveImage } from 'maka/host';
import { ComputerStage } from './ComputerStage';
import { createComputerStageWindow } from './ComputerStageWindow';
import {
  createComputerFrames,
  type ComputerFrame,
  type ComputerFrameSource,
} from './computerFrames';
import type { ComputerStageController, ComputerTarget } from './computerStageController';
import { computerText } from './computerText';
import { C } from '../../../../products/maka/workbench/app/ui';
import { errorMessage } from '../../../../products/maka/workbench/app/text';

function frameAuthority(value: ComputerFrame): string {
  return JSON.stringify([value.sessionId, value.bindingId, value.targetId, value.revision]);
}

function LiveFrame(props: {
  frame(): ComputerFrame | undefined;
  error(): string | undefined;
  ready(value: boolean): void;
  failed(message: string | null): void;
  report(reason: unknown): void;
}) {
  const frame = computed(props.frame);
  let alive = true;
  cleanup(() => {
    alive = false;
    props.ready(false);
    props.failed(null);
  });
  // Keep decoded readiness across ordinary frame updates; never across an authority change.
  const authority = computed(() => {
    const value = frame();
    return value ? frameAuthority(value) : null;
  });
  effect(() => {
    authority();
    untracked(() => {
      props.ready(false);
      props.failed(null);
    });
  });
  effect(() => {
    if (props.error()) untracked(() => props.ready(false));
  });
  return (
    <View style={{ flexGrow: 1, minHeight: 0, position: 'relative' }}>
      <Each of={authority() === null ? [] : [authority()!]} key={(identity) => identity}>
        {(identity) => {
          let current = true;
          cleanup(() => {
            current = false;
          });
          return (
            <LiveImage
              frame={frame()}
              onLoad={() => {
                const value = frame();
                if (!alive || !current || authority() !== identity() || !value || props.error())
                  return;
                props.failed(null);
                props.ready(true);
              }}
              onError={(event) => {
                if (!alive || !current || !frame() || authority() !== identity()) return;
                props.ready(false);
                props.failed(event.message);
                props.report(new Error(event.message));
              }}
              style={{ width: '100%', height: '100%' }}
            />
          );
        }}
      </Each>
    </View>
  );
}

export function ComputerStageView(props: {
  controller: ComputerStageController;
  source(): ComputerFrameSource | null;
  visible(): boolean;
  report(reason: unknown): void;
}) {
  const parent = currentWindow();
  const visible = computed(() => {
    const state = parent.state();
    return props.visible() && state !== null && state.visible && !state.minimized;
  });
  const live = createComputerFrames({
    source: props.source,
    stage: props.controller,
    visible,
    report: props.report,
  });
  const windowError = signal<string | null>(null);
  const bindingId = computed(() => props.controller.snapshot()?.bindingId ?? null);
  effect(() => {
    props.source();
    bindingId();
    windowError.set(null);
  });
  const hasContent = computed(
    () => props.controller.targets().length > 0 || props.controller.fault() !== null,
  );
  createComputerStageWindow({
    owner: props.source,
    bindingId,
    visible: () => visible() && hasContent() && !props.controller.hidden(),
    hide: () => props.controller.hidden.set(true),
    report: (reason) => {
      windowError.set(errorMessage(reason));
      props.report(reason);
    },
    render: (contentSize, maxSize) => {
      // These belong to this window opening, not the next source or binding.
      const ready = signal<ReadonlyMap<string, string>>(new Map());
      const failures = signal<ReadonlyMap<string, string>>(new Map());
      const frameFor = (target: ComputerTarget) => {
        const value = live.frames().get(target.id);
        const source = props.source();
        const snapshot = props.controller.snapshot();
        return value &&
          value.sessionId === source?.sessionId &&
          value.bindingId === snapshot?.bindingId &&
          value.targetId === target.id &&
          value.revision === target.revision
          ? value
          : undefined;
      };
      return (
        <ComputerStage
          controller={props.controller}
          maxSize={maxSize()}
          frameSize={(id) => {
            const target = props.controller.targets().find((target) => target.id === id);
            return target ? frameFor(target) : undefined;
          }}
          frameReady={(id) => {
            const target = props.controller.targets().find((target) => target.id === id);
            const value = target && frameFor(target);
            return !!value && ready().get(id) === frameAuthority(value);
          }}
          frameError={(id) => failures().get(id) ?? live.errors().get(id)}
          contentSize={contentSize}
          renderFrame={(target) => {
            const id = target().id;
            return (
              <LiveFrame
                frame={() => frameFor(target())}
                error={() => live.errors().get(id)}
                ready={(value) => {
                  const frame = frameFor(target());
                  const identity = value && frame ? frameAuthority(frame) : undefined;
                  if (ready().get(id) === identity) return;
                  const next = new Map(ready());
                  if (identity === undefined) next.delete(id);
                  else next.set(id, identity);
                  ready.set(next);
                }}
                failed={(message) => {
                  if ((failures().get(id) ?? null) === message) return;
                  const next = new Map(failures());
                  if (message === null) next.delete(id);
                  else next.set(id, message);
                  failures.set(next);
                }}
                report={props.report}
              />
            );
          }}
        />
      );
    },
  });
  return (
    <If when={windowError()}>
      <View style={{ padding: 8, gap: 8 }}>
        <Text style={{ color: C.danger }}>{windowError()}</Text>
        <Button
          accessibilityLabel={computerText('Retry live view')}
          onPress={() => {
            windowError.set(null);
            props.controller.hidden.set(false);
          }}
        >
          <Text>{computerText('Retry live view')}</Text>
        </Button>
      </View>
    </If>
  );
}
