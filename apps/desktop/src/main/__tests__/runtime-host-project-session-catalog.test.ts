import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRuntimeHostProjectSessionCatalog } from "../runtime-host-project-session-catalog.js";

describe("Runtime Host project Session catalog", () => {
  test("projects Host Session headers without taking local authority", async () => {
    const catalog = createRuntimeHostProjectSessionCatalog({
      listSessions: async () => [
        { id: "session-1", cwd: "/workspace/one", projectId: "project-1" },
      ],
      relocateSessionCwd: async () => assert.fail("unexpected relocation"),
      updateSessionMetadata: async () => assert.fail("unexpected metadata update"),
    } as never);

    assert.deepEqual(await catalog.listHeaders(), [
      { id: "session-1", cwd: "/workspace/one", projectId: "project-1" },
    ]);
  });

  test("relocates cwd and project association in one Host mutation", async () => {
    const calls: unknown[][] = [];
    const catalog = createRuntimeHostProjectSessionCatalog({
      listSessions: async () => [],
      relocateSessionCwd: async (...args: unknown[]) => {
        calls.push(args);
        return {} as never;
      },
      updateSessionMetadata: async () => assert.fail("must not split the mutation"),
    } as never);

    await catalog.updateHeader("session-1", {
      cwd: "/workspace/next",
      projectId: "project-2",
    });

    assert.deepEqual(calls, [
      ["session-1", "/workspace/next", "project-2"],
    ]);
  });

  test("updates a project association without relocating cwd", async () => {
    const calls: unknown[][] = [];
    const catalog = createRuntimeHostProjectSessionCatalog({
      listSessions: async () => [],
      relocateSessionCwd: async () => assert.fail("unexpected relocation"),
      updateSessionMetadata: async (...args: unknown[]) => {
        calls.push(args);
        return {} as never;
      },
    } as never);

    await catalog.updateHeader("session-1", { projectId: "project-2" });

    assert.deepEqual(calls, [
      ["session-1", { projectId: "project-2" }],
    ]);
  });
});
