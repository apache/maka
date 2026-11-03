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

import { platform, Text, View } from 'nsh';
import type { HistoryTool } from '../../../../packages/plugin-sdk/src/index.js';
import { ImageThumbnail } from './ImageThumbnail';
import { C, captionTextStyle } from './ui';
import type { ImagePreview } from './ImageThumbnail';
export type { ImagePreview } from './ImageThumbnail';
import type { Position } from './history';
import { useHost } from './host';
import { immutableAsset } from './immutableAsset';

export function ToolImage(props: {
  sessionId: string;
  through: () => number;
  position: Position;
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

export type ToolImageRef = { key: string; position: Position; image?: number };

/** The content image has no index; the others are what the model saw beside the content. */
export function toolImages(tool: HistoryTool | null | undefined): ToolImageRef[] {
  const result = tool?.result;
  if (!result) return [];
  const key = `${tool.toolUseId}/${result.position.sourceSequence}/${result.position.itemIndex}`;
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
  rows: Iterable<{ turnId?: string; tool?: HistoryTool | null }>,
  turnId: string,
): ToolImageRef[] {
  const tools = new Map<string, HistoryTool>();
  for (const row of rows)
    if (row.turnId === turnId && row.tool?.result) tools.set(row.tool.toolUseId, row.tool);
  return [...tools.values()]
    .toSorted(
      (left, right) =>
        left.result!.position.sourceSequence - right.result!.position.sourceSequence ||
        left.result!.position.itemIndex - right.result!.position.itemIndex,
    )
    .flatMap(toolImages);
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
