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

//! Computer-use activity wording.
use crate::protocol::*;
use maka_agent_facts::display::Text;

fn clean(text: &str, max: usize) -> String {
    let mut output = String::new();
    for word in text.split_whitespace() {
        if !output.is_empty() && output.len() < max {
            output.push(' ');
        }
        for c in word.chars().filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        }) {
            if output.len() + c.len_utf8() > max {
                return output;
            }
            output.push(c);
        }
    }
    output
}

pub(crate) fn command(command: &Command, bound_target: Option<&str>) -> Text {
    let (en, cn, tw, target) = match command {
        Command::Documentation => (
            "Read computer-use instructions",
            "查看电脑操作说明",
            "查看電腦操作說明",
            None,
        ),
        Command::StartAudioRecording { .. } => (
            "Record computer audio",
            "录制电脑声音",
            "錄製電腦聲音",
            None,
        ),
        Command::StopAudioRecording => (
            "Finish computer audio recording",
            "完成电脑声音录制",
            "完成電腦聲音錄製",
            None,
        ),
        Command::ConfigureCursor { .. } => {
            ("Configure cursor", "设置操作光标", "設定操作游標", None)
        }
        Command::CursorState { .. } => ("Inspect cursor", "查看操作光标", "查看操作游標", None),
        Command::GetState { .. } => ("Inspect desktop", "查看当前桌面", "查看目前桌面", None),
        Command::ListApps { .. } => (
            "List applications",
            "查看应用列表",
            "查看應用程式清單",
            None,
        ),
        Command::ListWindows { .. } => ("List windows", "查看窗口列表", "查看視窗清單", None),
        Command::LaunchApp { app } => (
            "Launch application",
            "打开应用",
            "開啟應用程式",
            Some(app.as_str()),
        ),
        Command::GetApp { target } => (
            "Inspect application",
            "查看应用",
            "查看應用程式",
            match target {
                AppReference::Name(name) => Some(name.as_str()),
                _ => None,
            },
        ),
        Command::Observe { handle, kind, .. } => match kind {
            ObservationKind::Screenshot => {
                ("Capture screenshot", "截取画面", "擷取畫面", bound_target)
            }
            _ => match handle {
                Handle::App(_) => ("Inspect window", "查看窗口", "查看視窗", bound_target),
                Handle::Tab(_) => ("Inspect page", "查看网页", "查看網頁", bound_target),
            },
        },
        Command::ListBrowsers { .. } => ("List browsers", "查看浏览器列表", "查看瀏覽器清單", None),
        Command::ListTabs { .. } => ("List tabs", "查看标签页列表", "查看分頁清單", None),
        Command::GetBrowser { options } => (
            "Connect browser",
            "连接浏览器",
            "連線瀏覽器",
            options.id.as_deref(),
        ),
        Command::BrowserManagedTabs { browser_id }
        | Command::BrowserUserOpenTabs { browser_id } => (
            "List user tabs",
            "查看用户标签页",
            "查看使用者分頁",
            Some(browser_id.as_str()),
        ),
        Command::BrowserUserClaimTab { browser_id, .. } => (
            "Claim tab",
            "接管标签页",
            "接管分頁",
            Some(browser_id.as_str()),
        ),
        Command::GetTab { .. } => ("Connect tab", "连接标签页", "連線分頁", None),
        Command::BrowserTab {
            browser_id,
            reference,
        } => match reference {
            crate::protocol::BrowserTabReference::Existing(_) => (
                "Connect tab",
                "连接标签页",
                "連線分頁",
                Some(browser_id.as_str()),
            ),
            crate::protocol::BrowserTabReference::New => (
                "Open tab",
                "打开标签页",
                "開啟分頁",
                Some(browser_id.as_str()),
            ),
        },
        Command::TabMetadata { .. } | Command::BrowserRead { .. } | Command::GetJsDialog { .. } => {
            ("Inspect page", "查看网页", "查看網頁", bound_target)
        }
        Command::BrowserWait { .. } => ("Wait for page", "等待网页", "等待網頁", bound_target),
        Command::BrowserMutation { .. } => {
            ("Interact with page", "操作网页", "操作網頁", bound_target)
        }
        Command::BrowserDownloadWait { .. } => (
            "Wait for browser download",
            "等待浏览器下载",
            "等待瀏覽器下載",
            bound_target,
        ),
        Command::BrowserDownloadPath { .. } => (
            "Get download path",
            "获取下载路径",
            "取得下載路徑",
            bound_target,
        ),
        Command::BrowserDownloadMedia { .. } => (
            "Download page media",
            "下载网页媒体",
            "下載網頁媒體",
            bound_target,
        ),
        Command::ClipboardRead { .. } | Command::ClipboardReadText { .. } => (
            "Read browser clipboard",
            "读取浏览器剪贴板",
            "讀取瀏覽器剪貼簿",
            bound_target,
        ),
        Command::ClipboardWrite { .. } | Command::ClipboardWriteText { .. } => (
            "Write browser clipboard",
            "写入浏览器剪贴板",
            "寫入瀏覽器剪貼簿",
            bound_target,
        ),
        Command::HandleJsDialog { action, .. } => match action {
            DialogAction::Accept => (
                "Accept browser dialog",
                "确认浏览器对话框",
                "確認瀏覽器對話框",
                bound_target,
            ),
            DialogAction::Dismiss => (
                "Dismiss browser dialog",
                "关闭浏览器对话框",
                "關閉瀏覽器對話框",
                bound_target,
            ),
        },
        Command::CreateBrowserTab { browser_id, .. } => (
            "Open tab",
            "打开标签页",
            "開啟分頁",
            Some(browser_id.as_str()),
        ),
        Command::Action { action, .. } => {
            let (en, cn, tw) = match action {
                Action::MoveCursor { .. } => ("Move cursor", "移动光标", "移動游標"),
                Action::Click { .. } | Action::LinuxClick { .. } => ("Click", "点击", "點擊"),
                Action::Drag { .. } | Action::LinuxDrag { .. } => ("Drag", "拖动", "拖曳"),
                Action::Scroll { .. } | Action::LinuxScroll { .. } => ("Scroll", "滚动", "捲動"),
                Action::SetValue { .. } | Action::TypeText { .. } => {
                    ("Enter text", "输入文本", "輸入文字")
                }
                Action::SelectText { .. } => ("Select text", "选择文本", "選取文字"),
                Action::Paste { .. } => ("Paste", "粘贴", "貼上"),
                Action::PressKey { .. } => ("Press key", "按下按键", "按下按鍵"),
                Action::Secondary { .. } => ("Perform control action", "操作控件", "操作控制項"),
                Action::Navigate { .. } => ("Navigate page", "打开网页", "開啟網頁"),
                Action::Back => ("Go back", "返回上一页", "返回上一頁"),
                Action::Forward => ("Go forward", "前往下一页", "前往下一頁"),
                Action::Reload => ("Reload page", "刷新网页", "重新載入網頁"),
                Action::Close => ("Close tab", "关闭标签页", "關閉分頁"),
            };
            (en, cn, tw, bound_target)
        }
    };
    let target = target
        .map(|target| clean(target, 160))
        .filter(|target| !target.is_empty());
    let phrase = |verb: &str| {
        target
            .as_ref()
            .map_or_else(|| verb.to_owned(), |target| format!("{verb} · {target}"))
    };
    Text::localized(&phrase(en), &phrase(cn), &phrase(tw))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actions_have_localized_titles_without_input_text_or_untrusted_controls() {
        let action: Command = serde_json::from_value(serde_json::json!({"method":"action","handle":{"kind":"app","id":"private"},"action":{"kind":"typeText","text":"password-must-not-enter-activity"}})).unwrap();
        let title = command(&action, Some("Calculator"));
        assert_eq!(title.resolve("zh-CN"), "输入文本 · Calculator");
        assert!(!serde_json::to_string(&title).unwrap().contains("password"));
        command(&action, Some(&"中".repeat(1000)))
            .validate()
            .unwrap();
    }
}
