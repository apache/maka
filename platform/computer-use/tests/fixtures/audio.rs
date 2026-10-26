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

//! Native public-REPL integration with an isolated output-only Pulse fixture.
use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use maka_agent_facts::language::Language;
use maka_computer_use::{Driver, InvocationContext, Session};
use std::process::{Child, Command, Stdio};

struct Native(Arc<tokio::sync::Mutex<Session>>);
impl ToolExecutor for Native {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        assert_eq!(name, "cua");
        let session = self.0.clone();
        Box::pin(async move {
            session
                .lock()
                .await
                .invoke(
                    serde_json::from_value(input).unwrap(),
                    &InvocationContext::new("audio-public-fixture", "audio-turn"),
                    &cancellation,
                    Language::En,
                )
                .await
        })
    }
}

struct Tone(Child);
impl Drop for Tone {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn pactl(arguments: &[&str]) -> String {
    let output = Command::new("pactl").args(arguments).output().unwrap();
    assert!(output.status.success(), "{:?}", output.stderr);
    String::from_utf8(output.stdout).unwrap()
}

async fn wait_for(mut observed: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while !observed() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("private Pulse fixture did not settle");
}

async fn run(repl: &Repl, bridge: Arc<Native>, code: &str) -> Vec<CellOutput> {
    let context =
        CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            code.into(),
            bridge,
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(15),
        )
        .await
        .unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    context.take_output()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a disposable container and the private generated-tone PulseAudio runner"]
async fn public_repl_records_generated_output_and_emits_identical_wav() {
    // The Cua fixture runner creates only a null output sink. Refuse the
    // caller's normal audio server before configuring or invoking native code.
    assert!(
        std::env::var("PULSE_SERVER")
            .unwrap()
            .starts_with("unix:/tmp/cua-loopback-audio.")
    );
    assert_eq!(pactl(&["get-default-sink"]).trim(), "cua_audio_fixture");
    assert!(pactl(&["list", "source-outputs", "short"]).is_empty());
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
                "sine=frequency=440:sample_rate=24000:duration=30",
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
    wait_for(|| !pactl(&["list", "sink-inputs", "short"]).is_empty()).await;
    let driver = Arc::new(tokio::sync::Mutex::new(Driver::with_audio(true)));
    let mut native = Session::new(driver.clone());
    native
        .configure(
            maka_capabilities::computer::Desktop::Local,
            vec![],
            Language::En,
        )
        .unwrap();
    let bridge = Arc::new(Native(Arc::new(tokio::sync::Mutex::new(native))));
    let repl = Repl::new(
        maka_computer_use::facade_for("linux", true),
        CellLimits::default(),
    );
    let started = run(
        &repl,
        bridge.clone(),
        "const started = await cua.computer.start_audio_recording({max_duration_ms:1500});
         nodeRepl.write(typeof started);",
    )
    .await;
    assert!(
        started
            .iter()
            .any(|output| matches!(output, CellOutput::Text {text} if text == "undefined"))
    );
    assert_eq!(
        pactl(&["list", "source-outputs", "short"]).lines().count(),
        1
    );
    wait_for(|| pactl(&["list", "source-outputs", "short"]).is_empty()).await;
    let output = run(
        &repl,
        bridge.clone(),
        "const recording = await cua.computer.stop_audio_recording();
         nodeRepl.write({filepath:recording.filepath,length:recording.bytes.length,data_url:recording.data_url});
         await nodeRepl.emitAudio(recording.bytes);",
    )
    .await;
    drop(tone);
    let recording: Value = output
        .iter()
        .find_map(|output| match output {
            CellOutput::Text { text } => serde_json::from_str::<Value>(text)
                .ok()
                .filter(|value| value.get("filepath").is_some()),
            _ => None,
        })
        .unwrap();
    let bytes = STANDARD
        .decode(
            recording["data_url"]
                .as_str()
                .unwrap()
                .strip_prefix("data:audio/wav;base64,")
                .unwrap(),
        )
        .unwrap();
    assert_eq!(recording["length"].as_u64().unwrap(), bytes.len() as u64);
    let path = std::path::Path::new(recording["filepath"].as_str().unwrap());
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    let media: Vec<_> = output
        .iter()
        .filter_map(|output| match output {
            CellOutput::Media {
                content: ContentBlock::Audio { data, mime_type },
                ..
            } => Some((data, mime_type)),
            _ => None,
        })
        .collect();
    assert_eq!(media.len(), 1);
    assert_eq!(media[0].1, "audio/wav");
    assert_eq!(STANDARD.decode(media[0].0).unwrap(), bytes);
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    let mut offset = 12;
    let mut pcm = None;
    let mut format = None;
    while offset + 8 <= bytes.len() {
        let length = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let data = &bytes[offset + 8..offset + 8 + length];
        match &bytes[offset..offset + 4] {
            b"fmt " => format = Some(data),
            b"data" => pcm = Some(data),
            _ => {}
        }
        offset += 8 + length + length % 2;
    }
    let format = format.unwrap();
    assert_eq!(&format[..4], &[1, 0, 2, 0]);
    assert_eq!(u32::from_le_bytes(format[4..8].try_into().unwrap()), 24_000);
    assert_eq!(&format[12..16], &[4, 0, 16, 0]);
    let pcm = pcm.unwrap();
    assert!(pcm.chunks_exact(4).all(|frame| frame[..2] == frame[2..]));
    let samples: Vec<_> = pcm
        .chunks_exact(4)
        .map(|frame| i16::from_le_bytes(frame[..2].try_into().unwrap()))
        .collect();
    let first = samples
        .iter()
        .position(|value| value.unsigned_abs() > 100)
        .unwrap();
    let last = samples
        .iter()
        .rposition(|value| value.unsigned_abs() > 100)
        .unwrap();
    let signal = &samples[first..=last];
    let crossings = signal
        .windows(2)
        .filter(|pair| pair[0] <= 0 && pair[1] > 0)
        .count();
    let frequency = crossings as f64 * 24_000.0 / signal.len() as f64;
    assert!((430.0..450.0).contains(&frequency), "tone_hz={frequency}");
    eprintln!(
        "MAKA_PUBLIC_AUDIO {}",
        json!({"bytes":bytes.len(),"tone_hz":frequency,"sample_rate":24000,"channels":2,"bits":16,"automatic_completion":true,"file_and_media_equal":true})
    );
    repl.close().await.unwrap();
    bridge.0.lock().await.close().await.unwrap();
    assert!(!path.exists(), "session close retained its recording");
    driver.lock().await.close().await.unwrap();
    assert!(pactl(&["list", "source-outputs", "short"]).is_empty());
}
