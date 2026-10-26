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

//! Product evaluation through a real Root and the output-only Pulse fixture.
//! Start's canonical T2 confirms successful startup. Background capture belongs
//! to its Session/Epoch resources; it is not an unfinished Start or Run effect.
//! These tests cover the product kernel, not Host transport or permission UI.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

struct Tone(Child);
impl Drop for Tone {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn pactl(arguments: &[&str]) -> String {
    let arguments: Vec<String> = arguments
        .iter()
        .map(|argument| (*argument).into())
        .collect();
    tokio::task::spawn_blocking(move || {
        let output = Command::new("pactl").args(arguments).output().unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        String::from_utf8(output.stdout).unwrap()
    })
    .await
    .unwrap()
}

async fn outputs() -> BTreeMap<u64, Value> {
    let rows: Vec<Value> =
        serde_json::from_str(&pactl(&["--format=json", "list", "source-outputs"]).await).unwrap();
    rows.into_iter()
        .map(|row| (row["index"].as_u64().unwrap(), row))
        .collect()
}

async fn wait_outputs(expected: &[u64]) -> BTreeMap<u64, Value> {
    let expected = expected.to_vec();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let observed = outputs().await;
            if observed.keys().copied().collect::<Vec<_>>() == expected {
                return observed;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("exact private Pulse source-output identities did not settle")
}

async fn fixture() -> Tone {
    assert!(
        std::env::var("PULSE_SERVER")
            .unwrap()
            .starts_with("unix:/tmp/cua-loopback-audio."),
        "run only through the existing private Pulse fixture script"
    );
    assert_eq!(
        pactl(&["get-default-sink"]).await.trim(),
        "cua_audio_fixture"
    );
    let sources: Vec<Value> =
        serde_json::from_str(&pactl(&["--format=json", "list", "sources"]).await).unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["name"], "cua_audio_fixture.monitor");
    assert!(outputs().await.is_empty());
    assert!(pactl(&["list", "sink-inputs", "short"]).await.is_empty());
    let tone = Tone(
        Command::new("ffmpeg")
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-re",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=24000:duration=90",
                "-ac",
                "2",
                "-f",
                "pulse",
                "cua_audio_fixture",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        while pactl(&["list", "sink-inputs", "short"]).await.is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("generated output did not reach the private sink");
    tone
}

async fn finish_tone(tone: Tone) {
    drop(tone);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !pactl(&["list", "sink-inputs", "short"]).await.is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("generated playback did not leave the private sink");
}

async fn evaluate(run: &Run, label: &str, code: String) -> (String, Value) {
    let (operation, result) = run
        .invoke(
            label,
            "evaluate",
            json!({"code":code,"timeout_ms":10000,"title":"Generated output audio fixture"}),
        )
        .await;
    (operation, result.unwrap())
}

async fn value(run: &Run, result: Value, marker: &str) -> Value {
    let text = run.text(result).await;
    serde_json::from_str(
        text.lines()
            .find_map(|line| line.strip_prefix(marker))
            .unwrap_or_else(|| panic!("missing exact marker {marker:?}: {text}")),
    )
    .unwrap()
}

async fn epoch(run: &Run) -> Arc<sessions::Epoch> {
    run.owner
        .sessions
        .get(&run.invocation.session_id)
        .unwrap()
        .kernel
        .lock()
        .await
        .as_ref()
        .unwrap()
        .epoch
        .clone()
}

struct Capture {
    epoch: Arc<sessions::Epoch>,
    source: u64,
    completion: tokio::task::JoinHandle<Result<(), ToolError>>,
    outer: String,
    started: Instant,
}
impl Capture {
    async fn start(run: &Run, label: &str, max_duration_ms: u64) -> Self {
        let before = outputs().await;
        let marker = format!("{label}-{}=", Uuid::new_v4());
        let started = Instant::now();
        let (outer, result) = evaluate(
            run,
            label,
            format!(
                "var audioBinding={label:?};var startedAudio=await cua.computer.start_audio_recording({{max_duration_ms:{max_duration_ms}}});nodeRepl.write({marker:?}+JSON.stringify({{started:typeof startedAudio}}));"
            ),
        )
        .await;
        assert_eq!(
            value(run, result, &marker).await,
            json!({"started":"undefined"})
        );
        let after = outputs().await;
        let added: Vec<_> = after
            .keys()
            .filter(|id| !before.contains_key(*id))
            .copied()
            .collect();
        assert_eq!(added.len(), 1);
        assert_eq!(after.len(), before.len() + 1);
        let epoch = epoch(run).await;
        let native = epoch.native.lock().await;
        assert_eq!(native.platform(), "linux");
        assert_eq!(native.native_epoch().to_string(), epoch.id);
        let mut finished = native.wait_audio_finished();
        drop(native);
        let (pending, registered) = tokio::sync::oneshot::channel();
        let completion = tokio::spawn(async move {
            assert!(futures_util::poll!(&mut finished).is_pending());
            pending.send(()).unwrap();
            // Keep polling the real observer: its snapshot can await a native
            // worker while temporarily holding SDK lifecycle admission.
            finished.await
        });
        registered.await.unwrap();
        run.record(
            &format!("{label}_capture"),
            json!({"epoch":epoch.id,"outer_operation":outer,"source_output":after[&added[0]],"all_source_outputs":after,"max_duration_ms":max_duration_ms,"completion_initially_pending":true}),
        ).await;
        Self {
            epoch,
            source: added[0],
            completion,
            outer,
            started,
        }
    }

    async fn finished(&mut self, run: &Run, label: &str) {
        tokio::time::timeout(Duration::from_secs(20), &mut self.completion)
            .await
            .expect("actual native capture completion remained pending")
            .expect("native completion observation worker failed")
            .expect("actual native capture failed");
        run.record(label, json!({"epoch":self.epoch.id,"source_output_id":self.source,"completion_observed_since_start_call_ms":self.started.elapsed().as_secs_f64()*1000.0,"completion":"actual native future; observation time includes product Root/artifact operations"})).await;
    }
}

async fn closed(run: &Run, capture: &Capture, label: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            // On an already configured Linux binding, prepare only reads Host
            // lifecycle state; it neither creates a runtime nor dispatches input.
            let observed = capture
                .epoch
                .native
                .lock()
                .await
                .prepare(&CancellationToken::new(), Language::En)
                .await;
            match observed {
                Err(ToolError::Failed(message)) if message == "Computer Use Session is closed" => {
                    break;
                }
                Ok(()) => tokio::time::sleep(Duration::from_millis(20)).await,
                Err(error) => panic!("unexpected epoch lifecycle observation: {error}"),
            }
        }
    })
    .await
    .expect("retired native epoch did not finish closing");
    assert!(!run.owner.stopping.is_cancelled());
    run.record(label, json!({"epoch":capture.epoch.id,"native_epoch_closed":true,"observation":"configured Linux prepare refuses closed binding; no native command dispatched"})).await;
}

