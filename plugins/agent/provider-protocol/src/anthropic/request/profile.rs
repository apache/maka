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

/// Explicit model families precede prefix fallbacks. The fallback policy is
/// intentionally conservative for legacy names and adaptive for future Claude.
#[derive(Debug, Clone, Copy)]
pub struct Profile {
    pub max_output_tokens: u64,
    pub known: bool,
    pub structured: bool,
    pub adaptive: bool,
    pub reject_sampling: bool,
    pub xhigh: bool,
    pub cap_disabled_effort: bool,
    pub reject_disabled: bool,
    pub reject_budget: bool,
    pub reject_forced: bool,
    pub between_tools: bool,
}
impl Default for Profile {
    fn default() -> Self {
        Self {
            max_output_tokens: 4096,
            known: true,
            structured: false,
            adaptive: false,
            reject_sampling: false,
            xhigh: false,
            cap_disabled_effort: false,
            reject_disabled: false,
            reject_budget: false,
            reject_forced: false,
            between_tools: false,
        }
    }
}
macro_rules! profile {
    ($max:expr; $($flag:ident),* $(,)?) => { Profile { max_output_tokens: $max, $($flag: true,)* ..Profile::default() } };
}
impl Profile {
    pub fn for_model(id: &str) -> Self {
        if id.contains("claude-sonnet-5-5") {
            return profile!(128000; structured, adaptive, reject_sampling, xhigh, cap_disabled_effort, reject_disabled, reject_budget, reject_forced, between_tools);
        }
        if id.contains("claude-opus-5-5") {
            return profile!(128000; structured, adaptive, reject_sampling, xhigh, cap_disabled_effort, reject_disabled, reject_budget, reject_forced);
        }
        if id.contains("claude-haiku-5-5") {
            return profile!(128000; structured, adaptive, reject_sampling, xhigh, cap_disabled_effort, reject_budget);
        }
        if id.contains("claude-opus-5") {
            return profile!(128000; structured, adaptive, reject_sampling, xhigh, cap_disabled_effort);
        }
        if id.contains("claude-fable-5-1") {
            return profile!(128000; structured, adaptive, reject_sampling, xhigh, reject_disabled, reject_budget, reject_forced);
        }
        if id.contains("claude-fable-5") {
            return profile!(128000; structured, adaptive, reject_sampling, xhigh, reject_disabled, reject_budget);
        }
        if ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"]
            .iter()
            .any(|name| id.contains(name))
        {
            return profile!(128000; structured, adaptive, reject_sampling, xhigh);
        }
        if ["claude-sonnet-4-6", "claude-opus-4-6"]
            .iter()
            .any(|name| id.contains(name))
        {
            return profile!(128000; structured, adaptive);
        }
        if ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"]
            .iter()
            .any(|name| id.contains(name))
        {
            return profile!(64000; structured);
        }
        if id.contains("claude-opus-4-1") {
            return profile!(32000; structured);
        }
        if followed_by(id, "claude-sonnet-4", "-@", false) {
            return profile!(64000;);
        }
        if followed_by(id, "claude-opus-4", "-@", false) {
            return profile!(32000;);
        }
        if id.contains("claude-3-haiku") {
            return profile!(4096;);
        }
        let legacy = followed_by(id, "claude-instant", "-", true)
            || followed_by(id, "claude-2", "-.:", true)
            || followed_by(id, "claude-v2", "-.:", true)
            || followed_by(id, "claude-3", "-.", true);
        let mut profile = if !legacy && id.contains("claude-") {
            profile!(128000; structured, adaptive, reject_sampling, xhigh, cap_disabled_effort)
        } else {
            profile!(4096;)
        };
        profile.known = false;
        profile
    }
}
fn followed_by(id: &str, prefix: &str, delimiters: &str, end: bool) -> bool {
    id.match_indices(prefix).any(|(index, _)| {
        id[index + prefix.len()..]
            .chars()
            .next()
            .map_or(end, |c| delimiters.contains(c))
    })
}
