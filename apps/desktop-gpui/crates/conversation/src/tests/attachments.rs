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

//! Attachments: "+" opens the file dialog, a paste or a drop on the dock
//! adds files too, they become chips under the draft, and sending uploads
//! each through `artifact.ingest` before the message carries their
//! `AttachmentRef`s, which the message's row shows above its bubble.
#![allow(clippy::disallowed_methods)] // Test fixtures write real files.

use std::path::{Path, PathBuf};

use gpui_kit::{
    ClipboardEntry, ClipboardItem, ClipboardString, ExternalPaths, FileDropEvent, Image,
    ImageFormat, InputEvent as _,
};

use super::*;

/// A fresh directory for one test's files.
fn scratch() -> PathBuf {
    let directory = std::env::temp_dir().join(format!("maka-gpui-attach-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("scratch directory");
    directory
}

fn write(directory: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let path = directory.join(name);
    std::fs::write(&path, bytes).expect("write");
    path
}

const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

fn chip(path: &Path) -> ElementId {
    shared::domain_element_id("composer-attachment", &path.to_string_lossy())
}

fn picked(harness: &Harness, cx: &mut TestAppContext) -> Vec<(String, u64, bool)> {
    harness.composer().read_with(cx, |composer, _| {
        composer
            .attachments()
            .iter()
            .map(|file| (file.name.to_string(), file.bytes, file.image))
            .collect()
    })
}

fn add(harness: &Harness, paths: Vec<PathBuf>, cx: &mut TestAppContext) {
    harness.composer().update(cx, |composer, cx| composer.add_files(paths, cx));
    settle(cx);
}

fn error(harness: &Harness, cx: &mut TestAppContext) -> Option<String> {
    harness.composer().read_with(cx, |composer, _| composer.error().map(ToString::to_string))
}

fn draft(harness: &Harness, cx: &mut TestAppContext) -> String {
    let draft = harness.composer().read_with(cx, |composer, _| composer.draft().clone());
    draft.read_with(cx, |draft, _| draft.value().to_string())
}

/// What Finder puts on the clipboard for copied files: their paths, and
/// their names as text.
fn copied_files(paths: &[PathBuf]) -> ClipboardItem {
    let names: Vec<String> = paths.iter().map(|path| attachment_name(path)).collect();
    ClipboardItem {
        entries: vec![
            ClipboardEntry::ExternalPaths(ExternalPaths(paths.iter().cloned().collect())),
            ClipboardEntry::String(ClipboardString::new(names.join("\n"))),
        ],
    }
}

fn attachment_name(path: &Path) -> String {
    path.file_name().expect("a file name").to_string_lossy().into_owned()
}

/// Puts `item` on the clipboard and presses Cmd+V in the draft.
fn paste(harness: &Harness, item: ClipboardItem, cx: &mut TestAppContext) {
    cx.write_to_clipboard(item);
    let composer = harness.composer().clone();
    harness.with_window(cx, |window, cx| {
        composer.update(cx, |composer, cx| composer.focus(window, cx));
    });
    harness.with_window(cx, |window, cx| window.press("cmd-v", cx));
    settle(cx);
}

/// Drags `paths` in from outside the window and drops them on the element
/// `target`.
fn drop_on(harness: &Harness, target: &'static str, paths: &[PathBuf], cx: &mut TestAppContext) {
    let paths = ExternalPaths(paths.iter().cloned().collect());
    harness.with_window(cx, |window, cx| {
        let position = window.find(target).bounds().center();
        window.dispatch_event(FileDropEvent::Entered { position, paths }.to_platform_input(), cx);
        window.dispatch_event(FileDropEvent::Submit { position }.to_platform_input(), cx);
        window.dispatch_event(FileDropEvent::Exited.to_platform_input(), cx);
    });
    settle(cx);
}

#[gpui_kit::test]
fn picked_files_become_chips_within_the_limits(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    let directory = scratch();
    let notes = write(&directory, "notes.txt", b"hello, world");
    let image = write(&directory, "photo.png", PNG);
    let big = directory.join("big.bin");
    std::fs::File::create(&big)
        .and_then(|file| file.set_len(host_protocol::MAX_ATTACHMENT_BYTES + 1))
        .expect("sparse file");

    // "+" opens the platform file dialog; what it answers is attached.
    harness.with_window(cx, |window, cx| window.click("composer-attach", cx));
    assert!(cx.did_prompt_for_paths());
    let chosen = vec![notes.clone(), image.clone()];
    cx.simulate_path_prompt_response(move |options| {
        assert!(options.files && options.multiple && !options.directories);
        Some(chosen)
    });
    settle(cx);
    assert_eq!(
        picked(&harness, cx),
        [("notes.txt".to_owned(), 12, false), ("photo.png".to_owned(), 12, true)]
    );
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(chip(&notes)).label(), Some("notes.txt"));
        assert!(window.find(chip(&image)).visible());
    });
    // With files, an empty draft can be sent.
    assert_eq!(
        harness.action(cx),
        ComposerAction::Send { enabled: true, busy: false, queues: false }
    );

    // The same file again is skipped; one over 50 MB is refused.
    add(&harness, vec![notes.clone(), big], cx);
    assert_eq!(picked(&harness, cx).len(), 2);
    assert_eq!(error(&harness, cx).as_deref(), Some("“big.bin” is larger than 50 MB."));

    // At most eight.
    let more: Vec<PathBuf> =
        (0..7).map(|n| write(&directory, &format!("file-{n}.txt"), b"x")).collect();
    add(&harness, more, cx);
    assert_eq!(picked(&harness, cx).len(), 8);
    assert_eq!(error(&harness, cx).as_deref(), Some(copy::ATTACH_TOO_MANY.en()));

    // Each chip's button takes its file off.
    harness.with_window(cx, |window, cx| {
        window.within(chip(&notes)).click("attachment-remove", cx);
    });
    assert_eq!(picked(&harness, cx).len(), 7);
    assert!(!picked(&harness, cx).iter().any(|(name, ..)| name == "notes.txt"));
    std::fs::remove_dir_all(directory).ok();
}

