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

import { cleanup, effect, host, mount, signal, untracked, Text, View, type ViewRef } from 'nsh';
import { ComputerStage } from '../../../../../plugins/agent/conversations/ui/ComputerStage';
import {
  createComputerStage,
  type ComputerSnapshot,
} from '../../../../../plugins/agent/conversations/ui/computerStageController';
import {
  createComputerFrames,
  type ComputerFrameSource,
} from '../../../../../plugins/agent/conversations/ui/computerFrames';
import type {
  UiService,
  UiSubscription,
} from '../../../../../packages/plugin-sdk/src/workbench.js';
import type {
  ComputerReadFrame,
  ComputerFrameNotice,
  ComputerFrameResult,
} from '../../../../../packages/plugin-sdk/src/generated/runtime.js';

// Only the service boundary is controlled; NSH owns every signal/effect and cleanup.
class Stream implements UiSubscription<unknown> {
  closed = false;
  admitted = false;
  private queue: unknown[] = [];
  private waiting: ((value: unknown) => void) | null = null;
  release: (() => void) | null = null;
  constructor(
    readonly method: string,
    readonly input: unknown,
    private changed: () => void,
  ) {}
  next(): Promise<unknown> {
    if (this.queue.length) {
      const next = this.queue.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.waiting = (value) => (value instanceof Error ? reject(value) : resolve(value));
    });
  }
  push(value: unknown) {
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) waiting(value);
    else this.queue.push(value);
  }
  async close() {
    this.closed = true;
    this.push(null);
    this.changed();
  }
}
type Read = {
  input: ComputerReadFrame;
  resolve(value: ComputerFrameResult): void;
  pending: boolean;
};
type Command =
  | { kind: 'stage'; value: ComputerSnapshot }
  | { kind: 'notice'; targetId: string; sequences: number[] }
  | {
      kind: 'resolve';
      index: number;
      sequence: number;
      revision: number;
      marker: string;
      width?: number;
      height?: number;
    }
  | { kind: 'decode'; targetId: string; value: boolean }
  | { kind: 'select'; targetId: string }
  | { kind: 'measure' }
  | { kind: 'failure'; method: 'watchStage' | 'watchFrames'; reason: string }
  | { kind: 'end'; method: 'watchStage' | 'watchFrames' }
  | { kind: 'unavailable'; index: number; reason: string }
  | { kind: 'source'; sessionId: string }
  | { kind: 'visible' | 'mounted'; value: boolean }
  | { kind: 'hold'; method: 'watchStage' | 'watchFrames' }
  | { kind: 'release' };

