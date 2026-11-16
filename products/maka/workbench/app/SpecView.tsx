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

import type { Spec } from '@json-render/core';
import { cleanup, effect, signal, Text, untracked, View } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { tr } from './locale';
import { CodeBlockAction, codeBlockActions, codeBlockStyles } from './codeBlockLook';
import { mermaidExtensions } from './MermaidView';
import { specComponentRegistry } from './spec/components.tsx';
import { SpecRenderer } from './spec/runtime.tsx';
import { SpecSession, type SpecFrame } from './spec/session.ts';
import { C, captionTextStyle, controlFocusStyle, controlHoverStyle } from './ui';

export const specExtensions = [{ name: 'spec', language: 'spec' }];
export const markdownExtensions = [...mermaidExtensions, ...specExtensions];

export function SpecView(props: {
  source(): string;
  streaming?(): boolean;
  sessionId?: string;
  openLink?(target: string, restoreFocus: () => boolean): Promise<void>;
}) {
  const session = new SpecSession();
  const frame = signal<SpecFrame>(
    session.ingest(
      untracked(() => props.source()),
      untracked(() => props.streaming?.() ?? false),
    ),
  );
  const sourceShown = signal(false);

  const unsubscribe = session.subscribeFrame(() => {
    const latest = session.getFrame();
    if (latest !== untracked(frame)) {
      frame.set(latest);
    }
  });

  effect(() => {
    const src = props.source();
    const isStreaming = props.streaming?.() ?? false;
    const next = session.ingest(src, isStreaming);
    if (next !== untracked(frame)) {
      frame.set(next);
    }
  });

  cleanup(unsubscribe);

  const sourceLabel = () => (sourceShown() ? tr('Hide spec source') : tr('Show spec source'));
  const readySpec = (): Spec | null => {
    const current = frame();
    return current.kind === 'ready' ? current.spec : null;
  };
  const statusText = () => {
    const current = frame();
    return current.kind === 'error'
      ? tr('Interface unavailable: {reason}', { reason: current.reason })
      : tr('Rendering interface…');
  };

  return (
    <View style={{ width: '100%', minWidth: 0, gap: 8 }}>
      <If when={readySpec() !== null}>
        <SpecRenderer
          spec={() => readySpec()!}
          session={session}
          registry={specComponentRegistry}
          sessionId={props.sessionId}
          openLink={props.openLink}
        />
      </If>
      <If when={frame().kind !== 'ready'}>
        <Text
          style={{
            ...captionTextStyle,
            color: frame().kind === 'error' ? C.danger : C.muted,
          }}
        >
          {statusText()}
        </Text>
      </If>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' }}>
        <Button
          accessibilityLabel={sourceLabel()}
          style={{ padding: 4 }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          onPress={() => sourceShown.set(!sourceShown())}
        >
          <Text style={{ ...captionTextStyle, color: C.muted }}>{sourceLabel()}</Text>
        </Button>
      </View>
      <If when={sourceShown() || frame().kind === 'error'}>
        <TextView
          document={{
            blocks: [{ type: 'codeBlock', language: 'json', code: props.source() }],
          }}
          selectable
          renderCodeBlockAction={(action) => <CodeBlockAction action={action} />}
          codeBlockActions={codeBlockActions()}
          styles={codeBlockStyles(C.text, 12)}
        />
      </If>
    </View>
  );
}
