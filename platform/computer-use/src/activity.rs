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
use crate::{language::i18n_catalog::activity as copy, protocol::*};
use maka_agent_facts::display::Text;
use maka_i18n::BuiltinLocale;

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
    type Label = fn(BuiltinLocale) -> &'static str;
    let (label, target): (Label, Option<&str>) = match command {
        Command::NativeComputer { .. } => (copy::use_native_computer, None),
        Command::Documentation | Command::ReadDocumentation { .. } => {
            (copy::read_instructions, None)
        }
        Command::StartAudioRecording { .. } => (copy::start_audio_recording, None),
        Command::StopAudioRecording => (copy::stop_audio_recording, None),
        Command::ConfigureCursor { .. } => (copy::configure_cursor, None),
        Command::CursorState { .. } => (copy::inspect_cursor, None),
        Command::GetState { .. } => (copy::inspect_desktop, None),
        Command::ListApps { .. } => (copy::list_apps, None),
        Command::ListWindows { .. } => (copy::list_windows, None),
        Command::LaunchApp { app } => (copy::launch_app, Some(app.as_str())),
        Command::GetApp { target } => (
            copy::inspect_app,
            match target {
                AppReference::Name(name) => Some(name.as_str()),
                _ => None,
            },
        ),
        Command::Observe { handle, kind, .. } => match kind {
            ObservationKind::Screenshot => (copy::capture_screenshot, bound_target),
            _ => match handle {
                Handle::App(_) => (copy::inspect_window, bound_target),
                Handle::Tab(_) => (copy::inspect_page, bound_target),
            },
        },
        Command::BrowserSelect { .. } => (copy::select_browser, None),
        Command::BrowserSelectedTab { browser_id } => {
            (copy::inspect_selected_tab, Some(browser_id.as_str()))
        }
        Command::BrowserNameSession { browser_id, .. } => {
            (copy::name_browser_session, Some(browser_id.as_str()))
        }
        Command::BrowserHistory { browser_id, .. } => {
            (copy::read_browser_history, Some(browser_id.as_str()))
        }
        Command::BrowserViewportSet { browser_id, .. }
        | Command::BrowserViewportReset { browser_id } => {
            (copy::set_browser_viewport, Some(browser_id.as_str()))
        }
        Command::TabPageAssetsList { .. } => (copy::list_page_assets, bound_target),
        Command::TabPageAssetsBundle { .. } => (copy::save_page_assets, bound_target),
        Command::ListBrowsers { .. } => (copy::list_browsers, None),
        Command::ListTabs { .. } => (copy::list_tabs, None),
        Command::BrowserRelease { browser_id } => {
            (copy::release_browser, Some(browser_id.as_str()))
        }
        Command::GetBrowser { options } => (copy::connect_browser, options.id.as_deref()),
        Command::BrowserManagedTabs { browser_id }
        | Command::BrowserUserOpenTabs { browser_id } => {
            (copy::list_user_tabs, Some(browser_id.as_str()))
        }
        Command::BrowserUserGetTabContext { browser_id, .. } => {
            (copy::read_user_tab_context, Some(browser_id.as_str()))
        }
        Command::BrowserUserClaimTab { browser_id, .. } => {
            (copy::claim_tab, Some(browser_id.as_str()))
        }
        Command::GetTab { .. } => (copy::connect_tab, None),
        Command::BrowserTab {
            browser_id,
            reference,
        } => match reference {
            crate::protocol::BrowserTabReference::Existing(_) => {
                (copy::connect_tab, Some(browser_id.as_str()))
            }
            crate::protocol::BrowserTabReference::New => {
                (copy::open_tab, Some(browser_id.as_str()))
            }
        },
        Command::BrowserScreenshot { .. } => (copy::capture_tab_screenshot, bound_target),
        Command::BrowserMarkTab { .. } => (copy::mark_tab_retention, bound_target),
        Command::TabMetadata { .. }
        | Command::BrowserRead { .. }
        | Command::BrowserEvaluate { .. }
        | Command::GetJsDialog { .. }
        | Command::BrowserCua {
            operation: crate::protocol::BrowserCuaOperation::DomSnapshot,
            ..
        } => (copy::inspect_page, bound_target),
        Command::BrowserWait { .. } => (copy::wait_for_page, bound_target),
        Command::BrowserCua { .. } | Command::BrowserMutation { .. } => {
            (copy::interact_with_page, bound_target)
        }
        Command::BrowserFileChooserWait { .. } => (copy::wait_for_file_chooser, bound_target),
        Command::BrowserFileChooserSetFiles { .. } => (copy::upload_selected_files, bound_target),
        Command::BrowserDownloadWait { .. } => (copy::wait_for_browser_download, bound_target),
        Command::BrowserDownloadPath { .. } => (copy::get_download_path, bound_target),
        Command::BrowserDownloadMedia { .. } => (copy::download_page_media, bound_target),
        Command::ClipboardRead { .. } | Command::ClipboardReadText { .. } => {
            (copy::read_browser_clipboard, bound_target)
        }
        Command::ClipboardWrite { .. } | Command::ClipboardWriteText { .. } => {
            (copy::write_browser_clipboard, bound_target)
        }
        Command::HandleJsDialog { action, .. } => match action {
            DialogAction::Accept => (copy::accept_browser_dialog, bound_target),
            DialogAction::Dismiss => (copy::dismiss_browser_dialog, bound_target),
        },
        Command::CreateBrowserTab { browser_id, .. } => (copy::open_tab, Some(browser_id.as_str())),
        Command::Action { action, .. } => {
            let verb: Label = match action {
                Action::BringToFront => copy::bring_to_front,
                Action::MoveCursor { .. } => copy::move_cursor,
                Action::Click { .. } | Action::LinuxClick { .. } => copy::click,
                Action::Drag { .. } | Action::LinuxDrag { .. } => copy::drag,
                Action::Scroll { .. } | Action::LinuxScroll { .. } => copy::scroll,
                Action::SetValue { .. } | Action::TypeText { .. } => copy::enter_text,
                Action::SelectText { .. } => copy::select_text,
                Action::Paste { .. } => copy::paste,
                Action::PressKey { .. } => copy::press_key,
                Action::Secondary { .. } => copy::perform_control_action,
                Action::Navigate { .. } => copy::navigate_page,
                Action::Back => copy::go_back,
                Action::Forward => copy::go_forward,
                Action::Reload => copy::reload_page,
                Action::Close => copy::close_tab,
            };
            (verb, bound_target)
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
    Text::for_locales(|locale| phrase(label(locale)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actions_have_localized_titles_without_input_text_or_untrusted_controls() {
        let action: Command = serde_json::from_value(serde_json::json!({"method":"action","handle":{"kind":"app","id":"private"},"action":{"kind":"typeText","text":"password-must-not-enter-activity"}})).unwrap();
        let title = command(&action, Some("Calculator"));
        assert_eq!(title.resolve("zh-CN"), "输入文本 · Calculator");
        assert_eq!(title.resolve("zh-TW"), "輸入文字 · Calculator");
        assert_eq!(title.resolve("zh-HK"), "輸入文字 · Calculator");
        assert_eq!(title.resolve("en"), "Enter text · Calculator");
        assert!(!serde_json::to_string(&title).unwrap().contains("password"));
        command(&action, Some(&"中".repeat(1000)))
            .validate()
            .unwrap();
        let bidi = command(&action, Some("A\u{202a}\u{202e}\u{2066}\u{2069}B"));
        bidi.validate().unwrap();
        assert_eq!(bidi.resolve("en"), "Enter text · AB");
    }
}
