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

use super::*;

pub(super) fn prepare(
    catalog: &maka_skills::Catalog<'_>,
    revision: String,
    input: Prepare,
) -> Result<Value, String> {
    if [&input.load_tool, &input.search_tool]
        .into_iter()
        .flatten()
        .any(|name| !catalog.host.tools.contains(name))
    {
        return Err("skills_query_invalid".into());
    }
    let (text, invocation, required_tools) =
        match catalog.prepare_invocation(&input.message, &[], input.language) {
            maka_skills::PreparedInvocation::Passthrough => {
                (None, Default::default(), Default::default())
            }
            maka_skills::PreparedInvocation::Blocked(invocation) => {
                return preparation_json(Preparation::Blocked { invocation });
            }
            maka_skills::PreparedInvocation::Ready {
                text,
                result,
                required_tools,
            } => (Some(text), result, required_tools),
        };
    let metadata_prompt = match input.load_tool {
        Some(load) => {
            let load = serde_json::to_string(&load).map_err(|_| "skills_encoding_failed")?;
            let search = input
                .search_tool
                .map(|name| serde_json::to_string(&name).expect("tool name"));
            let search_instruction = search.as_ref().map_or_else(
                || {
                    maka_agent_facts::i18n::skills::native_search_unavailable(input.language)
                        .to_owned()
                },
                |name| {
                    maka_agent_facts::i18n::skills::native_search_instruction(input.language, name)
                },
            );
            let intro = maka_agent_facts::i18n::skills::native_prompt_intro(
                input.language,
                &load,
                &revision,
                &search_instruction,
            );
            let omitted = search.map_or_else(
                || {
                    maka_agent_facts::i18n::skills::native_omitted_no_search(input.language)
                        .to_owned()
                },
                |name| {
                    maka_agent_facts::i18n::skills::native_omitted_with_search(
                        input.language,
                        &name,
                    )
                },
            );
            catalog.prompt_with(18_000, &intro, &omitted, input.language)
        }
        None => String::new(),
    };
    preparation_json(Preparation::Ready {
        text,
        record: PreparationRecord {
            revision,
            metadata_prompt,
            invocation,
        },
        required_tools,
    })
}
fn preparation_json(value: Preparation) -> Result<Value, String> {
    let value = serde_json::to_value(value).map_err(|_| "skills_encoding_failed")?;
    Ok(value)
}
