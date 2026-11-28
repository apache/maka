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

//! Deterministic pure-schema corpus used to train `dict_v1.bin`.
//!
//! Contains strictly synthetic Maka protocol envelopes (JSON keys, enum tags,
//! tool/cell/operation shapes, and placeholder tokens) with zero user data,
//! host paths, or session identifiers.

pub const DICT_V1_SIZE_BYTES: usize = 32 * 1024;

fn fake_uuid(seed: u32) -> String {
    format!(
        "{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}",
        seed.wrapping_mul(2654435761),
        (seed.wrapping_mul(40503)) & 0xffff,
        (seed.wrapping_mul(12289)) & 0x0fff,
        (seed.wrapping_mul(7919)) & 0x0fff,
        u64::from(seed).wrapping_mul(0x9e37_79b9_7f4a_7c15) & 0xffff_ffff_ffff
    )
}

fn fake_sha(seed: u32) -> String {
    let mut out = String::with_capacity(71);
    out.push_str("sha256:");
    let mut x = u64::from(seed) ^ 0x243f_6a88_85a3_08d3;
    for _ in 0..8 {
        x = x
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{x:08x}");
    }
    out
}

/// Build the deterministic pure-schema training corpus for `dict_v1.bin`.
pub fn pure_schema_samples() -> Vec<Vec<u8>> {
    let mut samples = Vec::with_capacity(640);
    let tool_names = [
        "Read",
        "Write",
        "Edit",
        "Shell",
        "exec",
        "wait",
        "Recall",
        "RecallMore",
        "RecallMaterial",
        "SessionRead",
        "SessionList",
        "SessionSend",
        "ProcessRead",
        "ProcessStop",
        "WebFetch",
        "Skill",
    ];
    let contracts = [
        ("maka.workspace.Read", "files", "read"),
        ("maka.workspace.Write", "files", "write"),
        ("maka.workspace.Edit", "files", "edit"),
        ("maka.workspace.Shell", "shell", "exec"),
        ("maka.agent.Recall", "recall", "search"),
        ("maka.agent.SessionRead", "session", "read"),
        ("maka.workspace.WebFetch", "web", "fetch"),
    ];
    let sample_texts = [
        "Reading source file to inspect schema and state transitions.",
        "Running unit tests for storage migration and query invariants.",
        "Updated implementation and verified all assertions pass.",
        "Checking index plan and bounded memory behavior on large inputs.",
        "Completed tool invocation with structured JSON output.",
        "Analyzing diff and verifying backward-compatible migration path.",
    ];

    for i in 0..64u32 {
        let run = fake_uuid(100 + i);
        let fact = fake_uuid(200 + i);
        let step = fake_uuid(300 + i);
        let attempt = fake_uuid(400 + i);
        let cell = fake_uuid(500 + i);
        let task = fake_uuid(600 + i);
        let op = fake_uuid(700 + i);
        let sha1 = fake_sha(1000 + i);
        let sha2 = fake_sha(2000 + i);
        let tool = tool_names[(i as usize) % tool_names.len()];
        let (contract, export, method) = contracts[(i as usize) % contracts.len()];
        let text = sample_texts[(i as usize) % sample_texts.len()];
        let ts = 1_700_000_000_000u64 + u64::from(i) * 137;
        let rev = u64::from(i) + 1;
        let bytes = 256 + u64::from(i) * 43;

        // 1. ModelObserved (text / thinking / tool_call)
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"model_observed","attempt":"{attempt}","index":{i},"part":{{"kind":"text","textKind":"output","text":"{text}"}}}}}}"#
            )
            .into_bytes(),
        );
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"model_observed","attempt":"{attempt}","index":{i},"part":{{"kind":"tool_call","call":{{"id":"call_{i}","name":"{tool}","input":{{"kind":"json","data":{{"path":"src/module_{i}.rs","offset":0,"limit":120}}}}}}}}}}}}"#
            )
            .into_bytes(),
        );

        // 2. LocalToolReturned & ToolResultAccepted
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"local_tool_returned","tool":{{"attempt":"{attempt}","call":"call_{i}"}},"settlement":"returned","result":{{"digest":"{sha1}","bytes":{bytes}}},"isError":false,"cellObservation":null}}}}"#
            )
            .into_bytes(),
        );
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"tool_result_accepted","tool":{{"attempt":"{attempt}","call":"call_{i}"}},"result":{{"digest":"{sha2}","bytes":{bytes}}},"outcome":{{"kind":"succeeded"}}}}}}"#
            )
            .into_bytes(),
        );

        // 3. ExternalTaskObserved (output_delta / thinking_delta / tool_start / tool_result / message_end)
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"external_task_observed","task":"{task}","index":{i},"modelTimeMs":null,"output":{{"type":"output_delta","messageId":"msg-{i}","text":"{text}"}}}}}}"#
            )
            .into_bytes(),
        );
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"external_task_observed","task":"{task}","index":{i},"modelTimeMs":null,"output":{{"type":"thinking_delta","messageId":"msg-{i}","text":"{text}"}}}}}}"#
            )
            .into_bytes(),
        );
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"external_task_observed","task":"{task}","index":{i},"modelTimeMs":null,"output":{{"type":"tool_start","toolCallId":"tc-{i}","name":"{tool}","input":{{"command":"cargo test -p maka-event-log"}}}}}}}}"#
            )
            .into_bytes(),
        );

        // 4. Cell events (started / child_prepared / child_observed / child_result_recorded / completed)
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"cell","event":{{"kind":"child_prepared","cell":"{cell}","operation":"{op}","name":"{tool}","semantics":"parallel","input":{{"digest":"{sha1}","bytes":{bytes}}},"resources":[]}}}}}}"#
            )
            .into_bytes(),
        );
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"cell","event":{{"kind":"child_observed","cell":"{cell}","operation":"{op}","reply":{{"reference":{{"operation":"{op}","contract":{{"name":"{contract}","version":"1.0.0"}},"export":"{export}","method":"{method}"}},"receipt":{{"kind":"settled","outcome":{{"kind":"succeeded","result":{{"kind":"reference","reference":{{"digest":"{sha1}","bytes":{bytes}}}}}}},"cleanup":{{"kind":"confirmed"}}}}}}}}}}}}"#
            )
            .into_bytes(),
        );
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"cell","event":{{"kind":"child_result_recorded","cell":"{cell}","operation":"{op}","result":{{"digest":"{sha2}","bytes":{bytes}}},"isError":false}}}}}}"#
            )
            .into_bytes(),
        );

        // 5. ToolReturn / StoredToolResult / AcceptedToolResult / CellObservation
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"body":{{"output":{{"kind":"text","text":"{text}"}},"projection":{{"kind":"text","text":"{text}"}},"isError":false,"loadedTools":[],"displayBudgetChars":null}},"artifacts":[]}}"#
            )
            .into_bytes(),
        );
        samples.push(
            format!(r#"{{"kind":"local","result":{{"digest":"{sha1}","bytes":{bytes}}}}}"#)
                .into_bytes(),
        );
        samples.push(
            format!(
                r#"{{"state":"completed","cell_id":"{cell}","content":[{{"type":"text","text":"{text}"}}],"result":{{"ok":true,"value":null,"toolCalls":[{{"index":1,"name":"{tool}"}}]}}}}"#
            )
            .into_bytes(),
        );

        // 6. Step / Attempt / Usage / RunSpec / Queue envelopes
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"id":"{fact}","run":"{run}","revision":{rev},"at":{ts},"fact":{{"kind":"model_closed","attempt":"{attempt}","outcome":{{"kind":"succeeded","stopReason":"end_turn"}},"usage":{{"inputTokens":1200,"outputTokens":340,"cachedInputTokens":800,"reasoningTokens":120,"cacheWriteTokens":0,"totalTokens":1660}}}}}}"#
            )
            .into_bytes(),
        );
        samples.push(
            format!(
                r#"{{"schemaVersion":1,"run":"{run}","step":"{step}","attempt":"{attempt}","sessionId":"session-{i}","turnId":"turn-{i}","owner":{{"kind":"agent","agentId":"agent-default"}},"trigger":{{"kind":"message","messageId":"msg-{i}"}},"input":{{"digest":"{sha1}","bytes":{bytes}}},"systemPrompt":{{"digest":"{sha2}","bytes":4096}},"toolSelection":{{"digest":"{sha1}","bytes":1024}}}}"#
            )
            .into_bytes(),
        );
        samples.push(
            format!(
                r#"{{"kind":"command","edit":{{"kind":"enqueue","request":{{"id":"req-{i}","source":{{"digest":"{sha1}","bytes":{bytes}}},"resources":{{"digest":"{sha2}","bytes":128}},"spec":{{"schemaVersion":1,"sessionId":"session-{i}","turnId":"turn-{i}"}}}}}}}}"#
            )
            .into_bytes(),
        );
    }

    samples
}

/// Deterministically train the 32 KiB `dict_v1.bin` dictionary from the pure-schema corpus.
pub fn train_dict_v1() -> std::io::Result<Vec<u8>> {
    let samples = pure_schema_samples();
    let slices: Vec<&[u8]> = samples.iter().map(Vec::as_slice).collect();
    zstd::dict::from_samples(&slices, DICT_V1_SIZE_BYTES)
}
