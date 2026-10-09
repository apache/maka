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

//! Maka's provider registry, as a small static copy (`PROVIDER_REGISTRY`,
//! `CATALOG_PROVIDER_TYPES`, and `RECOMMENDED_PROVIDER_TYPES` in
//! packages/core/src/provider-registry.ts, with the auth helpers of
//! packages/core/src/llm-connections.ts).
//!
//! It holds what the Models page needs to offer, add, and describe a
//! connection: the `providerType` wire literal, the registry's label, the
//! default endpoint (or the template one is built from), how the provider
//! authenticates, its group in the provider catalog, where to get a key,
//! whether the Host can list its models, and the model the Host's catalog
//! recommends for it when it has none stored (`buildCatalogRecommendedDefaultModel`
//! in apps/desktop/src/renderer/model-catalog-choices.ts, which is the first
//! chat-capable entry `resolveConnectionModelCatalog` yields). The order is
//! the catalog's (`catalogOrder`), then the providers the catalog does not
//! list (account sign-ins and retired ones).
//!
//! Since epoch 184 `custom` is the one provider for endpoints the registry
//! does not know (it replaced `openai-compatible`,
//! `openai-responses-compatible` and `anthropic-compatible`); a custom
//! connection is created with a [`ModelApiProtocol`], which the form picks
//! in a select of its own, as Maka Desktop does.
//!
//! The Host owns model facts; nothing here describes models beyond the
//! recommended id. This table is a copy that goes stale: regenerate it from
//! the TS registry whenever [`crate::RUNTIME_HOST_COMPATIBILITY_EPOCH`]
//! changes.

wire_enum! {
    /// `ModelApiProtocol` (`MODEL_API_PROTOCOLS` in
    /// packages/core/src/provider-registry.ts): the request wire of a model,
    /// and the default one of a `custom` connection.
    pub enum ModelApiProtocol {
        OpenaiChat = "openai-chat",
        OpenaiResponses = "openai-responses",
        AnthropicMessages = "anthropic-messages",
    }
}

impl ModelApiProtocol {
    /// Every protocol, in the registry's order.
    pub const ALL: [Self; 3] = [Self::OpenaiChat, Self::OpenaiResponses, Self::AnthropicMessages];

    /// `MODEL_API_PROTOCOL_LABELS`: the protocol's name, the same in every
    /// language.
    pub fn label(&self) -> &str {
        match self {
            Self::OpenaiChat => "OpenAI Chat Completions",
            Self::OpenaiResponses => "OpenAI Responses",
            Self::AnthropicMessages => "Anthropic Messages",
            Self::Other(other) => other,
        }
    }
}

/// How a provider authenticates (`authKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProviderAuth {
    /// `api_key`: a key is required.
    ApiKey,
    /// `optional_api_key`: a key is sent only when one is given.
    OptionalApiKey,
    /// `oauth_token`: an account sign-in, which this client leaves to Maka
    /// Desktop for now.
    OauthToken,
    /// `none`: a local runtime with no credential slot.
    None,
}

/// `ProviderCatalogGroup`: where the catalog lists a provider. The fifth
/// group, `recommended`, is a shortlist of its own
/// ([`ProviderDefinition::is_recommended`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProviderGroup {
    Plans,
    Api,
    Aggregators,
    Local,
}

/// In `CATALOG_PROVIDER_TYPES`.
const CATALOG: u16 = 1;
/// In `RECOMMENDED_PROVIDER_TYPES`.
const RECOMMENDED: u16 = 1 << 1;
/// `category` `local`.
const LOCAL: u16 = 1 << 2;
/// `modelDiscovery` other than `fallback` (`providerSupportsModelDiscovery`).
const DISCOVERY: u16 = 1 << 3;
/// The ChatGPT Codex adapter, which refuses an output-token limit
/// (`providerAcceptsOutputTokenLimit`).
const NO_OUTPUT_LIMIT: u16 = 1 << 4;
/// `retired`: kept so stored connections decode; it cannot send.
const RETIRED: u16 = 1 << 5;
/// `status` `phase3-experimental`.
const EXPERIMENTAL: u16 = 1 << 6;