async fn reset(run: &Run, label: &str) {
    let (_, result) = run.invoke(label, "reset", json!({})).await;
    assert_eq!(result.unwrap()["state"], "fresh");
}

async fn fresh_stop_refusal(run: &Run, old: &Capture) -> String {
    let marker = format!("fresh-audio-{}=", Uuid::new_v4());
    let (outer, result) = evaluate(run, "fresh_stop", format!(
        "var oldBindingType=typeof audioBinding;try{{await cua.computer.stop_audio_recording();nodeRepl.write({marker:?}+JSON.stringify({{unexpectedStop:true}}));}}catch(error){{nodeRepl.write({marker:?}+JSON.stringify({{oldBinding:oldBindingType,refusal:String(error.message)}}));}}"
    )).await;
    let result = value(run, result, &marker).await;
    assert_eq!(result["oldBinding"], "undefined");
    assert!(
        result["refusal"]
            .as_str()
            .unwrap()
            .contains("computer audio recording is not active"),
        "{result}"
    );
    assert_ne!(epoch(run).await.id, old.epoch.id);
    assert!(outputs().await.contains_key(&old.source));
    run.record("fresh_stop_preserves_old", json!({"old_epoch":old.epoch.id,"new_epoch":epoch(run).await.id,"old_source_output_id":old.source,"public_refusal":result,"source_outputs":outputs().await})).await;
    outer
}

