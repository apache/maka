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

import { cleanup, effect, Image, platform, signal, Text, View } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { host } from 'maka/host';
import { diagramSvg } from './mermaid';
import { tr } from './locale';
import { C, captionTextStyle, codeTextStyle, controlFocusStyle, controlHoverStyle } from './ui';

type Presentation =
  | { kind: 'loading' }
  | { kind: 'image'; uri: string; width: number; height: number }
  | { kind: 'error'; message: string };

export const mermaidExtensions = [{ name: 'mermaid', language: 'mermaid' }];

export function MermaidView(props: { source(): string }) {
  const code = () => (
    <TextView
      document={{ blocks: [{ type: 'codeBlock', language: 'mermaid', code: props.source() }] }}
      selectable
      codeBlockActions={[
        { id: 'copy', label: tr('Copy code block') },
        { id: 'wrap', label: tr('Wrap code') },
      ]}
      styles={{ codeBlockCode: { ...codeTextStyle, color: C.text } }}
    />
  );
  if (platform.isTerminal) return code();

  const width = signal(0);
  const state = signal<Presentation>({ kind: 'loading' });
  const sourceShown = signal(false);
  let alive = true;
  let generation = 0;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { generation: number; diagram: ReturnType<typeof diagramSvg> } | null = null;
  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (alive && pending) {
        const request = pending;
        pending = null;
        try {
          const uri = await host.diagramImage(request.diagram.svg);
          if (alive && generation === request.generation)
            state.set({
              kind: 'image',
              uri,
              width: request.diagram.width,
              height: request.diagram.height,
            });
        } catch (error) {
          if (alive && generation === request.generation)
            state.set({
              kind: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
        }
      }
    } finally {
      running = false;
    }
  };
  effect(() => {
    const source = props.source();
    const maxWidth = Math.floor(width());
    const palette = {
      background: C.background,
      text: C.text,
      muted: C.muted,
      secondary: C.secondary,
      surface: C.surface,
      raised: C.raised,
      line: C.line,
      accent: C.accent,
      danger: C.danger,
    };
    const current = ++generation;
    clearTimeout(timer);
    pending = null;
    state.set({ kind: 'loading' });
    if (maxWidth < 1) return;
    // Coalesce streamed edits; each mounted diagram has at most one native job.
    timer = setTimeout(() => {
      if (!alive || generation !== current) return;
      try {
        pending = { generation: current, diagram: diagramSvg(source, palette, maxWidth) };
        void drain();
      } catch (error) {
        state.set({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }, 200);
  });
  cleanup(() => {
    alive = false;
    pending = null;
    clearTimeout(timer);
  });
  const images = () => {
    const current = state();
    return current.kind === 'image' ? [current] : [];
  };
  const status = () => {
    const current = state();
    return current.kind === 'error'
      ? tr('Diagram unavailable: {reason}', { reason: current.message })
      : tr('Rendering diagram…');
  };
  return (
    <View
      style={{ width: '100%', gap: 8 }}
      onLayout={({ bounds }) => width.set(Math.floor(bounds.size.width))}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>Mermaid</Text>
        <Button
          style={{ padding: 4 }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          onPress={() => sourceShown.set(!sourceShown())}
        >
          <Text style={{ ...captionTextStyle, color: C.secondary }}>
            {sourceShown() ? tr('Hide diagram source') : tr('Show diagram source')}
          </Text>
        </Button>
      </View>
      <Each of={images()} key={(image) => image.uri}>
        {(image) => {
          const selected = image();
          return (
            <Image
              src={selected.uri}
              accessibilityLabel={tr('Mermaid diagram')}
              style={{
                width: selected.width,
                maxWidth: '100%',
                aspectRatio: selected.width / selected.height,
                objectFit: 'contain',
              }}
              onError={({ message }) => {
                if (alive && state() === selected) state.set({ kind: 'error', message });
              }}
            />
          );
        }}
      </Each>
      <If when={state().kind !== 'image'}>
        <Text style={{ ...captionTextStyle, color: state().kind === 'error' ? C.danger : C.muted }}>
          {status()}
        </Text>
      </If>
      <If when={sourceShown() || state().kind === 'error'}>{code()}</If>
    </View>
  );
}
