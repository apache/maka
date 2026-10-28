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
use maka_app_client::Client;

/// Opens the fixture conversation through `gate`, types `text` and presses
/// Send; returns once the Host's send receipt is held at the gate.
async fn send_held(
    fixture: &Fixture,
    gate: &ReplyGate,
    text: &str,
) -> (AppView, maka_workbench::bindings::Bindings, Client) {
    let client = fixture.client_at(&gate.address).await;
    let selected = support::mutate(&client, "selectBackend", json!({"sessionId":fixture.session,"backend":{"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model","thinkingLevel":null}})).await;
    assert_eq!(selected["kind"], "committed");
    let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
    view.resize(150, 50);
    wait_editable_composer(&mut view).await;
    tab_to_label(&mut view, "Message composer").await;
    view.handle_event(Event::Paste(text.into()));
    support::wait_draft(&client, &fixture.session, text).await;
    gate.arm();
    support::click_button(&mut view, "Send message").await;
    tokio::time::timeout(Duration::from_secs(20), async {
        let held = gate.held.notified();
        tokio::pin!(held);
        loop {
            support::tick(&mut view);
            tokio::select! {
                () = &mut held => break,
                () = tokio::time::sleep(Duration::from_millis(5)) => {}
            }
        }
    })
    .await
    .expect("the send receipt never reached the gate");
    (view, bindings, client)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rejected_send_keeps_the_text_typed_while_it_was_confirmed() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::open().await;
        let gate = ReplyGate::start(fixture.directory.path(), fixture.address.clone());
        // The Host rejects a message that invokes a skill it cannot load.
        let sent = "/skill:missing-fixture first";
        let (mut view, bindings, client) = send_held(&fixture, &gate, sent).await;
        view.handle_event(Event::Paste(" next".into()));
        support::tick(&mut view);
        gate.release();
        support::wait_draft(&client, &fixture.session, "/skill:missing-fixture first next").await;
        let screen = wait_view(&mut view, |screen| screen.contains("/skill:missing-fixture first next")).await;
        evidence("rejected-send-keeps-held-text", &screen);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        drop(gate);
        fixture.finish().await;
    }).await.expect("rejected send workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn switching_waits_until_text_typed_during_a_send_can_be_saved() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let setup = fixture.client().await;
        let other = support::mutate(&setup, "create", json!({
            "title":"Other held conversation","labels":[],
            "workspace":{"kind":"session","sessionId":fixture.session}
        })).await;
        assert_eq!(other["kind"], "created");
        setup.close().await.unwrap();
        let gate = ReplyGate::start(fixture.directory.path(), fixture.address.clone());
        let (mut view, bindings, client) = send_held(&fixture, &gate, "Held message A").await;
        view.handle_event(Event::Paste(" later".into()));
        support::tick(&mut view);
        shortcut(&mut view, 'o');
        select_palette(&mut view, "Search titles and messages…", "Other held", "Other held conversation").await;
        let refused = wait_view(&mut view, |screen| screen.contains("Wait for the message to send before switching.")).await;
        evidence("switch-refused-while-send-held", &refused);
        gate.release();
        let mut request = fixture.next_request().await;
        assert!(request.body.to_string().contains("Held message A"));
        assert!(!request.body.to_string().contains("later"));
        support::wait_draft(&client, &fixture.session, " later").await;
        request.delta("HELD_SEND_ANSWER").await;
        request.finish().await;
        wait_view(&mut view, |screen| screen.contains("HELD_SEND_ANSWER")).await;
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        drop(gate);
        fixture.finish().await;
    }).await.expect("held send navigation workflow timed out");
}
