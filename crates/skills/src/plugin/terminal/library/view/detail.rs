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
use terminal_ui::view::Confirm;

pub(in crate::plugin::terminal::library) fn skill(
    item: &GovernanceItem,
    stamp: &Stamp,
    cx: &Cx,
) -> View {
    let enabled = !item.needs_review && item.runtime_status != SkillRuntimeStatus::StateError;
    let mut nodes = vec![text(
        "description",
        clipped(&item.description, 8192, true),
        Tone::Normal,
    )];
    if item.reference.starts_with("workspace:legacy:") {
        nodes.push(text("ownership", Copy::Destination.text(cx), Tone::Muted));
    }
    if let Some(path) = &item.path {
        nodes.push(text("location", clean(path, true), Tone::Normal));
    }
    nodes.extend([
        input("enabled", "enabled", Copy::Enabled.text(cx)),
        input("pinned", "pinned", Copy::Pinned.text(cx)),
        button("save", "save", Role::Primary),
    ]);
    if matches!(
        item.managed_update_status,
        Some(
            ManagedUpdateStatus::UpdateAvailable
                | ManagedUpdateStatus::LocalModified
                | ManagedUpdateStatus::UpToDate
        )
    ) {
        nodes.push(
            link(
                "review-update",
                Copy::ReviewUpdate.text(cx),
                Route::Preview {
                    reference: item.reference.clone(),
                }
                .value(),
            )
            .into(),
        );
    }
    if item.manageable
        && (item.reference.starts_with("workspace:legacy:") || item.reference.starts_with("user:"))
    {
        nodes.push(
            link(
                "review-delete",
                Copy::DeleteReview.text(cx),
                Route::Delete {
                    reference: item.reference.clone(),
                }
                .value(),
            )
            .tone(Tone::Warning)
            .into(),
        );
    }
    let mut screen = screen(clipped(&item.name, 256, false), stamp, nodes);
    screen.fields = vec![
        toggle("enabled", item.enabled),
        toggle("pinned", item.pinned),
    ];
    for field in &mut screen.fields {
        field.enabled = enabled;
    }
    let mut save = action("save", Copy::Save.text(cx));
    save.enabled = enabled;
    save.fields = vec!["enabled".into(), "pinned".into()];
    screen.actions.push(save);
    screen
}
pub(in crate::plugin::terminal::library) fn preview(
    route: &Route,
    item: &GovernanceItem,
    stamp: &Stamp,
    preview: &PreviewOutcome,
    cx: &Cx,
) -> View {
    let PreviewOutcome::Preview {
        current_snippet: current,
        source_snippet: source,
        current_truncated,
        source_truncated,
        has_managed_baseline: baseline,
        summary,
        ..
    } = preview
    else {
        unreachable!()
    };
    let count = cx.t(
        &format!(
            "{} current lines; {} source lines; {} differing lines",
            summary.current_line_count, summary.source_line_count, summary.changed_line_count
        ),
        &format!(
            "当前 {} 行；来源 {} 行；差异 {} 行",
            summary.current_line_count, summary.source_line_count, summary.changed_line_count
        ),
        &format!(
            "目前 {} 行；來源 {} 行；差異 {} 行",
            summary.current_line_count, summary.source_line_count, summary.changed_line_count
        ),
    );
    let mut nodes = vec![
        text("summary", count, Tone::Muted),
        heading("current-label", Copy::Current.text(cx)),
        scroll("current-scroll", 12, code("current", clean(current, true))),
        heading("source-label", Copy::Upstream.text(cx)),
        scroll("source-scroll", 12, code("source", clean(source, true))),
    ];
    if *current_truncated || *source_truncated {
        nodes.push(text("truncated", Copy::Truncated.text(cx), Tone::Warning));
    }
    if item.user_modified {
        nodes.push(text(
            "local-edits",
            Copy::LocalEdits.text(cx),
            Tone::Warning,
        ));
    }
    if !*baseline {
        nodes.push(text("baseline", Copy::NoBaseline.text(cx), Tone::Warning));
    }
    nodes.extend([
        button("apply", "apply", Role::Primary),
        back(&item.reference, cx),
    ]);
    let mut screen = screen(Copy::ReviewUpdate.text(cx), stamp, nodes);
    let mut apply = offered("apply", Copy::Apply, route, stamp, cx);
    apply.enabled = *baseline;
    if item.user_modified {
        apply.confirm = Some(Confirm {
            title: Copy::Apply.text(cx),
            message: Copy::LocalEdits.text(cx),
            destructive: true,
        });
    }
    screen.actions.push(apply);
    screen
}
pub(in crate::plugin::terminal::library) fn delete(
    route: &Route,
    item: &GovernanceItem,
    stamp: &Stamp,
    paths: &[String],
    cx: &Cx,
) -> View {
    let mut nodes = vec![
        heading("name", clipped(&item.name, 256, false)),
        text("hint", Copy::DeleteHint.text(cx), Tone::Warning),
    ];
    if let Some(path) = &item.path {
        nodes.push(text("location", clean(path, true), Tone::Normal));
    }
    let manifest = paths.join("\n");
    nodes.extend([
        scroll(
            "resources",
            12,
            code("tree", clipped(&manifest, 24 * 1024, true)),
        ),
        button("delete", "delete", Role::Destructive),
        back(&item.reference, cx),
    ]);
    if manifest.len() > 24 * 1024 {
        nodes.push(text(
            "truncated",
            cx.t(
                "The resource list is truncated; all paths and contents are bound to this review.",
                "资源列表已截断；审核绑定了全部路径和内容。",
                "資源清單已截斷；審核綁定了全部路徑和內容。",
            ),
            Tone::Warning,
        ));
    }
    let mut screen = screen(Copy::DeleteReview.text(cx), stamp, nodes);
    let mut delete = offered("delete", Copy::Delete, route, stamp, cx);
    delete.confirm = Some(Confirm {
        title: clipped(&item.name, 256, false),
        message: delete_message(
            Copy::DeleteConfirm.text(cx),
            item.path.as_deref(),
            Copy::DeleteLocationReview.text(cx),
        ),
        destructive: true,
    });
    screen.actions.push(delete);
    screen
}
pub(in crate::plugin::terminal::library) fn resume(stamp: &Stamp, cx: &Cx) -> View {
    let mut screen = screen(
        Copy::Resume.text(cx),
        stamp,
        vec![
            text("hint", Copy::RecoveryHint.text(cx), Tone::Warning),
            button("resume", "resume", Role::Primary),
        ],
    );
    screen.actions.push(action("resume", Copy::Resume.text(cx)));
    screen
}

