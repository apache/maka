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

import { MAX_MODEL_IMAGE_EDGE } from '@maka/core/attachments';

export const ATTACHMENT_IMAGE_MAX_EDGE = MAX_MODEL_IMAGE_EDGE;

/**
 * Compute the target size to scale an image down so its longest edge fits
 * `maxEdge`, preserving aspect ratio. Returns `null` when the image already
 * fits or has no usable dimensions (no resize needed). Pure so it can be
 * tested without Electron's nativeImage.
 */
export function computeResizeDimensions(
  width: number,
  height: number,
  maxEdge: number = ATTACHMENT_IMAGE_MAX_EDGE,
): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest === 0 || longest <= maxEdge) return null;
  const scale = maxEdge / longest;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
