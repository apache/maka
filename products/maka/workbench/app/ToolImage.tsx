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

import type {
  AgentToolImageRead,
  HistoryRowAddress,
} from '../../../../packages/plugin-sdk/src/index.js';
import { cleanup, computed, platform, signal, Text, View } from 'nsh';
import type { ViewRef } from 'nsh';
import { Button } from 'nsh/base';
import type { HistoryTool, HistoryOrder } from '../../../../packages/plugin-sdk/src/index.js';
import { ImageThumbnail } from './ImageThumbnail';
import { ImageViewer } from './ImageViewer';
import { tr } from './locale';
import { C, captionTextStyle, textTooltip } from './ui';
import { activityTitle } from './toolActivityPresentation';
import type { ImagePreview } from './ImageThumbnail';
export type { ImagePreview } from './ImageThumbnail';

import { historyRowKey, historyTurnKey, compareHistoryOrder } from './history';
import { useHost } from './host';
import { immutableAsset } from './immutableAsset';

export function ToolImage(props: {
  sessionId: string;
  through: () => number;
  position: HistoryRowAddress;
  /** One of the result's `images`; absent when the content is the image. */
  image?: number;
  label?: string;
  preview(image: ImagePreview): void;
}) {
  const host = useHost();
  const source = toolImageRead(props.sessionId, props.through(), props);
  return (
    <ImageThumbnail
      source={{ kind: 'tool-image', read: source }}
      uri={host.assetUri(immutableAsset('tool-image', source))}
      label={props.label}
      preview={props.preview}
    />
  );
}

function toolImageRead(
  sessionId: string,
  through: number,
  ref: { position: HistoryRowAddress; image?: number },
): AgentToolImageRead {
  return Object.freeze({
    sessionId,
    through,
    position: Object.freeze({ ...ref.position }),
    ...(ref.image == null ? {} : { image: ref.image }),
    offset: 0,
  });
}

export type ToolImageRef = { key: string; position: HistoryRowAddress; image?: number };

/** The content image has no index; the others are what the model saw beside the content. */
export function toolImages(tool: HistoryTool | null | undefined): ToolImageRef[] {
  const result = tool?.result;
  if (!result) return [];
  const key = `${tool.toolUseId}/${historyRowKey(result.position)}`;
  return [
    ...(result.image ? [{ key: `${key}/content`, position: result.position }] : []),
    ...Array.from({ length: result.images ?? 0 }, (_, image) => ({
      key: `${key}/${image}`,
      position: result.position,
      image,
    })),
  ];
}

/** Every tool image of one Turn, in transcript order, each tool once. */
export function turnImages(
  rows: Iterable<{
    turnId?: string;
    importedTurn?: number;
    position?: HistoryRowAddress;
    order?: HistoryOrder;
    tool?: HistoryTool | null;
  }>,
  turnKey: string,
): ToolImageRef[] {
  const tools = new Map<string, { tool: HistoryTool; order: HistoryOrder | undefined }>();
  for (const row of rows) {
    if (historyTurnKey(row) !== turnKey || !row.tool?.result) continue;
    const key = historyRowKey(row.tool.result.position);
    const previous = tools.get(key);
    tools.set(key, { tool: row.tool, order: previous?.order ?? row.order });
  }
  return [...tools.values()]
    .toSorted((left, right) =>
      left.order && right.order ? compareHistoryOrder(left.order, right.order) : 0,
    )
    .flatMap((item) => toolImages(item.tool));
}

const stripLimit = 4;

/**
 * The latest images as one-line thumbnails; earlier ones are counted. A thumbnail opens
 * every image of the strip over the window, leaving the side panels as they are.
 */
