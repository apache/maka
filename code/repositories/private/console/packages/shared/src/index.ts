// 跨前后端的共享 Zod schema 单一事实源。
// 各域 schema 随模块迁移分文件加入：assets.ts / inventory.ts / agentops.ts / governance.ts。
export * from "./health";
export * from "./assets/domain";
export * from "./assets/parsers";
export * from "./agentops";
export * from "./governance";
export * from "./practice";
// todo 域与 agentops 存在 ApiError 等同名导出，走子路径导入：@ggbdpq/console-shared/todo
