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

import type { HistoryRowAddress } from '../../../../packages/plugin-sdk/src/index.js';
import { platform, Text, View } from 'nsh';
import type { HistoryTool, HistoryOrder } from '../../../../packages/plugin-sdk/src/index.js';
import { ImageThumbnail } from './ImageThumbnail';
import { C, captionTextStyle } from './ui';
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
  mini?: boolean;
  label?: string;
  preview(image: ImagePreview): void;
}) {
  const host = useHost();
  const source = Object.freeze({
    sessionId: props.sessionId,
    through: props.through(),
    position: Object.freeze({ ...props.position }),
    ...(props.image == null ? {} : { image: props.image }),
    offset: 0,
  });
  return (
    <ImageThumbnail
      source={{ kind: 'tool-image', read: source }}
      uri={host.assetUri(immutableAsset('tool-image', source))}
      mini={props.mini}
      label={props.label}
      preview={props.preview}
    />
  );
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

/** The latest images as one-line thumbnails; earlier ones are counted. */
export function ToolImageStrip(props: {
  sessionId: string;
  through: () => number;
  images: () => ToolImageRef[];
  preview(image: ImagePreview): void;
}) {
  // Terminal cells are too coarse for thumbnails; expanded tools still show each image.
  if (platform.isTerminal) return <View />;
  const shown = () => props.images().slice(-stripLimit);
  const hidden = () => props.images().length - shown().length;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      <If when={hidden() > 0}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{`+${hidden()}`}</Text>
      </If>
      <Each of={shown()} key={(value: ToolImageRef) => value.key}>
        {(value) => (
          <ToolImage
            mini
            sessionId={props.sessionId}
            through={props.through}
            position={value().position}
            image={value().image}
            preview={props.preview}
          />
        )}
      </Each>
    </View>
  );
}
