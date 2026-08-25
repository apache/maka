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
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { registerWorkspaceFileRefsIpc } from "../workspace-file-refs-ipc-main.js";

type Handler = (event: unknown, ...args: any[]) => unknown;

interface Harness {
  handlers: Map<string, Handler>;
  root: string;
  opened: string[];
  revealed: string[];
  setSessionCwd(cwd: string): void;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "maka-workspace-file-refs-"));
  const handlers = new Map<string, Handler>();
  const opened: string[] = [];
  const revealed: string[] = [];
  let sessionCwd = root;
  registerWorkspaceFileRefsIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as Handler),
    },
    client: {
      async getSession(sessionId: string) {
        if (sessionId !== "session-1") return null;
        return { workspace: { hostCwd: sessionCwd } };
      },
    } as never,
    openPath: async (path) => {
      opened.push(path);
      return "";
    },
    showItemInFolder: (path) => {
      revealed.push(path);
    },
  });
  return {
    handlers,
    root,
    opened,
    revealed,
    setSessionCwd(cwd) {
      sessionCwd = cwd;
    },
  };
}

test("workspace file refs read files inside the project root", async () => {
  const h = await createHarness();
  try {
    await mkdir(join(h.root, "docs"), { recursive: true });
    await writeFile(join(h.root, "docs", "设计 笔记.md"), "# 你好");
    const read = h.handlers.get("workspace-files:readText")!;
    // Raw space/CJK reference resolves identically to its percent-encoded form.
    assert.deepEqual(await read({}, "session-1", "docs/设计 笔记.md"), {
      ok: true,
      name: "设计 笔记.md",
      text: "# 你好",
    });
    assert.deepEqual(
      await read({}, "session-1", "docs/%E8%AE%BE%E8%AE%A1%20%E7%AC%94%E8%AE%B0.md"),
      { ok: true, name: "设计 笔记.md", text: "# 你好" },
    );
    // Relative-dot and in-root absolute spellings are the same file.
    assert.deepEqual(await read({}, "session-1", "./docs/设计 笔记.md"), {
      ok: true,
      name: "设计 笔记.md",
      text: "# 你好",
    });
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("workspace file refs reject traversal outside the root", async () => {
  const h = await createHarness();
  try {
    const secretDir = await mkdtemp(join(tmpdir(), "maka-refs-secret-"));
    await writeFile(join(secretDir, "secret.md"), "secret");
    const read = h.handlers.get("workspace-files:readText")!;
    assert.deepEqual(await read({}, "session-1", "../secret/secret.md"), {
      ok: false,
      reason: "outside_workspace",
    });
    assert.deepEqual(await read({}, "session-1", join(secretDir, "secret.md")), {
      ok: false,
      reason: "outside_workspace",
    });
    await rm(secretDir, { recursive: true, force: true });
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("workspace file refs reject symlink escapes", async () => {
  const h = await createHarness();
  try {
    const secretDir = await mkdtemp(join(tmpdir(), "maka-refs-secret-"));
    await writeFile(join(secretDir, "outside.md"), "secret");
    await mkdir(join(h.root, "docs"), { recursive: true });
    await symlink(join(secretDir, "outside.md"), join(h.root, "docs", "leak.md"));
    const read = h.handlers.get("workspace-files:readText")!;
    assert.deepEqual(await read({}, "session-1", "docs/leak.md"), {
      ok: false,
      reason: "outside_workspace",
    });
    await rm(secretDir, { recursive: true, force: true });
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("workspace file refs report missing files non-destructively", async () => {
  const h = await createHarness();
  try {
    const read = h.handlers.get("workspace-files:readText")!;
    assert.deepEqual(await read({}, "session-1", "docs/gone.md"), {
      ok: false,
      reason: "not_found",
    });
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("workspace file refs reject invalid references and non-Markdown targets", async () => {
  const h = await createHarness();
  try {
    await writeFile(join(h.root, "notes.txt"), "plain");
    const read = h.handlers.get("workspace-files:readText")!;
    for (const reference of [
      "notes.txt",
      "file:///etc/passwd.md",
      "https://example.com/a.md",
      "",
      42,
      null,
      `a\nb.md`,
      `${"a".repeat(2049)}.md`,
    ]) {
      assert.deepEqual(await read({}, "session-1", reference), {
        ok: false,
        reason: "invalid_reference",
      }, String(reference));
    }
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("workspace file refs enforce the preview size cap", async () => {
  const h = await createHarness();
  try {
    await writeFile(join(h.root, "big.md"), "x".repeat(1024 * 1024 + 1));
    const read = h.handlers.get("workspace-files:readText")!;
    assert.deepEqual(await read({}, "session-1", "big.md"), {
      ok: false,
      reason: "too_large",
    });
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("open locally and reveal resolve through the same boundary check", async () => {
  const h = await createHarness();
  try {
    await writeFile(join(h.root, "readme.md"), "# hi");
    const open = h.handlers.get("workspace-files:openLocally")!;
    const reveal = h.handlers.get("workspace-files:revealInFolder")!;
    assert.deepEqual(await open({}, "session-1", "readme.md"), {
      ok: true,
      opened: "readme.md",
    });
    assert.equal(h.opened.length, 1);
    assert.deepEqual(await reveal({}, "session-1", "./readme.md"), {
      ok: true,
      opened: "readme.md",
    });
    assert.equal(h.revealed.length, 1);
    assert.ok(h.revealed[0]!.endsWith("readme.md"));
    // Escapes never reach the shell.
    assert.deepEqual(await open({}, "session-1", "../escape.md"), {
      ok: false,
      reason: "outside_workspace",
    });
    assert.equal(h.opened.length, 1);
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});

test("remote hosts have no local workspace to serve", async () => {
  const root = await mkdtemp(join(tmpdir(), "maka-workspace-file-refs-remote-"));
  try {
    await writeFile(join(root, "readme.md"), "# hi");
    const handlers = new Map<string, Handler>();
    registerWorkspaceFileRefsIpc({
      ipcMain: {
        handle: (channel, handler) => handlers.set(channel, handler as Handler),
      },
      client: {
        async getSession() {
          return { workspace: { hostCwd: root } };
        },
      } as never,
      allowLocalWorkspace: false,
      openPath: async () => "",
      showItemInFolder: () => {},
    });
    assert.deepEqual(
      await handlers.get("workspace-files:readText")!({}, "session-1", "readme.md"),
      { ok: false, reason: "workspace_unavailable" },
    );
    assert.deepEqual(
      await handlers.get("workspace-files:openLocally")!({}, "session-1", "readme.md"),
      { ok: false, reason: "workspace_unavailable" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown sessions fail loudly instead of resolving against a default root", async () => {
  const h = await createHarness();
  try {
    const read = h.handlers.get("workspace-files:readText")!;
    await assert.rejects(
      Promise.resolve(read({}, "session-other", "readme.md")),
      /No such Session/,
    );
  } finally {
    await rm(h.root, { recursive: true, force: true });
  }
});
