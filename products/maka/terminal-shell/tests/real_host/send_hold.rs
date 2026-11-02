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

/// Opens the fixture conversation through `gate`, types `text` and sends
/// it; returns while the send waits at the gate for its model, after it
/// freezes the draft locally.
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
    // Resolve the initial model before holding the original send preparation.
    wait_view(&mut view, |screen| screen.contains("fixture-model")).await;
    support::wait_enabled_button(&mut view, "Send message").await;
    gate.arm();
    // Enter sends from the composer and leaves it focused for more typing.
    view.handle_event(Event::Key(KeyEvent::new(
        KeyCode::Enter,
        KeyModifiers::NONE,
    )));
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
    .expect("the original send never reached preparation");
    support::wait_draft(&client, &fixture.session, "").await;
    (view, bindings, client)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_rejected_send_preserves_its_snapshot_and_the_next_draft() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let fixture = Fixture::open().await;
        let gate = ReplyGate::send(fixture.directory.path(), fixture.address.clone());
        // The Host rejects a message that invokes a skill it cannot load.
        let sent = "/skill:missing-fixture first";
        let (mut view, bindings, client) = send_held(&fixture, &gate, sent).await;
        view.handle_event(Event::Paste("next draft".into()));
        support::tick(&mut view);
        gate.release();
        // Check the composer only once the send has settled.
        let screen = wait_view_state(&mut view, |view, screen| {
            screen.contains("/skill:missing-fixture first")
                && screen.contains("next draft")
                && screen.contains("Retry")
                && view
                    .accessibility_snapshot()
                    .iter()
                    .any(|node| node.label == "Send message" && !node.state.disabled)
        })
        .await;
        support::wait_draft(&client, &fixture.session, "next draft").await;
        // The Host refused the send itself; the typing did not cancel it.
        assert!(screen.contains("Retry"));
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        drop(view);
        bindings.close().await.unwrap();
        client.close().await.unwrap();
        drop(gate);
        fixture.finish().await;
    })
    .await
    .expect("rejected send workflow timed out");
}
