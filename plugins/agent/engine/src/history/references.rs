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

use maka_agent_facts::language::Language;

use crate::RunError;
use maka_agent_facts::attachment::AttachmentKind;
use maka_agent_facts::attachment::AttachmentRef;
use maka_agent_facts::attachment::StorageRef;
use maka_agent_facts::input::MessageInput;
use serde_json::json;

/// The log retains references structurally. Only provider input folds them into
/// text; UI chips and invocation fingerprints never use this derived string.
pub(super) fn text(
    content: &MessageInput,
    resources: &super::resources::Resources<'_>,
    language: Language,
) -> Result<String, RunError> {
    let mut text = content.text.clone();
    if let Some(quotes) = &content.quotes
        && !quotes.is_empty()
    {
        text.push_str("\n\n");
        text.push_str(
            &maka_agent_facts::input::render_quotes(quotes, language)
                .map_err(RunError::Internal)?,
        );
    }
    if let Some(attachments) = &content.attachments
        && !attachments.is_empty()
    {
        text.push_str("\n\n");
        for (index, attachment) in attachments.iter().enumerate() {
            if index != 0 {
                text.push('\n');
            }
            text.push_str(&attachment_text(
                attachment,
                resources.resolve(&attachment.storage_ref),
                language,
            ));
        }
    }
    if let Some(references) = &content.directory_references
        && !references.is_empty()
    {
        text.push_str("\n\n");
        text.push_str(
            &maka_agent_facts::input::render_directory_references(references, language)
                .map_err(RunError::Internal)?,
        );
    }
    if let Some(session_refs) =
        maka_agent_facts::input::render_session_references(&content.text, language)
    {
        text.push_str("\n\n");
        text.push_str(&session_refs);
    }
    Ok(text)
}

fn attachment_text(
    attachment: &AttachmentRef,
    reference: Option<&StorageRef>,
    language: Language,
) -> String {
    let mut text = String::from("<attachment>\n");
    let read_label = match language {
        Language::En => "Read argument",
        Language::ZhCn => "Read 参数",
        Language::ZhTw => "Read 參數",
    };
    let image_label = match language {
        Language::En => "Markdown image source",
        Language::ZhCn => "Markdown 图片来源",
        Language::ZhTw => "Markdown 圖片來源",
    };
    if let Some(resource) = reference.and_then(StorageRef::resource_ref) {
        text.push_str(&format!("{read_label}: {}\n", json!({"path":resource})));
        if attachment.kind == AttachmentKind::Image {
            text.push_str(&format!("{image_label}: {}\n", json!(resource)));
        }
        text.push_str(match language {
            Language::En => {
                "Session resource; the Read path above differs from the display name.\n"
            }
            Language::ZhCn => "会话资源；上面的 Read 路径与显示名称不同。\n",
            Language::ZhTw => "工作階段資源；上面的 Read 路徑與顯示名稱不同。\n",
        });
    } else {
        match reference {
            Some(StorageRef::WorkspaceFile { relative_path }) => {
                text.push_str(&format!(
                    "{read_label}: {}\n",
                    json!({"path":relative_path})
                ));
            }
            Some(StorageRef::ExternalFile { absolute_path }) => {
                text.push_str(&format!(
                    "{read_label}: {}\n",
                    json!({"path":absolute_path})
                ));
            }
            Some(StorageRef::SessionFile { .. } | StorageRef::SessionContext { .. }) | None => text
                .push_str(match language {
                    Language::En => "The attachment content is unavailable to Read.\n",
                    Language::ZhCn => "Read 无法读取该附件内容。\n",
                    Language::ZhTw => "Read 無法讀取該附件內容。\n",
                }),
        }
    }
    text.push_str(&format!(
        "name: {}\nmime_type: {}\n</attachment>",
        json!(attachment.name),
        json!(attachment.mime_type)
    ));
    text
}