fn kind_icon(kind: &str) -> ElementId {
    shared::domain_element_id("attachment-kind", kind)
}

/// Every chip leads with its kind's glyph, text and code as much as an
/// image, and keeps the chip's 28 px.
#[gpui_kit::test]
fn every_chip_shows_its_files_kind(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    let directory = scratch();
    let files = [
        (write(&directory, "notes.txt", b"hello"), "other"),
        (write(&directory, "main.rs", b"fn main() {}"), "code"),
        (write(&directory, "report.pdf", b"%PDF-1.7 body"), "pdf"),
        (write(&directory, "plan.docx", b"PK"), "doc"),
        (write(&directory, "photo.png", PNG), "image"),
    ];
    add(&harness, files.iter().map(|(path, _)| path.clone()).collect(), cx);
    harness.with_window(cx, |window, _| {
        for (path, kind) in &files {
            let chip = window.find(chip(path)).bounds();
            let scope = window.within(self::chip(path));
            let icon = scope.find(kind_icon(kind));
            assert!(icon.visible(), "{kind} glyph on {path:?}");
            assert_eq!(chip.size.height, px(28.), "the chip keeps its height");
            assert!(icon.bounds().left() < scope.find("attachment-remove").bounds().left());
        }
    });
    std::fs::remove_dir_all(directory).ok();
}

#[gpui_kit::test]
fn sending_uploads_each_file_and_the_message_carries_them(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    let directory = scratch();
    let notes = write(&directory, "notes.txt", b"hello, world");
    add(&harness, vec![notes], cx);
    fill(&harness, "Quote the file.", cx);
    let attachment = json!({"kind": "other", "name": "notes.txt",
                            "mimeType": "application/octet-stream", "bytes": 12,
                            "ref": {"kind": "session_file", "sessionId": SESSION,
                                    "relativePath": "art-1"}});
    let transport = &harness.transport;
    transport.reply(
        "artifact.ingest",
        Ok(json!({"kind": "upload_opened", "uploadId": "u", "nextOffset": 0})),
    );
    transport.reply(
        "artifact.ingest",
        Ok(json!({"kind": "chunk_accepted", "uploadId": "u", "nextOffset": 12})),
    );
    transport.reply(
        "artifact.ingest",
        Ok(json!({"kind": "committed", "uploadId": "u", "attachment": attachment})),
    );
    transport.reply(
        "turn.message.submit",
        Ok(json!({"disposition": "turn_started", "turnId": TURN,
                  "skillInvocation": {"loaded": [], "failed": [], "receipts": []}})),
    );
    harness.with_window(cx, |window, cx| window.press("enter", cx));
    settle(cx);

    let ingest = harness.transport.requests("artifact.ingest");
    let kinds: Vec<&str> = ingest.iter().filter_map(|input| input["kind"].as_str()).collect();
    assert_eq!(kinds, ["begin", "chunk", "commit"]);
    assert_eq!(
        (&ingest[0]["name"], &ingest[0]["totalBytes"], &ingest[0]["mimeType"]),
        (&json!("notes.txt"), &json!(12), &json!("application/octet-stream"))
    );
    assert_eq!(
        ingest[0]["contentSha256"],
        "sha256:09ca7e4eaa6e8ae9c7d261167129184883644d07dfba7cbfbc4c8a2e08360d5b"
    );
    assert_eq!(ingest[1]["chunkBase64"], "aGVsbG8sIHdvcmxk");
    let upload_id = &ingest[0]["uploadId"];
    assert!(
        ingest.iter().all(|input| &input["uploadId"] == upload_id && input["sessionId"] == SESSION)
    );
    let submit = &harness.transport.requests("turn.message.submit")[0];
    assert_eq!(submit["content"], json!({"text": "Quote the file.", "attachments": [attachment]}));
    assert!(picked(&harness, cx).is_empty(), "sent files leave the composer");
    std::fs::remove_dir_all(directory).ok();
}

