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

//! Bounded title prompt policy for an authorized auxiliary model call.
use maka_agent_ports::llm::{Generate, Language};
use maka_agent_ports::session::title::Policy;
use unicode_normalization::UnicodeNormalization;

/// A single display-safe NFC title, bounded by Unicode code points.
pub fn normalize(input: &str) -> Option<String> {
    let cleaned: String = input
        .nfc()
        .filter_map(|ch| match ch as u32 {
            0x200b..=0x200d | 0x2060..=0x2064 | 0xfeff => None,
            0..=0x1f
            | 0x7f..=0x9f
            | 0x61c
            | 0x200e..=0x200f
            | 0x202a..=0x202e
            | 0x2066..=0x206f => Some(' '),
            _ => Some(ch),
        })
        .collect();
    let title: String = cleaned
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect();
    (!title.is_empty()).then_some(title)
}

pub struct Title;
impl Policy for Title {
    fn prepare(&self, text: &str, language: Language) -> Option<Generate> {
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        let system = maka_agent_facts::i18n::session::title_system(language);
        let instruction = maka_agent_facts::i18n::session::title_instruction(language);
        // Some models answer a bare request ("help me summarize this") instead
        // of naming it, so the message is quoted as material.
        Some(Generate {
            language,
            system: Some(system.into()),
            prompt: format!(
                "<message>\n{}\n</message>\n\n{instruction}",
                text.chars().take(4096).collect::<String>()
            ),
            max_output_tokens: Some(2048),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_request_quotes_the_message_as_material() {
        for (language, rule) in [
            (Language::EN, "main language of the session"),
            (Language::ZH_CN, "会话的主要语言"),
            (Language::ZH_TW, "工作階段的主要語言"),
        ] {
            let request = Title.prepare(" 帮我补充、总结和续写 ", language).unwrap();
            assert_eq!(request.language, language);
            assert!(request.system.unwrap().contains(rule));
            assert!(
                request
                    .prompt
                    .starts_with("<message>\n帮我补充、总结和续写\n</message>\n\n")
            );
        }
    }

    #[test]
    fn title_request_bounds_its_material() {
        assert!(Title.prepare("  ", Language::EN).is_none());
        let request = Title.prepare(&"中".repeat(5000), Language::ZH_CN).unwrap();
        assert_eq!(request.prompt.matches('中').count(), 4096);
        assert_eq!(request.max_output_tokens, Some(2048));
        assert!(request.validate().is_ok());
        assert_eq!(
            normalize("  cafe\u{301}\n\u{202e}two\u{200b}  ").as_deref(),
            Some("café two")
        );
        assert_eq!(normalize(&"🦊".repeat(81)).unwrap().chars().count(), 80);
        assert!(normalize("\u{200b}\u{202e} \n").is_none());
    }
}
