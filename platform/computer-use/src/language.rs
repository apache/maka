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

//! Invocation-owned copy for CUA documentation and recovery guidance.
use maka_agent_facts::language::Language;

#[cfg(feature = "native-desktop")]
pub(crate) fn documentation(language: Language) -> &'static str {
    let source = documentation_source(language);
    source
        .split_once("<!-- named-browser-documents -->")
        .map_or(source, |(text, _)| text)
}

#[cfg(feature = "native-desktop")]
fn documentation_source(language: Language) -> &'static str {
    match language {
        Language::En => include_str!("api.md"),
        Language::ZhCn => include_str!("api.zh-CN.md"),
        Language::ZhTw => include_str!("api.zh-TW.md"),
    }
}

/// Read an exact named document from the same localized source as the general API.
/// Name availability is not a capability grant or a claim that its feature is enabled.
#[cfg(feature = "native-desktop")]
pub(crate) fn named_documentation(language: Language, name: &str) -> Option<&'static str> {
    let source = documentation_source(language)
        .split_once("<!-- named-browser-documents -->")?
        .1;
    for block in source.split("<!-- browser-document: ").skip(1) {
        let (names, body) = block.split_once(" -->")?;
        let (body, _) = body.split_once("<!-- /browser-document -->")?;
        if names
            .split_ascii_whitespace()
            .any(|candidate| candidate == name)
        {
            return Some(body.strip_prefix('\n').unwrap_or(body));
        }
    }
    None
}

pub fn reset(language: Language) -> &'static str {
    match language {
        Language::En => "Computer Use REPL reset. Bind targets again.",
        Language::ZhCn => "Computer Use REPL 已重置。请重新绑定目标。",
        Language::ZhTw => "Computer Use REPL 已重設。請重新綁定目標。",
    }
}
pub fn partial_observations(language: Language) -> &'static str {
    match language {
        Language::En => {
            "\nObservations emitted before failure (actions may already have completed):\n"
        }
        Language::ZhCn => "\n失败前输出的观察（操作可能已经完成）：\n",
        Language::ZhTw => "\n失敗前輸出的觀察（操作可能已經完成）：\n",
    }
}
pub fn closed(language: Language) -> &'static str {
    match language {
        Language::En => {
            "\nThis REPL is closed. Call cua_reset and rebind targets. Dispatched input may already have taken effect."
        }
        Language::ZhCn => {
            "\n此 REPL 已关闭。请调用 cua_reset 并重新绑定目标。已派发的输入可能已经生效。"
        }
        Language::ZhTw => {
            "\n此 REPL 已關閉。請呼叫 cua_reset 並重新綁定目標。已派發的輸入可能已經生效。"
        }
    }
}
#[cfg(feature = "native-desktop")]
pub(crate) fn uncertain(language: Language) -> &'static str {
    match language {
        Language::En => {
            "The driver did not verify the requested effect; repeating the action may duplicate it."
        }
        Language::ZhCn => "驱动未验证请求的效果；重复操作可能产生重复效果。",
        Language::ZhTw => "驅動程式未驗證請求的效果；重複操作可能產生重複效果。",
    }
}

#[cfg(feature = "native-desktop")]
pub(crate) fn inactive(language: Language) -> &'static str {
    match language {
        Language::En => "Computer Use session is inactive. Call cua_reset and rebind targets.",
        Language::ZhCn => "Computer Use 会话已失效。请调用 cua_reset 并重新绑定目标。",
        Language::ZhTw => "Computer Use 工作階段已失效。請呼叫 cua_reset 並重新綁定目標。",
    }
}
#[cfg(feature = "native-desktop")]
pub(crate) fn terminal(language: Language) -> &'static str {
    match language {
        Language::En => {
            "\nCall cua_reset and rebind targets. This refused operation did not dispatch input."
        }
        Language::ZhCn => "\n请调用 cua_reset 并重新绑定目标。此次被拒绝的操作未派发输入。",
        Language::ZhTw => "\n請呼叫 cua_reset 並重新綁定目標。此次被拒絕的操作未派發輸入。",
    }
}
#[cfg(feature = "native-desktop")]
pub(crate) fn background_unavailable(language: Language) -> &'static str {
    match language {
        Language::En => {
            "Background input is unavailable for this control on the current desktop. Use an indexed accessibility action if one is exposed by app.getAXState(); otherwise this action requires a supported desktop input backend. The public Cua API cannot switch this call to foreground delivery."
        }
        Language::ZhCn => {
            "当前桌面上的此控件不支持后台输入。若 app.getAXState() 提供了索引无障碍操作，请使用该操作；否则需要支持此输入的桌面后端。公开 Cua API 无法将此次调用切换为前台交付。"
        }
        Language::ZhTw => {
            "目前桌面上的此控制項不支援背景輸入。若 app.getAXState() 提供了索引輔助使用操作，請使用該操作；否則需要支援此輸入的桌面後端。公開 Cua API 無法將此次呼叫切換為前景交付。"
        }
    }
}

// CDP preserves the original error and uncertainty class; the accepted browser
// dispatch owns this warning for every unknown outcome.
#[cfg(feature = "native-desktop")]
pub(crate) fn browser_unknown(language: Language) -> &'static str {
    match language {
        Language::En => "; repeating a mutation may duplicate its effects",
        Language::ZhCn => "；重复变更操作可能产生重复效果",
        Language::ZhTw => "；重複變更操作可能產生重複效果",
    }
}

#[cfg(all(test, feature = "native-desktop"))]
mod named_documentation_tests {
    use super::*;

    #[test]
    fn named_lookup_is_exact_and_cannot_become_a_filesystem_path() {
        for language in [Language::En, Language::ZhCn, Language::ZhTw] {
            assert!(named_documentation(language, "session-naming").is_some());
            assert!(named_documentation(language, "capabilities/browser/viewport").is_some());
            for missing in [
                "",
                " session-naming",
                "session-naming ",
                "Session-Naming",
                "../api",
                "__proto__",
            ] {
                assert!(
                    named_documentation(language, missing).is_none(),
                    "accepted {missing:?}"
                );
            }
            assert!(!documentation(language).contains("<!-- named-browser-documents -->"));
            assert!(!documentation(language).contains("<!-- browser-document: "));
        }
    }
}
