// pi-web-dev 教学核心迁入位：保持零依赖纯 JS（agent/cli/llm/tools/tui 五文件体系）。
// 豁免规则见仓库 AGENTS.md：禁止 TS 化、禁止加依赖、禁止改写风格。
export { runAgent, compactContext } from './agent.js';
export { main, getModel } from './cli.js';
export {
  contextToOpenAIMessages,
  stream,
  buildAssistantMessage,
  buildToolResultMessage,
} from './llm.js';
export { builtinTools } from './tools.js';
export { Tui } from './tui.js';
export * as vfs from './web-utils/vfs.js';
export { diffOps, diffHunks, diffToText } from './web-utils/diff.js';
export { EventPump, BREAKPOINT_TYPES } from './web-utils/pump.js';
export { parseDeclarations, locate } from './web-utils/source-locate.js';
export { TOUR_SECTIONS, DEMO_TASK } from './tour-data.js';
