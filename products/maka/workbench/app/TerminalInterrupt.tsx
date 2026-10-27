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
import { Button, Dialog } from 'nsh/base';
import { host } from 'nsh';
import { keymap } from 'nsh';
import type { ComposerSession } from './Composer';
import { tr } from './locale';
import { bodyTextStyle, C, controlFocusStyle, controlHoverStyle, controlStyle } from './ui';

type StopRequest = { owner: ComposerSession; invocationId: string };

export function createTerminalInterrupt(options: {
  session(): ComposerSession | null;
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
  let previousOwner: ComposerSession | null = null;
  let previousInvocation: string | null = null;
  effect(() => {
    const owner = options.session();
    const invocationId = owner?.invocation() ?? null;
    if (owner !== previousOwner || invocationId !== previousInvocation) dismiss();
    previousOwner = owner;
    previousInvocation = invocationId;
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
    const invocationId = owner?.invocation();
    if (owner && invocationId && !owner.stopping()) {
      reset();
      confirmation.set({ owner, invocationId });
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
    prompt,
    confirmation,
    dismiss,
    confirm(request: StopRequest) {
      if (
        !alive ||
        confirmation() !== request ||
        options.session() !== request.owner ||
        request.owner.invocation() !== request.invocationId ||
        request.owner.stopping()
      )
        return;
      dismiss();
      void request.owner.stop(request.invocationId).catch(options.report);
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
            <Dialog
              animation="none"
              onOpenChange={props.state.dismiss}
              style={{
                flex: 1,
                justifyContent: 'center',
                alignItems: 'center',
                backgroundColor: '#00000099',
              }}
            >
              <View
                style={{
                  width: '90%',
                  maxWidth: 480,
                  padding: 24,
                  gap: 24,
                  borderRadius: 16,
                  backgroundColor: C.surface,
                }}
              >
                <Text style={{ ...bodyTextStyle, color: C.text }}>
                  {tr('Stop the current task?')}
                </Text>
                <Text style={{ ...bodyTextStyle, color: C.secondary }}>
                  {tr('The task will keep running unless you choose to stop it.')}
                </Text>
                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    justifyContent: 'flex-end',
                    gap: 8,
                  }}
                >
                  <Button
                    ref={(node) => node.focus()}
                    accessibilityLabel={tr('Keep running')}
                    onPress={props.state.dismiss}
                    style={{ ...controlStyle, backgroundColor: C.raised }}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                  >
                    <Text style={{ ...bodyTextStyle, color: C.text }}>{tr('Keep running')}</Text>
                  </Button>
                  <Button
                    accessibilityLabel={tr('Stop task')}
                    onPress={() => props.state.confirm(expected)}
                    style={controlStyle}
                    hoverStyle={controlHoverStyle()}
                    focusStyle={controlFocusStyle()}
                  >
                    <Text style={{ ...bodyTextStyle, color: C.danger }}>{tr('Stop task')}</Text>
                  </Button>
                </View>
              </View>
            </Dialog>
          );
        }}
      </Each>
    </>
  );
}
