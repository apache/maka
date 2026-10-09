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

//! A provider's name and its line of description in the provider catalog,
//! in every locale, by `providerType`: Maka Desktop's `PROVIDER_DISPLAY_COPY`
//! (apps/desktop/src/renderer/settings/provider-display-copy.ts), which
//! names providers by brand and describes how one connects to them.
//! Generated from that table at compatibility epoch 197, with the account
//! sign-ins' names from `modelOAuthCards` (provider-oauth-section.tsx).
//!
//! Brand names read the same in every language, so these are not part of
//! the copy table's translation test; [`tests`] checks them instead.

use super::{Locale, Text};

/// One provider's catalog copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct ProviderCopy {
    pub name: Text,
    pub description: Text,
}

/// The copy of the provider `provider_type`, when Desktop has it.
pub fn provider_copy(provider_type: &str) -> Option<&'static ProviderCopy> {
    PROVIDERS.iter().find(|(key, _)| *key == provider_type).map(|(_, copy)| copy)
}

/// The provider's name in `locale`: Desktop's, else the `providerType`
/// itself (a provider this build does not know).
pub fn provider_name(locale: Locale, provider_type: &str) -> &str {
    provider_copy(provider_type).map_or(provider_type, |copy| copy.name.in_locale(locale))
}

/// The provider's description in `locale`.
pub fn provider_description(locale: Locale, provider_type: &str) -> &'static str {
    provider_copy(provider_type)
        .map_or(UNKNOWN_PROVIDER.in_locale(locale), |copy| copy.description.in_locale(locale))
}

/// `UNKNOWN_PROVIDER_DESCRIPTION`.
pub const UNKNOWN_PROVIDER: Text = Text::new(
    "This provider is not registered in the current build.",
    "该 provider 在当前版本未注册。",
    "該 provider 在目前版本未註冊。",
);

/// The account sign-ins the catalog lists first, by the `providerType` of
/// the connection each creates, with Desktop's card names (brands).
pub const ACCOUNT_CARDS: [(&str, &str); 3] = [
    ("openai-codex", "OpenAI Codex"),
    ("github-copilot", "GitHub Copilot"),
    ("xai-oauth", "xAI Grok"),
];

