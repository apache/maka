import type { ProjectSessionCatalog } from "./project-management-service.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

type RuntimeHostProjectClient = Pick<
  DesktopRuntimeHostClient,
  "listSessions" | "relocateSessionCwd" | "updateSessionMetadata"
>;

export function createRuntimeHostProjectSessionCatalog(
  client: RuntimeHostProjectClient,
): ProjectSessionCatalog {
  return {
    async listHeaders() {
      return (await client.listSessions()).map((session) => ({
        id: session.id,
        cwd: session.cwd,
        projectId: session.projectId,
      }));
    },

    async updateHeader(sessionId, patch) {
      if (patch.cwd !== undefined) {
        return client.relocateSessionCwd(sessionId, patch.cwd, patch.projectId);
      }
      if (patch.projectId !== undefined) {
        return client.updateSessionMetadata(sessionId, {
          projectId: patch.projectId,
        });
      }
      return undefined;
    },
  };
}