fn command(
    events: &[StoredEvent],
    method: &str,
    outer: &str,
    epoch: &str,
    succeeded: bool,
) -> String {
    let found: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::ToolDispatched {
                operation_id,
                call,
                name,
                input,
                ..
            } if name == "cua_operation" && input["method"] == method => match &call.origin {
                ToolOrigin::HostSdk {
                    parent:
                        Some(HostSdkParent::EvaluationObserver {
                            operation_id: parent,
                            epoch: observed,
                        }),
                    ..
                } if parent == outer && observed == epoch => Some(operation_id.clone()),
                _ => None,
            },
            _ => None,
        })
        .collect();
    assert_eq!(
        found.len(),
        1,
        "exact canonical dispatch for {method}/{outer}/{epoch}"
    );
    let operation = &found[0];
    let outcomes: Vec<_> = events
        .iter()
        .filter_map(|event| match &event.event.fact {
            Fact::ToolSettled {
                operation_id,
                outcome,
            } if operation_id == operation => Some(outcome),
            _ => None,
        })
        .collect();
    assert_eq!(outcomes.len(), 1);
    assert_eq!(
        matches!(outcomes[0], ToolOutcome::Succeeded { .. }),
        succeeded
    );
    if !succeeded {
        assert!(matches!(outcomes[0], ToolOutcome::Failed { .. }));
    }
    operation.clone()
}

fn counts(events: &[StoredEvent]) -> (usize, usize) {
    let count = |method: &str| {
        events
            .iter()
            .filter(|event| {
                matches!(
                    &event.event.fact, Fact::ToolDispatched {name,input,..}
                        if name == "cua_operation" && input["method"] == method
                )
            })
            .count()
    };
    (count("startAudioRecording"), count("stopAudioRecording"))
}

async fn ledger(run: &Run, label: &str) -> Vec<StoredEvent> {
    // The Run's execution handle is intentionally released by Run::close.
    let store = run
        .owner
        .store
        .session(&run.invocation.session_id)
        .await
        .unwrap();
    let events = facts(&store, &run.invocation.session_id).await;
    capture(
        run.directory.join(format!("{label}_ledger.json")),
        serde_json::to_value(&events).unwrap(),
    )
    .await;
    events
}

async fn cleanup(run: &Run) {
    NativeOwner::close(&Service(run.owner.clone()))
        .await
        .unwrap();
    assert!(run.owner.resources.is_idle());
    assert!(outputs().await.is_empty());
    run.owner.store.shutdown().await.unwrap();
}