/// Every provider's copy, by `providerType`, in the catalog's order.
pub const PROVIDERS: &[(&str, ProviderCopy)] = &[
    (
        "kimi-coding-plan",
        ProviderCopy {
            name: Text::new("Kimi Coding Plan", "Kimi Coding Plan", "Kimi Coding Plan"),
            description: Text::new(
                "Moonshot · Anthropic-compatible",
                "月之暗面 · Anthropic 兼容",
                "月之暗面 · Anthropic 相容",
            ),
        },
    ),
    (
        "minimax-coding-plan",
        ProviderCopy {
            name: Text::new("MiniMax Coding Plan", "MiniMax Coding Plan", "MiniMax Coding Plan"),
            description: Text::new(
                "MiniMax coding plan · Anthropic-compatible",
                "MiniMax Coding 套餐 · Anthropic 兼容",
                "MiniMax Coding 套餐 · Anthropic 相容",
            ),
        },
    ),
    (
        "deepseek",
        ProviderCopy {
            name: Text::new("DeepSeek", "DeepSeek", "DeepSeek"),
            description: Text::new(
                "Official DeepSeek API access.",
                "DeepSeek 官方接入",
                "DeepSeek 官方 API 連線",
            ),
        },
    ),
    (
        "moonshot",
        ProviderCopy {
            name: Text::new("Moonshot", "Moonshot", "Moonshot"),
            description: Text::new(
                "Official Moonshot API access.",
                "Moonshot 官方接入",
                "Moonshot 官方 API 連線",
            ),
        },
    ),
    (
        "moonshot-global",
        ProviderCopy {
            name: Text::new("Moonshot Global", "Moonshot 国际版", "Moonshot 國際版"),
            description: Text::new(
                "Official Moonshot international API access.",
                "Moonshot 国际版官方 API 接入",
                "Moonshot 國際版官方 API 連線",
            ),
        },
    ),
    (
        "zai-coding-plan",
        ProviderCopy {
            name: Text::new("Z.AI Coding Plan", "Z.AI Coding Plan", "Z.AI Coding Plan"),
            description: Text::new(
                "Zhipu · OpenAI-compatible",
                "智谱 · OpenAI 兼容",
                "智譜 · OpenAI 相容",
            ),
        },
    ),
    (
        "MiniMax",
        ProviderCopy {
            name: Text::new("MiniMax", "MiniMax", "MiniMax"),
            description: Text::new(
                "MiniMax · Anthropic-compatible",
                "MiniMax · Anthropic 兼容",
                "MiniMax · Anthropic 相容",
            ),
        },
    ),
    (
        "MiniMax-cn",
        ProviderCopy {
            name: Text::new("MiniMax China", "MiniMax 中国站", "MiniMax 中國站"),
            description: Text::new(
                "MiniMax China · Anthropic-compatible",
                "MiniMax 中国站 · Anthropic 兼容",
                "MiniMax 中國站 · Anthropic 相容",
            ),
        },
    ),
    (
        "siliconflow",
        ProviderCopy {
            name: Text::new("SiliconFlow", "SiliconFlow", "SiliconFlow"),
            description: Text::new(
                "Hosted multi-model API with exact upstream model ids.",
                "硅基流动多模型 API，支持精确模型 ID。",
                "矽基流動多模型 API，支援精確模型 ID。",
            ),
        },
    ),
    (
        "anthropic",
        ProviderCopy {
            name: Text::new("Anthropic", "Anthropic", "Anthropic"),
            description: Text::new(
                "Official Anthropic API access.",
                "Anthropic 官方接入",
                "Anthropic 官方 API 連線",
            ),
        },
    ),
    (
        "openai",
        ProviderCopy {
            name: Text::new("OpenAI", "OpenAI", "OpenAI"),
            description: Text::new(
                "Official OpenAI API access.",
                "OpenAI 官方接入",
                "OpenAI 官方 API 連線",
            ),
        },
    ),
    (
        "google",
        ProviderCopy {
            name: Text::new("Google Gemini", "Google Gemini", "Google Gemini"),
            description: Text::new(
                "Google AI Studio API access.",
                "Google AI Studio 接入",
                "Google AI Studio API 連線",
            ),
        },
    ),
    (
        "xai",
        ProviderCopy {
            name: Text::new("xAI", "xAI", "xAI"),
            description: Text::new(
                "Official xAI API access for Grok models.",
                "xAI 官方接入，Grok 系列模型",
                "xAI 官方 API 連線，支援 Grok 系列模型",
            ),
        },
    ),
    (
        "zai",
        ProviderCopy {
            name: Text::new("Z.AI", "Z.AI", "Z.AI"),
            description: Text::new(
                "Official Z.AI API access for GLM models.",
                "智谱官方接入，GLM 系列模型",
                "智譜官方 API 連線，支援 GLM 系列模型",
            ),
        },
    ),
    (
        "xiaomi",
        ProviderCopy {
            name: Text::new("Xiaomi", "Xiaomi", "Xiaomi"),
            description: Text::new(
                "Official Xiaomi API access for MiMo models.",
                "小米官方接入，MiMo 系列模型",
                "小米官方 API 連線，支援 MiMo 系列模型",
            ),
        },
    ),
    (
        "xiaomi-token-plan-cn",
        ProviderCopy {
            name: Text::new(
                "Xiaomi Token Plan (China)",
                "Xiaomi Token Plan 中国",
                "Xiaomi Token Plan 中國",
            ),
            description: Text::new(
                "Xiaomi MiMo Token Plan subscription (China) for coding tools.",
                "小米 MiMo Token Plan 订阅 · 中国 · 编码工具",
                "小米 MiMo Token Plan 訂閱 · 中國 · 編碼工具",
            ),
        },
    ),
    (
        "xiaomi-token-plan-sgp",
        ProviderCopy {
            name: Text::new(
                "Xiaomi Token Plan (Singapore)",
                "Xiaomi Token Plan 新加坡",
                "Xiaomi Token Plan 新加坡",
            ),
            description: Text::new(
                "Xiaomi MiMo Token Plan subscription (Singapore) for coding tools.",
                "小米 MiMo Token Plan 订阅 · 新加坡 · 编码工具",
                "小米 MiMo Token Plan 訂閱 · 新加坡 · 編碼工具",
            ),
        },
    ),
    (
        "xiaomi-token-plan-ams",
        ProviderCopy {
            name: Text::new(
                "Xiaomi Token Plan (Europe)",
                "Xiaomi Token Plan 欧洲",
                "Xiaomi Token Plan 歐洲",
            ),
            description: Text::new(
                "Xiaomi MiMo Token Plan subscription (Europe) for coding tools.",
                "小米 MiMo Token Plan 订阅 · 欧洲 · 编码工具",
                "小米 MiMo Token Plan 訂閱 · 歐洲 · 編碼工具",
            ),
        },
    ),
    (
        "cerebras",
        ProviderCopy {
            name: Text::new("Cerebras", "Cerebras", "Cerebras"),
            description: Text::new(
                "Fast hosted open-model inference.",
                "高速推理托管开源模型",
                "高速推理託管開源模型",
            ),
        },
    ),
    (
        "mistral",
        ProviderCopy {
            name: Text::new("Mistral", "Mistral", "Mistral"),
            description: Text::new(
                "Official Mistral API access.",
                "Mistral 官方接入",
                "Mistral 官方 API 連線",
            ),
        },
    ),
    (
        "togetherai",
        ProviderCopy {
            name: Text::new("Together AI", "Together AI", "Together AI"),
            description: Text::new(
                "Hosted open models over one API.",
                "托管开源模型 API",
                "託管開源模型 API",
            ),
        },
    ),
    (
        "ollama",
        ProviderCopy {
            name: Text::new("Ollama", "Ollama", "Ollama"),
            description: Text::new(
                "Runs locally · works offline",
                "本机运行 · 离线可用",
                "本機執行 · 離線可用",
            ),
        },
    ),
    (
        "lm-studio",
        ProviderCopy {
            name: Text::new("LM Studio", "LM Studio", "LM Studio"),
            description: Text::new(
                "Local models served by LM Studio.",
                "本机 LM Studio 服务 · 离线可用",
                "本機 LM Studio 服務 · 離線可用",
            ),
        },
    ),
    (
        "localai",
        ProviderCopy {
            name: Text::new("LocalAI", "LocalAI", "LocalAI"),
            description: Text::new(
                "Local models served by LocalAI, with optional API key.",
                "本机 LocalAI 服务，可选密钥保护",
                "本機 LocalAI 服務，可選金鑰保護",
            ),
        },
    ),
    (
        "custom",
        ProviderCopy {
            name: Text::new("Custom connection", "自定义连接", "自訂連線"),
            description: Text::new(
                "Relay, proxy, or self-hosted gateway speaking OpenAI Chat, OpenAI Responses, or Anthropic Messages, chosen per model.",
                "中转站、代理服务或自部署网关，支持 OpenAI Chat、OpenAI Responses 和 Anthropic Messages，可按模型选择协议。",
                "中轉站、代理服務或自部署閘道器，支援 OpenAI Chat、OpenAI Responses 和 Anthropic Messages，可依模型選擇協定。",
            ),
        },
    ),
    (
        "fireworks-ai",
        ProviderCopy {
            name: Text::new("Fireworks AI", "Fireworks AI", "Fireworks AI"),
            description: Text::new(
                "Serverless open models with exact Fireworks model paths.",
                "Serverless 开源模型托管",
                "Serverless 開源模型託管",
            ),
        },
    ),
    (
        "nvidia",
        ProviderCopy {
            name: Text::new("NVIDIA", "NVIDIA", "NVIDIA"),
            description: Text::new(
                "NVIDIA-hosted models API access.",
                "NVIDIA 官方托管模型接入",
                "NVIDIA 官方託管模型服務",
            ),
        },
    ),
    (
        "tencent-tokenhub",
        ProviderCopy {
            name: Text::new("Tencent TokenHub", "Tencent TokenHub", "Tencent TokenHub"),
            description: Text::new(
                "Tencent Cloud TokenHub pay-as-you-go access.",
                "腾讯云 TokenHub 按量接入，混元等模型",
                "騰訊雲 TokenHub 按量計費模型服務，包含混元等模型",
            ),
        },
    ),
    (
        "stepfun",
        ProviderCopy {
            name: Text::new("StepFun (China)", "StepFun 中国站", "StepFun 中國站"),
            description: Text::new(
                "Official StepFun China API access.",
                "阶跃星辰官方接入 · 中国站",
                "階躍星辰官方 API 連線 · 中國站",
            ),
        },
    ),
    (
        "tencent-coding-plan",
        ProviderCopy {
            name: Text::new("Tencent Coding Plan", "Tencent Coding Plan", "Tencent Coding Plan"),
            description: Text::new(
                "Tencent Cloud coding plan · OpenAI-compatible",
                "腾讯云 Coding 套餐 · OpenAI 兼容",
                "騰訊雲 Coding 套餐 · OpenAI 相容",
            ),
        },
    ),
    (
        "stepfun-ai",
        ProviderCopy {
            name: Text::new("StepFun (Global)", "StepFun 国际站", "StepFun 國際站"),
            description: Text::new(
                "Official StepFun Global API access.",
                "阶跃星辰官方接入 · 国际站",
                "階躍星辰官方 API 連線 · 國際站",
            ),
        },
    ),
    (
        "volcengine-ark",
        ProviderCopy {
            name: Text::new("Volcengine Ark (China)", "火山方舟", "火山方舟"),
            description: Text::new(
                "Volcengine Ark direct API access in China.",
                "火山引擎官方接入，豆包等模型",
                "火山引擎官方 API 連線，包含豆包等模型",
            ),
        },
    ),
    (
        "volcengine-coding-plan",
        ProviderCopy {
            name: Text::new(
                "Volcengine Ark Coding Plan (China)",
                "火山方舟 Coding Plan",
                "火山方舟 Coding Plan",
            ),
            description: Text::new(
                "Volcengine Ark coding subscription · OpenAI-compatible",
                "火山引擎 Coding 订阅 · OpenAI 兼容",
                "火山引擎 Coding 訂閱 · OpenAI 相容",
            ),
        },
    ),
    (
        "volcengine-agent-plan",
        ProviderCopy {
            name: Text::new(
                "Volcengine Ark Agent Plan (China)",
                "火山方舟 Agent Plan",
                "火山方舟 Agent Plan",
            ),
            description: Text::new(
                "Volcengine Ark agent subscription · Responses API",
                "火山引擎 Agent 订阅 · Responses API",
                "火山引擎 Agent 訂閱 · Responses API",
            ),
        },
    ),
    (
        "tencent-token-plan",
        ProviderCopy {
            name: Text::new("Tencent Token Plan", "Tencent Token Plan", "Tencent Token Plan"),
            description: Text::new(
                "Tencent Cloud token plan for personal agents and coding tools.",
                "腾讯云 Token 套餐，个人智能体与编码工具",
                "騰訊雲 Token 套餐，個人智慧體與編碼工具",
            ),
        },
    ),
    (
        "stepfun-step-plan",
        ProviderCopy {
            name: Text::new(
                "StepFun Step Plan (China)",
                "StepFun Step Plan 中国站",
                "StepFun Step Plan 中國站",
            ),
            description: Text::new(
                "StepFun China subscription for coding and agent tools.",
                "阶跃星辰订阅套餐 · 中国站",
                "階躍星辰訂閱套餐 · 中國站",
            ),
        },
    ),
    (
        "deepinfra",
        ProviderCopy {
            name: Text::new("DeepInfra", "DeepInfra", "DeepInfra"),
            description: Text::new(
                "Hosted open-model inference · OpenAI-compatible",
                "开源模型托管推理 · OpenAI 兼容",
                "開源模型託管推理 · OpenAI 相容",
            ),
        },
    ),
    (
        "cohere",
        ProviderCopy {
            name: Text::new("Cohere", "Cohere", "Cohere"),
            description: Text::new(
                "Official Cohere Chat API access.",
                "Cohere 官方接入",
                "Cohere 官方 API 連線",
            ),
        },
    ),
    (
        "vercel",
        ProviderCopy {
            name: Text::new("Vercel AI Gateway", "Vercel AI Gateway", "Vercel AI Gateway"),
            description: Text::new(
                "One API key for hosted models with exact creator/model ids.",
                "一个密钥接入多家托管模型",
                "使用一組金鑰連線多家託管模型",
            ),
        },
    ),
    (
        "stepfun-ai-step-plan",
        ProviderCopy {
            name: Text::new(
                "StepFun Step Plan (Global)",
                "StepFun Step Plan 国际站",
                "StepFun Step Plan 國際站",
            ),
            description: Text::new(
                "StepFun Global subscription for coding and agent tools.",
                "阶跃星辰订阅套餐 · 国际站",
                "階躍星辰訂閱套餐 · 國際站",
            ),
        },
    ),
    (
        "cloudflare-workers-ai",
        ProviderCopy {
            name: Text::new(
                "Cloudflare Workers AI",
                "Cloudflare Workers AI",
                "Cloudflare Workers AI",
            ),
            description: Text::new(
                "Cloudflare-hosted models over the account-scoped API.",
                "Cloudflare 托管模型，账户级接入",
                "Cloudflare 託管模型，使用帳號層級連線",
            ),
        },
    ),
    (
        "huggingface",
        ProviderCopy {
            name: Text::new("Hugging Face", "Hugging Face", "Hugging Face"),
            description: Text::new(
                "Inference Providers router across hosted models.",
                "Inference Providers 路由，聚合多家托管模型",
                "Inference Providers 路由，聚合多家託管模型",
            ),
        },
    ),
    (
        "ollama-cloud",
        ProviderCopy {
            name: Text::new("Ollama Cloud", "Ollama Cloud", "Ollama Cloud"),
            description: Text::new(
                "Ollama-hosted cloud models over the official remote API.",
                "Ollama 官方云端托管模型",
                "Ollama 官方雲端託管模型",
            ),
        },
    ),
    (
        "zenmux",
        ProviderCopy {
            name: Text::new("ZenMux", "ZenMux", "ZenMux"),
            description: Text::new(
                "One API key for routed models with exact creator/model ids.",
                "模型路由网关，一个密钥接入多家模型",
                "模型路由閘道器，使用一組金鑰連線多家模型",
            ),
        },
    ),
    (
        "opencode",
        ProviderCopy {
            name: Text::new("OpenCode Zen", "OpenCode Zen", "OpenCode Zen"),
            description: Text::new(
                "Curated pay-as-you-go models for coding agents.",
                "面向编码智能体的按量模型精选",
                "面向編碼智慧體的按量模型精選",
            ),
        },
    ),
    (
        "opencode-go",
        ProviderCopy {
            name: Text::new("OpenCode Go", "OpenCode Go", "OpenCode Go"),
            description: Text::new(
                "Low-cost subscription to curated open coding models.",
                "低价订阅制的开源编码模型精选",
                "低價訂閱制的開源編碼模型精選",
            ),
        },
    ),
    (
        "groq",
        ProviderCopy {
            name: Text::new("Groq", "Groq", "Groq"),
            description: Text::new(
                "Ultra-fast LPU-hosted open models.",
                "LPU 高速推理托管开源模型",
                "LPU 高速推理託管開源模型",
            ),
        },
    ),
    (
        "openrouter",
        ProviderCopy {
            name: Text::new("OpenRouter", "OpenRouter", "OpenRouter"),
            description: Text::new(
                "One API key across all major model labs · OpenAI-compatible",
                "一个密钥接入各大模型厂商 · OpenAI 兼容",
                "使用一組金鑰連線各大模型廠商 · OpenAI 相容",
            ),
        },
    ),
    (
        "alibaba",
        ProviderCopy {
            name: Text::new("Alibaba", "Alibaba", "Alibaba"),
            description: Text::new(
                "Alibaba Cloud API access for Qwen models.",
                "阿里云百炼接入，通义千问 Qwen 模型",
                "阿里雲百鍊 API 連線，支援通義千問 Qwen 模型",
            ),
        },
    ),
    (
        "alibaba-cn",
        ProviderCopy {
            name: Text::new("Alibaba (China)", "Alibaba 中国站", "Alibaba 中國站"),
            description: Text::new(
                "Alibaba Cloud China-platform API access for Qwen models.",
                "阿里云百炼中国站接入，通义千问 Qwen 模型",
                "阿里雲百鍊中國站 API 連線，支援通義千問 Qwen 模型",
            ),
        },
    ),
    (
        "alibaba-coding-plan-cn",
        ProviderCopy {
            name: Text::new(
                "Alibaba Coding Plan (China)",
                "Alibaba Coding Plan 中国站",
                "Alibaba Coding Plan 中國站",
            ),
            description: Text::new(
                "Alibaba Cloud Model Studio Coding Plan for interactive coding tools · China.",
                "阿里云百炼 Coding Plan 订阅 · 中国站",
                "阿里雲百鍊 Coding Plan 訂閱 · 中國站",
            ),
        },
    ),
    (
        "alibaba-coding-plan",
        ProviderCopy {
            name: Text::new(
                "Alibaba Coding Plan",
                "Alibaba Coding Plan 国际站",
                "Alibaba Coding Plan 國際站",
            ),
            description: Text::new(
                "Alibaba Cloud Model Studio Coding Plan for interactive coding tools.",
                "阿里云百炼 Coding Plan 订阅 · 国际站",
                "阿里雲百鍊 Coding Plan 訂閱 · 國際站",
            ),
        },
    ),
    (
        "alibaba-token-plan-cn",
        ProviderCopy {
            name: Text::new(
                "Alibaba Token Plan (China)",
                "Alibaba Token Plan（团队版）",
                "Alibaba Token Plan（團隊版）",
            ),
            description: Text::new(
                "Alibaba Cloud Model Studio Token Plan for interactive agents and coding tools, Beijing region.",
                "阿里云百炼 Token Plan 订阅，交互式智能体与编码工具 · 北京",
                "阿里雲百鍊 Token Plan 訂閱，互動式智慧體與編碼工具 · 北京",
            ),
        },
    ),
    (
        "alibaba-token-plan",
        ProviderCopy {
            name: Text::new(
                "Alibaba Token Plan",
                "Alibaba Token Plan（团队版）",
                "Alibaba Token Plan（團隊版）",
            ),
            description: Text::new(
                "Alibaba Cloud Model Studio Token Plan for interactive agents and coding tools, Singapore region.",
                "阿里云百炼 Token Plan 订阅，交互式智能体与编码工具 · 新加坡",
                "阿里雲百鍊 Token Plan 訂閱，互動式智慧體與編碼工具 · 新加坡",
            ),
        },
    ),
    (
        "commandcode",
        ProviderCopy {
            name: Text::new("Command Code", "Command Code", "Command Code"),
            description: Text::new(
                "Use your Command Code plan credits. Models are fetched when you connect.",
                "使用 Command Code 套餐额度，连接后自动获取模型。",
                "使用 Command Code 方案額度，連線後自動取得模型。",
            ),
        },
    ),
    (
        "xai-oauth",
        ProviderCopy {
            name: Text::new("xAI OAuth", "xAI OAuth", "xAI OAuth"),
            description: Text::new(
                "Sign in with SuperGrok or X Premium.",
                "使用 SuperGrok 或 X Premium 账号登录。",
                "使用 SuperGrok 或 X Premium 帳號登入。",
            ),
        },
    ),
    (
        "opencode-free",
        ProviderCopy {
            name: Text::new("OpenCode Free", "OpenCode Free", "OpenCode Free"),
            description: Text::new(
                "Retired: OpenCode restricts its free tier to its own client.",
                "已停用：OpenCode 免费服务仅限其官方客户端使用。",
                "已停用：OpenCode 免費服務僅限其官方用戶端使用。",
            ),
        },
    ),
    (
        "commandcode-go",
        ProviderCopy {
            name: Text::new("Command Code GO", "Command Code GO", "Command Code GO"),
            description: Text::new(
                "Retired: this plan reached a private endpoint under the official CLI’s identity.",
                "已停用：该套餐通过官方 CLI 的私有通道访问，已不再支持。",
                "已停用：該方案透過官方 CLI 的私有通道存取，已不再支援。",
            ),
        },
    ),
    (
        "github-copilot",
        ProviderCopy {
            name: Text::new("GitHub Copilot", "GitHub Copilot", "GitHub Copilot"),
            description: Text::new(
                "GitHub Copilot subscription access using an existing GitHub login.",
                "GitHub Copilot 订阅接入，复用本机 GitHub 登录",
                "透過 GitHub Copilot 訂閱連線，沿用本機 GitHub 登入",
            ),
        },
    ),
    (
        "claude-subscription",
        ProviderCopy {
            name: Text::new("Claude Subscription", "Claude Subscription", "Claude Subscription"),
            description: Text::new(
                "Sign in with a Claude Pro / Max subscription; it becomes an available model connection once signed in.",
                "Claude Pro / Max 订阅账号登录；登录后自动成为可用模型连接。",
                "Claude Pro / Max 訂閱帳號登入；登入後自動成為可用模型連線。",
            ),
        },
    ),
    (
        "openai-codex",
        ProviderCopy {
            name: Text::new("OpenAI OAuth", "OpenAI OAuth", "OpenAI OAuth"),
            description: Text::new(
                "Sign in with a ChatGPT / Codex account; it becomes an available model connection once signed in.",
                "ChatGPT / Codex 账号登录；登录后自动成为可用模型连接。",
                "ChatGPT / Codex 帳號登入；登入後自動成為可用模型連線。",
            ),
        },
    ),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_is_named_and_described_in_every_locale() {
        for (key, copy) in PROVIDERS {
            for locale in Locale::ALL {
                assert!(!copy.name.in_locale(locale).trim().is_empty(), "{key} {locale:?}");
                assert!(!copy.description.in_locale(locale).trim().is_empty(), "{key} {locale:?}");
            }
            for locale in [Locale::SimplifiedChinese, Locale::TraditionalChinese] {
                let description = copy.description.in_locale(locale);
                assert!(
                    description.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                    "{key}'s description is not translated into {locale:?}"
                );
            }
        }
        assert_eq!(provider_name(Locale::SimplifiedChinese, "custom"), "自定义连接");
        assert_eq!(provider_name(Locale::English, "future-provider"), "future-provider");
    }
}