mount(() => {
  const mounted = signal(true);
  const visible = signal(true);
  const tick = signal(0);
  const fault = signal('none');
  const changed = () => untracked(() => tick.set(tick() + 1));
  const decoded = signal<ReadonlyMap<string, string>>(new Map());
  const measured = signal('none');
  const contentSize = signal('0x0');
  const refs = new Map<string, ViewRef>();
  const lifetimes = new Map<string, { mounted: number; disposed: number }>();
  let decode: (id: string, value: boolean) => void;
  let select: (id: string) => void;
  const streams: Stream[] = [];
  const reads: Read[] = [];
  let hold: string | null = null;
  let maxBusy = 0;
  const active = (method: string) =>
    streams.filter((s) => s.method === method && !s.closed && s.admitted);
  const latest = (method: string) => {
    const stream = active(method).at(-1);
    if (!stream) throw new Error(`No open ${method}`);
    return stream;
  };
  const service: UiService = {
    subscribe(method, input) {
      const stream = new Stream(method, input, changed);
      streams.push(stream);
      changed();
      const admit = () => {
        stream.admitted = true;
        changed();
        return stream;
      };
      if (hold === method) {
        hold = null;
        return new Promise<UiSubscription>((resolve) => {
          stream.release = () => resolve(admit());
        });
      }
      return Promise.resolve(admit());
    },
    query(method, input) {
      if (method !== 'readFrame') throw new Error(`Unexpected query: ${method}`);
      const request = input as ComputerReadFrame;
      return new Promise<ComputerFrameResult>((resolve) => {
        const read: Read = {
          input: request,
          pending: true,
          resolve(value) {
            read.pending = false;
            changed();
            resolve(value);
          },
        };
        reads.push(read);
        maxBusy = Math.max(
          maxBusy,
          reads.filter(
            (r) =>
              r.pending &&
              r.input.feedId === request.feedId &&
              r.input.targetId === request.targetId,
          ).length,
        );
        changed();
      });
    },
    mutation() {
      throw new Error('Stage must not mutate Computer');
    },
    beginMutation() {
      throw new Error('Stage must not send Computer input');
    },
  };
  const makeSource = (sessionId: string): ComputerFrameSource => ({
    sessionId,
    service,
    subscribe: () =>
      service.subscribe('watchStage', { sessionId }) as Promise<UiSubscription<ComputerSnapshot>>,
  });
  const source = signal(makeSource('session-1'));
  host.on('computer', (raw) => {
    const command = raw as Command;
    switch (command.kind) {
      case 'stage':
        latest('watchStage').push(command.value);
        break;
      case 'notice': {
        const stream = latest('watchFrames');
        const input = stream.input as { sessionId: string; bindingId: string };
        for (const sequence of command.sequences) {
          const notice: ComputerFrameNotice = {
            sessionId: input.sessionId,
            bindingId: input.bindingId,
            feedId: `feed-${streams.indexOf(stream)}`,
            targetId: command.targetId,
            sequence,
          };
          stream.push(notice);
        }
        break;
      }
      case 'resolve': {
        const read = reads[command.index]!;
        read.resolve({
          kind: 'frame',
          frame: {
            sessionId: read.input.sessionId,
            bindingId: read.input.bindingId,
            targetId: read.input.targetId,
            sequence: command.sequence,
            revision: command.revision,
            mimeType: 'image/png',
            dataBase64: command.marker,
            width: command.width ?? 1,
            height: command.height ?? 1,
          },
        });
        break;
      }
      case 'decode':
        decode(command.targetId, command.value);
        break;
      case 'select':
        select(command.targetId);
        break;
      case 'failure':
        latest(command.method).push(new Error(command.reason));
        break;
      case 'end':
        void latest(command.method).close();
        break;
      case 'unavailable':
        reads[command.index]!.resolve({ kind: 'unavailable', message: command.reason });
        break;
      case 'measure':
        measured.set('pending');
        void Promise.all(
          [...refs].map(async ([id, ref]) => {
            const value = await ref.measure();
            if (!value) throw new Error(`Detached frame ${id}`);
            return [
              id,
              value.pagePosition.x,
              value.pagePosition.y,
              value.bounds.size.width,
              value.bounds.size.height,
            ];
          }),
        )
          .then((values) => measured.set(JSON.stringify(values)))
          .catch((reason) => fault.set(String(reason)));
        break;
      case 'source':
        source.set(makeSource(command.sessionId));
        break;
      case 'visible':
        visible.set(command.value);
        break;
      case 'mounted':
        mounted.set(command.value);
        break;
      case 'hold':
        hold = command.method;
        break;
      case 'release': {
        const stream = streams.find((s) => s.release !== null);
        if (!stream?.release) throw new Error('No deferred subscription');
        const release = stream.release;
        stream.release = null;
        release();
        break;
      }
    }
  });
  function StageOwner() {
    const stage = createComputerStage({
      source,
      visible,
      report: (reason) => fault.set(String(reason)),
    });
    const live = createComputerFrames({
      source,
      stage,
      visible,
      report: (reason) => fault.set(String(reason)),
    });
    const identity = (id: string) => {
      const frame = live.frames().get(id);
      return frame
        ? JSON.stringify([frame.sessionId, frame.bindingId, frame.targetId, frame.revision])
        : undefined;
    };
    decode = (id, value) => {
      const key = identity(id);
      if (!key) throw new Error(`Cannot decode missing frame ${id}`);
      const next = new Map(decoded());
      if (value) next.set(id, key);
      else next.delete(id);
      decoded.set(next);
    };
    select = stage.select;
    effect(() => {
      live.frames();
      untracked(() =>
        decoded.set(new Map([...decoded()].filter(([id, key]) => identity(id) === key))),
      );
    });
    return (
      <View style={{ flex: 1 }}>
        <Text>{`Slots ${
          stage
            .targets()
            .map((target) => target.id)
            .join(',') || 'none'
        }`}</Text>
        <Text>{`Selected ${stage.selected() ?? 'none'} pinned ${stage.pinned()}`}</Text>
        <Text>{`Pixels ${
          [...live.frames().values()]
            .map((frame) => `${frame.targetId}:${frame.dataBase64}`)
            .sort()
            .join(',') || 'none'
        }`}</Text>
        <ComputerStage
          controller={stage}
          frameSize={(id) => {
            const frame = live.frames().get(id);
            const target = stage.targets().find((target) => target.id === id);
            return frame && target?.revision === frame.revision ? frame : undefined;
          }}
          frameError={(id) => live.errors().get(id)}
          frameReady={(id) => decoded().has(id) && decoded().get(id) === identity(id)}
          contentSize={(size) => contentSize.set(`${size.width}x${size.height}`)}
          renderFrame={(target, presented) => {
            const id = target().id;
            const counts = lifetimes.get(id) ?? { mounted: 0, disposed: 0 };
            counts.mounted++;
            lifetimes.set(id, counts);
            changed();
            cleanup(() => {
              counts.disposed++;
              refs.delete(id);
              changed();
            });
            return (
              <View ref={(ref) => refs.set(id, ref)} style={{ width: '100%', height: '100%' }}>
                <Text>{`Frame ${target().id} presented ${presented()} ${live.frames().get(target().id)?.dataBase64 ?? 'waiting'}`}</Text>
              </View>
            );
          }}
        />
      </View>
    );
  }
  const stats = () => {
    tick();
    return `Streams ${active('watchStage').length}/${active('watchFrames').length} closed ${streams.filter((s) => s.closed).length}`;
  };
  const calls = () => {
    tick();
    return `Reads ${reads.length} maxBusy ${maxBusy} after ${reads.map((r) => r.input.after).join(',') || 'none'}`;
  };
  return (
    <View style={{ flex: 1 }}>
      <Text>{stats()}</Text>
      <Text>{calls()}</Text>
      <Text>{`Fault ${fault()}`}</Text>
      <Text>{`Bounds ${measured()}`}</Text>
      <Text>{`Content ${contentSize()}`}</Text>
      <Text>
        {(() => {
          tick();
          return `Lifetimes ${[...lifetimes].map(([id, count]) => `${id}:${count.mounted}/${count.disposed}`).join(',') || 'none'}`;
        })()}
      </Text>
      <If when={mounted()}>
        <StageOwner />
      </If>
      <If when={!mounted()}>
        <Text>Unmounted</Text>
      </If>
    </View>
  );
});
