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

import { randomUUID } from "node:crypto";
import { open, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAX_ATTACHMENT_BYTES } from '@maka/core/attachments';
import { type ArtifactSaveResult } from '@maka/core/artifacts';
import { sanitizeArtifactName } from "@maka/storage/artifact-stores";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";
import type { createMainWindowController } from "./main-window.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

interface RuntimeHostArtifactsIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
  readonly mainWindowController: ReturnType<typeof createMainWindowController>;
  readonly sendToRenderer: (channel: string, ...args: unknown[]) => void;
  readonly showItemInFolder: (path: string) => void;
  readonly presentationRoot?: string;
}

export function registerRuntimeHostArtifactsIpc(
  deps: RuntimeHostArtifactsIpcDeps,
): void {
  const presentationRoot =
    deps.presentationRoot ??
    join(tmpdir(), "maka-runtime-host-artifacts", deps.client.hostEpoch);

  handleReconnectableRead(
    deps.ipcMain,
    "artifacts:list",
    async (
      _event,
      sessionId: string,
      options?: { includeDeleted?: boolean },
    ) => {
      const artifacts = await deps.client.listArtifacts(sessionId);
      return options?.includeDeleted
        ? artifacts
        : artifacts.filter(({ status }) => status !== "deleted");
    },
  );
  handleReconnectableRead(
    deps.ipcMain,
    "artifacts:readText",
    (_event, sessionId: string, artifactId: string) =>
      deps.client.readArtifactText(sessionId, artifactId),
  );
  handleReconnectableRead(
    deps.ipcMain,
    "artifacts:readBinary",
    (_event, sessionId: string, artifactId: string) =>
      deps.client.readArtifactBinary(sessionId, artifactId),
  );
  deps.ipcMain.handle(
    "artifacts:delete",
    async (_event, sessionId: string, artifactId: string) => {
      const result = await deps.client.deleteArtifact(sessionId, artifactId);
      deps.sendToRenderer("artifacts:changed", {
        reason: "deleted",
        artifactId,
        sessionId,
        ts: Date.now(),
      });
      return result;
    },
  );
  handleReconnectableRead(
    deps.ipcMain,
    "attachments:readBytes",
    async (_event, sessionId: string, artifactId: string) => {
      const artifact = await deps.client.getArtifact(sessionId, artifactId);
      if (
        !artifact ||
        artifact.status === "deleted" ||
        artifact.sizeBytes > MAX_ATTACHMENT_BYTES
      ) {
        return { ok: false as const, reason: "not_found" };
      }
      const chunks: Buffer[] = [];
      let received = 0;
      await deps.client.streamArtifact(sessionId, artifactId, async (chunk) => {
        received += chunk.byteLength;
        if (received > MAX_ATTACHMENT_BYTES) {
          throw new Error("Attachment exceeds the renderer byte limit");
        }
        chunks.push(Buffer.from(chunk));
      });
      if (received !== artifact.sizeBytes) {
        return { ok: false as const, reason: "read_failed" };
      }
      return {
        ok: true as const,
        base64: Buffer.concat(chunks, received).toString("base64"),
        mimeType: artifact.mimeType ?? "application/octet-stream",
      };
    },
  );
  deps.ipcMain.handle(
    "app:openArtifactPath",
    async (_event, sessionId: string, artifactId: string) => {
      const artifact = await deps.client.getArtifact(sessionId, artifactId);
      if (!artifact || artifact.status === "deleted") {
        return { ok: false as const, reason: "missing" as const };
      }
      try {
        const path = join(
          presentationRoot,
          sessionId,
          `${artifactId}-${sanitizeArtifactName(artifact.name)}`,
        );
        await materializeArtifact(deps.client, sessionId, artifactId, path, artifact.sizeBytes);
        deps.showItemInFolder(path);
        return { ok: true as const, opened: artifact.name };
      } catch {
        return { ok: false as const, reason: "open-failed" as const };
      }
    },
  );
  deps.ipcMain.handle(
    "app:saveArtifactAs",
    async (
      _event,
      sessionId: string,
      artifactId: string,
    ): Promise<ArtifactSaveResult> => {
      const artifact = await deps.client.getArtifact(sessionId, artifactId);
      if (!artifact) return { ok: false, reason: "not_found" };
      if (artifact.status === "deleted") return { ok: false, reason: "deleted" };
      const result = await deps.mainWindowController.showSaveDialog({
        title: `另存为 ${artifact.name}`,
        defaultPath: artifact.name,
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, reason: "canceled" };
      }
      try {
        await materializeArtifact(
          deps.client,
          sessionId,
          artifactId,
          result.filePath,
          artifact.sizeBytes,
        );
        return { ok: true, saved: artifact.name };
      } catch {
        return { ok: false, reason: "write_failed" };
      }
    },
  );
}

async function materializeArtifact(
  client: DesktopRuntimeHostClient,
  sessionId: string,
  artifactId: string,
  targetPath: string,
  expectedBytes: number,
): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  const stagingPath = join(
    dirname(targetPath),
    `.${sanitizeArtifactName(artifactId)}.${randomUUID()}.tmp`,
  );
  const handle = await open(stagingPath, "wx");
  let offset = 0;
  try {
    const totalBytes = await client.streamArtifact(
      sessionId,
      artifactId,
      async (chunk) => {
        let written = 0;
        while (written < chunk.byteLength) {
          const result = await handle.write(
            chunk,
            written,
            chunk.byteLength - written,
            offset + written,
          );
          if (result.bytesWritten === 0) throw new Error("Artifact write stalled");
          written += result.bytesWritten;
        }
        offset += written;
      },
    );
    if (totalBytes !== expectedBytes || offset !== expectedBytes) {
      throw new Error("Artifact size changed during export");
    }
    await handle.sync();
    await handle.close();
    await rm(targetPath, { force: true });
    await rename(stagingPath, targetPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(stagingPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
