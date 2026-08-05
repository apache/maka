import { SHELL_RUN_ACTIVE_STATUSES } from "@maka/core/shell-run";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

type RuntimeHostActivityClient = Pick<
  DesktopRuntimeHostClient,
  "listSessions" | "listAutomations" | "listRuntimeResources"
>;

const ACTIVE_SESSION_STATUSES = new Set(["running", "waiting_for_user"]);
const ACTIVE_RESOURCE_STATUSES = new Set<string>(SHELL_RUN_ACTIVE_STATUSES);

export async function hasRuntimeHostInterruptibleWork(
  client: RuntimeHostActivityClient,
): Promise<boolean> {
  const sessions = (await client.listSessions()).filter(
    (session) => !session.isArchived,
  );
  if (sessions.some((session) => ACTIVE_SESSION_STATUSES.has(session.status))) {
    return true;
  }

  const activity = await Promise.all(
    sessions.map(async (session) => {
      const [automations, resources] = await Promise.all([
        client.listAutomations(session.id),
        client.listRuntimeResources(session.id),
      ]);
      return (
        automations.some((automation) => automation.firePending) ||
        resources.some((resource) =>
          ACTIVE_RESOURCE_STATUSES.has(resource.result.status),
        )
      );
    }),
  );
  return activity.some(Boolean);
}
