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

use crate::control::ControlPlaneConfig;
use crate::handler::{HandlerFuture, TurnContext, TurnDecision, TurnHandler};
use crate::metrics::RecorderMode;
use crate::plan::{FinishReason, TurnEvent, TurnPlan};
use crate::protocol::{AuthPolicy, NormalizedRequest, Protocol};
use crate::workload::WorkloadConfig;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use thiserror::Error;
use yaml_rust2::{Yaml, YamlLoader};

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("failed to read config file: {0}")]
    Io(#[from] std::io::Error),
    #[error("failed to parse JSON config: {0}")]
    Json(#[from] serde_json::Error),
    #[error("failed to parse YAML config: {0}")]
    Yaml(String),
    #[error("invalid regex in rule '{rule_id}': {source}")]
    Regex {
        rule_id: String,
        #[source]
        source: regex::Error,
    },
}

/// Top-level declarative server configuration (loadable from JSON or YAML).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MockServerConfig {
    #[serde(default)]
    pub auth: AuthPolicy,
    #[serde(default)]
    pub control: ControlPlaneConfig,
    #[serde(default)]
    pub recorder: RecorderMode,
    #[serde(default)]
    pub latency: crate::pacing::LatencyProfile,
    #[serde(default)]
    pub schedule: crate::pacing::ScenarioSchedule,
    #[serde(default)]
    pub rate_limit: crate::ratelimit::RateLimitConfig,
    #[serde(default)]
    pub watchdog: crate::watchdog::WatchdogConfig,
    #[serde(default)]
    pub rules: Vec<RuleSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workload: Option<WorkloadConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_reply: Option<TurnPlan>,
}

impl MockServerConfig {
    pub fn from_json_str(src: &str) -> Result<Self, ConfigError> {
        Ok(serde_json::from_str(src)?)
    }

    pub fn from_yaml_str(src: &str) -> Result<Self, ConfigError> {
        let docs = YamlLoader::load_from_str(src).map_err(|e| ConfigError::Yaml(e.to_string()))?;
        let doc = docs
            .into_iter()
            .next()
            .ok_or_else(|| ConfigError::Yaml("empty YAML document".into()))?;
        let json_val = yaml_to_json(doc)?;
        Ok(serde_json::from_value(json_val)?)
    }

    pub fn from_file(path: &Path) -> Result<Self, ConfigError> {
        let content = std::fs::read_to_string(path)?;
        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "json" {
            Self::from_json_str(&content)
        } else {
            Self::from_yaml_str(&content)
        }
    }
}

fn yaml_to_json(yaml: Yaml) -> Result<Value, ConfigError> {
    match yaml {
        Yaml::Null | Yaml::BadValue => Ok(Value::Null),
        Yaml::Boolean(b) => Ok(Value::Bool(b)),
        Yaml::Integer(i) => Ok(Value::Number(i.into())),
        Yaml::Real(s) => {
            let f: f64 = s
                .parse()
                .map_err(|e| ConfigError::Yaml(format!("invalid float '{s}': {e}")))?;
            serde_json::Number::from_f64(f)
                .map(Value::Number)
                .ok_or_else(|| ConfigError::Yaml(format!("non-finite float '{s}'")))
        }
        Yaml::String(s) => Ok(Value::String(s)),
        Yaml::Array(arr) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                out.push(yaml_to_json(item)?);
            }
            Ok(Value::Array(out))
        }
        Yaml::Hash(map) => {
            let mut obj = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                let key = match k {
                    Yaml::String(s) => s,
                    Yaml::Integer(i) => i.to_string(),
                    Yaml::Boolean(b) => b.to_string(),
                    other => {
                        return Err(ConfigError::Yaml(format!(
                            "non-string YAML map key: {other:?}"
                        )));
                    }
                };
                obj.insert(key, yaml_to_json(v)?);
            }
            Ok(Value::Object(obj))
        }
        Yaml::Alias(_) => Err(ConfigError::Yaml("YAML aliases are not supported".into())),
    }
}

/// Declarative match predicates for a single rule.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleMatcher {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<Protocol>,
    /// Glob pattern matched against `req.model` (supports `*` wildcard).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Match against concatenated system + message text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_contains: Option<String>,
    /// Regex matched against concatenated system + message text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_regex: Option<String>,
    /// Match against the most recent user message only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_user_contains: Option<String>,
    /// Match against the most recent tool result content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result_contains: Option<String>,
    /// Require a tool with this name to be advertised in `req.tools`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_tool: Option<String>,
    /// Match exact HTTP headers (case-insensitive header names).
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Match Responses/Codex `compaction_trigger` input presence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_compaction_trigger: Option<bool>,
    /// Match Anthropic compaction capability enabled on the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_compaction_enabled: Option<bool>,
    /// Exact 1-based per-session turn index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_turn: Option<u64>,
    /// Exact 1-based global server turn index.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub global_turn: Option<u64>,
    /// Minimum number of messages in the request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_messages: Option<usize>,
    /// Minimum raw prompt byte size.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_prompt_bytes: Option<usize>,
}

