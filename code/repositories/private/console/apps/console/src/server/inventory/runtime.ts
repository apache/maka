import { createToolkit, type Toolkit } from "@ggbdpq/inventory-core";
import { catalogPlugin } from "@ggbdpq/inventory-core";
import { marketplacePlugin } from "@ggbdpq/inventory-core";
import type { WorkspaceService } from "@ggbdpq/inventory-core";
import { pipelinePlugin } from "@ggbdpq/inventory-core";

// 库存台运行时单例：dev 热重载下挂在 globalThis 上防重复装配。
// 与原 API 行为一致：内存事件库 + fixture 插件全集。
interface InventoryRuntime {
  toolkit: Toolkit;
  workspace: WorkspaceService;
}

const g = globalThis as typeof globalThis & {
  __inventoryRuntime?: InventoryRuntime;
};

export function getInventoryRuntime(): InventoryRuntime {
  if (g.__inventoryRuntime) return g.__inventoryRuntime;
  const toolkit = createToolkit({ dbPath: ":memory:" });
  void marketplacePlugin.apply(toolkit);
  void catalogPlugin.apply(toolkit);
  void pipelinePlugin.apply(toolkit);
  const workspace = toolkit.seams.consume("marketplace") as WorkspaceService;
  g.__inventoryRuntime = { toolkit, workspace };
  return g.__inventoryRuntime;
}
