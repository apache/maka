import type { Toolkit } from "../index";
import { WorkspaceService } from "./workspace";

export const marketplacePlugin = {
  id: "marketplace",
  apply(toolkit: Toolkit) {
    toolkit.seams.define("marketplace");
    toolkit.seams.provide("marketplace", new WorkspaceService());
  },
};