#[gpui_kit::test]
fn a_failed_upload_keeps_the_files_and_sends_nothing(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    let directory = scratch();
    let notes = write(&directory, "notes.txt", b"hello");
    add(&harness, vec![notes], cx);
    harness.transport.reply(
        "artifact.ingest",
        Ok(json!({"kind": "upload_opened", "uploadId": "u", "nextOffset": 0})),
    );
    harness.transport.reply(
        "artifact.ingest",
        Err(HostRequestError::Transport("the connection dropped".into())),
    );
    harness
        .transport
        .reply("artifact.ingest", Ok(json!({"kind": "upload_aborted", "uploadId": "u"})));
    harness.with_window(cx, |window, cx| window.click("send-message", cx));
    settle(cx);
    let kinds: Vec<String> = harness
        .transport
        .requests("artifact.ingest")
        .iter()
        .filter_map(|input| input["kind"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(kinds, ["begin", "chunk", "abort"], "an opened upload is aborted");
    assert!(harness.transport.requests("turn.message.submit").is_empty());
    assert_eq!(picked(&harness, cx).len(), 1, "the file stays for another try");
    assert_eq!(
        error(&harness, cx).as_deref(),
        Some("Couldn’t attach “notes.txt”. The connection dropped.")
    );
    std::fs::remove_dir_all(directory).ok();
}

#[gpui_kit::test]
fn pasting_copied_files_attaches_them_and_types_nothing(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    let directory = scratch();
    let notes = write(&directory, "notes.txt", b"hello, world");
    let image = write(&directory, "photo.png", PNG);
    paste(&harness, copied_files(&[notes.clone(), image.clone()]), cx);
    assert_eq!(
        picked(&harness, cx),
        [("notes.txt".to_owned(), 12, false), ("photo.png".to_owned(), 12, true)]
    );
    assert_eq!(draft(&harness, cx), "", "the paths win over their names as text");
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find(chip(&notes)).label(), Some("notes.txt"));
    });
    // Pasting them again adds nothing, as picking them again does.
    paste(&harness, copied_files(&[notes]), cx);
    assert_eq!(picked(&harness, cx).len(), 2);
    std::fs::remove_dir_all(directory).ok();
}

#[gpui_kit::test]
fn a_pasted_image_is_attached_as_clipboard_image_png_and_uploaded(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    paste(
        &harness,
        ClipboardItem::new_image(&Image::from_bytes(ImageFormat::Png, PNG.to_vec())),
        cx,
    );
    assert_eq!(picked(&harness, cx), [("clipboard-image.png".to_owned(), 12, true)]);
    assert_eq!(draft(&harness, cx), "");
    let key =
        harness.composer().read_with(cx, |composer, _| composer.attachments()[0].source.key());
    harness.with_window(cx, |window, _| {
        let chip = shared::domain_element_id("composer-attachment", &key);
        assert_eq!(window.find(chip).label(), Some("clipboard-image.png"));
    });
    // The same screenshot pasted twice is two attachments.
    paste(
        &harness,
        ClipboardItem::new_image(&Image::from_bytes(ImageFormat::Png, PNG.to_vec())),
        cx,
    );
    assert_eq!(picked(&harness, cx).len(), 2);
    harness.with_window(cx, |window, cx| {
        window
            .within(shared::domain_element_id("composer-attachment", &key))
            .click("attachment-remove", cx);
    });
    assert_eq!(picked(&harness, cx).len(), 1, "only the chip's own paste is taken off");

    // Sending uploads the bytes held in memory.
    let attachment = json!({"kind": "image", "name": "clipboard-image.png",
                            "mimeType": "image/png", "bytes": 12,
                            "ref": {"kind": "session_file", "sessionId": SESSION,
                                    "relativePath": "art-1"}});
    let transport = &harness.transport;
    transport.reply(
        "artifact.ingest",
        Ok(json!({"kind": "upload_opened", "uploadId": "u", "nextOffset": 0})),
    );
    transport.reply(
        "artifact.ingest",
        Ok(json!({"kind": "chunk_accepted", "uploadId": "u", "nextOffset": 12})),
    );
    transport.reply(
        "artifact.ingest",
        Ok(json!({"kind": "committed", "uploadId": "u", "attachment": attachment})),
    );
    transport.reply(
        "turn.message.submit",
        Ok(json!({"disposition": "turn_started", "turnId": TURN,
                  "skillInvocation": {"loaded": [], "failed": [], "receipts": []}})),
    );
    harness.with_window(cx, |window, cx| window.click("send-message", cx));
    settle(cx);
    let ingest = harness.transport.requests("artifact.ingest");
    assert_eq!(
        (&ingest[0]["name"], &ingest[0]["mimeType"], &ingest[0]["totalBytes"]),
        (&json!("clipboard-image.png"), &json!("image/png"), &json!(12))
    );
    let sent = base64::engine::general_purpose::STANDARD.encode(PNG);
    assert_eq!(ingest[1]["chunkBase64"], sent);
    let submit = &harness.transport.requests("turn.message.submit")[0];
    assert_eq!(submit["content"]["attachments"], json!([attachment]));
    assert!(picked(&harness, cx).is_empty());
}

