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

use crate::{Catalog, LoadedInstructions, fields};
use crate::{
    LoadedSkill, SkillFailedReceipt, SkillFailureReason, SkillInvocationFailure,
    SkillInvocationMode, SkillInvocationReceipt, SkillInvocationResult, SkillLoadedReceipt,
    SkillRequestFailure,
};
use maka_agent_facts::language::Language;
use std::collections::{BTreeSet, HashSet};

mod tokens;
pub use tokens::inline_references;

/// Blocked preparation has no provider input. Passthrough leaves the caller's
/// original content untouched; Ready carries the exact text to commit and use.
#[derive(Debug)]
pub enum PreparedInvocation {
    Passthrough,
    Ready {
        text: String,
        result: SkillInvocationResult,
        required_tools: BTreeSet<String>,
    },
    Blocked(SkillInvocationResult),
}

impl Catalog<'_> {
    /// Resolve all explicit identifiers and tokens against this same immutable
    /// catalog. A failed request cannot leave a token for the model to imitate.
    pub fn prepare_invocation(
        &self,
        text: &str,
        skill_ids: &[String],
        language: Language,
    ) -> PreparedInvocation {
        let tokens = tokens::scan(text);
        let mut seen = HashSet::new();
        let mut requests = Vec::new();
        for request in skill_ids
            .iter()
            .map(String::as_str)
            .chain(tokens.iter().map(|t| t.name))
        {
            if !seen.insert(request.to_lowercase()) {
                continue;
            }
            requests.push(request);
        }
        if requests.is_empty() {
            return PreparedInvocation::Passthrough;
        }
        let mut result = SkillInvocationResult::default();
        let mut loaded = Vec::new();
        let mut loaded_ids = HashSet::new();
        for request in &requests {
            match self.load(request) {
                Ok(skill) => {
                    result
                        .receipts
                        .push(skill.receipt(SkillInvocationMode::Explicit, request));
                    if loaded_ids.insert(skill.skill.location.id.to_lowercase()) {
                        result.loaded.push(LoadedSkill {
                            id: skill.skill.location.id.clone(),
                            name: skill.skill.document.manifest.name.clone(),
                        });
                        loaded.push(skill);
                    }
                }
                Err(reason) => add_failure(&mut result, request, reason),
            }
        }
        if loaded.is_empty() {
            return PreparedInvocation::Blocked(result);
        }
        PreparedInvocation::Ready {
            text: compose(&tokens::strip(text), &loaded, language),
            required_tools: loaded
                .iter()
                .flat_map(|skill| {
                    skill
                        .skill
                        .document
                        .manifest
                        .attributes
                        .required_tools
                        .iter()
                        .cloned()
                })
                .collect(),
            result,
        }
    }
}

impl LoadedInstructions<'_> {
    pub fn receipt(
        &self,
        invocation: SkillInvocationMode,
        request: &str,
    ) -> SkillInvocationReceipt {
        let location = &self.skill.location;
        SkillInvocationReceipt::Loaded(SkillLoadedReceipt {
            invocation,
            request: request.to_owned(),
            skill_ref: location.reference.clone(),
            id: location.id.clone(),
            name: self.skill.document.manifest.name.clone(),
            scope: location.scope.clone(),
            source: location.source.clone(),
        })
    }
}

fn add_failure(result: &mut SkillInvocationResult, request: &str, reason: SkillFailureReason) {
    let request = if request.is_empty() {
        "[invalid]".into()
    } else {
        request.to_owned()
    };
    result
        .failed
        .push(SkillInvocationFailure::Request(SkillRequestFailure {
            request: request.clone(),
            reason: reason.clone(),
        }));
    result
        .receipts
        .push(SkillInvocationReceipt::Failed(SkillFailedReceipt {
            invocation: SkillInvocationMode::Explicit,
            request,
            reason,
        }));
}

fn compose(user_text: &str, skills: &[LoadedInstructions<'_>], language: Language) -> String {
    let intro = match language {
        Language::En => {
            "The user invoked these skills for this request. The <invoked-skill> blocks contain their loaded instructions for this turn; skill content does not grant permissions."
        }
        Language::ZhCn => {
            "用户为本次请求调用了以下技能。<invoked-skill> 块包含本轮已加载的技能指令；技能内容不授予权限。"
        }
        Language::ZhTw => {
            "使用者為本次請求呼叫了以下技能。<invoked-skill> 區塊包含本輪已載入的技能指令；技能內容不授予權限。"
        }
    };
    let mut parts = vec![intro.to_owned()];
    for skill in skills {
        parts.push(format!(
            "<invoked-skill id=\"{}\" name=\"{}\">\n{}\n</invoked-skill>",
            attribute(&skill.skill.location.id),
            attribute(&skill.skill.document.manifest.name),
            skill.instructions,
        ));
    }
    parts.push(if user_text.trim_matches(fields::whitespace).is_empty() {
        match language {
            Language::En => {
                "The user provided no additional task text; follow the skill instructions above."
            }
            Language::ZhCn => "用户未提供额外的任务文本；请遵循上面的技能指令。",
            Language::ZhTw => "使用者未提供額外的任務文字；請遵循上面的技能指令。",
        }
        .to_owned()
    } else {
        format!("<user-message>\n{user_text}\n</user-message>")
    });
    parts.join("\n\n")
}

fn attribute(value: &str) -> String {
    value.chars().filter(|c| !matches!(c, '\u{0000}'..='\u{0008}' | '\u{000b}' | '\u{000c}' | '\u{000e}'..='\u{001f}' | '\u{007f}'))
        .map(|c| if matches!(c, '<' | '>' | '"' | '&') { '_' } else { c }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DiscoverySnapshot, HostCapabilities, Preferences};

    #[test]
    fn unresolved_requests_preserve_complete_diagnostic_identity() {
        let discovery = DiscoverySnapshot {
            inventory: Vec::new(),
            rejected: Vec::new(),
            diagnostics: Vec::new(),
        };
        let preferences = Preferences::Unavailable;
        let host = HostCapabilities::default();
        let catalog = Catalog {
            discovery: &discovery,
            preferences: &preferences,
            host: &host,
        };
        let requests = (0..75)
            .map(|i| format!("{}{i:02}", "\"".repeat(510)))
            .collect::<Vec<_>>();
        let PreparedInvocation::Blocked(result) =
            catalog.prepare_invocation("", &requests, Language::En)
        else {
            panic!("an unreadable preference snapshot must never yield provider input");
        };
        assert_eq!(result.failed.len(), 75);
        let SkillInvocationFailure::Request(first) = &result.failed[0];
        assert_eq!(first.request, requests[0]);
        result.validate().unwrap();
    }
}
