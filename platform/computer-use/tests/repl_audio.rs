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

use maka_agent_facts::{
    capability::ContentBlock,
    tools::{ToolExecutor, ToolFuture},
};
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult};
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[cfg(all(feature = "native-desktop", target_os = "linux"))]
#[path = "fixtures/audio.rs"]
mod native_audio;

const WAV: &str = "UklGRigAAABXQVZFZm10IBAAAAABAAIAwF0AAAB3AQAEABAAZGF0YQQAAAABAP9/";

#[derive(Default)]
struct Fixture {
    calls: Mutex<Vec<Value>>,
}

impl ToolExecutor for Fixture {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }

    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        self.calls.lock().unwrap().push(input.clone());
        Box::pin(async move {
            Ok(match input["method"].as_str().unwrap() {
                "documentation" => json!("Fixture audio API"),
                "startAudioRecording" => Value::Null,
                "stopAudioRecording" => json!({
                    "filepath":"/fixture/recording.wav",
                    "byte_length":48,
                    "data_url":format!("data:audio/wav;base64,{WAV}"),
                }),
                other => panic!("unexpected audio fixture command {other}"),
            })
        })
    }
}

async fn evaluate(repl: &Repl, bridge: Arc<Fixture>, code: &str) -> Vec<CellOutput> {
    let context =
        CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            code.into(),
            bridge,
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    context.take_output()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audio_opt_in_preserves_the_public_recording_bytes_and_media() {
    let bridge = Arc::new(Fixture::default());
    let repl = Repl::new(
        maka_computer_use::facade_for("linux", true),
        CellLimits::default(),
    )
    .unwrap();
    let output = evaluate(
        &repl,
        bridge.clone(),
        "const started=await cua.computer.start_audio_recording({max_duration_ms:1250});
         nodeRepl.write(typeof started);
         const recording=await cua.computer.stop_audio_recording();
         nodeRepl.write({filepath:recording.filepath,bytes:[...recording.bytes],data_url:recording.data_url});
         await nodeRepl.emitAudio(recording.bytes);",
    )
    .await;
    assert!(
        output
            .iter()
            .any(|part| matches!(part, CellOutput::Text { text } if text == "undefined"))
    );
    let recording = output
        .iter()
        .find_map(|part| match part {
            CellOutput::Text { text } => serde_json::from_str::<Value>(text)
                .ok()
                .filter(|value| value.get("filepath").is_some()),
            _ => None,
        })
        .unwrap();
    assert_eq!(
        recording,
        json!({
            "filepath":"/fixture/recording.wav",
            "data_url":format!("data:audio/wav;base64,{WAV}"),
            "bytes":[82,73,70,70,40,0,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,2,0,192,93,0,0,0,119,1,0,4,0,16,0,100,97,116,97,4,0,0,0,1,0,255,127],
        })
    );
    let media: Vec<_> = output
        .iter()
        .filter_map(|part| match part {
            CellOutput::Media { content, .. } => Some(content),
            _ => None,
        })
        .collect();
    assert_eq!(
        media,
        vec![&ContentBlock::Audio {
            data: WAV.into(),
            mime_type: "audio/wav".into()
        }]
    );
    assert_eq!(
        *bridge.calls.lock().unwrap(),
        vec![
            json!({"method":"documentation"}),
            json!({"method":"startAudioRecording","options":{"max_duration_ms":1250}}),
            json!({"method":"documentation"}),
            json!({"method":"stopAudioRecording"}),
        ]
    );
    repl.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn default_facade_and_host_both_refuse_recording_without_opt_in() {
    let bridge = Arc::new(Fixture::default());
    let repl = Repl::new(maka_computer_use::facade(), CellLimits::default()).unwrap();
    let output = evaluate(
        &repl,
        bridge.clone(),
        "nodeRepl.write([typeof cua.computer.start_audio_recording,
                         typeof cua.computer.stop_audio_recording,typeof nodeRepl.emitAudio]);",
    )
    .await;
    assert!(output.iter().any(|part| matches!(part, CellOutput::Text { text } if text == "[\"undefined\",\"undefined\",\"undefined\"]")));
    assert!(bridge.calls.lock().unwrap().is_empty());
    repl.close().await.unwrap();

    let mut native = maka_computer_use::Session::new(Arc::new(tokio::sync::Mutex::new(
        maka_computer_use::Driver::default(),
    )));
    let error = native
        .invoke(
            maka_computer_use::protocol::Command::StartAudioRecording {
                options: Default::default(),
            },
            &maka_computer_use::InvocationContext::new(
                "disabled-audio-session",
                "disabled-audio-turn",
            ),
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En,
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, maka_agent_facts::tools::ToolError::Failed(message)
        if message == "Computer audio recording is disabled in Host configuration")
    );
    native.close().await.unwrap();
}