#[gpui_kit::test]
fn pasted_text_goes_into_the_draft(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    paste(&harness, ClipboardItem::new_string("a\nlong paste".to_owned()), cx);
    assert_eq!(draft(&harness, cx), "a\nlong paste", "plain, editable text");
    assert!(picked(&harness, cx).is_empty());
    assert_eq!(error(&harness, cx), None);
}

#[gpui_kit::test]
fn a_pasted_folder_is_refused_with_the_reason(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    let directory = scratch();
    let folder = directory.join("project");
    std::fs::create_dir_all(&folder).expect("folder");
    let notes = write(&directory, "notes.txt", b"hello");
    paste(&harness, copied_files(&[folder, notes]), cx);
    assert_eq!(picked(&harness, cx), [("notes.txt".to_owned(), 5, false)], "the file still comes");
    assert_eq!(error(&harness, cx).as_deref(), Some(copy::ATTACH_FOLDER.en()));
    assert_eq!(draft(&harness, cx), "");
    std::fs::remove_dir_all(directory).ok();
}

#[gpui_kit::test]
fn files_dropped_on_the_dock_are_attached_and_elsewhere_ignored(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    let directory = scratch();
    let notes = write(&directory, "notes.txt", b"hello, world");
    drop_on(&harness, "conversation", std::slice::from_ref(&notes), cx);
    assert!(picked(&harness, cx).is_empty(), "the transcript takes no drop");
    // While the files hover the dock its ring changes, and nothing moves.
    let hovering = ExternalPaths(std::iter::once(notes.clone()).collect());
    harness.with_window(cx, |window, cx| {
        let resting = window.find("composer").bounds();
        let position = resting.center();
        let entered = FileDropEvent::Entered { position, paths: hovering };
        window.dispatch_event(entered.to_platform_input(), cx);
        window.render_frame(cx);
        assert_eq!(window.find("composer").bounds(), resting);
        window.dispatch_event(FileDropEvent::Exited.to_platform_input(), cx);
    });
    assert!(picked(&harness, cx).is_empty(), "hovering attaches nothing");
    drop_on(&harness, "composer", std::slice::from_ref(&notes), cx);
    assert_eq!(picked(&harness, cx), [("notes.txt".to_owned(), 12, false)]);
    let folder = directory.join("project");
    std::fs::create_dir_all(&folder).expect("folder");
    drop_on(&harness, "composer", &[folder], cx);
    assert_eq!(error(&harness, cx).as_deref(), Some(copy::ATTACH_FOLDER.en()));
    assert_eq!(picked(&harness, cx).len(), 1);
    std::fs::remove_dir_all(directory).ok();
}