/// One declarative rule pairing a matcher with a `TurnPlan` and optional hit budget.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSpec {
    pub id: String,
    #[serde(default, rename = "match")]
    pub matcher: RuleMatcher,
    pub reply: TurnPlan,
    /// Optional cap on how many times this rule may fire (e.g. `Some(1)` to inject a one-shot 429).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_hits: Option<u64>,
}

struct CompiledRule {
    spec: RuleSpec,
    regex: Option<Regex>,
    hits: AtomicU64,
}

impl CompiledRule {
    fn compile(spec: RuleSpec) -> Result<Self, ConfigError> {
        let regex = match &spec.matcher.text_regex {
            Some(pat) => Some(Regex::new(pat).map_err(|source| ConfigError::Regex {
                rule_id: spec.id.clone(),
                source,
            })?),
            None => None,
        };
        Ok(Self {
            spec,
            regex,
            hits: AtomicU64::new(0),
        })
    }

    fn matches(&self, req: &NormalizedRequest, ctx: &TurnContext) -> bool {
        if let Some(max) = self.spec.max_hits
            && self.hits.load(Ordering::Relaxed) >= max
        {
            return false;
        }
        let m = &self.spec.matcher;
        if let Some(proto) = m.protocol
            && req.protocol != proto
        {
            return false;
        }
        if let Some(pat) = &m.model
            && !glob_match(pat, &req.model)
        {
            return false;
        }
        if let Some(expected) = m.has_compaction_trigger
            && req.has_compaction_trigger != expected
        {
            return false;
        }
        if let Some(expected) = m.anthropic_compaction_enabled
            && req.anthropic_compaction_enabled != expected
        {
            return false;
        }
        if let Some(turn) = m.session_turn
            && ctx.session_turn != turn
        {
            return false;
        }
        if let Some(turn) = m.global_turn
            && ctx.global_turn != turn
        {
            return false;
        }
        if let Some(min) = m.min_messages
            && req.messages.len() < min
        {
            return false;
        }
        if let Some(min_bytes) = m.min_prompt_bytes
            && req.prompt_bytes < min_bytes
        {
            return false;
        }
        if let Some(tool) = &m.has_tool
            && !req.has_tool(tool)
        {
            return false;
        }
        for (k, v) in &m.headers {
            let key = k.to_ascii_lowercase();
            if req.headers.get(&key).map(String::as_str) != Some(v.as_str()) {
                return false;
            }
        }
        if let Some(needle) = &m.last_user_contains
            && !req
                .last_user_text()
                .is_some_and(|text| text.contains(needle.as_str()))
        {
            return false;
        }
        if let Some(needle) = &m.tool_result_contains
            && !req
                .last_tool_result()
                .is_some_and(|msg| msg.text.contains(needle.as_str()))
        {
            return false;
        }
        if m.text_contains.is_some() || self.regex.is_some() {
            let full = req.all_text();
            if let Some(needle) = &m.text_contains
                && !full.contains(needle.as_str())
            {
                return false;
            }
            if let Some(re) = &self.regex
                && !re.is_match(&full)
            {
                return false;
            }
        }
        // Atomically claim a hit slot if max_hits is bounded so concurrent requests can't overshoot.
        if let Some(max) = self.spec.max_hits {
            let prev = self.hits.fetch_add(1, Ordering::AcqRel);
            if prev >= max {
                return false;
            }
        } else {
            self.hits.fetch_add(1, Ordering::Relaxed);
        }
        true
    }
}

/// Thread-safe, hot-swappable rule engine implementing `TurnHandler`.
pub struct RuleEngine {
    rules: RwLock<Vec<Arc<CompiledRule>>>,
    default_reply: RwLock<Option<TurnPlan>>,
}

impl RuleEngine {
    pub fn new(specs: Vec<RuleSpec>, default_reply: Option<TurnPlan>) -> Result<Self, ConfigError> {
        let compiled = compile_all(specs)?;
        Ok(Self {
            rules: RwLock::new(compiled),
            default_reply: RwLock::new(default_reply),
        })
    }

