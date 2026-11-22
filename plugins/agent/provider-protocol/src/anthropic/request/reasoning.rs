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

use super::{Diagnostic, Profile, Reasoning, options::*};

pub(super) fn resolve(
    model: &str,
    profile: Profile,
    level: Reasoning,
    options: &mut ProviderOptions,
    diagnostics: &mut Vec<Diagnostic>,
) {
    if !matches!(level, Reasoning::ProviderDefault) && options.effort.is_none() {
        let (thinking, effort) = map(model, profile, level, diagnostics);
        if options.thinking.is_none() {
            options.thinking = thinking;
        }
        if effort.is_some() && !options.thinking.as_ref().is_some_and(Thinking::disabled) {
            options.effort = effort;
        }
    }
    if profile.reject_disabled && options.thinking.as_ref().is_some_and(Thinking::disabled) {
        if profile.between_tools {
            diagnostics.push(Diagnostic::unsupported("providerOptions.anthropic.thinking",format!("thinking cannot be disabled for {model}. Using 'between_tools' thinking, the lowest thinking setting, instead.")));
            options.thinking = Some(Thinking::Mode(ThinkingMode::BetweenTools));
        } else {
            diagnostics.push(Diagnostic::unsupported("providerOptions.anthropic.thinking",format!("thinking cannot be disabled for {model}; it always uses adaptive thinking. The thinking setting has been removed. Lower 'effort' to reduce thinking.")));
            options.thinking = None;
        }
    }
    if profile.reject_budget && options.thinking.as_ref().is_some_and(Thinking::budgeted) {
        let detail = if profile.reject_disabled {
            "; it always uses adaptive thinking."
        } else {
            "."
        };
        diagnostics.push(Diagnostic::unsupported("providerOptions.anthropic.thinking",format!("budget-based thinking is not supported by {model}{detail} Using adaptive thinking instead. Use 'effort' to control how much the model thinks.")));
        options.thinking = Some(Thinking::Mode(ThinkingMode::Adaptive {
            display: None,
            block_binding: None,
        }));
    }
    if let Some(effort) = options.effort.filter(|e| e.above_high()) {
        let details = if profile.cap_disabled_effort
            && options.thinking.as_ref().is_some_and(Thinking::disabled)
        {
            Some(format!(
                "effort '{}' is not supported by {model} when thinking is disabled. The effort has been lowered to 'high'.",
                effort.as_str()
            ))
        } else if matches!(
            options.thinking,
            Some(Thinking::Mode(ThinkingMode::BetweenTools))
        ) {
            Some(format!(
                "effort '{}' is not supported with 'between_tools' thinking. The effort has been lowered to 'high'.",
                effort.as_str()
            ))
        } else {
            None
        };
        if let Some(details) = details {
            diagnostics.push(Diagnostic::unsupported(
                "providerOptions.anthropic.effort",
                details,
            ));
            options.effort = Some(Effort::High);
        }
    }
}
fn map(
    model: &str,
    profile: Profile,
    level: Reasoning,
    diagnostics: &mut Vec<Diagnostic>,
) -> (Option<Thinking>, Option<Effort>) {
    if matches!(level, Reasoning::ProviderDefault) {
        return (None, None);
    }
    if matches!(level, Reasoning::None) {
        if profile.between_tools {
            return (Some(Thinking::Mode(ThinkingMode::BetweenTools)), None);
        }
        if profile.reject_disabled {
            diagnostics.push(Diagnostic::compatibility("reasoning",format!("reasoning 'none' is not supported by {model}; it always uses adaptive thinking. Using effort 'low' to minimize thinking instead.")));
            return (None, Some(Effort::Low));
        }
        return (Some(Thinking::Mode(ThinkingMode::Disabled)), None);
    }
    if profile.adaptive {
        let effort = match level {
            Reasoning::Minimal | Reasoning::Low => Effort::Low,
            Reasoning::Medium => Effort::Medium,
            Reasoning::High => Effort::High,
            Reasoning::Xhigh if profile.xhigh => Effort::Xhigh,
            Reasoning::Xhigh | Reasoning::Max => Effort::Max,
            _ => unreachable!(),
        };
        if level.as_str() != effort.as_str() {
            diagnostics.push(Diagnostic::compatibility("reasoning",format!("reasoning \"{}\" is not directly supported by this model. mapped to effort \"{}\".",level.as_str(),effort.as_str())));
        }
        return (
            Some(Thinking::Mode(ThinkingMode::Adaptive {
                display: Some(ThinkingDisplay::Summarized),
                block_binding: None,
            })),
            Some(effort),
        );
    }
    let percent = match level {
        Reasoning::Minimal => 2,
        Reasoning::Low => 10,
        Reasoning::Medium => 30,
        Reasoning::High => 60,
        Reasoning::Xhigh => 90,
        Reasoning::Max => 95,
        _ => unreachable!(),
    };
    // Integer arithmetic makes the round-to-nearest budget deterministic.
    let budget =
        ((profile.max_output_tokens * percent + 50) / 100).clamp(1024, profile.max_output_tokens);
    (
        Some(Thinking::Mode(ThinkingMode::Enabled {
            budget_tokens: Some(budget),
        })),
        None,
    )
}
