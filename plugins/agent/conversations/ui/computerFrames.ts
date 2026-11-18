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

import { cleanup, computed, effect, signal, untracked } from 'nsh';
import type { UiService, UiSubscription } from '../../../../packages/plugin-sdk/src/workbench.js';
import type {
  ComputerStageController,
  ComputerStageSource,
  ComputerTarget,
} from './computerStageController';

import type {
  ComputerStageFrame,
  ComputerFrameNotice,
  ComputerFrameResult,
  ComputerPresentationArea,
  ComputerPresentationResult,
} from '../../../../packages/plugin-sdk/src/generated/runtime.js';

export type ComputerFrame = ComputerStageFrame;
type Notice = ComputerFrameNotice;
type FrameRead = ComputerFrameResult;
export interface ComputerFrameSource extends ComputerStageSource {
  service: UiService;
}

export function createComputerFrames(props: {
  source(): ComputerFrameSource | null;
  stage: ComputerStageController;
  visible(): boolean;
  report(reason: unknown): void;
}) {
  const frames = signal<ReadonlyMap<string, ComputerFrame>>(new Map());
  const errors = signal<ReadonlyMap<string, string>>(new Map());
  let presentation: {
    canPresent(target: ComputerTarget): boolean;
    present(target: ComputerTarget, area: ComputerPresentationArea): Promise<void>;
  } | null = null;
  // Control revisions and title changes must not restart capture.
  const request = computed(() =>
    JSON.stringify({
      bindingId: props.stage.snapshot()?.bindingId ?? null,
      targets: props.stage.targets().map(({ id, revision }) => ({ id, revision })),
    }),
  );
  const binding = computed(() => props.stage.snapshot()?.bindingId ?? null);
  // Owner/visibility changes revoke all pixels. Target changes revoke only that target.
  effect(() => {
    props.source();
    props.visible();
    props.stage.hidden();
    binding();
    frames.set(new Map());
    errors.set(new Map());
    cleanup(() => {
      frames.set(new Map());
      errors.set(new Map());
    });
  });
  effect(() => {
    const { targets } = JSON.parse(request()) as { targets: { id: string; revision: number }[] };
    const revisions = new Map(targets.map(({ id, revision }) => [id, revision]));
    untracked(() => {
      frames.set(
        new Map([...frames()].filter(([id, frame]) => revisions.get(id) === frame.revision)),
      );
      errors.set(new Map([...errors()].filter(([id]) => revisions.has(id))));
    });
  });
  effect(() => {
    const source = props.source();
    const visible = props.visible() && !props.stage.hidden();
    const { bindingId, targets } = JSON.parse(request()) as {
      bindingId: string | null;
      targets: { id: string; revision: number }[];
    };
    const targetIds = targets.map((target) => target.id);
    const revisions = new Map(targets.map((target) => [target.id, target.revision]));
    const selectedTargetId = props.stage.selected();
    if (!source || !visible || !bindingId || targetIds.length === 0) return;
    const sessionId = source.sessionId;
    let current = true;
    let stream: UiSubscription<Notice> | null = null;
    const readers = new Map<
      string,
      { last: number; newest: number; busy: boolean; feedId: string; frame?: ComputerFrame }
    >();
    const canPresent = (target: ComputerTarget) => {
      const reader = readers.get(target.id);
      const frame = frames().get(target.id);
      return (
        current &&
        !!reader &&
        !!frame &&
        frame === reader.frame &&
        frame.revision === target.revision &&
        props.visible() &&
        !props.stage.hidden()
      );
    };
    const present = async (target: ComputerTarget, area: ComputerPresentationArea) => {
      const reader = readers.get(target.id);
      if (!reader || !canPresent(target))
        throw new Error('Computer presentation frame is no longer current');
      const operation = await source.service.mutation('presentTarget', {
        sessionId,
        bindingId,
        feedId: reader.feedId,
        targetId: target.id,
        revision: target.revision,
        area,
      });
      const receipt = operation.reply.receipt;
      if (receipt.kind !== 'recorded')
        throw new Error(
          receipt.kind === 'unavailable'
            ? receipt.diagnostic
            : 'Computer presentation was not recorded',
        );
      if (receipt.cleanup.kind !== 'confirmed')
        throw new Error(
          receipt.cleanup.kind === 'failed'
            ? receipt.cleanup.diagnostic
            : 'Computer presentation cleanup is unconfirmed',
        );
      if (receipt.outcome.kind !== 'returned')
        throw new Error(
          receipt.outcome.kind === 'unknown'
            ? receipt.outcome.diagnostic
            : `Computer presentation has no returned result (${receipt.outcome.kind})`,
        );
      if (receipt.outcome.result.kind === 'failure')
        throw new Error(receipt.outcome.result.diagnostic);
      const result = receipt.outcome.result.value as ComputerPresentationResult;
      if (result.kind === 'partial') throw new Error(result.message);
    };
    const presentationBinding = { canPresent, present };
    presentation = presentationBinding;
    const close = () => {
      const owned = stream;
      stream = null;
      if (owned) void owned.close().catch(props.report);
    };
    cleanup(() => {
      current = false;
      if (presentation === presentationBinding) presentation = null;
      close();
      readers.clear();
    });
    const failure = (targetId: string, message: string) => {
      if (!current) return;
      const next = new Map(frames());
      next.delete(targetId);
      frames.set(next);
      errors.set(new Map(errors()).set(targetId, message));
    };
    const read = async (
      targetId: string,
      reader: {
        last: number;
        newest: number;
        busy: boolean;
        feedId: string;
        frame?: ComputerFrame;
      },
    ) => {
      reader.busy = true;
      try {
        while (current && reader.newest > reader.last) {
          const requested = reader.newest;
          const result = (await source.service.query('readFrame', {
            sessionId,
            bindingId,
            feedId: reader.feedId,
            targetId,
            after: reader.last,
          })) as FrameRead;
          if (!current) return;
          if (result.kind === 'unavailable') {
            failure(targetId, result.message);
            return;
          }
          if (result.kind === 'pending') {
            // A new notice is the wakeup; no polling or retry timers.
            if (reader.newest <= requested) return;
            continue;
          }
          const frame = result.frame;
          if (
            frame.sessionId !== sessionId ||
            frame.bindingId !== bindingId ||
            frame.targetId !== targetId
          )
            throw new Error('Computer frame owner mismatch');
          if (frame.sequence <= reader.last) return;
          reader.last = frame.sequence;
          if (
            frame.revision !== revisions.get(targetId) ||
            frame.revision !==
              props.stage.targets().find((target) => target.id === targetId)?.revision
          )
            continue;
          reader.frame = frame;
          frames.set(new Map(frames()).set(targetId, frame));
          const nextErrors = new Map(errors());
          nextErrors.delete(targetId);
          errors.set(nextErrors);
        }
      } catch (reason) {
        if (current) {
          failure(targetId, String(reason));
          props.report(reason);
        }
      } finally {
        reader.busy = false;
      }
    };
    void (async () => {
      const opened = (await source.service.subscribe('watchFrames', {
        sessionId,
        bindingId,
        targetIds,
        selectedTargetId,
      })) as UiSubscription<Notice>;
      if (!current) {
        await opened.close();
        return;
      }
      stream = opened;
      for (;;) {
        const notice = await opened.next();
        if (!current) return;
        if (notice === null) {
          current = false;
          frames.set(new Map());
          close();
          return;
        }
        if (
          notice.sessionId !== sessionId ||
          notice.bindingId !== bindingId ||
          !targetIds.includes(notice.targetId)
        )
          throw new Error('Computer frame notification owner mismatch');
        let reader = readers.get(notice.targetId);
        if (!reader) {
          reader = { last: 0, newest: 0, busy: false, feedId: notice.feedId };
          readers.set(notice.targetId, reader);
        }
        if (reader.feedId !== notice.feedId) throw new Error('Computer frame feed changed');
        reader.newest = Math.max(reader.newest, notice.sequence);
        if (!reader.busy && reader.newest > reader.last) void read(notice.targetId, reader);
      }
    })().catch((reason) => {
      close();
      if (!current) return;
      frames.set(new Map());
      for (const id of targetIds) failure(id, String(reason));
      current = false;
      props.report(reason);
    });
  });
  return {
    frames,
    errors,
    canPresent(target: ComputerTarget) {
      return presentation?.canPresent(target) ?? false;
    },
    present(target: ComputerTarget, area: ComputerPresentationArea) {
      if (!presentation) return Promise.reject(new Error('Computer viewer is no longer current'));
      return presentation.present(target, area);
    },
  };
}
