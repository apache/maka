// 示例数据（mock 模式）。模型名只是演示，不代表供应商当前真实型号。
import type { AgentIntegration, Provider, RouteGroup } from "./contracts";

export const providers: Provider[] = [
  { id: "qoder", kind: "qoder-gateway", label: "Qoder", models: ["auto", "performance", "ultimate", "lite"], capabilities: { tools: true, vision: true, thinking: true }, enabled: true },
  { id: "deepseek", kind: "openai-compatible", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyHint: "1a2b", models: ["deepseek-v4-pro", "deepseek-v4-flash"], capabilities: { tools: true, vision: false, thinking: true }, enabled: true },
  { id: "kimi", kind: "openai-compatible", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1", keyHint: "9f0c", models: ["kimi-k2.6", "kimi-k2.6-turbo"], capabilities: { tools: true, vision: true, thinking: true }, enabled: true },
  { id: "glm", kind: "openai-compatible", label: "GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", keyHint: "77de", models: ["glm-5.1", "glm-5.1-air"], capabilities: { tools: true, vision: false, thinking: true }, enabled: true },
  { id: "qwen", kind: "openai-compatible", label: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyHint: "c3e1", models: ["qwen3.6-coder-plus"], capabilities: { tools: true, vision: false, thinking: false }, enabled: false },
];

export const groups: RouteGroup[] = [
  { id: "daily-coding", name: "Daily coding", strategy: "smart", enabled: true, members: [{ providerId: "qoder", model: "auto" }, { providerId: "deepseek", model: "deepseek-v4-pro" }, { providerId: "glm", model: "glm-5.1" }] },
  { id: "cheap-and-fast", name: "Cheap and fast", strategy: "ordered", enabled: true, members: [{ providerId: "deepseek", model: "deepseek-v4-flash" }, { providerId: "glm", model: "glm-5.1-air" }, { providerId: "kimi", model: "kimi-k2.6-turbo" }] },
  { id: "long-context", name: "Long context", strategy: "smart", enabled: true, members: [{ providerId: "deepseek", model: "deepseek-v4-pro" }, { providerId: "glm", model: "glm-5.1" }, { providerId: "kimi", model: "kimi-k2.6" }] },
];

export const agents: AgentIntegration[] = [
  { id: "claude-code", name: "Claude Code", detected: true, connected: true, configPath: "~/.claude/settings.json", backupPath: "~/.qoder-proxy-api/backups/claude-settings.20260518-0932.json", model: "group/long-context", note: "env.ANTHROPIC_BASE_URL → 本网关 /v1/messages" },
  { id: "codex", name: "Codex", detected: true, connected: true, configPath: "~/.codex/config.toml", backupPath: "~/.qoder-proxy-api/backups/codex-config.20260518-0932.toml", model: "group/long-context", note: "model_provider = qoder-proxy（Responses API）" },
  { id: "opencode", name: "OpenCode", detected: true, connected: true, configPath: "~/.config/opencode/opencode.json", backupPath: null, model: "group/long-context", note: "provider.qoder-proxy（OpenAI 兼容）" },
];

export const plans = [
  { id: "budget", name: "Budget", mapping: { "claude-code": "group/cheap-and-fast", codex: "group/cheap-and-fast", opencode: "deepseek/deepseek-v4-flash" } },
  { id: "focus", name: "Focus", mapping: { "claude-code": "group/long-context", codex: "group/long-context", opencode: "group/long-context" } },
];

export const agentColor: Record<string, string> = {
  "claude-code": "var(--a-claude)",
  codex: "var(--a-codex)",
  opencode: "var(--a-opencode)",
};
export const agentName: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };
