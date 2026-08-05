import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { hasRuntimeHostInterruptibleWork } from "../runtime-host-update-activity.js";

function client(input: {
  status?: string;
  archived?: boolean;
  firePending?: boolean;
  resourceStatus?: string;
}) {
  return {
    listSessions: async () => [
      {
        id: "session-1",
        status: input.status ?? "active",
        isArchived: input.archived ?? false,
      },
    ],
    listAutomations: async () =>
      input.firePending === undefined
        ? []
        : [{ firePending: input.firePending }],
    listRuntimeResources: async () =>
      input.resourceStatus === undefined
        ? []
        : [{ result: { status: input.resourceStatus } }],
  } as never;
}

describe("Runtime Host update activity", () => {
  test("detects active Turns before querying background domains", async () => {
    assert.equal(
      await hasRuntimeHostInterruptibleWork(client({ status: "running" })),
      true,
    );
    assert.equal(
      await hasRuntimeHostInterruptibleWork(
        client({ status: "waiting_for_user" }),
      ),
      true,
    );
  });

  test("detects Automation fires and live Runtime Resources", async () => {
    assert.equal(
      await hasRuntimeHostInterruptibleWork(client({ firePending: true })),
      true,
    );
    assert.equal(
      await hasRuntimeHostInterruptibleWork(
        client({ resourceStatus: "running" }),
      ),
      true,
    );
  });

  test("ignores terminal work and archived Sessions", async () => {
    assert.equal(
      await hasRuntimeHostInterruptibleWork(
        client({ firePending: false, resourceStatus: "completed" }),
      ),
      false,
    );
    assert.equal(
      await hasRuntimeHostInterruptibleWork(
        client({ archived: true, resourceStatus: "running" }),
      ),
      false,
    );
  });
});
