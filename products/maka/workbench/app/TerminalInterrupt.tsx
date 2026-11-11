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

import { cleanup, effect, signal, Text, View } from 'nsh';
import { host } from 'nsh';
import { keymap } from 'nsh';
import type { ComposerSession } from '../../../../packages/plugin-sdk/src/composer-view.js';
import type { RunId } from '../../../../packages/plugin-sdk/src/index.js';
import { tr } from './locale';
import { DialogFooter, DialogHeader, ModalDialog } from './ModalDialog';
import { SettingsButton } from './SettingsPage';
import { bodyTextStyle, C } from './ui';

type InterruptSession = Pick<ComposerSession, 'draft' | 'run' | 'stopping' | 'stop'>;
type StopRequest = { owner: InterruptSession; runId: RunId };

export function createTerminalInterrupt(options: {
  session(): InterruptSession | null;
  blocked(): boolean;
  dismissOverlay(): boolean;
  report(reason: unknown): void;
}) {
  const prompt = signal(false);
  const confirmation = signal<StopRequest | null>(null);
  let armedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  const reset = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    armedAt = null;
    prompt.set(false);
  };
  const dismiss = () => {
    reset();
    confirmation.set(null);
  };
  effect(() => {
    // Restoring a saved draft also cancels an earlier exit gesture.
    options.session()?.draft();
    reset();
  });
  let previousOwner: InterruptSession | null = null;
  let previousRun: RunId | null = null;
  effect(() => {
    const owner = options.session();
    const runId = owner?.run() ?? null;
    if (owner !== previousOwner || runId !== previousRun) dismiss();
    previousOwner = owner;
    previousRun = runId;
    if (owner?.stopping() || options.blocked()) confirmation.set(null);
  });
  const interrupt = () => {
    if (!alive) return;
    if (confirmation()) {
      dismiss();
      return;
    }
    if (options.dismissOverlay()) {
      reset();
      return;
    }
    const owner = options.session();
    const runId = owner?.run();
    if (owner && runId && !owner.stopping()) {
      reset();
      confirmation.set({ owner, runId });
      return;
    }
    const now = Date.now();
    // Preserve the original main TUI's one-second double-press gesture.
    if (armedAt !== null && now >= armedAt && now - armedAt <= 1000) {
      reset();
      host.post('terminal.exit');
    } else {
      reset();
      armedAt = now;
      prompt.set(true);
      timer = setTimeout(() => {
        timer = undefined;
        prompt.set(false);
      }, 1000);
    }
  };
  keymap.bind('ctrl+c', interrupt, { when: 'always', fallback: true });
  host.on('terminal.activity', reset);
  cleanup(() => {
    alive = false;
    if (timer !== undefined) clearTimeout(timer);
  });
  return {
    interrupt,
    prompt,
    confirmation,
    dismiss,
    confirm(request: StopRequest) {
      if (
        !alive ||
        confirmation() !== request ||
        options.session() !== request.owner ||
        request.owner.run() !== request.runId ||
        request.owner.stopping()
      )
        return;
      dismiss();
      void request.owner.stop(request.runId).catch(options.report);
    },
  };
}

export function TerminalInterrupt(props: { state: ReturnType<typeof createTerminalInterrupt> }) {
  return (
    <>
      <If when={props.state.prompt()}>
        <View
          style={[
            { position: 'absolute', left: 0, right: 0, bottom: 24, alignItems: 'center' },
            { pointerEvents: 'none' },
          ]}
        >
          <View
            style={{
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderRadius: 12,
              backgroundColor: C.raised,
              borderWidth: 1,
              borderColor: C.line,
            }}
          >
            <Text style={{ ...bodyTextStyle, color: C.text }}>
              {tr('Press Ctrl+C again to exit.')}
            </Text>
          </View>
        </View>
      </If>
      <Each of={props.state.confirmation() ? [props.state.confirmation()!] : []}>
        {(request) => {
          // A late click must retain this dialog's identity, not read its replacement.
          const expected = request();
          return (
            <ModalDialog size="alert" onCancel={props.state.dismiss}>
              <DialogHeader
                title={tr('Stop the current task?')}
                detail={tr('The task will keep running unless you choose to stop it.')}
              />
              <DialogFooter>
                <SettingsButton
                  label={tr('Cancel')}
                  tone="quiet"
                  autoFocus
                  onPress={props.state.dismiss}
                />
                <SettingsButton
                  label={tr('Stop task')}
                  tone="danger"
                  onPress={() => props.state.confirm(expected)}
                />
              </DialogFooter>
            </ModalDialog>
          );
        }}
      </Each>
    </>
  );
}
