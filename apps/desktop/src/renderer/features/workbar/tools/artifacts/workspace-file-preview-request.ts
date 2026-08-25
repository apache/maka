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

/**
 * Hand-off from transcript Markdown clicks (`MakaUriDest` kind `file-ref`) to
 * the ArtifactPane's workspace-file preview. Module-level staging mirrors
 * `quote-companion-panel-state`: the requester (app shell) and the consumer
 * (lazily mounted pane) never need a direct prop thread through the workbar.
 *
 * A request is delivered exactly once: staged until a subscriber consumes it,
 * then pushed live to already-mounted subscribers. Nothing here resolves or
 * touches the referenced file — that is desktop main's job via IPC.
 */

export interface WorkspaceFilePreviewRequest {
  readonly sessionId: string;
  /** Raw reference exactly as written in the Markdown source. */
  readonly reference: string;
}

let stagedRequest: WorkspaceFilePreviewRequest | null = null;
const subscribers = new Set<(request: WorkspaceFilePreviewRequest) => void>();

export function requestWorkspaceFilePreview(request: WorkspaceFilePreviewRequest): void {
  stagedRequest = request;
  for (const subscriber of subscribers) subscriber(request);
}

/** Deliver any staged request to `subscriber` and keep it fed; one-shot. */
export function subscribeWorkspaceFilePreviewRequests(
  subscriber: (request: WorkspaceFilePreviewRequest) => void,
): () => void {
  if (stagedRequest) {
    const request = stagedRequest;
    stagedRequest = null;
    subscriber(request);
  }
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}