    pub fn replace_rules(&self, specs: Vec<RuleSpec>) -> Result<(), ConfigError> {
        let compiled = compile_all(specs)?;
        *self.rules.write().unwrap() = compiled;
        Ok(())
    }

    pub fn rule_specs(&self) -> Vec<RuleSpec> {
        self.rules
            .read()
            .unwrap()
            .iter()
            .map(|r| r.spec.clone())
            .collect()
    }
}

fn compile_all(specs: Vec<RuleSpec>) -> Result<Vec<Arc<CompiledRule>>, ConfigError> {
    specs
        .into_iter()
        .map(|s| CompiledRule::compile(s).map(Arc::new))
        .collect()
}

impl TurnHandler for RuleEngine {
    fn handle<'a>(&'a self, req: &'a NormalizedRequest, ctx: &'a TurnContext) -> HandlerFuture<'a> {
        // Clone Arc list under short read lock; never hold lock across async boundaries.
        let snapshot: Vec<Arc<CompiledRule>> = self.rules.read().unwrap().clone();
        for rule in snapshot {
            if rule.matches(req, ctx) {
                let plan = interpolate_plan(&rule.spec.reply, req, ctx);
                return Box::pin(async move { Some(TurnDecision::Plan(plan)) });
            }
        }
        let fallback = self
            .default_reply
            .read()
            .unwrap()
            .as_ref()
            .map(|p| interpolate_plan(p, req, ctx));
        Box::pin(async move { fallback.map(TurnDecision::Plan) })
    }

    fn reset(&self) {
        for rule in self.rules.read().unwrap().iter() {
            rule.hits.store(0, Ordering::Relaxed);
        }
    }
}

fn interpolate_plan(plan: &TurnPlan, req: &NormalizedRequest, ctx: &TurnContext) -> TurnPlan {
    let mut out = plan.clone();
    let has_template = out.events.iter().any(|ev| match ev {
        TurnEvent::Text { text, .. } | TurnEvent::Reasoning { text, .. } => text.contains("{{"),
        TurnEvent::NativeCompaction(c) => {
            c.summary.contains("{{") || c.encrypted_content.contains("{{")
        }
        _ => false,
    });
    if !has_template {
        return out;
    }
    let last_user = req.last_user_text().unwrap_or("");
    let last_tool = req
        .last_tool_result()
        .map(|m| m.text.as_str())
        .unwrap_or("");
    let last_tool_id = req
        .last_tool_result()
        .and_then(|m| m.tool_call_id.as_deref())
        .unwrap_or("");

    let render = |s: &str| -> String {
        s.replace("{{model}}", &req.model)
            .replace("{{session_key}}", &req.session_key)
            .replace("{{session_turn}}", &ctx.session_turn.to_string())
            .replace("{{global_turn}}", &ctx.global_turn.to_string())
            .replace("{{prompt_bytes}}", &req.prompt_bytes.to_string())
            .replace("{{last_user_text}}", last_user)
            .replace("{{last_tool_result}}", last_tool)
            .replace("{{last_tool_call_id}}", last_tool_id)
    };

    for ev in &mut out.events {
        match ev {
            TurnEvent::Text { text, .. } | TurnEvent::Reasoning { text, .. } => {
                *text = render(text);
            }
            TurnEvent::NativeCompaction(c) => {
                c.summary = render(&c.summary);
                c.encrypted_content = render(&c.encrypted_content);
            }
            _ => {}
        }
    }
    out
}

/// Simple `*` glob matcher (no regex allocation needed).
pub fn glob_match(pattern: &str, text: &str) -> bool {
    if pattern == "*" {
        return true;
    }
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut pos = 0;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            if !text.starts_with(part) {
                return false;
            }
            pos = part.len();
        } else if i == parts.len() - 1 {
            if !text[pos..].ends_with(part) {
                return false;
            }
        } else if let Some(found) = text[pos..].find(part) {
            pos += found + part.len();
        } else {
            return false;
        }
    }
    true
}

/// Convenience helper for simple rule construction in Rust tests.
impl RuleSpec {
    pub fn on_text(
        id: impl Into<String>,
        contains: impl Into<String>,
        reply: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            matcher: RuleMatcher {
                text_contains: Some(contains.into()),
                ..Default::default()
            },
            reply: TurnPlan::text(reply),
            max_hits: None,
        }
    }

    pub fn with_max_hits(mut self, hits: u64) -> Self {
        self.max_hits = Some(hits);
        self
    }

    pub fn with_reply(mut self, reply: TurnPlan) -> Self {
        self.reply = reply;
        self
    }

    pub fn finish_stop(mut self) -> Self {
        self.reply = self.reply.finish(FinishReason::Stop);
        self
    }
}