fn delete_message(prompt: String, path: Option<&str>, review_hint: String) -> String {
    let Some(path) = path else {
        return prompt;
    };
    let full = format!("{prompt}\n\n{}", clean(path, true));
    // Confirmation messages are limited to 1024 bytes by the public view
    // contract. The review page always wraps the complete path, even here.
    if full.len() <= 1024 {
        full
    } else {
        format!("{prompt}\n\n{review_hint}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deletion_confirmation_keeps_exact_paths_or_points_to_the_complete_review() {
        let path = format!(
            "/tmp/skill-library/root/plugin-data/{}/skills/review",
            "a".repeat(64)
        );
        let long_path = format!("/tmp/{}/skills/review", "長".repeat(1300));
        for (prompt, hint) in [
            (
                "Delete this directory?",
                "Review the complete path on the preceding page.",
            ),
            ("删除此目录？", "请在前一审核页核对完整路径。"),
            ("刪除此目錄？", "請在前一審核頁核對完整路徑。"),
        ] {
            let exact = delete_message(prompt.into(), Some(&path), hint.into());
            assert!(exact.ends_with(&path));
            let bounded = delete_message(prompt.into(), Some(&long_path), hint.into());
            assert_eq!(bounded, format!("{prompt}\n\n{hint}"));
            for (message, location) in [(exact, path.as_str()), (bounded, long_path.as_str())] {
                let view = View {
                    version: terminal_ui::VERSION,
                    title: "Deletion review".into(),
                    revision: "review".into(),
                    fields: vec![],
                    actions: vec![Action {
                        confirm: Some(Confirm {
                            title: "Delete".into(),
                            message,
                            destructive: true,
                        }),
                        ..action("delete", "Delete")
                    }],
                    root: column(
                        "review",
                        vec![
                            text("location", location, Tone::Normal),
                            button("delete", "delete", Role::Destructive),
                        ],
                    ),
                };
                view.validate().unwrap();
            }
        }
    }
}
