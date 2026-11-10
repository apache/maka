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

//! AppKit integration tests run on the process main thread, never a libtest worker.
#[cfg(target_os = "macos")]
mod cases;

fn main() -> std::process::ExitCode {
    let args: Vec<_> = std::env::args().skip(1).collect();
    #[cfg(target_os = "macos")]
    let cases: &[(&str, fn())] = &[
        (
            "native_focus_survives_updates_and_revokes_removed_and_modal_editors",
            cases::focus_admission,
        ),
        (
            "delayed_native_image_invalidates_idle_capture_without_input_or_js",
            cases::delayed_image,
        ),
        (
            "pending_focus_fence_holds_editing_shortcuts_paste_and_reports_stranded_text",
            cases::focus_fence_without_queued_text,
        ),
        (
            "desktop_composing_escape_cancels_marked_text_without_blurring_or_dismissing_modal",
            cases::desktop_composing_escape,
        ),
        (
            "hidden_and_clipped_subtrees_exclude_pressables_and_revoke_focus",
            cases::subtree_reachability,
        ),
        (
            "box_none_input_takes_keyboard_focus_and_typing",
            cases::box_none_input_focus,
        ),
        (
            "native_input_shortcuts_copy_cut_paste_and_undo_without_global_pasteboard",
            cases::native_input_clipboard_and_undo,
        ),
        (
            "rich_editor_to_box_none_input_focus_transition_copies_and_submits",
            cases::rich_editor_to_box_none_input_focus_transition,
        ),
        (
            "unfocused_readonly_input_mount_preserves_focused_target_until_focused",
            cases::unfocused_readonly_input_preserves_focused_target,
        ),
        (
            "rich_editor_composition_commit_matches_preedit_and_keeps_shortcuts",
            cases::rich_editor_composition_commit_matches_preedit,
        ),
    ];
    #[cfg(not(target_os = "macos"))]
    let cases: &[(&str, fn())] = &[];
    let mut filter = None;
    let mut skips = Vec::new();
    let mut arguments = args.iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--format" | "--color" | "--test-threads" => {
                arguments.next();
            }
            "--skip" => {
                if let Some(skip) = arguments.next() {
                    skips.push(skip);
                }
            }
            value if !value.starts_with('-') => filter = Some(value),
            _ => {}
        }
    }
    let selected: Vec<_> = cases
        .iter()
        .filter(|(name, _)| {
            !args.iter().any(|arg| arg == "--ignored")
                && filter.is_none_or(|filter| {
                    if args.iter().any(|arg| arg == "--exact") {
                        *name == filter
                    } else {
                        name.contains(filter)
                    }
                })
                && !skips.iter().any(|skip| name.contains(skip.as_str()))
        })
        .collect();
    if args.iter().any(|arg| arg == "--list") {
        for (name, _) in selected {
            println!("{name}: test");
        }
        return std::process::ExitCode::SUCCESS;
    }
    let mut failed = false;
    for (name, run) in selected {
        print!("test {name} ... ");
        if std::panic::catch_unwind(*run).is_ok() {
            println!("ok");
        } else {
            println!("FAILED");
            failed = true;
        }
    }
    if failed {
        std::process::ExitCode::FAILURE
    } else {
        std::process::ExitCode::SUCCESS
    }
}
