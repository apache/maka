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

export interface TerminalAnimationFrameEnvironment {
  request(callback: FrameRequestCallback): number;
  cancel(frame: number): void;
}

const browserAnimationFrames: TerminalAnimationFrameEnvironment = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (frame) => cancelAnimationFrame(frame),
};

/**
 * Schedules Terminal DOM work that must not outlive the xterm instance.
 *
 * The active flag is intentional even though cleanup cancels the browser frame:
 * a callback already handed off by a scheduler must still become a no-op.
 */
export function scheduleTerminalFrame(
  callback: FrameRequestCallback,
  environment: TerminalAnimationFrameEnvironment = browserAnimationFrames,
): () => void {
  let pending = true;
  const frame = environment.request((time) => {
    if (!pending) return;
    pending = false;
    callback(time);
  });
  return () => {
    if (!pending) return;
    pending = false;
    environment.cancel(frame);
  };
}
