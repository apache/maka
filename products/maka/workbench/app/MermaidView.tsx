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
import type { ViewRef } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { host } from 'maka/host';
import { diagramSvg, type DiagramPalette } from './mermaid';
import { CodeBlockAction, codeBlockActions, codeBlockStyles } from './codeBlockLook';
import { Icon } from './Icon';
import { ImageViewer, type ViewerImage } from './ImageViewer';
import { tr } from './locale';
import {
  C,
  captionTextStyle,
  controlFocusStyle,
  controlHoverStyle,
  defaultColors,
  isDark,
  textTooltip,
} from './ui';

type RenderedDiagram = { uri: string; width: number; height: number };
type Presentation =
  | { kind: 'loading' }
  | ({ kind: 'image' } & RenderedDiagram)
  | { kind: 'error'; message: string };

const DARK_COLORS = defaultColors(true);
const DARK_PALETTE: DiagramPalette = {
  background: DARK_COLORS.background,
  text: DARK_COLORS.text,
  muted: DARK_COLORS.muted,
  secondary: DARK_COLORS.secondary,
  surface: DARK_COLORS.surface,
  raised: DARK_COLORS.raised,
  line: DARK_COLORS.line,
  accent: DARK_COLORS.accent,
  danger: DARK_COLORS.danger,
};

export const mermaidExtensions = [{ name: 'mermaid', language: 'mermaid' }];

