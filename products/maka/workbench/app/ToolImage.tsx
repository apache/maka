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
import { cleanup, platform, signal, Text, View } from 'nsh';
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
  const source = (ref: ToolImageRef) => {
    const address = `${historyRowKey(ref.position)}/${ref.image ?? 'content'}`;
    let known = sources.get(address);
    if (!known) {
      const read = toolImageRead(props.sessionId, props.through(), ref);
      known = { read, uri: host.assetUri(immutableAsset('tool-image', read)) };
      sources.set(address, known);
    }
    return known;
  };
  const everything = signal<{ ref: ToolImageRef; title: string }[] | null>(null);
  let loading: { total: number | undefined; task: Promise<void> } | undefined;
  // A running Turn adds images, so a later opening reads the list again.
  const load = () => {
    const total = props.total?.();
    if (!props.all || (loading && loading.total === total)) return loading?.task;
    const task = props.all().then((tools) => {
      if (!alive || loading?.task !== task || tools.length === 0) return;
      everything.set(
        tools.flatMap((tool) =>
          toolImages(tool).map((ref) => ({ ref, title: activityTitle(tool.call) })),
        ),
      );
    });
    loading = { total, task };
    return task;
  };
  const viewing = signal<{ start: string; opened?: ImagePreview } | null>(null);
  const shown = () => props.images().slice(-stripLimit);
  // Once read, the full list is what the viewer pages through, so it is what is counted.
  const count = () => everything()?.length ?? props.total?.() ?? props.images().length;
  const hidden = () => count() - shown().length;
  const gallery = () => {
    const opened = viewing()?.opened;
    return (
      everything() ?? props.images().map((ref) => ({ ref, title: tr('Original image') }))
    ).map(({ ref, title }) => {
      const { uri } = source(ref);
      return {
        uri,
        title,
        ...(opened?.uri === uri ? { width: opened.width, height: opened.height } : {}),
      };
    });
  };
  const showAll = async () => {
    await load();
    const first = gallery()[0];
    if (alive && !viewing() && first) viewing.set({ start: first.uri });
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
          onPress={() => void showAll()}
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
              if (!alive) return;
              viewing.set({ start: opened.uri, opened });
              void load();
            }}
          />
        )}
      </Each>
      <If when={viewing()}>
        <ImageViewer
          images={gallery}
          start={viewing()!.start}
          close={() => {
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