export function ToolImageStrip(props: {
  sessionId: string;
  through: () => number;
  images: () => ToolImageRef[];
  total?: () => number | undefined;
  /**
   * Every image-bearing tool of the Turn, oldest first, when `images` holds only the
   * latest. It reports its own failure and then resolves empty.
   */
  all?(): Promise<HistoryTool[]>;
}) {
  // Terminal cells are too coarse for thumbnails; expanded tools still show each image.
  if (platform.idiom === 'terminal') return <View />;
  const host = useHost();
  let alive = true;
  let more: ViewRef | undefined;
  cleanup(() => {
    alive = false;
  });
  // Each image keeps the selector it was first read with, so the viewer reuses that load.
  // Summaries and loaded tools key the same image differently, so it is kept by address.
  const sources = new Map<string, { read: AgentToolImageRead; uri: string }>();
  const address = (ref: ToolImageRef) => `${historyRowKey(ref.position)}/${ref.image ?? 'content'}`;
  const source = (ref: ToolImageRef) => {
    const key = address(ref);
    let known = sources.get(key);
    if (!known) {
      const read = toolImageRead(props.sessionId, props.through(), ref);
      known = { read, uri: host.assetUri(immutableAsset('tool-image', read)) };
      sources.set(key, known);
    }
    return known;
  };
  type Item = { ref: ToolImageRef; title: string };
  const version = computed(() => {
    const refs = props.images();
    return `${props.total?.()}/${refs.length}/${refs.at(-1)?.key}`;
  });
  const loaded = signal<{ version: string; items: Map<string, Item> } | null>(null);
  // The live window may omit earlier images and already contain results beyond the last read.
  const extra = computed(() => {
    const known = loaded()?.items;
    return known ? props.images().filter((ref) => !known.has(address(ref))) : props.images();
  });
  const items = () => [
    ...(loaded()?.items.values() ?? []),
    ...extra().map((ref) => ({ ref, title: tr('Original image') })),
  ];
  let pending: { version: string; task: Promise<boolean> } | undefined;
  const load = (all: () => Promise<HistoryTool[]>) => {
    const key = version();
    if (loaded()?.version === key) return true;
    if (pending?.version === key) return pending.task;
    const task = all()
      .then((tools) => {
        if (!alive || pending?.task !== task) return false;
        const result = new Map<string, Item>();
        for (const tool of tools) {
          const title = activityTitle(tool.call);
          for (const ref of toolImages(tool)) result.set(address(ref), { ref, title });
        }
        if (!result.size) return false;
        loaded.set({ version: key, items: result });
        return true;
      })
      .finally(() => {
        if (pending?.task === task) pending = undefined;
      });
    pending = { version: key, task };
    return task;
  };
  const shown = () => props.images().slice(-stripLimit);
  const count = () => {
    const page = loaded();
    const known = (page?.items.size ?? 0) + extra().length;
    return page?.version === version() ? known : Math.max(props.total?.() ?? 0, known);
  };
  const hidden = () => count() - shown().length;
  const viewing = signal<{ start: string; opened?: ImagePreview } | null>(null);
  const gallery = computed(() => {
    const view = viewing();
    if (!view) return [];
    return items().map(({ ref, title }) => {
      const { uri } = source(ref);
      const opened = view.opened;
      return {
        uri,
        title,
        ...(opened?.uri === uri ? { width: opened.width, height: opened.height } : {}),
      };
    });
  });
  let opening = 0;
  const open = async (opened?: ImagePreview) => {
    const request = ++opening;
    if (opened) viewing.set({ start: opened.uri, opened });
    if (props.all && props.images().some((ref) => ref.position.kind === 'live')) {
      if (!(await load(props.all))) return;
    }
    if (!opened && alive && opening === request) {
      const first = loaded()?.items.values().next().value?.ref ?? props.images()[0];
      if (first) viewing.set({ start: source(first).uri });
    }
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <If when={hidden() > 0}>
        <Button
          ref={(node) => {
            more = node;
          }}
          accessibilityLabel={tr('Show all {count} images', { count: String(count()) })}
          tooltip={textTooltip(() => tr('Show all {count} images', { count: String(count()) }))}
          onPress={() => void open()}
          style={{ height: 24, paddingHorizontal: 4, justifyContent: 'center', borderRadius: 4 }}
          hoverStyle={{ backgroundColor: C.raised }}
          focusStyle={{ backgroundColor: C.line }}
        >
          <Text style={{ ...captionTextStyle, color: C.muted }}>{`+${hidden()}`}</Text>
        </Button>
      </If>
      <Each of={shown()} key={(value: ToolImageRef) => value.key}>
        {(value) => (
          <ImageThumbnail
            mini
            source={{ kind: 'tool-image', read: source(value()).read }}
            uri={source(value()).uri}
            preview={(opened) => {
              if (alive) void open(opened);
            }}
          />
        )}
      </Each>
      <If when={viewing()}>
        <ImageViewer
          images={gallery}
          start={viewing()!.start}
          close={() => {
            ++opening;
            const opened = viewing()?.opened;
            viewing.set(null);
            if (opened) opened.restoreFocus?.();
            else if (alive) more?.focus();
          }}
        />
      </If>
    </View>
  );
}
