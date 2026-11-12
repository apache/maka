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

use maka_agent_facts::display::Text;
use maka_agent_facts::read::{ReadInput, ReadRequest};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Copy)]
pub(crate) enum Kind {
    Read,
    ReadImage,
    Write,
    Edit,
    Patch,
    Glob,
    List,
    Grep,
    Fetch,
    Search,
    CreateSession,
    ForkSession,
    SendSession,
}

impl Kind {
    pub(super) fn render(self, input: &Value) -> Option<Text> {
        // ToolCatalog has validated this already parsed input against its schema.
        let target = match self {
            Self::Read | Self::ReadImage | Self::Write | Self::Edit | Self::List => &input["path"],
            Self::Patch => &input["operation"]["path"],
            Self::Glob | Self::Grep => &input["pattern"],
            Self::Fetch => &input["url"],
            Self::CreateSession | Self::ForkSession => &input["title"],
            Self::SendSession => &input["message"],
            Self::Search => &input["query"],
        };
        let continuation = match self {
            Self::Read => ReadInput::deserialize(input)
                .ok()
                .and_then(|read| read.resolve().ok())
                .filter(ReadRequest::is_continuation),
            _ => None,
        };
        let target = continuation
            .as_ref()
            .map_or_else(|| target.as_str(), |read| Some(read.path()))?;
        if matches!(self, Self::SendSession) {
            let line = target.lines().find(|line| !line.trim().is_empty())?.trim();
            let mut chars = line.chars();
            let mut preview: String = chars.by_ref().take(96).collect();
            if chars.next().is_some() {
                preview.push('…');
            }
            return self.render_target(&preview, false);
        }
        self.render_target(target, continuation.is_some())
    }

    pub(crate) fn render_target(self, target: &str, continuation: bool) -> Option<Text> {
        let (en, zh, tw) = match self {
            Self::Read => ("Read file", "读取文件", "讀取檔案"),
            Self::ReadImage => ("Read image", "读取图片", "讀取圖片"),
            Self::Write => ("Write file", "写入文件", "寫入檔案"),
            Self::Edit => ("Edit file", "编辑文件", "編輯檔案"),
            Self::Patch => ("Patch file", "修补文件", "修補檔案"),
            Self::Glob => ("Find files", "查找文件", "尋找檔案"),
            Self::List => ("List directory", "列出目录", "列出目錄"),
            Self::Grep => ("Search files", "搜索文件", "搜尋檔案"),
            Self::Fetch => ("Read web page", "读取网页", "讀取網頁"),
            Self::Search => ("Search the web", "搜索网络", "搜尋網路"),
            Self::CreateSession => ("Create conversation", "创建会话", "建立對話"),
            Self::ForkSession => ("Branch conversation", "从会话分支", "從對話建立分支"),
            Self::SendSession => ("Send message to agent", "向协作者发消息", "傳訊息給協作者"),
        };
        let target = Text::single_line(target)?.fallback;
        let (en_more, zh_more, tw_more) = if continuation {
            (" · continued", " · 续读", " · 續讀")
        } else {
            ("", "", "")
        };
        Some(Text::localized(
            &format!("{en} · {target}{en_more}"),
            &format!("{zh} · {target}{zh_more}"),
            &format!("{tw} · {target}{tw_more}"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn continued_read_names_the_original_path() {
        let first = json!({"path": "src/main.rs"});
        assert_eq!(
            Kind::Read.render(&first).unwrap().fallback,
            "Read file · src/main.rs"
        );
        let next = json!({
            "path": "maka://read/c3JjL21haW4ucnM?at=120&sha=0123456789abcdef0123456789abcdef"
        });
        assert_eq!(
            Kind::Read.render(&next).unwrap().fallback,
            "Read file · src/main.rs · continued"
        );
    }
}