#[gpui_kit::test]
fn pasted_files_and_images_keep_to_the_limits(cx: &mut TestAppContext) {
    let harness = open_composer(cx);
    let directory = scratch();
    let big = directory.join("big.bin");
    std::fs::File::create(&big)
        .and_then(|file| file.set_len(host_protocol::MAX_ATTACHMENT_BYTES + 1))
        .expect("sparse file");
    paste(&harness, copied_files(&[big]), cx);
    assert!(picked(&harness, cx).is_empty());
    assert_eq!(error(&harness, cx).as_deref(), Some("“big.bin” is larger than 50 MB."));

    let files: Vec<PathBuf> =
        (0..8).map(|n| write(&directory, &format!("file-{n}.txt"), b"x")).collect();
    add(&harness, files, cx);
    assert_eq!(picked(&harness, cx).len(), 8);
    paste(
        &harness,
        ClipboardItem::new_image(&Image::from_bytes(ImageFormat::Png, PNG.to_vec())),
        cx,
    );
    assert_eq!(picked(&harness, cx).len(), 8);
    assert_eq!(error(&harness, cx).as_deref(), Some(copy::ATTACH_TOO_MANY.en()));
    assert_eq!(draft(&harness, cx), "", "a refused image is not typed either");
    std::fs::remove_dir_all(directory).ok();
}

/// `AttachmentRef` for a Session Artifact at `relative_path`.
fn attachment_ref(kind: &str, name: &str, mime_type: &str, bytes: u64, path: &str) -> Value {
    json!({"kind": kind, "name": name, "mimeType": mime_type, "bytes": bytes,
           "ref": {"kind": "session_file", "sessionId": SESSION, "relativePath": path}})
}

/// Opens the synthetic session with `prompt` as its turn's durable user row.
fn open_with_prompt(prompt: Value, cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    let harness = Harness::open(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    let mut frames = Frames::new();
    harness.transport.reply("session.transcript.page", Ok(page(23, &[(16, prompt)])));
    harness.push(frames.projection(root("admitted"), vec![]), cx);
    harness.push(frames.advanced(23), cx);
    harness.push(frames.projection(root("running"), vec![]), cx);
    settle(cx);
    harness
}

fn sent_chip(path: &str) -> ElementId {
    shared::domain_element_id("sent-attachment", path)
}

#[gpui_kit::test]
fn a_sent_message_shows_its_files_above_the_bubble(cx: &mut TestAppContext) {
    let attachments = [
        attachment_ref("other", "notes.txt", "application/octet-stream", 12, "art-1"),
        attachment_ref("image", "clipboard-image.png", "image/png", 2048, "art-2"),
    ];
    let prompt = json!({"type": "user", "id": TURN, "turnId": TURN, "ts": 10,
                        "text": "Quote the file.", "attachments": attachments});
    let harness = open_with_prompt(prompt, cx);
    let row = item_element_id(TURN, &ItemKey::User(TURN.into()));
    harness.with_window(cx, |window, _| {
        let row = window.within(row.clone());
        assert_eq!(row.find(sent_chip("art-1")).label(), Some("notes.txt"));
        assert_eq!(row.find(sent_chip("art-2")).label(), Some("clipboard-image.png"));
        assert!(row.try_find("attachment-remove").is_none(), "a sent file is not removed");
    });
    // Each leads with the kind the Host gave it: the text file too.
    harness.with_window(cx, |window, _| {
        for (chip, kind) in [("art-1", "other"), ("art-2", "image")] {
            assert!(window.within(sent_chip(chip)).find(kind_icon(kind)).visible(), "{chip}");
        }
    });
    let (chip, text) = harness.with_window(cx, |window, _| {
        let chip = window.find(sent_chip("art-1")).bounds();
        (chip, window.find(row.clone()).bounds())
    });
    assert!(text.bottom() - chip.bottom() >= px(40.), "the bubble sits under the chips");
    assert!(
        matches!(&harness.rows(cx)[0], RowBody::User { text, attachments }
            if text.as_ref() == "Quote the file." && attachments.len() == 2 && attachments[1].image),
        "{:?}",
        harness.rows(cx)
    );
}

#[gpui_kit::test]
fn a_message_of_files_alone_shows_only_their_chips(cx: &mut TestAppContext) {
    let attachments = [attachment_ref("pdf", "report.pdf", "application/pdf", 4096, "art-9")];
    let prompt = json!({"type": "user", "id": TURN, "turnId": TURN, "ts": 10, "text": "", "attachments": attachments});
    let harness = open_with_prompt(prompt, cx);
    let row = item_element_id(TURN, &ItemKey::User(TURN.into()));
    harness.with_window(cx, |window, _| {
        let chip = window.within(row.clone()).find(sent_chip("art-9"));
        assert_eq!(chip.label(), Some("report.pdf"));
        assert!(window.within(sent_chip("art-9")).find(kind_icon("pdf")).visible());
        // The row ends with the chip's line, which trails: no empty bubble.
        let row = window.find(row).bounds();
        assert_eq!((chip.bounds().bottom(), chip.bounds().right()), (row.bottom(), row.right()));
    });
}
