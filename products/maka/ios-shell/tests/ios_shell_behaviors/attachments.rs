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
use maka_agent_facts::{artifact::content_digest, durable::RunOwner};
use maka_agent_state::artifacts::{ArtifactStore, SessionScope};
use nsh_core::{
    ImageData,
    geometry::DevicePixels,
    picker::{Pick, PickFormat, PickedFile},
};
use rusqlite::{Connection, OpenFlags};

// A 1×1 PNG.
const PHOTO: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
    0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x64, 0xf8, 0x0f, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x27, 0x18, 0xe3, 0x66, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
];

fn picker(app: &mut Headless, title: &str) {
    app.press("label:Add attachments").unwrap();
    app.choose_menu_item(title).unwrap();
}

fn driver(channel: &HostChannel) -> (Headless, RpcDriver) {
    let (send, replies) = mpsc::unbounded_channel();
    channel.handle("test.attachments.reply", move |mut call| {
        send.send(call.take_data()).unwrap();
    });
    let bundle = Bundle::source(
        r#"
        import {host} from 'nsh';
        host.on('test.rpc', async requests => {
            const results = await Promise.all(requests.map(async ([name, input]) => {
                try { return {ok: await host.call(name, input)}; }
                catch (error) { return {error: String(error)}; }
            }));
            host.post('test.attachments.reply', results);
        });
    "#
        .into(),
    )
    .with_capabilities_json(Some(r#"{"host":true}"#))
    .unwrap();
    let mut config = EngineConfig::new(bundle);
    config.host = channel.clone();
    config.runtime = Some(tokio::runtime::Handle::current());
    (
        Headless::start(config).unwrap(),
        RpcDriver {
            channel: channel.clone(),
            replies,
        },
    )
}

async fn capture_uploads(
    root: &std::path::Path,
    store: &RootStore,
    session: &str,
) -> BTreeMap<String, (u64, String, Vec<u8>)> {
    // Enumerate registrations; the scoped artifact read verifies their actual bytes.
    let db_path = root.join("root").join(maka_event_log::root::ROOT_DATABASE);
    let session_for_query = session.to_owned();
    let registrations = tokio::task::spawn_blocking(move || {
        let connection = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        connection
            .prepare("SELECT artifact, owner FROM agent_session_artifact_registrations WHERE session = ?")
            .unwrap()
            .query_map([session_for_query], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
    }).await.unwrap();
    let count = registrations.len();
    let artifacts = ArtifactStore::new(store.data_writer().unwrap());
    let mut saved = BTreeMap::new();
    for (id, owner) in registrations {
        let owner: RunOwner = serde_json::from_str(&owner).unwrap();
        let (name, bytes, digest, payload) = artifacts
            .with_content(
                SessionScope {
                    owner,
                    session: session.into(),
                },
                id,
                |artifact, read| {
                    let mut payload = Vec::new();
                    read.read_to_end(&mut payload).unwrap();
                    (
                        artifact.name.clone(),
                        artifact.size_bytes,
                        artifact.summary.clone().unwrap(),
                        payload,
                    )
                },
            )
            .await
            .unwrap()
            .unwrap();
        saved.insert(name, (bytes, digest, payload));
    }
    assert_eq!(saved.len(), count, "a file was uploaded twice");
    saved
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
async fn room_picker_streams_photo_and_binary_to_the_real_host_in_order() {
    tokio::time::timeout(Duration::from_secs(45), async {
        let (relay, config, relay_url) = https_relay().await;
        let (dir, host, store) = test_host(true).await;
        let mut remote = Live::start_host(&config, "Attachment Host", (dir, host)).await;
        let root = remote.host.root_id().to_owned();
        let support = tempfile::tempdir().unwrap();
        let channel = HostChannel::new();
        let runtime = tokio::runtime::Handle::current();
        let bridge = HostBridge::attach(channel.clone(), support.path().into(), runtime.clone()).unwrap();
        let (driver_engine, mut rpc) = driver(&channel);
        let ticket = rpc.call("ios.beginPairing", json!({
            "uri":remote.uri,"relayUrl":relay_url,"relayToken":RELAY_TOKEN,
        })).await;
        let (_, sas) = remote.sas().await;
        let state = rpc.call("ios.confirmPairing", json!({"pairingId":ticket["pairingId"],"sas":sas})).await;
        assert_eq!(state["kind"], "saved");
        let generation = state["snapshot"]["connections"][&root]["connection"]["generation"]
            .as_u64().unwrap();
        let workspace = remote._root.path().canonicalize().unwrap().join("workspace");
        let mut sessions = Vec::new();
        for title in ["Media Room", "Other Room"] {
            let created = rpc.call("ios.hostMutate", json!({
                "rootId":root,"generation":generation,"endpoint":"agent","method":"create","input":{
                    "kind":"room","title":title,"labels":[],"workspace":{"kind":"directory","path":workspace},
                },
            })).await;
            assert_eq!(created["value"]["kind"], "created", "{created}");
            sessions.push(created["value"]["session"]["id"].as_str().unwrap().to_owned());
        }

        drop(driver_engine);
        let mut config = maka_ios_shell::engine_config_with_bridge(channel.clone(), runtime, &bridge);
        config.viewport = Size::new(px(390.), px(844.));
        config.environment = Environment { os: Os::MacOs, reduce_motion: true, ..Environment::default() };
        let mut app = Headless::start(config).unwrap();
        app.wait_for("label:Conversation: Media Room").unwrap();
        app.press("label:Conversation: Media Room").unwrap();
        app.wait_for("label:Message composer").unwrap();

        app.on_pick(|request| {
            let Pick::Images(request) = request else { panic!("not the photo library: {request:?}") };
            assert!(request.multiple());
            assert_eq!(request.limit, 4);
            assert_eq!(request.max_dimension, Some(DevicePixels(2048)));
            assert_eq!(request.format, PickFormat::Compatible);
            vec![PickedFile::new("photo.png", "image/png", ImageData::new(PHOTO))]
        });
        picker(&mut app, "Photo Library");
        app.wait_for("label:/^photo.png, .*Uploaded$/").unwrap();

        let binary: Vec<u8> = (0..65_537).map(|index| (index + 255) as u8).collect();
        app.answer_picks_myself();
        picker(&mut app, "Choose Files");
        let Some(Pick::Files(request)) = app.pending_pick() else { panic!("no file picker") };
        assert_eq!(request.size_limit(), 16 * 1024 * 1024);
        assert_eq!(request.limit, 3);
        assert!(request.multiple());
        app.answer_pick(vec![
            PickedFile::too_large("oversize.bin", "application/octet-stream", 16 * 1024 * 1024 + 1),
            PickedFile::new("binary.bin", "application/octet-stream", ImageData::new(binary.clone())),
        ]).unwrap();
        app.wait_for("label:/^binary.bin, .*Uploaded$/").unwrap();
        assert!(!app.shows("label:Remove oversize.bin"));

        let uploads = capture_uploads(remote._root.path(), &store, &sessions[0]).await;
        assert_eq!(uploads, BTreeMap::from([
            ("photo.png".into(), (PHOTO.len() as u64, content_digest(PHOTO), PHOTO.to_vec())),
            ("binary.bin".into(), (binary.len() as u64, content_digest(&binary), binary)),
        ]));
        app.press("label:Send message").unwrap();
        app.wait_for_gone("label:Remove binary.bin", Duration::from_secs(5)).unwrap();
        app.wait_for("id:chat-history-attachment").unwrap();

        picker(&mut app, "Choose Files");
        assert!(app.pending_pick().is_some());
        app.press("label:Chats").unwrap();
        app.press("label:Conversation: Other Room").unwrap();
        app.answer_pick(vec![PickedFile::new("late.bin", "application/octet-stream", ImageData::new(vec![0xff]))]).unwrap();
        assert!(!app.shows("label:Remove late.bin"));
        assert!(capture_uploads(remote._root.path(), &store, &sessions[1]).await.is_empty());

        app.press("label:Chats").unwrap();
        app.press("label:Conversation: Media Room").unwrap();
        app.wait_for("id:chat-history-attachment").unwrap();
        assert_eq!(app.screen().count("id:chat-history-attachment").unwrap(), 2);
        drop(app);
        let (driver_engine, mut rpc) = driver(&channel);
        let history = rpc.call("ios.hostQuery", json!({
            "rootId":root,"generation":generation,"endpoint":"agent","method":"history","input":{
                "sessionId":sessions[0],"position":{"kind":"tail"},
            },
        })).await;
        let posts = history["value"]["page"]["items"].as_array().unwrap();
        assert_eq!(posts.len(), 1, "Room published the same post twice");
        assert_eq!(posts[0]["content"]["text"], "");
        let attachments = posts[0]["content"]["attachments"].as_array().unwrap();
        assert_eq!(attachments.iter().map(|item| item["name"].as_str().unwrap()).collect::<Vec<_>>(),
            ["photo.png", "binary.bin"]);

        drop(driver_engine);
        drop(bridge);
        remote.shutdown().await;
        relay.shutdown().await.unwrap();
    }).await.unwrap();
}

type UploadCall = (String, String, String, tokio::sync::oneshot::Sender<Value>);
#[nsh_core::element::class]
struct ControlledUploads {
    uploads: mpsc::UnboundedSender<UploadCall>,
    leaving: Option<mpsc::UnboundedSender<String>>,
}

#[nsh_core::element::class]
impl ControlledUploads {
    pub fn upload(
        &self,
        root: String,
        generation: u64,
        session: String,
        attempt: String,
        name: String,
        url: String,
    ) -> nsh_core::element::Later<Value> {
        assert_eq!(generation, 1);
        assert!(!attempt.is_empty());
        assert!(url.starts_with("blob:"));
        let (send, receive) = tokio::sync::oneshot::channel();
        self.uploads.send((root, session, name, send)).unwrap();
        nsh_core::element::Later::new(async move { receive.await.map_err(|err| err.to_string()) })
    }

    pub fn cancel(&self, _attempt: String) {}

    pub fn cancel_before_confirm(&self, attempt: String) {
        if let Some(leaving) = &self.leaving {
            leaving.send(attempt).unwrap();
        }
    }
}

fn native_fixture(config: &mut EngineConfig, uploads: mpsc::UnboundedSender<UploadCall>) {
    native_fixture_with_leave(config, uploads, None);
}

fn native_fixture_with_leave(
    config: &mut EngineConfig,
    uploads: mpsc::UnboundedSender<UploadCall>,
    leaving: Option<mpsc::UnboundedSender<String>>,
) {
    use nsh_core::element::{Instance, Registry};
    config.environment.os = Os::MacOs;
    config
        .ui_sets
        .retain(|set| set.specifier() != Some("maka/host"));
    let mut registry = Registry::ui_set("maka/host");
    registry.value("iosAttachments", move || {
        Instance::new(ControlledUploads {
            uploads: uploads.clone(),
            leaving: leaving.clone(),
        })
    });
    config.ui_sets.push(registry);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn leaving_chat_cancels_preconfirm_upload_and_offers_to_choose_again() {
    let (send, mut uploads) = mpsc::unbounded_channel();
    let (leave, mut leaves) = mpsc::unbounded_channel();
    let mut fx = ComposerDockFixture::start_configured(
        dock_run(),
        dock_model(),
        empty_queue(),
        false,
        false,
        |config| native_fixture_with_leave(config, send, Some(leave)),
    )
    .await;
    pick_document(&mut fx.app, "pending.bin");
    let (_, _, _, receipt) = fixture_recv(&mut uploads).await;
    fx.app.press("label:Chats").unwrap();
    assert!(!fixture_recv(&mut leaves).await.is_empty());
    receipt.send(json!({"kind":"cancelled"})).unwrap();

    fx.app.press("label:Conversation: Dock Chat").unwrap();
    let choose_again = "label:Choose a replacement for pending.bin";
    fx.app.wait_for(choose_again).unwrap();
    assert!(!fx.app.shows("label:Retry upload of pending.bin"));
    fx.app.answer_picks_myself();
    fx.app.press(choose_again).unwrap();
    assert!(matches!(fx.app.pending_pick(), Some(Pick::Files(_))));
    fx.app.answer_pick(vec![]).unwrap();
    assert!(uploads.try_recv().is_err());
}

fn uploaded(session: &str, name: &str, id: &str) -> Value {
    json!({"kind":"uploaded","attachment":{"sessionId":session,"name":name,
        "id":id,"bytes":3,"mimeType":"application/octet-stream"}})
}

fn pick_document(app: &mut Headless, name: &'static str) {
    app.on_pick(move |_| {
        vec![PickedFile::new(
            name,
            "application/octet-stream",
            ImageData::new(vec![0, 255, 0]),
        )]
    });
    picker(app, "Choose Files");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_card_fits_dynamic_type_and_keeps_glass_text_readable() {
    use nsh_core::{Bounds, Color, Points, platform::ColorScheme};

    let (send, mut uploads) = mpsc::unbounded_channel();
    let mut fx = ComposerDockFixture::start_configured(
        dock_run(),
        dock_model(),
        empty_queue(),
        false,
        false,
        |config| native_fixture(config, send),
    )
    .await;
    fx.history.lock().unwrap().extend((2..=18).map(|n| {
        let mut row = quote_history_row(n, "user", &format!("Dock message {n}"));
        row["turnId"] = json!(format!("dock-turn-{n}"));
        row
    }));
    fx.transcript_changed(18, "transcript_changed");
    let tail = "id:chat-transcript >> text:Dock message 18";
    fx.app.wait_for(tail).unwrap();
    fx.app
        .set_environment("Dynamic Type", |env| env.font_scale = 2.0)
        .unwrap();
    let bounds = |app: &Headless, selector| app.screen().layout(selector).unwrap().unwrap().bounds;
    let bottom = |bounds: Bounds<Points>| bounds.origin.y + bounds.size.height;
    let tail_gap =
        |app: &Headless| bounds(app, "id:chat-composer").origin.y - bottom(bounds(app, tail));
    let gap = tail_gap(&fx.app);
    assert!(gap >= px(0.));

    pick_document(&mut fx.app, "report.bin");
    let (_, _, _, upload) = fixture_recv(&mut uploads).await;
    upload.send(json!({"kind":"not_submitted"})).unwrap();
    let strip = "id:chat-attachment-strip";
    let card = "id:chat-draft-attachment";
    let status = "text:3 B · Upload did not start";
    let retry = "label:Retry upload of report.bin";
    fx.app.wait_for(retry).unwrap();
    let viewport = bounds(&fx.app, strip);
    assert!(viewport.size.height > px(56.));
    for selector in [card, "text:report.bin", status, retry, "text:Retry"] {
        let content = bounds(&fx.app, selector);
        assert!(
            viewport.origin.y <= content.origin.y && bottom(content) <= bottom(viewport),
            "{selector} extends outside the strip: {content:?} vs {viewport:?}"
        );
    }
    assert_eq!(
        tail_gap(&fx.app),
        gap,
        "the transcript tail must follow the full strip height"
    );

    for scheme in [ColorScheme::Light, ColorScheme::Dark] {
        fx.app
            .set_environment("appearance", |env| env.color_scheme = scheme)
            .unwrap();
        let screen = fx.app.screen();
        let status_id = screen.id(status).unwrap();
        let nodes = screen.layout_nodes();
        let color = nodes
            .iter()
            .find(|node| node.id == status_id)
            .unwrap()
            .text
            .as_ref()
            .unwrap()
            .text
            .spans[0]
            .style
            .color;
        let (r, g, b, a) = color.to_f64();
        assert_eq!(a, 1.);
        let fg = relative_luminance([r, g, b]);
        let fill = Color(
            screen
                .view_style(card)
                .unwrap()
                .unwrap()
                .background_color
                .unwrap(),
        );
        let (_, _, _, opacity) = fill.to_f64();
        assert!(opacity > 0. && opacity < 1.);
        for backdrop in [0., 1.] {
            let bg = relative_luminance(color_over(fill, [backdrop; 3]));
            let ratio = (fg.max(bg) + 0.05) / (fg.min(bg) + 0.05);
            assert!(
                ratio >= 4.5,
                "status on {scheme:?} glass over {backdrop}: {ratio:.2}:1"
            );
        }
        assert_chat_button_contrast(&mut fx.app, retry, Some(card), button_text_color);
    }

    fx.app.set_viewport(Size::new(px(390.), px(310.))).unwrap();
    assert!(!fx.app.shows(strip));
    fx.app.wait_for("id:chat-composer-actions").unwrap();
    assert!(
        tail_gap(&fx.app) >= px(0.),
        "compact mode covered the transcript tail"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachment_gate_and_send_ownership_cover_keyboard_steer_queue_and_retry() {
    let (send, mut uploads) = mpsc::unbounded_channel();
    let mut fx = ComposerDockFixture::start_configured(
        dock_run(),
        dock_model(),
        empty_queue(),
        false,
        false,
        |config| native_fixture(config, send),
    )
    .await;
    let composer = "label:Message composer";
    fx.app.type_text(composer, "First line").unwrap();
    fx.app.submit(composer).unwrap();
    fx.app.type_text(composer, "Second line").unwrap();
    assert!(
        fx.calls.try_recv().is_err(),
        "Return sent without attachments"
    );

    pick_document(&mut fx.app, "first.bin");
    let (root, session, name, first) = fixture_recv(&mut uploads).await;
    assert_eq!((&*root, &*session, &*name), ("root", "chat", "first.bin"));
    fx.app.submit(composer).unwrap();
    fx.app.type_text(composer, "With a file").unwrap();
    fx.app.press_key("mod+enter").unwrap();
    let _ = fx.app.press("label:Send message");
    let _ = fx.app.long_press("label:Send message");
    assert!(fx.app.choose_menu_item("Add to queue").is_err());
    assert!(
        fx.calls.try_recv().is_err(),
        "an uploading message was delivered"
    );

    first
        .send(uploaded("chat", "first.bin", "attachment-first"))
        .unwrap();
    fx.app.wait_for("label:/^first.bin, .*Uploaded$/").unwrap();
    fx.app.press("label:Send message").unwrap();
    let (first_delivery, send) = fx.call("send").await;
    assert_eq!(
        first_delivery["message"],
        "First line\nSecond line\nWith a file"
    );
    assert_eq!(first_delivery["attachments"], json!(["attachment-first"]));
    assert_eq!(first_delivery["delivery"], "steer");

    pick_document(&mut fx.app, "new.bin");
    let (_, _, name, another) = fixture_recv(&mut uploads).await;
    assert_eq!(name, "new.bin");
    another
        .send(uploaded("chat", "new.bin", "attachment-added"))
        .unwrap();
    fx.app.wait_for("label:/^new.bin, .*Uploaded$/").unwrap();
    send.resolve(json!({"value":{"kind":"rejected","reason":"model_unavailable"}}));
    fx.app.wait_for("label:/^Retry/").unwrap();
    fx.app.press("label:/^Retry/").unwrap();
    let (retried, reply) = fx.call("send").await;
    assert_eq!(retried["attachments"], first_delivery["attachments"]);
    assert_eq!(retried["message"], first_delivery["message"]);
    assert!(
        uploads.try_recv().is_err(),
        "retry reuploaded a Host artifact"
    );
    reply.resolve(queued_result("retry", 1));
    fx.app
        .wait_for("text:Steer · Waiting for next step")
        .unwrap();

    fx.app.submit(composer).unwrap();
    assert!(
        fx.calls.try_recv().is_err(),
        "Return sent a ready attachment"
    );
    fx.app.press_key("mod+enter").unwrap();
    let (another, reply) = fx.call("send").await;
    assert_eq!(another["message"], "");
    assert_eq!(another["attachments"], json!(["attachment-added"]));
    let mut history = quote_history_row(2, "user", "");
    history["messageId"] = json!("attachment-only");
    history["attachments"] = json!([{"kind":"file","name":"new.bin",
        "bytes":3,"mimeType":"application/octet-stream"}]);
    fx.history.lock().unwrap().push(history);
    reply.resolve(queued_result("attachment-only", 2));
    fx.transcript_changed(2, "transcript_changed");
    fx.app
        .wait_for("id:chat-transcript >> label:/^new.bin, /")
        .unwrap();
    assert_eq!(
        fx.app
            .screen()
            .count("id:chat-transcript >> label:/^new.bin, /")
            .unwrap(),
        1
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forked_side_question_uses_its_own_upload_and_send_target() {
    let (send, mut uploads) = mpsc::unbounded_channel();
    let mut fx = ComposerDockFixture::start_configured(
        dock_run(),
        dock_model(),
        empty_queue(),
        true,
        false,
        |config| native_fixture(config, send),
    )
    .await;
    let side = "label:Side questions (1) · Waiting for your response";
    fx.app.wait_for(side).unwrap();
    fx.app.press(side).unwrap();
    fx.app.wait_for("text:Side Question · Dock Chat").unwrap();
    pick_document(&mut fx.app, "child.bin");
    let (_, session, name, receipt) = fixture_recv(&mut uploads).await;
    assert_eq!((&*session, &*name), ("saved", "child.bin"));
    receipt
        .send(uploaded("saved", "child.bin", "child-file"))
        .unwrap();
    fx.app.wait_for("label:/^child.bin, .*Uploaded$/").unwrap();
    fx.app.press("label:Send message").unwrap();
    let (child_send, reply) = fx.call("send").await;
    assert_eq!(child_send["sessionId"], "saved");
    assert_eq!(child_send["message"], "");
    assert_eq!(child_send["attachments"], json!(["child-file"]));
    reply.resolve(json!({"value":{"kind":"queued","messageId":"child-msg","revision":1}}));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unconfirmed_attachment_can_be_removed_but_not_retried_or_sent() {
    let (send, mut uploads) = mpsc::unbounded_channel();
    let mut fx = ComposerDockFixture::start_configured(
        dock_run(),
        dock_model(),
        empty_queue(),
        false,
        false,
        |config| native_fixture(config, send),
    )
    .await;
    pick_document(&mut fx.app, "unknown.bin");
    let (_, _, _, receipt) = fixture_recv(&mut uploads).await;
    receipt.send(json!({"kind":"unconfirmed"})).unwrap();
    fx.app
        .wait_for("label:/^unknown.bin, .*Could not confirm upload$/")
        .unwrap();
    assert!(!fx.app.shows("label:/^Retry/"));

    let composer = "label:Message composer";
    fx.app.type_text(composer, "First line").unwrap();
    fx.app.submit(composer).unwrap();
    fx.app.type_text(composer, "Second line").unwrap();
    assert_eq!(
        fx.app.screen().input_text(composer).unwrap(),
        Some("First line\nSecond line")
    );
    fx.app.press_key("mod+enter").unwrap();
    assert!(fx.calls.try_recv().is_err());
    fx.app.press("label:Remove unknown.bin").unwrap();
    fx.app.press("label:Send message").unwrap();
    let (input, reply) = fx.call("send").await;
    assert_eq!(input["message"], "First line\nSecond line");
    assert_eq!(input["attachments"], json!([]));
    assert!(uploads.try_recv().is_err());
    reply.resolve(queued_result("sent", 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queued_text_can_be_cleared_without_replacing_the_hosts_attachments() {
    let queue = json!({"revision":1,"entries":[
        {"messageId":"later","kind":"followup","preview":"Work to revisit"}
    ]});
    let mut fx = ComposerDockFixture::start(dock_run(), dock_model(), queue.clone()).await;
    fx.app.press("label:Queued Messages (1)").unwrap();
    fx.app.press("label:Edit queued message").unwrap();
    let (input, reply) = fx.call("queueMessage").await;
    assert_eq!(input["messageId"], "later");
    reply.resolve(
        json!({"value":{"kind":"ready","revision":1,"message":"Work to revisit",
        "hasAttachments":true,"quotes":[]}}),
    );
    let editor = "id:queue-message-editor";
    fx.app.wait_for(editor).unwrap();
    fx.app.clear(editor).unwrap();
    fx.app.press("label:Save").unwrap();
    confirm_queue_edit(&mut fx, queue, "").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_attachment_draft_does_not_open_a_picker_and_ignores_removed_uploads() {
    let (send, mut uploads) = mpsc::unbounded_channel();
    let mut fx = ComposerDockFixture::start_configured(
        dock_run(),
        dock_model(),
        empty_queue(),
        false,
        false,
        |config| native_fixture(config, send),
    )
    .await;
    let (send_props, mut hit_slops) = mpsc::unbounded_channel();
    fx.app.observe(move |_, batch| {
        for item in &batch.items {
            if let nsh_core::MountItem::ViewProps { id, props } = item {
                send_props.send((*id, props.hit_slop)).unwrap();
            }
        }
    });
    let mut slop = BTreeMap::new();
    let mut assert_touch_target = |app: &Headless, selector: &str| {
        while let Ok((id, insets)) = hit_slops.try_recv() {
            slop.insert(id, insets);
        }
        let screen = app.screen();
        let size = screen.layout(selector).unwrap().unwrap().bounds.size;
        let pad = slop[&screen.id(selector).unwrap()];
        assert!(
            size.width + pad.left + pad.right >= px(44.)
                && size.height + pad.top + pad.bottom >= px(44.),
            "{selector}: {size:?} + {pad:?}"
        );
    };
    fx.app.answer_picks_myself();
    picker(&mut fx.app, "Choose Files");
    let Some(Pick::Files(request)) = fx.app.pending_pick() else {
        panic!("no file picker")
    };
    assert_eq!(request.limit, 4);
    fx.app
        .answer_pick(
            ["a.bin", "b.bin", "c.bin", "d.bin"]
                .into_iter()
                .map(|name| {
                    PickedFile::new(
                        name,
                        "application/octet-stream",
                        ImageData::new(vec![0, 0xff, 0]),
                    )
                })
                .collect(),
        )
        .unwrap();
    let mut late = None;
    for _ in 0..4 {
        let (_, session, name, receipt) = fixture_recv(&mut uploads).await;
        assert_eq!(session, "chat");
        if name == "a.bin" {
            late = Some(receipt);
        } else {
            receipt
                .send(uploaded("chat", &name, &format!("attachment-{name}")))
                .unwrap();
        }
    }
    assert_eq!(
        fx.app.screen().count("id:chat-draft-attachment").unwrap(),
        4
    );
    fx.app.press("label:Add attachments").unwrap();
    let _ = fx.app.choose_menu_item("Choose Files");
    assert!(fx.app.pending_pick().is_none());
    assert_touch_target(&fx.app, "label:Remove a.bin");
    fx.app.press("label:Remove a.bin").unwrap();
    late.unwrap()
        .send(uploaded("chat", "a.bin", "late-id"))
        .unwrap();
    picker(&mut fx.app, "Choose Files");
    let Some(Pick::Files(request)) = fx.app.pending_pick() else {
        panic!("no file picker")
    };
    assert_eq!(request.limit, 1);
    assert!(!request.multiple());
    fx.app.answer_pick(vec![]).unwrap();
    assert!(!fx.app.shows("label:Remove a.bin"));

    let composer = "label:Message composer";
    fx.app.type_text(composer, "Draft").unwrap();
    let input = fx.app.screen().id(composer).unwrap();
    fx.app.set_viewport(Size::new(px(844.), px(390.))).unwrap();
    fx.app
        .set_environment("landscape software keyboard", |env| {
            env.keyboard_height = px(240.);
            env.safe_area.left = px(47.);
            env.safe_area.right = px(47.);
        })
        .unwrap();
    assert_eq!(fx.app.screen().id(composer).unwrap(), input);
    assert!(!fx.app.shows("id:chat-attachment-strip"));
    assert_touch_target(&fx.app, "label:Send message");
    fx.app.press("id:chat-composer-actions").unwrap();
    fx.app.choose_menu_item("Attachments (3)").unwrap();
    let sheet = "id:chat-attachments-sheet-scroll";
    fx.app.wait_for(sheet).unwrap();
    let bounds = fx.app.screen().layout(sheet).unwrap().unwrap().bounds;
    assert!(bounds.origin.x >= px(47.));
    assert!(bounds.origin.x + bounds.size.width <= px(797.));
    assert!(bounds.origin.y + bounds.size.height <= px(150.));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn attachments_are_root_scoped_even_when_session_ids_match() {
    let (send, mut uploads) = mpsc::unbounded_channel();
    let mut fx = ComposerDockFixture::start_configured(
        dock_run(),
        dock_model(),
        empty_queue(),
        false,
        false,
        |config| {
            native_fixture(config, send);
            config.host.handle("ios.bootstrap", |call| {
                let mut state = dock_host(1);
                let other = json!({"rootId":"other","hostName":"Other Host",
                    "generation":1,"endpoints":["agent","settings"]});
                state["hosts"].as_array_mut().unwrap().push(other.clone());
                state["connections"]["other"] = json!({"status":"connected","connection":other});
                call.resolve(state);
            });
        },
    )
    .await;

    pick_document(&mut fx.app, "root-a.bin");
    let (root, session, _, receipt) = fixture_recv(&mut uploads).await;
    assert_eq!((&*root, &*session), ("root", "chat"));
    receipt
        .send(uploaded("chat", "root-a.bin", "file-a"))
        .unwrap();
    fx.app.wait_for("label:/^root-a.bin, .*Uploaded$/").unwrap();
    fx.app.press("label:Chats").unwrap();
    fx.app.press("label:Conversation: Other Dock Chat").unwrap();
    assert!(!fx.app.shows("label:Remove root-a.bin"));

    pick_document(&mut fx.app, "root-b.bin");
    let (root, session, _, receipt) = fixture_recv(&mut uploads).await;
    assert_eq!((&*root, &*session), ("other", "chat"));
    receipt
        .send(uploaded("chat", "root-b.bin", "file-b"))
        .unwrap();
    fx.app.wait_for("label:/^root-b.bin, .*Uploaded$/").unwrap();
    fx.app.press("label:Chats").unwrap();
    fx.app.press("label:Conversation: Dock Chat").unwrap();
    fx.app.wait_for("label:/^root-a.bin, .*Uploaded$/").unwrap();
    assert!(!fx.app.shows("label:Remove root-b.bin"));
}
