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

// One frame budget for every computer-use backend. The bound is the model's
// context, not the transport: a frame that survives the wire but blows the
// context window is no more usable than one that never arrived, so both the
// cua-driver backend (frames inline, base64 on stdout) and the maka-cu backend
// (frames by file reference) measure the same decoded bytes against it.

/** Frames above this get re-encoded before the cap check; small crisp PNGs pass through. */
export const FRAME_COMPRESS_THRESHOLD_BYTES = 1.5 * 1024 * 1024;

export const FRAME_MAX_BYTES = 8 * 1024 * 1024;

export function exceedsFrameCap(byteLength: number): boolean {
  return byteLength > FRAME_MAX_BYTES;
}