/// One provider of the registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub struct ProviderDefinition {
    /// The `providerType` wire literal, for example `deepseek` or `custom`.
    pub provider_type: &'static str,
    /// The registry's `label`, a brand; the Models page shows the name in
    /// the copy table instead.
    pub label: &'static str,
    /// The registry's `baseUrl`; `None` when it has none (`custom`, and
    /// Cloudflare, whose endpoint comes from [`Self::base_url_template`]).
    pub base_url: Option<&'static str>,
    /// `baseUrlTemplate`, with `${CLOUDFLARE_ACCOUNT_ID}` in it.
    pub base_url_template: Option<&'static str>,
    pub auth: ProviderAuth,
    /// `catalogGroup`; `None` for the providers the catalog does not list.
    pub group: Option<ProviderGroup>,
    /// `signupUrl`: where to get a key.
    pub signup_url: Option<&'static str>,
    /// The model a connection starts on when none is chosen.
    pub recommended_model: Option<&'static str>,
    flags: u16,
}

/// The placeholder a Cloudflare endpoint template takes the account id in.
const ACCOUNT_ID_PLACEHOLDER: &str = "${CLOUDFLARE_ACCOUNT_ID}";

impl ProviderDefinition {
    /// The provider with the `providerType` `provider_type`, if the registry
    /// has it.
    pub fn find(provider_type: &str) -> Option<&'static ProviderDefinition> {
        PROVIDER_REGISTRY.iter().find(|provider| provider.provider_type == provider_type)
    }

    /// The providers the catalog offers, in its order: listed, and neither
    /// experimental nor retired (`providersMatching` in
    /// apps/desktop/src/renderer/settings/provider-catalog-page.tsx).
    pub fn catalog() -> impl Iterator<Item = &'static ProviderDefinition> {
        PROVIDER_REGISTRY.iter().filter(|provider| {
            provider.flags & CATALOG != 0 && provider.flags & (EXPERIMENTAL | RETIRED) == 0
        })
    }

    /// Whether the catalog's shortlist (推荐) lists it.
    pub fn is_recommended(&self) -> bool {
        self.flags & RECOMMENDED != 0
    }

    /// Whether it is a local runtime.
    pub fn is_local(&self) -> bool {
        self.flags & LOCAL != 0
    }

    /// Whether the Host can list its models (`providerSupportsModelDiscovery`).
    pub fn supports_model_discovery(&self) -> bool {
        self.flags & DISCOVERY != 0
    }

    /// Whether a request may carry an output-token limit
    /// (`providerAcceptsOutputTokenLimit`).
    pub fn accepts_output_token_limit(&self) -> bool {
        self.flags & NO_OUTPUT_LIMIT == 0
    }

    /// Whether Maka stopped offering it (`isRetiredProvider`).
    pub fn is_retired(&self) -> bool {
        self.flags & RETIRED != 0
    }

    /// Whether it is still experimental (`status` `phase3-experimental`).
    pub fn is_experimental(&self) -> bool {
        self.flags & EXPERIMENTAL != 0
    }

    /// Whether a connection keeps an API key (`providerAuthSupportsApiKey`).
    pub fn supports_api_key(&self) -> bool {
        matches!(self.auth, ProviderAuth::ApiKey | ProviderAuth::OptionalApiKey)
    }

    /// Whether a connection cannot work without a secret
    /// (`providerAuthRequiresSecret`).
    pub fn requires_secret(&self) -> bool {
        matches!(self.auth, ProviderAuth::ApiKey | ProviderAuth::OauthToken)
    }

    /// Whether it is added by signing in with an account.
    pub fn is_account(&self) -> bool {
        self.auth == ProviderAuth::OauthToken
    }

    /// Whether the connection's endpoint comes from an account id.
    pub fn builds_endpoint_from_account(&self) -> bool {
        self.base_url_template.is_some()
    }

    /// Whether adding it takes only a key: it needs one and has a fixed
    /// endpoint (Desktop's `usesQuickApiKeyDialog`).
    pub fn takes_only_a_key(&self) -> bool {
        self.auth == ProviderAuth::ApiKey && self.base_url.is_some()
    }

    /// Whether the form must be given an endpoint: the registry has none
    /// and builds none.
    pub fn requires_base_url(&self) -> bool {
        self.base_url.is_none() && self.base_url_template.is_none()
    }

    /// Whether a connection's endpoint can be edited on its detail: its own
    /// for a custom relay or a local runtime, never an account's or a
    /// derived one (`providerEndpointPresentation` in
    /// apps/desktop/src/renderer/settings/provider-endpoint-presentation.ts).
    pub fn endpoint_editable(&self) -> bool {
        !self.is_account()
            && self.base_url_template.is_none()
            && (self.base_url.is_none() || self.is_local())
    }

    /// The Cloudflare endpoint for `account_id`, percent-encoded as
    /// `encodeURIComponent` does.
    pub fn endpoint_for_account(&self, account_id: &str) -> Option<String> {
        let template = self.base_url_template?;
        Some(template.replace(ACCOUNT_ID_PLACEHOLDER, &encode_uri_component(account_id)))
    }

    /// Whether it is the provider for unknown endpoints, which takes a
    /// default API protocol.
    pub fn is_custom(&self) -> bool {
        self.provider_type == CUSTOM_PROVIDER_TYPE
    }
}

