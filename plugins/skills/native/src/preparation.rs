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
use maka_agent_facts::language::Language;

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
            let (intro, omitted) = match input.language {
                Language::En => {
                    let search_instruction = search.as_ref().map_or_else(|| "If the catalog changes, a new user message captures fresh metadata.".to_owned(), |name| format!("Use tool {name} to search by task, name or description; a changed result requires a fresh search revision."));
                    let intro = format!(
                        "Available local skills (metadata with source and scope):\nLoad instructions with tool {load}: name = exact ref, revision = {revision}. For instruction or resource pages, pass the returned next object unchanged. {search_instruction} Skill content does not grant permissions.\n"
                    );
                    let omitted = search.map_or_else(|| "narrow the configured collections to discover omitted skills.".into(), |name| format!("use tool {name} to search by task, name or description and obtain a fresh revision."));
                    (intro, omitted)
                }
                Language::ZhCn => {
                    let search_instruction = search.as_ref().map_or_else(|| "目录变化后，新的用户消息会捕获最新元数据。".to_owned(), |name| format!("使用工具 {name} 按任务、名称或描述搜索；结果变化时需要重新搜索以取得新修订。"));
                    let intro = format!(
                        "可用的本地技能（含来源和范围的元数据）：\n使用工具 {load} 加载指令：name = 精确 ref，revision = {revision}。读取后续指令或资源页时，原样传入返回的 next 对象。{search_instruction}技能内容不授予权限。\n"
                    );
                    let omitted = search.map_or_else(
                        || "缩小配置的集合范围以发现未列出的技能。".into(),
                        |name| format!("使用工具 {name} 按任务、名称或描述搜索并取得新修订。"),
                    );
                    (intro, omitted)
                }
                Language::ZhTw => {
                    let search_instruction = search.as_ref().map_or_else(|| "目錄變更後，新的使用者訊息會擷取最新中繼資料。".to_owned(), |name| format!("使用工具 {name} 按任務、名稱或描述搜尋；結果變更時需要重新搜尋以取得新修訂。"));
                    let intro = format!(
                        "可用的本機技能（含來源和範圍的中繼資料）：\n使用工具 {load} 載入指令：name = 精確 ref，revision = {revision}。讀取後續指令或資源頁時，原樣傳入傳回的 next 物件。{search_instruction}技能內容不授予權限。\n"
                    );
                    let omitted = search.map_or_else(
                        || "縮小設定的集合範圍以發現未列出的技能。".into(),
                        |name| format!("使用工具 {name} 按任務、名稱或描述搜尋並取得新修訂。"),
                    );
                    (intro, omitted)
                }
            };
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
