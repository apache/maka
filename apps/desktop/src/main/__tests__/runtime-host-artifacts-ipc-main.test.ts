import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerRuntimeHostArtifactsIpc } from "../runtime-host-artifacts-ipc-main.js";

type Handler = (event: unknown, ...args: any[]) => unknown;

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
    kind: "file",
    sizeBytes: content.byteLength,
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
