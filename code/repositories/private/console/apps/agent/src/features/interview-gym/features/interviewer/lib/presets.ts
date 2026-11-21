import type { ProviderConfig } from "@ig/state/store";

export interface ProviderPreset {
  label: string;
  kind: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  viaProxy: boolean;
  keyHint?: string;
}

// 常见厂商预设；Key 由用户自己填，存浏览器 localStorage，不经任何服务器
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    label: "DeepSeek",
    kind: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    viaProxy: false,
  },
  {
    label: "OpenRouter（聚合）",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-4o-mini",
    viaProxy: false,
  },
  {
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    viaProxy: false,
  },
  {
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    viaProxy: false,
  },
  {
    label: "智谱 GLM",
    kind: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    viaProxy: true,
  },
  {
    label: "Kimi 月之暗面",
    kind: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    viaProxy: true,
  },
  {
    label: "硅基流动",
    kind: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    viaProxy: true,
  },
  {
    label: "Ollama（本地）",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3",
    viaProxy: false,
    keyHint: "本地模型无需 Key",
  },
];

export function presetToConfig(preset: ProviderPreset): ProviderConfig {
  return {
    id: crypto.randomUUID(),
    kind: preset.kind,
    label: preset.label,
    baseUrl: preset.baseUrl,
    apiKey: "",
    model: preset.model,
    viaProxy: preset.viaProxy,
  };
}
