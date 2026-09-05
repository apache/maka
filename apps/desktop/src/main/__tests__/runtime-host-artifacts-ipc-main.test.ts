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

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerRuntimeHostArtifactsIpc } from "../runtime-host-artifacts-ipc-main.js";

type Handler = (event: unknown, ...args: any[]) => unknown;
type StreamArtifact = (
  sessionId: string,
  artifactId: string,
  writeChunk: (chunk: Uint8Array) => Promise<void>,
) => Promise<number>;

function previewArtifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "artifact-1",
    sessionId: "session-1",
    turnId: "turn-1",
    createdAt: 1,
    name: "preview.png",
    kind: "image",
    sizeBytes: 4,
    mimeType: "image/png",
    status: "live",
    ...overrides,
  };
}

function attachmentReadHandler(
  artifact: Record<string, unknown>,
  streamArtifact: StreamArtifact,
): Handler {
  const handlers = new Map<string, Handler>();
  registerRuntimeHostArtifactsIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as Handler),
    },
    client: {
      hostEpoch: "host-1",
      async getArtifact() {
        return artifact;
      },
      streamArtifact,
    } as never,
    mainWindowController: {} as never,
    sendToRenderer() {},
    showItemInFolder() {},
  });
  const handler = handlers.get("attachments:readBytes");
  assert.ok(handler);
  return handler;
}

test("Runtime Host Artifact IPC preserves previews and streams complete exports", async () => {
  const root = await mkdtemp(join(tmpdir(), "maka-host-artifact-ipc-"));
  const savedPath = join(root, "saved.bin");
  const presentationRoot = join(root, "presentations");
  const content = Buffer.alloc(70 * 1024, 5);
  const handlers = new Map<string, Handler>();
  const opened: string[] = [];
  const events: unknown[] = [];
  const artifact = {
    id: "artifact-1",
    sessionId: "session-1",
    turnId: "turn-1",
    createdAt: 1,
    name: "result.bin",
    kind: "image",
    sizeBytes: content.byteLength,
    mimeType: "image/png",
    status: "live",
  } as const;
  const client = {
    hostEpoch: "host-1",
    async listArtifacts() {
      return [artifact];
    },
    async getArtifact() {
      return artifact;
    },
    async readArtifactText() {
      return { ok: false, reason: "too_large" };
    },
    async readArtifactBinary() {
      return { ok: false, reason: "unsupported_mime" };
    },
    async deleteArtifact() {
      return { kind: "deleted", artifact: { ...artifact, status: "deleted" } };
    },
    async streamArtifact(
      _sessionId: string,
      _artifactId: string,
      writeChunk: (chunk: Uint8Array) => Promise<void>,
    ) {
      for (let offset = 0; offset < content.byteLength; offset += 32 * 1024) {
        await writeChunk(content.subarray(offset, offset + 32 * 1024));
      }
      return content.byteLength;
    },
  };

  try {
    registerRuntimeHostArtifactsIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler as Handler),
      },
      client: client as never,
      mainWindowController: {
        showSaveDialog: async () => ({ canceled: false, filePath: savedPath }),
      } as never,
      sendToRenderer: (_channel, event) => events.push(event),
      showItemInFolder: (path) => opened.push(path),
      presentationRoot,
    });

    assert.deepEqual(
      await handlers.get("artifacts:readText")?.({}, "session-1", "artifact-1"),
      { ok: false, reason: "too_large" },
    );
    assert.deepEqual(
      await handlers.get("attachments:readBytes")?.({}, "session-1", "artifact-1"),
      {
        ok: true,
        base64: content.toString("base64"),
        mimeType: "image/png",
      },
    );
    assert.deepEqual(
      await handlers.get("app:saveArtifactAs")?.({}, "session-1", "artifact-1"),
      { ok: true, saved: "result.bin" },
    );
    assert.deepEqual(await readFile(savedPath), content);

    assert.deepEqual(
      await handlers.get("app:openArtifactPath")?.({}, "session-1", "artifact-1"),
      { ok: true, opened: "result.bin" },
    );
    assert.equal(opened.length, 1);
    assert.deepEqual(await readFile(opened[0]!), content);

    await handlers.get("artifacts:delete")?.({}, "session-1", "artifact-1");
    assert.equal((events[0] as { reason: string }).reason, "deleted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Attachment byte IPC rejects preview-ineligible metadata before streaming", async () => {
  for (const [overrides, reason] of [
    [{ id: "artifact-large", sizeBytes: 2 * 1024 * 1024 + 1 }, "too_large"],
    [{ id: "artifact-svg", name: "vector.svg", mimeType: "image/svg+xml" }, "unsupported_mime"],
  ] as const) {
    let streamCalls = 0;
    const read = attachmentReadHandler(previewArtifact(overrides), async () => {
      streamCalls += 1;
      return 0;
    });
    assert.deepEqual(await read({}, "session-1", overrides.id), { ok: false, reason });
    assert.equal(streamCalls, 0);
  }
});

test("Attachment byte IPC stops a stream that exceeds its preview admission", async () => {
  const read = attachmentReadHandler(
    previewArtifact({ id: "artifact-drifted" }),
    async (_sessionId, _artifactId, writeChunk) => {
      await writeChunk(new Uint8Array(2 * 1024 * 1024 + 1));
      return 2 * 1024 * 1024 + 1;
    },
  );

  assert.deepEqual(
    await read({}, "session-1", "artifact-drifted"),
    { ok: false, reason: "too_large" },
  );
});
