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

use super::super::{Pty, support};
use fixture::*;
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, time::Duration};

mod fixture;
mod host;

#[test]
fn skill_library_import_install_update_and_reviewed_delete_through_real_host_pty() {
    let directory = tempfile::Builder::new()
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let workspace = directory.path().join("workspace");
    let user_library = directory.path().join("user-library");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&user_library).unwrap();
    let original = document("Original instructions");
    let updated = document("Updated instructions");
    let local = document("My local edit");
    let import = workspace.join("import-source/review.md");
    fs::create_dir_all(import.parent().unwrap()).unwrap();
    fs::write(&import, &original).unwrap();
    fs::write(import.parent().unwrap().join("notes.txt"), b"not imported").unwrap();
    let original_tree = tree(import.parent().unwrap());
    let source = user_library.join(".maka/skill-sources/review");
    let host = crate::candidate::CandidateFixture::new(directory.path().join("root"));
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let stop = tokio_util::sync::CancellationToken::new();
    let _cleanup = stop.clone().drop_guard();
    let (server, registration, client, provider) = runtime.block_on(async {
        let (server, registration) = host::serve(&host.root, &user_library, stop.clone()).await;
        let provider = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = support::model_client(&host.root, &format!("http://{}/v1", provider.local_addr().unwrap())).await;
        client.create_session(maka_protocol::session::decode_session_create_input(&json!({
            "sessionId":"skill-library", "name":"Library session", "workspace":{"kind":"host_path","path":workspace},
            "sandboxMode":"read-only", "modelTarget":{"kind":"default"}
        })).unwrap()).await.unwrap();
        (server, registration, client, provider)
    });
    let args = ["--root", host.root.to_str().unwrap()];
    let mut tui = Pty::spawn_at(&args, Some(&workspace));
    tui.wait_for("Library session");
    tui.click_text("Library session");
    tui.wait_for("No messages yet.");
    tui.command("Plugin pages");
    tui.wait_for("Skill library");
    tui.click_text("Skill library");
    tui.wait_for("Browse sources");
    tui.click_text("Browse sources");
    // The tabs also exist on the old installed page. Wait for the destination
    // content before sending another navigation click.
    tui.wait_for("Computer Use");
    tui.click_text("Local sources");
    tui.wait_for("Import Markdown");
    tui.click_text("Import Markdown");
    tui.wait_for("Absolute file path on the Host");
    enter_path(&mut tui, &import);
    tui.send(b"\r"); // The import field's primary action requests consent.
    tui.wait_for("Allow plugin access?");
    tui.wait_for(user_library.to_str().unwrap());
    let status = runtime.block_on(read(
        &client,
        "user-authorization",
        json!({"kind":"status"}),
    ));
    assert_eq!(
        status["target"],
        json!({"kind":"directory","path":user_library})
    );
    assert!(status["grant"].is_null());
    tui.send(b"\r"); // The shell focuses Cancel by default.
    tui.wait_until(|s| !s.contains("Allow plugin access?") && s.contains("review.md"));
    assert!(!source.exists());
    assert_eq!(tree(import.parent().unwrap()), original_tree);
    assert!(
        runtime.block_on(read(
            &client,
            "user-authorization",
            json!({"kind":"status"})
        ))["grant"]
            .is_null()
    );
    tui.click_last_text("Import Markdown");
    tui.wait_for("Allow plugin access?");
    tui.click_text("Allow and continue");
    tui.wait_for(NAME);
    assert_eq!(tree(&source), files(&[("SKILL.md", original.as_bytes())]));
    tui.click_text(NAME);
    tui.wait_for("Maka skill library (shared by sessions in this profile)");
    tui.click_text("Install");
    tui.wait_for("Review deletion");
    let installed = installed(&host.root);
    verify(&installed, &original);
    assert!(!workspace.join(".maka/skills").exists());
    assert!(!user_library.join(".maka/skills/review").exists());
    assert!(!user_library.join(".agents/skills/review").exists());
    tui.click_text("Pinned");
    tui.click_text("Save");
    tui.wait_for("✓ Save");
    let catalog = runtime.block_on(read(
        &client,
        "request",
        json!({"kind":"catalog","view":"governance","page":null}),
    ));
    let item = catalog["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["ref"] == REFERENCE)
        .unwrap();
    assert_eq!(item["enabled"], true);
    assert_eq!(item["pinned"], true);
    assert_eq!(
        item["path"],
        installed.canonicalize().unwrap().to_str().unwrap()
    );
    let picked_candidate = runtime
        .block_on(candidate(&client))
        .expect("installed exact reference is selectable");
    tui.click_text("Library session");
    tui.wait_for("No messages yet.");
    tui.click_text("Settings");
    tui.wait_for("Interface");
    tui.click_text("Interface");
    tui.wait_for("Unicode ▾");
    tui.click_text("Icons");
    tui.wait_for("○ ASCII");
    tui.send(b"\x1b[B\r");
    tui.wait_for("ASCII v");
    tui.click_text("Library session");
    tui.wait_until(|screen| screen.contains("No messages yet.") && !screen.contains("ASCII v"));
    tui.command("Skills");
    tui.wait_for("Selected · 0"); // Composer picker, distinct from the Skills plugin page.
    tui.wait_for(NAME);
    tui.click_text(NAME);
    tui.wait_for("Selected · 1");
    tui.resize(80, 24);
    tui.wait_for("Selected · 1");
    outside(&mut tui, "Selected · 1");
    tui.close_terminal();
    tui.finish();
    let checkpoint = directory
        .path()
        .join("tui-state")
        .join(&client.identity.root_id)
        .join("default/state.json");
    let picked = selection(&checkpoint, &picked_candidate);
    let mut tui = Pty::spawn_at(
        &["--root", host.root.to_str().unwrap(), "--locale", "zh-CN"],
        Some(&workspace),
    );
    tui.wait_for(NAME);
    tui.wait_for("fixture-model");
    tui.resize(80, 24);
    chinese_command(&mut tui, "技能");
    tui.wait_for("已选 · 1");
    tui.click_text("已选 · 1");
    tui.wait_for(&format!("[x] {NAME}")); // Restored ASCII picker, same selected identity.
    outside(&mut tui, "已选 · 1");
    tui.resize(120, 40);
    chinese_command(&mut tui, "插件页面");
    tui.wait_for("技能库");
    tui.click_text("技能库");
    tui.wait_for(NAME);
    tui.click_text(NAME);
    tui.wait_for("审核更新");

    // These are external edits, never a substitute for the lifecycle UI writes.
    fs::write(installed.join("notes.txt"), b"keep my resource").unwrap();
    fs::write(installed.join("SKILL.md"), &local).unwrap();
    fs::write(source.join("SKILL.md"), &updated).unwrap();
    let before = tree(&installed);
    tui.click_text("审核更新");
    reveal(&mut tui, "My local edit");
    reveal(&mut tui, "Updated instructions");
    reveal(&mut tui, "应用更新");
    tui.click_text("应用更新");
    tui.wait_for("取消");
    tui.send(b"\r");
    tui.wait_until(|s| !s.contains("取消") && s.contains("应用更新"));
    assert_eq!(
        tree(&installed),
        before,
        "cancel preserves the entire installation"
    );
    assert_eq!(
        fs::read(source.join("SKILL.md")).unwrap(),
        updated.as_bytes()
    );
    assert_eq!(tree(import.parent().unwrap()), original_tree);
    tui.click_text("应用更新");
    tui.wait_for("取消");
    tui.send(b"\t\r"); // Deliberately leave Cancel and replace local edits.
    tui.wait_for("审核删除");
    verify(&installed, &updated);
    assert_eq!(
        fs::read(installed.join("notes.txt")).unwrap(),
        b"keep my resource"
    );

    // An unrelated user skill deliberately shares the name, never the identity.
    let unrelated = user_library.join(".agents/skills/keep/SKILL.md");
    fs::create_dir_all(unrelated.parent().unwrap()).unwrap();
    fs::write(&unrelated, document("Unrelated user skill")).unwrap();
    let unrelated_tree = tree(unrelated.parent().unwrap());
    tui.click_text("审核删除");
    tui.wait_for("notes.txt");
    reveal(&mut tui, "删除技能目录");
    tui.click_text("删除技能目录");
    tui.wait_for("永久删除审核过的技能目录及其全部资源？");
    let reviewed = tree(&installed);
    tui.send(b"\r");
    tui.wait_until(|s| !s.contains("取消") && s.contains("删除技能目录"));
    assert_eq!(tree(&installed), reviewed);
    tui.click_text("删除技能目录");
    tui.wait_for("永久删除审核过的技能目录及其全部资源？");
    fs::write(
        installed.join("notes.txt"),
        b"changed after deletion review",
    )
    .unwrap();
    let changed = tree(&installed);
    tui.send(b"\t\r");
    tui.wait_for("审核过的文件已变化");
    assert_eq!(
        tree(&installed),
        changed,
        "an old review cannot delete changed resources"
    );
    tui.click_text("刷新");
    // Refresh clears the refusal while the old review is still visible. Wait
    // for the read to finish before confirming its new operation/tree digest.
    tui.wait_until(|s| {
        !s.contains("审核过的文件已变化") && !s.contains("正在加载") && s.contains("notes.txt")
    });
    reveal(&mut tui, "删除技能目录");
    tui.click_text("删除技能目录");
    tui.wait_for("永久删除审核过的技能目录及其全部资源？");
    tui.send(b"\t\r");
    tui.wait_until(|s| !s.contains("删除技能目录") && s.contains("本地来源"));
    assert!(!installed.exists());
    assert_eq!(tree(&source), files(&[("SKILL.md", updated.as_bytes())]));
    assert_eq!(tree(import.parent().unwrap()), original_tree);
    assert_eq!(tree(unrelated.parent().unwrap()), unrelated_tree);
    assert!(!workspace.join(".maka/skills").exists());
    assert!(runtime.block_on(candidate(&client)).is_none());
    tui.close_terminal();
    tui.finish();
    assert_eq!(
        selection(&checkpoint, &picked_candidate),
        picked,
        "deletion must not silently retarget a composer draft"
    );
    runtime.block_on(async {
        assert!(
            tokio::time::timeout(Duration::from_millis(50), provider.accept())
                .await
                .is_err(),
            "library management must not execute a model"
        );
    });
    client.disconnect();
    stop.cancel();
    runtime
        .block_on(async { tokio::time::timeout(Duration::from_secs(10), server).await })
        .unwrap()
        .unwrap()
        .unwrap();
    registration.remove().unwrap();
}