export function MermaidView(props: { source(): string; editable?: boolean }) {
  const code = () => (
    <TextView
      document={{ blocks: [{ type: 'codeBlock', language: 'mermaid', code: props.source() }] }}
      selectable
      renderCodeBlockAction={(action) => <CodeBlockAction action={action} />}
      codeBlockActions={codeBlockActions()}
      styles={codeBlockStyles(C.text, 12)}
    />
  );
  if (platform.idiom === 'terminal') return code();

  const width = signal(0);
  const state = signal<Presentation>({ kind: 'loading' });
  const sourceShown = signal(false);
  const viewerImage = signal<ViewerImage | null>(null);
  const sourceLabel = () => (sourceShown() ? tr('Hide diagram source') : tr('Show diagram source'));
  let alive = true;
  let generation = 0;
  let viewerGeneration = 0;
  let running = false;
  let frame: ReturnType<typeof requestAnimationFrame> | undefined;
  let lastSource: string | undefined;
  let expandButton: ViewRef | undefined;
  let diagramButton: ViewRef | undefined;
  let opener: ViewRef | undefined;
  let pending: {
    generation: number;
    source: string;
    palette: DiagramPalette;
    maxWidth: number;
  } | null = null;
  const closeViewer = () => {
    viewerGeneration += 1;
    viewerImage.set(null);
    const target = opener;
    opener = undefined;
    if (alive && target) target.focus();
  };
  const openViewer = (selected: RenderedDiagram, trigger?: ViewRef) => {
    if (!alive) return;
    opener = trigger;
    const title = tr('Mermaid diagram');
    if (isDark()) {
      viewerGeneration += 1;
      viewerImage.set({ ...selected, title });
      return;
    }
    // Pele SVGs have transparent backgrounds; render a dark-palette copy for the always-dark viewer.
    const current = ++viewerGeneration;
    const source = props.source();
    const maxWidth = Math.max(Math.floor(width()), selected.width);
    void (async () => {
      try {
        const darkDiagram = diagramSvg(source, DARK_PALETTE, maxWidth);
        const uri = await host.diagramImage(darkDiagram.svg);
        if (alive && viewerGeneration === current) {
          viewerImage.set({ uri, width: darkDiagram.width, height: darkDiagram.height, title });
        }
      } catch {
        if (alive && viewerGeneration === current) {
          viewerImage.set({ ...selected, title });
        }
      }
    })();
  };
  const drain = async () => {
    if (!alive || running || !pending) return;
    const request = pending;
    pending = null;
    running = true;
    try {
      const diagram = diagramSvg(request.source, request.palette, request.maxWidth);
      const uri = await host.diagramImage(diagram.svg);
      if (alive && generation === request.generation)
        state.set({ kind: 'image', uri, width: diagram.width, height: diagram.height });
    } catch (error) {
      if (alive && generation === request.generation)
        state.set({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      running = false;
      schedule();
    }
  };
  const schedule = () => {
    if (!alive || running || frame !== undefined || !pending) return;
    frame = requestAnimationFrame(() => {
      frame = undefined;
      void drain();
    });
  };
  effect(() => {
    const source = props.source();
    const maxWidth = Math.floor(width());
    const palette = {
      background: C.panel,
      text: C.text,
      muted: C.muted,
      secondary: C.secondary,
      surface: C.card,
      raised: C.cardRaised,
      line: C.line,
      accent: C.accent,
      danger: C.danger,
    };
    if (lastSource !== undefined && lastSource !== source) {
      viewerGeneration += 1;
      viewerImage.set(null);
    }
    lastSource = source;
    const current = ++generation;
    pending = maxWidth > 0 ? { generation: current, source, palette, maxWidth } : null;
    state.set({ kind: 'loading' });
    // Keep only the latest input; parse and outline at most one diagram per frame/job.
    schedule();
  });
  cleanup(() => {
    alive = false;
    pending = null;
    viewerGeneration += 1;
    if (frame !== undefined) cancelAnimationFrame(frame);
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
      <If when={!props.editable}>
        <View
          style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <Text style={{ ...captionTextStyle, color: C.muted }}>Mermaid</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <If when={state().kind === 'image'}>
              <Button
                ref={(node) => {
                  expandButton = node;
                }}
                accessibilityLabel={tr('Open diagram full screen')}
                tooltip={textTooltip(() => tr('Open full screen'))}
                style={{ padding: 4, alignItems: 'center', justifyContent: 'center' }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
                onPress={() => {
                  const current = state();
                  if (current.kind === 'image') openViewer(current, expandButton);
                }}
              >
                <Icon name="expand" color={C.secondary} />
              </Button>
            </If>
            <Button
              accessibilityLabel={sourceLabel()}
              style={{ padding: 4 }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
              onPress={() => sourceShown.set(!sourceShown())}
            >
              <Text style={{ ...captionTextStyle, color: C.secondary }}>{sourceLabel()}</Text>
            </Button>
          </View>
        </View>
      </If>
      <Each of={images()} key={(image) => image.uri}>
        {(image) => {
          const selected = image();
          const interactive = !props.editable;
          const diagram = (
            <Image
              src={selected.uri}
              accessibilityLabel={interactive ? undefined : tr('Mermaid diagram')}
              style={[
                {
                  width: selected.width,
                  maxWidth: '100%',
                  aspectRatio: selected.width / selected.height,
                  objectFit: 'contain',
                },
                interactive && { pointerEvents: 'none' },
              ]}
              onError={({ message }) => {
                if (alive && state() === selected) state.set({ kind: 'error', message });
              }}
            />
          );
          // Editable Markdown preview uses clicks on the diagram to reveal its source fence in place.
          if (props.editable) return diagram;
          return (
            <Button
              ref={(node) => {
                diagramButton = node;
              }}
              accessibilityLabel={tr('Mermaid diagram')}
              tooltip={textTooltip(() => tr('Open full screen'))}
              style={{
                alignSelf: 'flex-start',
                maxWidth: '100%',
                padding: 0,
                backgroundColor: 'transparent',
              }}
              focusStyle={controlFocusStyle()}
              onPress={() => openViewer(selected, diagramButton)}
            >
              {diagram}
            </Button>
          );
        }}
      </Each>
      <If when={state().kind === 'error' || (!props.editable && state().kind === 'loading')}>
        <Text style={{ ...captionTextStyle, color: state().kind === 'error' ? C.danger : C.muted }}>
          {status()}
        </Text>
      </If>
      <If when={sourceShown() || state().kind === 'error'}>{code()}</If>
      <If when={viewerImage()}>
        <ImageViewer images={[viewerImage()!]} close={closeViewer} />
      </If>
    </View>
  );
}
