/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import type { ProviderType } from '@maka/core/llm-connections';

import type { UiCatalog, UiLocale } from '@maka/core/ui-locale';

/**
 * Pure-data provider introduction copy, localized zh / en.
 *
 * No React / @maka/ui imports on purpose: the desktop main-process test
 * runner (node --test over dist/main) imports this module directly, so the
 * copy contract (provider-display-copy-contract.test.ts) asserts the real
 * data instead of regex-parsing TSX source.
 *
 * These stay in the display layer (not the registry) because they are
 * introduction prose tuned for the catalog, not the runtime provider facts.
 * Descriptions stay version-agnostic on purpose: they name the PROVIDER and
 * how you connect (official key / plan / protocol-compatible / gateway /
 * local), never a specific model generation — model names go stale (GPT-4o,
 * DeepSeek-V3, …) but the provider and access path do not. Brand names
 * (Anthropic, OpenAI, …) are never translated. Entries follow
 * CATALOG_PROVIDER_TYPES order, with the OAuth account providers at the end.
 *
 * Completeness is enforced at compile time: `satisfies Record<ProviderType,
 * …>` fails the build when a registered provider has no bilingual entry.
 */
export interface ProviderCopy {
  name: string;
  description: string;
  badge?: string;
}

export const UNKNOWN_PROVIDER_DESCRIPTION = {
  zh: '该 provider 在当前版本未注册。',
  en: 'This provider is not registered in the current build.',
} satisfies UiCatalog<string>;