async fn verify_wav(run: &Run, result: Value) {
    let path = PathBuf::from(result["filepath"].as_str().unwrap());
    let bytes = tokio::fs::read(&path).await.unwrap();
    assert_eq!(bytes.len() as u64, result["length"].as_u64().unwrap());
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    let mut position = 12;
    let mut pcm = None;
    let mut format = None;
    while position + 8 <= bytes.len() {
        let length =
            u32::from_le_bytes(bytes[position + 4..position + 8].try_into().unwrap()) as usize;
        let data = &bytes[position + 8..position + 8 + length];
        match &bytes[position..position + 4] {
            b"fmt " => format = Some(data),
            b"data" => pcm = Some(data),
            _ => {}
        }
        position += 8 + length + length % 2;
    }
    let format = format.unwrap();
    assert_eq!(&format[..4], &[1, 0, 2, 0]);
    assert_eq!(u32::from_le_bytes(format[4..8].try_into().unwrap()), 24000);
    assert_eq!(&format[12..16], &[4, 0, 16, 0]);
    let pcm = pcm.unwrap();
    assert!(pcm.chunks_exact(4).all(|frame| frame[..2] == frame[2..]));
    let samples: Vec<_> = pcm
        .chunks_exact(4)
        .map(|frame| i16::from_le_bytes(frame[..2].try_into().unwrap()))
        .collect();
    let first = samples
        .iter()
        .position(|sample| sample.abs() > 100)
        .unwrap();
    let last = samples
        .iter()
        .rposition(|sample| sample.abs() > 100)
        .unwrap();
    let signal = &samples[first..=last];
    let crossings = signal
        .windows(2)
        .filter(|pair| pair[0] <= 0 && pair[1] > 0)
        .count();
    let frequency = crossings as f64 * 24000.0 / signal.len() as f64;
    assert!((430.0..450.0).contains(&frequency), "frequency={frequency}");
    let digest = hex::encode(Sha256::digest(&bytes));
    tokio::fs::write(
        run.directory.join("replacement-generated-output.wav"),
        &bytes,
    )
    .await
    .unwrap();
    run.record("replacement_wav", json!({"filepath":path,"bytes":bytes.len(),"sha256":digest,"frames":samples.len(),"frequency_hz":frequency,"format":"PCM16/stereo/24000Hz"})).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires native-desktop SDK, a disposable container and the existing private generated-tone Pulse runner"]
async fn linux_product_retired_audio_reaches_native_eof_without_stopping_fresh_epoch() {
    let tone = fixture().await;
    let mut run = Run::open_with_audio(true).await;
    let mut old = Capture::start(&run, "old_start", 8000).await;
    reset(&run, "retire_old").await;
    assert!(outputs().await.contains_key(&old.source));
    let refused_stop = fresh_stop_refusal(&run, &old).await;
    let mut fresh = Capture::start(&run, "replacement_start", 300000).await;
    assert_ne!(fresh.epoch.id, old.epoch.id);
    assert_ne!(fresh.source, old.source);
    assert_eq!(outputs().await.len(), 2);
    old.finished(&run, "old_native_eof").await;
    closed(&run, &old, "old_epoch_cleanup_complete").await;
    let remaining = wait_outputs(&[fresh.source]).await;
    assert!(futures_util::poll!(&mut fresh.completion).is_pending());
    run.record(
        "only_replacement_remains",
        json!({"old_epoch":old.epoch.id,"fresh_epoch":fresh.epoch.id,"source_outputs":remaining}),
    )
    .await;
    let marker = format!("replacement-wav-{}=", Uuid::new_v4());
    let (stopped, result) = evaluate(&run, "replacement_stop", format!(
        "var recordedAudio=await cua.computer.stop_audio_recording();nodeRepl.write({marker:?}+JSON.stringify({{filepath:recordedAudio.filepath,length:recordedAudio.bytes.length}}));"
    )).await;
    verify_wav(&run, value(&run, result, &marker).await).await;
    fresh
        .finished(&run, "replacement_explicit_stop_complete")
        .await;
    assert!(outputs().await.is_empty());
    let events = ledger(&run, "before_run_close").await;
    command(
        &events,
        "startAudioRecording",
        &old.outer,
        &old.epoch.id,
        true,
    );
    command(
        &events,
        "startAudioRecording",
        &fresh.outer,
        &fresh.epoch.id,
        true,
    );
    command(
        &events,
        "stopAudioRecording",
        &refused_stop,
        &fresh.epoch.id,
        false,
    );
    command(
        &events,
        "stopAudioRecording",
        &stopped,
        &fresh.epoch.id,
        true,
    );
    assert_eq!(counts(&events), (2, 2));
    assert!(
        run.effects.is_idle(),
        "both Start command T2s already committed"
    );
    run.close().await;
    run.record("result", json!({"natural_old_native_completion":true,"fresh_vm_cannot_stop_old":true,"replacement_survives_old_cleanup":true,"start_command_t2_is_not_background_audio_eof":true,"scope":"Linux product evaluate, canonical Root and real native Pulse; not Host transport/UI or cross-platform timing parity"})).await;
    ledger(&run, "after_run_close").await;
    cleanup(&run).await;
    finish_tone(tone).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires native-desktop SDK, a disposable container and the existing private generated-tone Pulse runner"]
async fn linux_product_broad_permission_revocation_discards_exact_retired_audio() {
    let tone = fixture().await;
    let mut run = Run::open_with_audio(true).await;
    let mut old = Capture::start(&run, "old_start", 300000).await;
    reset(&run, "retire_old").await;
    let interaction = run.owner.sessions.get(&run.invocation.session_id).unwrap();
    assert!(outputs().await.contains_key(&old.source));
    assert!(run.effects.is_idle());
    let events = ledger(&run, "before_revoke").await;
    command(
        &events,
        "startAudioRecording",
        &old.outer,
        &old.epoch.id,
        true,
    );
    let store = run
        .owner
        .store
        .session(&run.invocation.session_id)
        .await
        .unwrap();
    let current = store
        .get_session::<StoredSessionConfiguration>(&run.invocation.session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        current.configuration.boundary_revision,
        run.basis.boundary_revision
    );
    let mut changes = run.owner.store.subscribe_catalog_changes();
    changes.borrow_and_update();
    let changed = store
        .update_session_permissions(
            &run.invocation.session_id,
            current.revision,
            maka_agent_authority::now(),
            |configuration: &mut StoredSessionConfiguration| {
                configuration.boundary_revision += 1;
                Ok(())
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        changed,
        maka_event_log::sessions::SessionMutation::Committed(_)
    ));
    tokio::time::timeout(Duration::from_secs(5), changes.changed())
        .await
        .unwrap()
        .unwrap();
    assert!(
        store
            .client_capability_grant(&run.invocation.session_id, &api::target())
            .await
            .unwrap()
            .is_none()
    );
    old.finished(&run, "revoked_native_completion").await;
    closed(&run, &old, "revoked_epoch_cleanup_complete").await;
    let after = wait_outputs(&[]).await;
    assert!(Arc::ptr_eq(
        &interaction,
        &run.owner.sessions.get(&run.invocation.session_id).unwrap()
    ));
    assert!(!interaction.retiring.is_cancelled());
    run.record("canonical_revoke", json!({"old_basis":run.basis,"new_boundary_revision":current.configuration.boundary_revision+1,"canonical_broad_computer_grant":null,"old_epoch":old.epoch.id,"old_source_output_id":old.source,"source_outputs":after,"same_interaction_retained":true,"linux_audio_specific_consent":false})).await;
    run.close().await;
    assert_eq!(
        counts(&ledger(&run, "after_revoke_and_run_close").await),
        (1, 0),
        "trusted cleanup adds no model Stop/replayed Start"
    );
    cleanup(&run).await;
    finish_tone(tone).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires native-desktop SDK, a disposable container and the existing private generated-tone Pulse runner"]
async fn linux_product_owner_close_joins_actual_retired_audio_after_run_end() {
    let tone = fixture().await;
    let mut run = Run::open_with_audio(true).await;
    let mut old = Capture::start(&run, "old_start", 300000).await;
    reset(&run, "retire_old").await;
    let before = ledger(&run, "before_run_close").await;
    command(
        &before,
        "startAudioRecording",
        &old.outer,
        &old.epoch.id,
        true,
    );
    assert!(run.effects.is_idle());
    let start = Instant::now();
    run.close().await;
    let run_close_ms = start.elapsed().as_secs_f64() * 1000.0;
    assert!(outputs().await.contains_key(&old.source));
    assert!(futures_util::poll!(&mut old.completion).is_pending());
    run.record("run_ended_capture_still_owned", json!({"run_close_ms":run_close_ms,"run_effects_idle":run.effects.is_idle(),"owner_resources_idle":run.owner.resources.is_idle(),"old_epoch":old.epoch.id,"source_outputs":outputs().await,"contract":"Start T2 is complete; retired capture remains a Session/Epoch resource"})).await;
    let after_run = ledger(&run, "after_run_close").await;
    assert!(
        after_run
            .iter()
            .any(|event| matches!(&event.event.fact, Fact::InvocationEnded { .. }))
    );
    // This real native ownership lock is only a test barrier. It delays no
    // fake backend and authorizes no new command; close must join this owner.
    let guard = old.epoch.native.lock().await;
    let service = Service(run.owner.clone());
    let mut closing = NativeOwner::close(&service);
    let close_start = Instant::now();
    assert!(futures_util::poll!(&mut closing).is_pending());
    assert!(outputs().await.contains_key(&old.source));
    drop(guard);
    tokio::time::timeout(Duration::from_secs(10), &mut closing)
        .await
        .expect("owner close did not confirm actual capture cleanup")
        .unwrap();
    let close_ms = close_start.elapsed().as_secs_f64() * 1000.0;
    old.finished(&run, "owner_closed_native_completion").await;
    assert!(wait_outputs(&[]).await.is_empty());
    assert!(run.owner.resources.is_idle());
    let after_close = ledger(&run, "after_owner_close").await;
    assert_eq!(counts(&after_close), (1, 0));
    run.record("result", json!({"run_close_ms":run_close_ms,"owner_close_ms":close_ms,"owner_close_initially_pending_while_exact_native_guard_held":true,"actual_native_completion_confirmed":true,"source_output_removed":old.source,"owner_resources_idle":true,"start_dispatches":1,"stop_dispatches":0,"scope":"Linux product evaluate and exact Session/Epoch cleanup; not Host transport/UI"})).await;
    run.owner.store.shutdown().await.unwrap();
    finish_tone(tone).await;
}