/// The `providerType` of a connection to an endpoint the registry does not
/// know.
pub const CUSTOM_PROVIDER_TYPE: &str = "custom";

/// `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` as
/// UTF-8 percent escapes.
fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Every provider of the registry: the catalog's in its order, then the
/// rest. Generated from `PROVIDER_REGISTRY` at compatibility epoch 197.
pub const PROVIDER_REGISTRY: &[ProviderDefinition] = &[
    ProviderDefinition {
        provider_type: "kimi-coding-plan",
        label: "Kimi Coding Plan",
        base_url: Some("https://api.kimi.com/coding/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://www.kimi.com/code/console"),
        recommended_model: Some("k3"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "minimax-coding-plan",
        label: "MiniMax Coding Plan",
        base_url: Some("https://api.minimax.io/anthropic"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://platform.minimax.io/subscribe/coding-plan"),
        recommended_model: Some("MiniMax-M3"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "deepseek",
        label: "DeepSeek",
        base_url: Some("https://api.deepseek.com"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://platform.deepseek.com/api_keys"),
        recommended_model: Some("deepseek-flash"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "moonshot",
        label: "Moonshot",
        base_url: Some("https://api.moonshot.cn/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://platform.kimi.com/console/api-keys"),
        recommended_model: Some("kimi-k2.6"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "moonshot-global",
        label: "Moonshot Global",
        base_url: Some("https://api.moonshot.ai/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://platform.kimi.ai/console/api-keys"),
        recommended_model: Some("kimi-k3"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "zai-coding-plan",
        label: "Z.AI Coding Plan",
        base_url: Some("https://api.z.ai/api/coding/paas/v4"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://bigmodel.cn/usercenter/proj-mgmt/apikeys"),
        recommended_model: Some("glm-5.2"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "MiniMax",
        label: "MiniMax",
        base_url: Some("https://api.minimax.io/anthropic/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://platform.minimax.io/user-center/basic-information/interface-key"),
        recommended_model: Some("MiniMax-M3"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "MiniMax-cn",
        label: "MiniMax 中国站",
        base_url: Some("https://api.minimaxi.com/anthropic/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some(
            "https://platform.minimaxi.com/user-center/basic-information/interface-key",
        ),
        recommended_model: Some("MiniMax-M3"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "siliconflow",
        label: "SiliconFlow",
        base_url: Some("https://api.siliconflow.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Aggregators),
        signup_url: Some("https://cloud.siliconflow.com/models"),
        recommended_model: Some("moonshotai/Kimi-K2.6"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "anthropic",
        label: "Anthropic",
        base_url: Some("https://api.anthropic.com"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://console.anthropic.com/settings/keys"),
        recommended_model: Some("claude-sonnet-4-6"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "openai",
        label: "OpenAI",
        base_url: Some("https://api.openai.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://platform.openai.com/api-keys"),
        recommended_model: Some("gpt-5.5"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "google",
        label: "Google Gemini",
        base_url: Some("https://generativelanguage.googleapis.com/v1beta"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://aistudio.google.com/app/apikey"),
        recommended_model: Some("gemini-3.5-flash"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "xai",
        label: "xAI",
        base_url: Some("https://api.x.ai/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://console.x.ai/"),
        recommended_model: Some("grok-4.5"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "zai",
        label: "Z.AI",
        base_url: Some("https://api.z.ai/api/paas/v4"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://z.ai/manage-apikey/apikey-list"),
        recommended_model: Some("glm-5.2"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "xiaomi",
        label: "Xiaomi",
        base_url: Some("https://api.xiaomimimo.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://platform.xiaomimimo.com/"),
        recommended_model: Some("mimo-v2.5"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "xiaomi-token-plan-cn",
        label: "Xiaomi Token Plan (China)",
        base_url: Some("https://token-plan-cn.xiaomimimo.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://platform.xiaomimimo.com/token-plan"),
        recommended_model: Some("mimo-v2.5-pro"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "xiaomi-token-plan-sgp",
        label: "Xiaomi Token Plan (Singapore)",
        base_url: Some("https://token-plan-sgp.xiaomimimo.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://platform.xiaomimimo.com/token-plan"),
        recommended_model: Some("mimo-v2.5-pro"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "xiaomi-token-plan-ams",
        label: "Xiaomi Token Plan (Europe)",
        base_url: Some("https://token-plan-ams.xiaomimimo.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://platform.xiaomimimo.com/token-plan"),
        recommended_model: Some("mimo-v2.5-pro"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "cerebras",
        label: "Cerebras",
        base_url: Some("https://api.cerebras.ai/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://cloud.cerebras.ai/"),
        recommended_model: Some("gpt-oss-120b"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "mistral",
        label: "Mistral",
        base_url: Some("https://api.mistral.ai/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://console.mistral.ai/api-keys/"),
        recommended_model: Some("mistral-large-latest"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "togetherai",
        label: "Together AI",
        base_url: Some("https://api.together.ai/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://api.together.ai/settings/projects/~current/api-keys"),
        recommended_model: Some("MiniMaxAI/MiniMax-M3"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "ollama",
        label: "Ollama",
        base_url: Some("http://127.0.0.1:11434/v1"),
        base_url_template: None,
        auth: ProviderAuth::None,
        group: Some(ProviderGroup::Local),
        signup_url: None,
        recommended_model: Some("llama3.2"),
        flags: CATALOG | LOCAL | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "lm-studio",
        label: "LM Studio",
        base_url: Some("http://127.0.0.1:1234/v1"),
        base_url_template: None,
        auth: ProviderAuth::None,
        group: Some(ProviderGroup::Local),
        signup_url: None,
        recommended_model: None,
        flags: CATALOG | LOCAL | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "localai",
        label: "LocalAI",
        base_url: Some("http://127.0.0.1:8080/v1"),
        base_url_template: None,
        auth: ProviderAuth::OptionalApiKey,
        group: Some(ProviderGroup::Local),
        signup_url: None,
        recommended_model: Some("qwen3-8b"),
        flags: CATALOG | LOCAL | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "custom",
        label: "Custom connection",
        base_url: None,
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Aggregators),
        signup_url: None,
        recommended_model: None,
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "fireworks-ai",
        label: "Fireworks AI",
        base_url: Some("https://api.fireworks.ai/inference/v1/"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://app.fireworks.ai/settings/users/api-keys"),
        recommended_model: Some("accounts/fireworks/models/kimi-k3"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "nvidia",
        label: "NVIDIA",
        base_url: Some("https://integrate.api.nvidia.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://build.nvidia.com/"),
        recommended_model: Some("nvidia/nemotron-3-super-120b-a12b"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "tencent-tokenhub",
        label: "Tencent TokenHub",
        base_url: Some("https://tokenhub.tencentmaas.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://cloud.tencent.com/document/product/1823/130090"),
        recommended_model: Some("hy3"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "stepfun",
        label: "StepFun (China)",
        base_url: Some("https://api.stepfun.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://platform.stepfun.com/interface-key"),
        recommended_model: Some("step-3.7-flash"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "tencent-coding-plan",
        label: "Tencent Coding Plan (China)",
        base_url: Some("https://api.lkeap.cloud.tencent.com/coding/v3"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://console.cloud.tencent.com/lkeap/coding-plan"),
        recommended_model: Some("tc-code-latest"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "stepfun-ai",
        label: "StepFun (Global)",
        base_url: Some("https://api.stepfun.ai/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://platform.stepfun.ai/interface-key"),
        recommended_model: Some("step-3.7-flash"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "volcengine-ark",
        label: "Volcengine Ark (China)",
        base_url: Some("https://ark.cn-beijing.volces.com/api/v3"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://console.volcengine.com/ark/region:ark+cn-beijing/model"),
        recommended_model: Some("doubao-seed-2-0-pro-260215"),
        flags: CATALOG,
    },
    ProviderDefinition {
        provider_type: "volcengine-coding-plan",
        label: "Volcengine Ark Coding Plan (China)",
        base_url: Some("https://ark.cn-beijing.volces.com/api/coding/v3"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://www.volcengine.com/activity/codingplan"),
        recommended_model: Some("ark-code-latest"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "volcengine-agent-plan",
        label: "Volcengine Ark Agent Plan (China)",
        base_url: Some("https://ark.cn-beijing.volces.com/api/plan/v3"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://console.volcengine.com/ark/agent-plan"),
        recommended_model: Some("ark-code-latest"),
        flags: CATALOG,
    },
    ProviderDefinition {
        provider_type: "tencent-token-plan",
        label: "Tencent Token Plan",
        base_url: Some("https://api.lkeap.cloud.tencent.com/plan/v3"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://console.cloud.tencent.com/tokenhub/tokenplan/common"),
        recommended_model: Some("tc-code-latest"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "stepfun-step-plan",
        label: "StepFun Step Plan (China)",
        base_url: Some("https://api.stepfun.com/step_plan/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://platform.stepfun.com/interface-key"),
        recommended_model: Some("step-3.7-flash"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "deepinfra",
        label: "Deep Infra",
        base_url: Some("https://api.deepinfra.com/v1/openai"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://deepinfra.com/dash/api_keys"),
        recommended_model: Some("moonshotai/Kimi-K2.7-Code"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "cohere",
        label: "Cohere",
        base_url: Some("https://api.cohere.com/v2"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://dashboard.cohere.com/api-keys"),
        recommended_model: Some("command-a-plus-05-2026"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "vercel",
        label: "Vercel AI Gateway",
        base_url: Some("https://ai-gateway.vercel.sh/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Aggregators),
        signup_url: Some("https://vercel.com/ai-gateway"),
        recommended_model: Some("anthropic/claude-opus-4.8"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "stepfun-ai-step-plan",
        label: "StepFun Step Plan (Global)",
        base_url: Some("https://api.stepfun.ai/step_plan/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://platform.stepfun.ai/interface-key"),
        recommended_model: Some("step-3.7-flash"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "cloudflare-workers-ai",
        label: "Cloudflare Workers AI",
        base_url: None,
        base_url_template: Some(
            "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
        ),
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://dash.cloudflare.com/profile/api-tokens"),
        recommended_model: Some("@cf/moonshotai/kimi-k2.6"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "huggingface",
        label: "Hugging Face",
        base_url: Some("https://router.huggingface.co/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Aggregators),
        signup_url: Some("https://huggingface.co/settings/tokens"),
        recommended_model: Some("openai/gpt-oss-120b"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "ollama-cloud",
        label: "Ollama Cloud",
        base_url: Some("https://ollama.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://ollama.com/settings/keys"),
        recommended_model: Some("qwen3.5:397b"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "zenmux",
        label: "ZenMux",
        base_url: Some("https://zenmux.ai/api/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Aggregators),
        signup_url: Some("https://zenmux.ai/settings/keys"),
        recommended_model: Some("moonshotai/kimi-k2.5"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "opencode",
        label: "OpenCode Zen",
        base_url: Some("https://opencode.ai/zen/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://opencode.ai/zen"),
        recommended_model: Some("gpt-5.5"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "opencode-go",
        label: "OpenCode Go",
        base_url: Some("https://opencode.ai/zen/go/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://opencode.ai/go"),
        recommended_model: Some("minimax-m3"),
        flags: CATALOG | RECOMMENDED | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "groq",
        label: "Groq",
        base_url: Some("https://api.groq.com/openai/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://console.groq.com/keys"),
        recommended_model: Some("llama-3.3-70b-versatile"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "openrouter",
        label: "OpenRouter",
        base_url: Some("https://openrouter.ai/api/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Aggregators),
        signup_url: Some("https://openrouter.ai/settings/keys"),
        recommended_model: Some("anthropic/claude-sonnet-5"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "alibaba",
        label: "Alibaba",
        base_url: Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://modelstudio.console.alibabacloud.com/"),
        recommended_model: Some("qwen3.7-plus"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "alibaba-cn",
        label: "Alibaba (China)",
        base_url: Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Api),
        signup_url: Some("https://bailian.console.aliyun.com/"),
        recommended_model: Some("qwen3.8-max"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "alibaba-coding-plan-cn",
        label: "Alibaba Coding Plan (China)",
        base_url: Some("https://coding.dashscope.aliyuncs.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://www.aliyun.com/benefit/scene/codingplan"),
        recommended_model: Some("qwen3.7-plus"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "alibaba-coding-plan",
        label: "Alibaba Coding Plan",
        base_url: Some("https://coding-intl.dashscope.aliyuncs.com/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://www.alibabacloud.com/help/en/model-studio/coding-plan"),
        recommended_model: Some("qwen3.7-plus"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "alibaba-token-plan-cn",
        label: "Alibaba Token Plan (China)",
        base_url: Some("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://bailian.console.aliyun.com/"),
        recommended_model: Some("qwen3.8-max"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "alibaba-token-plan",
        label: "Alibaba Token Plan",
        base_url: Some("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://modelstudio.console.alibabacloud.com/"),
        recommended_model: Some("qwen3.8-max"),
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "commandcode",
        label: "Command Code",
        base_url: Some("https://api.commandcode.ai/provider/v1"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: Some("https://commandcode.ai/docs/plans/goat"),
        recommended_model: None,
        flags: CATALOG | DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "xai-oauth",
        label: "xAI OAuth (SuperGrok / X Premium)",
        base_url: Some("https://api.x.ai/v1"),
        base_url_template: None,
        auth: ProviderAuth::OauthToken,
        group: None,
        signup_url: Some("https://x.ai/grok"),
        recommended_model: Some("grok-4.5"),
        flags: DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "opencode-free",
        label: "OpenCode Free",
        base_url: Some("https://opencode.ai/zen/v1"),
        base_url_template: None,
        auth: ProviderAuth::None,
        group: None,
        signup_url: None,
        recommended_model: None,
        flags: RETIRED | EXPERIMENTAL,
    },
    ProviderDefinition {
        provider_type: "commandcode-go",
        label: "Command Code GO",
        base_url: Some("https://api.commandcode.ai"),
        base_url_template: None,
        auth: ProviderAuth::ApiKey,
        group: Some(ProviderGroup::Plans),
        signup_url: None,
        recommended_model: None,
        flags: RETIRED | EXPERIMENTAL,
    },
    ProviderDefinition {
        provider_type: "github-copilot",
        label: "GitHub Copilot",
        base_url: Some("https://api.githubcopilot.com"),
        base_url_template: None,
        auth: ProviderAuth::OauthToken,
        group: None,
        signup_url: Some("https://github.com/features/copilot/plans"),
        recommended_model: Some("gpt-5.4"),
        flags: DISCOVERY,
    },
    ProviderDefinition {
        provider_type: "claude-subscription",
        label: "Claude Subscription (Pro / Max OAuth)",
        base_url: Some("https://api.anthropic.com"),
        base_url_template: None,
        auth: ProviderAuth::OauthToken,
        group: None,
        signup_url: None,
        recommended_model: None,
        flags: RETIRED | EXPERIMENTAL,
    },
    ProviderDefinition {
        provider_type: "openai-codex",
        label: "OpenAI OAuth (ChatGPT / Codex)",
        base_url: Some("https://chatgpt.com/backend-api/codex"),
        base_url_template: None,
        auth: ProviderAuth::OauthToken,
        group: None,
        signup_url: None,
        recommended_model: Some("gpt-6-astra"),
        flags: DISCOVERY | NO_OUTPUT_LIMIT | EXPERIMENTAL,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_lists_ready_providers_in_order_with_one_custom() {
        let catalog: Vec<&str> = ProviderDefinition::catalog().map(|p| p.provider_type).collect();
        assert_eq!(catalog.first(), Some(&"kimi-coding-plan"));
        assert_eq!(catalog.iter().filter(|p| **p == "custom").count(), 1);
        for listed in ["ollama", "lm-studio", "localai", "cloudflare-workers-ai", "opencode-go"] {
            assert!(catalog.contains(&listed), "{listed}");
        }
        // Account sign-ins, retired and relay types are not in the catalog.
        for missing in [
            "openai-codex",
            "github-copilot",
            "xai-oauth",
            "opencode-free",
            "claude-subscription",
            "openai-compatible",
            "anthropic-compatible",
        ] {
            assert!(!catalog.contains(&missing), "{missing}");
        }
        let recommended: Vec<&str> = ProviderDefinition::catalog()
            .filter(|p| p.is_recommended())
            .map(|p| p.provider_type)
            .collect();
        assert_eq!(recommended, ["opencode-go"]);
    }

    #[test]
    fn auth_and_endpoints_decide_the_form() {
        let deepseek = ProviderDefinition::find("deepseek").expect("deepseek");
        assert!(deepseek.takes_only_a_key() && deepseek.requires_secret());
        assert!(!deepseek.endpoint_editable());
        let custom = ProviderDefinition::find("custom").expect("custom");
        assert!(custom.is_custom() && custom.requires_base_url() && custom.endpoint_editable());
        assert!(!custom.takes_only_a_key());
        let ollama = ProviderDefinition::find("ollama").expect("ollama");
        assert_eq!(ollama.auth, ProviderAuth::None);
        assert!(!ollama.supports_api_key() && ollama.is_local() && ollama.endpoint_editable());
        let localai = ProviderDefinition::find("localai").expect("localai");
        assert!(localai.supports_api_key() && !localai.requires_secret());
        let cloudflare = ProviderDefinition::find("cloudflare-workers-ai").expect("cloudflare");
        assert!(!cloudflare.requires_base_url() && !cloudflare.endpoint_editable());
        assert_eq!(
            cloudflare.endpoint_for_account("a b/c").as_deref(),
            Some("https://api.cloudflare.com/client/v4/accounts/a%20b%2Fc/ai/v1")
        );
        let codex = ProviderDefinition::find("openai-codex").expect("codex");
        assert!(codex.is_account() && !codex.accepts_output_token_limit());
        assert!(ProviderDefinition::find("opencode-free").expect("retired").is_retired());
        assert_eq!(
            ProviderDefinition::find("volcengine-ark").map(|p| p.supports_model_discovery()),
            Some(false)
        );
        assert_eq!(ProviderDefinition::find("custom").and_then(|p| p.recommended_model), None);
    }

    #[test]
    fn provider_types_are_unique() {
        let mut ids: Vec<&str> = PROVIDER_REGISTRY.iter().map(|p| p.provider_type).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), PROVIDER_REGISTRY.len());
    }
}
