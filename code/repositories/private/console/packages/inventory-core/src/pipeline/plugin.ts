import type { Toolkit } from "../index";
import { createFixtureMailProvider, defaultFixtureInbox } from "../mail";
import { WorkspaceService } from "../marketplace/workspace";
import { executeReplenish } from "./replenish";

type ReplayInput = {
  jobs?: Array<{ type: string; payload: unknown }>;
};

type ImportInput = {
  items?: Array<{ id: string; account: string; plan: string; priceCents?: number }>;
};

export const DEFAULT_AUTHORIZED_IMPORT_ITEMS = [
  {
    id: "inv-imported-1",
    account: "local.import@example.com",
    plan: "Plus",
    priceCents: 1400,
  },
];

export const pipelinePlugin = {
  id: "pipeline",
  apply(toolkit: Toolkit) {
    toolkit.jobs.register({
      name: "replay",
      execute: (input: unknown) => {
        const payload = (input ?? {}) as ReplayInput;
        const jobs = payload.jobs ?? [];
        for (const job of jobs) {
          toolkit.events.append({ type: job.type, payload: job.payload });
        }
        return { replayed: jobs.length };
      },
    });
    toolkit.jobs.register({
      name: "authorized-import",
      execute: (input: unknown) => {
        const payload = (input ?? {}) as ImportInput;
        const items = payload.items?.length ? payload.items : DEFAULT_AUTHORIZED_IMPORT_ITEMS;
        const workspace = toolkit.seams.consume("marketplace") as WorkspaceService;
        const imported = workspace.importAuthorized(items);
        toolkit.events.append({
          type: "inventory.imported",
          payload: { count: imported.length, items: imported },
        });
        return { imported: imported.length, items: imported };
      },
    });
    toolkit.jobs.register({
      name: "replenish",
      execute: () => executeReplenish(toolkit),
    });
    toolkit.jobs.register({
      name: "mail-inbox",
      execute: async () => {
        const provider = createFixtureMailProvider(defaultFixtureInbox());
        await provider.connect({ kind: "fixture", mailbox: "inbox@example.com" });
        const listed = await provider.listMessages();
        for (const message of listed.messages) {
          toolkit.events.append({ type: "mail.received", payload: message });
        }
        return listed;
      },
    });
  },
};
