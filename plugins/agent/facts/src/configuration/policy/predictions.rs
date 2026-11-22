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

//! Preferences and localized instructions for optional composer predictions.
use crate::language::Language;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "MessagePredictionSettings")]
pub struct MessagePredictionSettings {
    pub enabled: bool,
    pub ordinary_sessions_only: bool,
    #[schemars(range(min = 0, max = 100))]
    pub live_sample_percent: f64,
    #[schemars(range(min = 0, max = 100))]
    pub catch_up_sample_percent: f64,
    /// None or blank selects the localized built-in instructions.
    pub prompt: Option<String>,
}
impl Default for MessagePredictionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            ordinary_sessions_only: false,
            live_sample_percent: 100.0,
            catch_up_sample_percent: 50.0,
            prompt: None,
        }
    }
}
impl MessagePredictionSettings {
    pub fn validate(&self) -> Result<(), String> {
        if ![self.live_sample_percent, self.catch_up_sample_percent]
            .into_iter()
            .all(|percent| (0.0..=100.0).contains(&percent))
        {
            return Err("prediction sampling must be between 0 and 100 percent".into());
        }
        Ok(())
    }
}

pub fn default_prediction_prompt(language: Language) -> &'static str {
    match language {
        Language::En => {
            r#"This is an app-generated request for a suggested next user message. The user did not write this message.

Your suggestion will appear in the user's empty message composer. They can accept it, edit it, or ignore it; it will not be sent automatically.

Predict the single message this user is most likely to type next from the visible conversation. Use the whole conversation to understand their current intent and the latest exchange. Choose the action and specific object that best continue that intent, rather than a generally useful follow-up. Express its core naturally in the user's voice, keeping the requirements needed to retain its meaning. Choose the strongest grounded move even if several continuations are possible; uncertainty about exact wording or incidental details is not a reason to return null. Use null only when the conversation offers no grounded next move at all.

Set suggestion to exactly one natural user message, one line, at most 240 characters, or null. No alternatives or explanation."#
        }
        Language::ZhCn => {
            r#"这是一条由应用自动生成的请求，用于提供下一条用户消息的建议。用户并未撰写这条请求。

你的建议会出现在用户的空白消息输入框中。用户可以采纳、修改或忽略它；建议不会自动发送。

根据当前可见的对话，预测这位用户最可能接着输入的那一条消息。结合整段对话，理解用户当前的意图和最近一轮交流。选择最能延续这一意图的行动和具体对象，不要只给出泛泛的后续建议。用用户自己的口吻自然地表达核心意思，并保留维持原意所必需的要求。即使有多种可能的后续，也要选择依据最充分的那一步；不要因为拿不准确切措辞或次要细节，就返回 null。只有在对话完全没有提供任何有依据的下一步时，才返回 null。

将 suggestion 设为一条自然的用户消息，限一行，最多 240 个字符，或设为 null。不要提供备选项或解释。"#
        }
        Language::ZhTw => {
            r#"這是應用程式自動產生的請求，用來提供使用者下一則訊息的建議。這則請求不是使用者寫的。

你的建議會顯示在使用者的空白訊息輸入框中。使用者可以採用、修改或忽略它；建議不會自動傳送。

根據目前可見的對話，預測這位使用者最可能接著輸入的那一則訊息。綜合整段對話，理解使用者目前的意圖和最近一輪的互動。選擇最能延續這個意圖的行動和具體對象，不要只給出泛泛的後續建議。用使用者自己的語氣自然地表達核心意思，並保留維持原意所必需的要求。即使有多種可能的後續，也要選擇依據最充分的下一步；不要因為無法確定具體措辭或次要細節，就回傳 null。只有在對話完全沒有提供任何有根據的下一步時，才回傳 null。

將 suggestion 設為一則自然的使用者訊息，限一行，最多 240 個字元，或設為 null。不要提供其他選項或解釋。"#
        }
    }
}
