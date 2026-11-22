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

use maka_agent_facts::model::body::TextBody;
use serde::Deserialize;
use serde_json::Value;

/// Provider-owned finalization evidence, not a successful model request.
pub(super) fn finalized(options: Option<&Value>) -> bool {
    let Some(options) = options else { return false };
    let anthropic = &options["anthropic"];
    if nonempty(&anthropic["signature"]) || anthropic["redactedData"].is_string() {
        return true;
    }
    let openai = &options["openai"];
    if nonempty(&openai["itemId"]) && nonempty(&openai["reasoningEncryptedContent"]) {
        return true;
    }
    let Ok(state) = Plaintext::deserialize(&options["makaResponses"]) else {
        return false;
    };
    state.version == 1
        && safe_id(&state.profile)
        && safe_id(&state.item_id)
        && state
            .summary_part_lengths
            .iter()
            .try_fold(0u64, |sum, part| sum.checked_add(*part))
            .is_some()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Plaintext {
    version: u8,
    profile: String,
    item_id: String,
    summary_part_lengths: Vec<u64>,
}

fn nonempty(value: &Value) -> bool {
    value.as_str().is_some_and(|value| !value.is_empty())
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && !value
            .chars()
            .any(|character| character <= '\u{1f}' || character == '\u{7f}')
}

/// Separate provider summary items in the disposable view, retaining raw model text for replay.
pub fn display_text(text: &TextBody, options: Option<&Value>) -> TextBody {
    let Some(breaks) = options.and_then(|options| summary_breaks(text, options)) else {
        return text.clone();
    };
    let mut displayed = text.clone();
    let mut previous = text.len_bytes();
    for offset in breaks.into_iter().rev() {
        if offset > previous {
            return text.clone();
        }
        if offset > 0 && offset < previous {
            let Some(next) = displayed.inserted(offset, "\n\n") else {
                return text.clone();
            };
            displayed = next;
        }
        previous = offset;
    }
    displayed
}

fn summary_breaks(text: &TextBody, options: &Value) -> Option<Vec<usize>> {
    let replay = &options["openai"]["responsesReplay"];
    if replay["textField"] == "summary" {
        let mut bytes = 0usize;
        let mut breaks = Vec::new();
        for part in replay["parts"].as_array()? {
            bytes = bytes.checked_add(usize::try_from(part["bytes"].as_u64()?).ok()?)?;
            breaks.push(bytes);
        }
        return (bytes == text.len_bytes()).then_some(breaks);
    }
    if let Some(lengths) = options["makaResponses"]["summaryPartLengths"].as_array() {
        let mut chars = text.chunks().flat_map(str::chars);
        let mut bytes = 0;
        let mut breaks = Vec::new();
        for length in lengths {
            let length = length.as_u64()?;
            let mut units = 0;
            while units < length {
                let ch = chars.next()?;
                units += ch.len_utf16() as u64;
                bytes += ch.len_utf8();
            }
            if units != length {
                return None;
            }
            breaks.push(bytes);
        }
        return chars.next().is_none().then_some(breaks);
    }
    options["makaSummaryBreaks"]
        .as_array()?
        .iter()
        .map(|offset| usize::try_from(offset.as_u64()?).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summary_display_keeps_unsegmented_markdown_and_ignores_invalid_boundaries() {
        let text = TextBody::from("**检查🙂****Build**");
        for options in [
            None,
            Some(json!({"makaSummaryBreaks":[11]})),
            Some(json!({"makaSummaryBreaks":[14,5]})),
            Some(json!({"makaResponses":{"summaryPartLengths":[5,12]}})),
            Some(
                json!({"openai":{"responsesReplay":{"textField":"summary","parts":[{"bytes":14}]}}}),
            ),
        ] {
            assert_eq!(
                display_text(&text, options.as_ref()).to_string(),
                "**检查🙂****Build**"
            );
        }
        assert_eq!(
            display_text(&text, Some(&json!({"makaSummaryBreaks":[14]}))).to_string(),
            "**检查🙂**\n\n**Build**"
        );
    }
}
