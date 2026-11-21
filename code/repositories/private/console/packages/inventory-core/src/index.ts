export { createToolkit, type Toolkit, type ToolkitOptions } from "./context";
export { createEventLog, type EventLog, type ToolkitEvent } from "./events";
export { createJobPipeline, type JobPipeline, type JobRunResult, type JobTool } from "./jobs";
export { applyOverlay, loadOverlayFiles, type OverlayFile, type OverlayRow } from "./overlay";
export { createPluginRegistry, type Plugin } from "./plugin";
export { createSeamRegistry, type SeamRegistry } from "./seams";

// —— 领域插件与类型（API 与 CLI 的公共入口，禁止深路径 import src/*）——
export * from "./catalog/plugin";
export * from "./catalog/fixture-repository";
export * from "./catalog/types";
export * from "./marketplace/plugin";
export * from "./marketplace/workspace";
export * from "./pipeline/plugin";
export * from "./pipeline/replenish";
export * from "./mail";