export const PROVIDER_DISPLAY_COPY = {
  'kimi-coding-plan': {
    zh: { name: 'Kimi Coding Plan', description: '月之暗面 · Anthropic 兼容', badge: 'Coding' },
    en: { name: 'Kimi Coding Plan', description: 'Moonshot · Anthropic-compatible', badge: 'Coding' },
  },
  'minimax-coding-plan': {
    zh: { name: 'MiniMax Coding Plan', description: 'MiniMax Coding 套餐 · Anthropic 兼容', badge: 'Coding' },
    en: { name: 'MiniMax Coding Plan', description: 'MiniMax coding plan · Anthropic-compatible', badge: 'Coding' },
  },
  deepseek: {
    zh: { name: 'DeepSeek', description: 'DeepSeek 官方接入', badge: 'API' },
    en: { name: 'DeepSeek', description: 'Official DeepSeek API access.', badge: 'API' },
  },
  moonshot: {
    zh: { name: 'Moonshot', description: 'Moonshot 官方接入', badge: 'API' },
    en: { name: 'Moonshot', description: 'Official Moonshot API access.', badge: 'API' },
  },
  'zai-coding-plan': {
    zh: { name: 'Z.AI Coding Plan', description: '智谱 · OpenAI 兼容', badge: 'Coding' },
    en: { name: 'Z.AI Coding Plan', description: 'Zhipu · OpenAI-compatible', badge: 'Coding' },
  },
  MiniMax: {
    zh: { name: 'MiniMax', description: 'MiniMax · Anthropic 兼容', badge: 'API' },
    en: { name: 'MiniMax', description: 'MiniMax · Anthropic-compatible', badge: 'API' },
  },
  'MiniMax-cn': {
    zh: { name: 'MiniMax 中国站', description: 'MiniMax 中国站 · Anthropic 兼容', badge: 'API' },
    en: { name: 'MiniMax China', description: 'MiniMax China · Anthropic-compatible', badge: 'API' },
  },
  siliconflow: {
    zh: { name: 'SiliconFlow', description: '硅基流动多模型 API，支持精确模型 ID。', badge: '聚合' },
    en: { name: 'SiliconFlow', description: 'Hosted multi-model API with exact upstream model ids.', badge: 'Aggregator' },
  },
  anthropic: {
    zh: { name: 'Anthropic', description: 'Anthropic 官方接入', badge: 'API' },
    en: { name: 'Anthropic', description: 'Official Anthropic API access.', badge: 'API' },
  },
  openai: {
    zh: { name: 'OpenAI', description: 'OpenAI 官方接入', badge: 'API' },
    en: { name: 'OpenAI', description: 'Official OpenAI API access.', badge: 'API' },
  },
  google: {
    zh: { name: 'Google Gemini', description: 'Google AI Studio 接入', badge: 'API' },
    en: { name: 'Google Gemini', description: 'Google AI Studio API access.', badge: 'API' },
  },
  xai: {
    zh: { name: 'xAI', description: 'xAI 官方接入，Grok 系列模型', badge: 'API' },
    en: { name: 'xAI', description: 'Official xAI API access for Grok models.', badge: 'API' },
  },
  zai: {
    zh: { name: 'Z.AI', description: '智谱官方接入，GLM 系列模型', badge: 'API' },
    en: { name: 'Z.AI', description: 'Official Z.AI API access for GLM models.', badge: 'API' },
  },
  xiaomi: {
    zh: { name: 'Xiaomi', description: '小米官方接入，MiMo 系列模型', badge: 'API' },
    en: { name: 'Xiaomi', description: 'Official Xiaomi API access for MiMo models.', badge: 'API' },
  },
  'xiaomi-token-plan-cn': {
    zh: { name: 'Xiaomi Token Plan 中国', description: '小米 MiMo Token Plan 订阅 · 中国 · 编码工具', badge: 'Token' },
    en: { name: 'Xiaomi Token Plan (China)', description: 'Xiaomi MiMo Token Plan subscription (China) for coding tools.', badge: 'Token' },
  },
  'xiaomi-token-plan-sgp': {
    zh: { name: 'Xiaomi Token Plan 新加坡', description: '小米 MiMo Token Plan 订阅 · 新加坡 · 编码工具', badge: 'Token' },
    en: { name: 'Xiaomi Token Plan (Singapore)', description: 'Xiaomi MiMo Token Plan subscription (Singapore) for coding tools.', badge: 'Token' },
  },
  'xiaomi-token-plan-ams': {
    zh: { name: 'Xiaomi Token Plan 欧洲', description: '小米 MiMo Token Plan 订阅 · 欧洲 · 编码工具', badge: 'Token' },
    en: { name: 'Xiaomi Token Plan (Europe)', description: 'Xiaomi MiMo Token Plan subscription (Europe) for coding tools.', badge: 'Token' },
  },
  cerebras: {
    zh: { name: 'Cerebras', description: '高速推理托管开源模型', badge: 'API' },
    en: { name: 'Cerebras', description: 'Fast hosted open-model inference.', badge: 'API' },
  },
  mistral: {
    zh: { name: 'Mistral', description: 'Mistral 官方接入', badge: 'API' },
    en: { name: 'Mistral', description: 'Official Mistral API access.', badge: 'API' },
  },
  togetherai: {
    zh: { name: 'Together AI', description: '托管开源模型 API', badge: 'API' },
    en: { name: 'Together AI', description: 'Hosted open models over one API.', badge: 'API' },
  },
  ollama: {
    zh: { name: 'Ollama', description: '本机运行 · 离线可用', badge: 'Local' },
    en: { name: 'Ollama', description: 'Runs locally · works offline', badge: 'Local' },
  },
  'lm-studio': {
    zh: { name: 'LM Studio', description: '本机 LM Studio 服务 · 离线可用', badge: 'Local' },
    en: { name: 'LM Studio', description: 'Local models served by LM Studio.', badge: 'Local' },
  },
  localai: {
    zh: { name: 'LocalAI', description: '本机 LocalAI 服务，可选密钥保护', badge: 'Local' },
    en: { name: 'LocalAI', description: 'Local models served by LocalAI, with optional API key.', badge: 'Local' },
  },
  'openai-compatible': {
    zh: { name: '自定义中转站（OpenAI Chat）', description: 'OpenAI Chat Completions 兼容中转站、代理服务或自部署网关。', badge: '中转' },
    en: { name: 'Custom relay (OpenAI Chat)', description: 'OpenAI Chat Completions-compatible relay, proxy, or self-hosted gateway.', badge: 'Relay' },
  },
  'openai-responses-compatible': {
    zh: { name: '自定义中转站（OpenAI Responses）', description: 'OpenAI Responses API 兼容中转站、代理服务或自部署网关。', badge: 'Responses' },
    en: { name: 'Custom relay (OpenAI Responses)', description: 'OpenAI Responses-compatible relay, proxy, or self-hosted gateway.', badge: 'Responses' },
  },
  'anthropic-compatible': {
    zh: { name: '自定义中转站（Anthropic）', description: 'Anthropic Messages 兼容中转站、代理服务或自部署网关。', badge: 'Anthropic' },
    en: { name: 'Custom relay (Anthropic)', description: 'Anthropic Messages-compatible relay, proxy, or self-hosted gateway.', badge: 'Anthropic' },
  },
  'fireworks-ai': {
    zh: { name: 'Fireworks AI', description: 'Serverless 开源模型托管', badge: 'API' },
    en: { name: 'Fireworks AI', description: 'Serverless open models with exact Fireworks model paths.', badge: 'API' },
  },
  nvidia: {
    zh: { name: 'NVIDIA', description: 'NVIDIA 官方托管模型接入', badge: 'API' },
    en: { name: 'NVIDIA', description: 'NVIDIA-hosted models API access.', badge: 'API' },
  },
  'tencent-tokenhub': {
    zh: { name: 'Tencent TokenHub', description: '腾讯云 TokenHub 按量接入，混元等模型', badge: 'API' },
    en: { name: 'Tencent TokenHub', description: 'Tencent Cloud TokenHub pay-as-you-go access.', badge: 'API' },
  },
  stepfun: {
    zh: { name: 'StepFun 中国站', description: '阶跃星辰官方接入 · 中国站', badge: 'API' },
    en: { name: 'StepFun (China)', description: 'Official StepFun China API access.', badge: 'API' },
  },
  'tencent-coding-plan': {
    zh: { name: 'Tencent Coding Plan', description: '腾讯云 Coding 套餐 · OpenAI 兼容', badge: 'Coding' },
    en: { name: 'Tencent Coding Plan', description: 'Tencent Cloud coding plan · OpenAI-compatible', badge: 'Coding' },
  },
  'stepfun-ai': {
    zh: { name: 'StepFun 国际站', description: '阶跃星辰官方接入 · 国际站', badge: 'API' },
    en: { name: 'StepFun (Global)', description: 'Official StepFun Global API access.', badge: 'API' },
  },
  'volcengine-ark': {
    zh: { name: '火山方舟', description: '火山引擎官方接入，豆包等模型', badge: 'API' },
    en: { name: 'Volcengine Ark (China)', description: 'Volcengine Ark direct API access in China.', badge: 'API' },
  },
  'volcengine-coding-plan': {
    zh: { name: '火山方舟 Coding Plan', description: '火山引擎 Coding 订阅 · OpenAI 兼容', badge: 'Coding' },
    en: { name: 'Volcengine Ark Coding Plan (China)', description: 'Volcengine Ark coding subscription · OpenAI-compatible', badge: 'Coding' },
  },
  'volcengine-agent-plan': {
    zh: { name: '火山方舟 Agent Plan', description: '火山引擎 Agent 订阅 · Responses API', badge: 'Agent' },
    en: { name: 'Volcengine Ark Agent Plan (China)', description: 'Volcengine Ark agent subscription · Responses API', badge: 'Agent' },
  },
  'tencent-token-plan': {
    zh: { name: 'Tencent Token Plan', description: '腾讯云 Token 套餐，个人智能体与编码工具', badge: 'Token' },
    en: { name: 'Tencent Token Plan', description: 'Tencent Cloud token plan for personal agents and coding tools.', badge: 'Token' },
  },
  'stepfun-step-plan': {
    zh: { name: 'StepFun Step Plan 中国站', description: '阶跃星辰订阅套餐 · 中国站', badge: 'Plan' },
    en: { name: 'StepFun Step Plan (China)', description: 'StepFun China subscription for coding and agent tools.', badge: 'Plan' },
  },
  deepinfra: {
    zh: { name: 'DeepInfra', description: '开源模型托管推理 · OpenAI 兼容', badge: 'API' },
    en: { name: 'DeepInfra', description: 'Hosted open-model inference · OpenAI-compatible', badge: 'API' },
  },
  cohere: {
    zh: { name: 'Cohere', description: 'Cohere 官方接入', badge: 'API' },
    en: { name: 'Cohere', description: 'Official Cohere Chat API access.', badge: 'API' },
  },
  vercel: {
    zh: { name: 'Vercel AI Gateway', description: '一个密钥接入多家托管模型', badge: '网关' },
    en: { name: 'Vercel AI Gateway', description: 'One API key for hosted models with exact creator/model ids.', badge: 'Gateway' },
  },
  'stepfun-ai-step-plan': {
    zh: { name: 'StepFun Step Plan 国际站', description: '阶跃星辰订阅套餐 · 国际站', badge: 'Plan' },
    en: { name: 'StepFun Step Plan (Global)', description: 'StepFun Global subscription for coding and agent tools.', badge: 'Plan' },
  },
  'cloudflare-workers-ai': {
    zh: { name: 'Cloudflare Workers AI', description: 'Cloudflare 托管模型，账户级接入', badge: 'API' },
    en: { name: 'Cloudflare Workers AI', description: 'Cloudflare-hosted models over the account-scoped API.', badge: 'API' },
  },
  huggingface: {
    zh: { name: 'Hugging Face', description: 'Inference Providers 路由，聚合多家托管模型', badge: '路由' },
    en: { name: 'Hugging Face', description: 'Inference Providers router across hosted models.', badge: 'Router' },
  },
  'ollama-cloud': {
    zh: { name: 'Ollama Cloud', description: 'Ollama 官方云端托管模型', badge: 'API' },
    en: { name: 'Ollama Cloud', description: 'Ollama-hosted cloud models over the official remote API.', badge: 'API' },
  },
  zenmux: {
    zh: { name: 'ZenMux', description: '模型路由网关，一个密钥接入多家模型', badge: '网关' },
    en: { name: 'ZenMux', description: 'One API key for routed models with exact creator/model ids.', badge: 'Gateway' },
  },
  opencode: {
    zh: { name: 'OpenCode Zen', description: '面向编码智能体的按量模型精选', badge: 'Plan' },
    en: { name: 'OpenCode Zen', description: 'Curated pay-as-you-go models for coding agents.', badge: 'Plan' },
  },
  'opencode-go': {
    zh: { name: 'OpenCode Go', description: '低价订阅制的开源编码模型精选', badge: 'Plan' },
    en: { name: 'OpenCode Go', description: 'Low-cost subscription to curated open coding models.', badge: 'Plan' },
  },
  'opencode-free': {
    zh: { name: 'OpenCode Free', description: '免费匿名 OpenCode Zen 模型，无需密钥，按 IP 限速', badge: 'Free' },
    en: { name: 'OpenCode Free', description: 'Free anonymous OpenCode Zen models — no API key, IP-limited.', badge: 'Free' },
  },
  groq: {
    zh: { name: 'Groq', description: 'LPU 高速推理托管开源模型', badge: 'API' },
    en: { name: 'Groq', description: 'Ultra-fast LPU-hosted open models.', badge: 'API' },
  },
  openrouter: {
    zh: { name: 'OpenRouter', description: '一个密钥接入各大模型厂商 · OpenAI 兼容', badge: '聚合' },
    en: { name: 'OpenRouter', description: 'One API key across all major model labs · OpenAI-compatible', badge: 'Aggregator' },
  },
  alibaba: {
    zh: { name: 'Alibaba', description: '阿里云百炼接入，通义千问 Qwen 模型', badge: 'API' },
    en: { name: 'Alibaba', description: 'Alibaba Cloud API access for Qwen models.', badge: 'API' },
  },
  'alibaba-coding-plan-cn': {
    zh: { name: 'Alibaba Coding Plan 中国站', description: '阿里云百炼 Coding Plan 订阅 · 中国站', badge: 'Plan' },
    en: { name: 'Alibaba Coding Plan (China)', description: 'Alibaba Cloud Model Studio Coding Plan for interactive coding tools · China.', badge: 'Plan' },
  },
  'alibaba-coding-plan': {
    zh: { name: 'Alibaba Coding Plan 国际站', description: '阿里云百炼 Coding Plan 订阅 · 国际站', badge: 'Plan' },
    en: { name: 'Alibaba Coding Plan', description: 'Alibaba Cloud Model Studio Coding Plan for interactive coding tools.', badge: 'Plan' },
  },
  'alibaba-token-plan-cn': {
    zh: { name: 'Alibaba Token Plan（团队版）', description: '阿里云百炼 Token Plan 订阅，交互式智能体与编码工具 · 北京', badge: 'Token' },
    en: { name: 'Alibaba Token Plan (China)', description: 'Alibaba Cloud Model Studio Token Plan for interactive agents and coding tools, Beijing region.', badge: 'Token' },
  },
  'alibaba-token-plan': {
    zh: { name: 'Alibaba Token Plan（团队版）', description: '阿里云百炼 Token Plan 订阅，交互式智能体与编码工具 · 新加坡', badge: 'Token' },
    en: { name: 'Alibaba Token Plan', description: 'Alibaba Cloud Model Studio Token Plan for interactive agents and coding tools, Singapore region.', badge: 'Token' },
  },
  // OAuth account providers (not in CATALOG_PROVIDER_TYPES; shown in the
  // accounts section and on connection rows).
  'github-copilot': {
    zh: { name: 'GitHub Copilot', description: 'GitHub Copilot 订阅接入，复用本机 GitHub 登录', badge: 'Account' },
    en: { name: 'GitHub Copilot', description: 'GitHub Copilot subscription access using an existing GitHub login.', badge: 'Account' },
  },
  'claude-subscription': {
    zh: { name: 'Claude Subscription', description: 'Claude Pro / Max 订阅账号登录；登录后自动成为可用模型连接。' },
    en: { name: 'Claude Subscription', description: 'Sign in with a Claude Pro / Max subscription; it becomes an available model connection once signed in.' },
  },
  'openai-codex': {
    zh: { name: 'OpenAI OAuth', description: 'ChatGPT / Codex 账号登录；登录后自动成为可用模型连接。' },
    en: { name: 'OpenAI OAuth', description: 'Sign in with a ChatGPT / Codex account; it becomes an available model connection once signed in.' },
  },
  'xai-oauth': {
    zh: { name: 'xAI OAuth', description: '使用 SuperGrok 或 X Premium 账号登录。', badge: 'Account' },
    en: { name: 'xAI OAuth', description: 'Sign in with SuperGrok or X Premium.', badge: 'Account' },
  },
} satisfies Record<ProviderType, UiCatalog<ProviderCopy>>;

export function providerDisplay(type: ProviderType, locale: UiLocale): ProviderCopy {
  const copy = (PROVIDER_DISPLAY_COPY as Partial<Record<string, UiCatalog<ProviderCopy>>>)[type]?.[locale];
  return copy ?? { name: type, description: UNKNOWN_PROVIDER_DESCRIPTION[locale] };
}
