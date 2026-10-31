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

//! Repeatable storage measurements through real Root and frozen semantic-source APIs.
use maka_agent_facts::{
    event::{
        EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, LogScope, RuntimeEvent,
    },
    history::semantic::directory::{
        ChildDirectory, JsonSpan, ListKind, PayloadDirectory, RowDirectory, TextSpan,
        ToolDirectory, ToolPartDirectory,
    },
    model::prompt_source::source::{Allocate, ChargedBuffer, SourceBudget, SourceBytes},
    tool_call::ToolCallIdentity,
    tool_output::{DurableToolProjection, ProjectionPart, ToolOutput, ToolSuccess},
};
use maka_event_log::{
    root::{RootNamespaces, RootOwner},
    root_store::{RootStore, SessionStore},
};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    collections::BTreeMap,
    error::Error,
    path::PathBuf,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
const PAGE_BYTES: usize = 64 * 1024;
struct Budget;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
struct Charge(usize);
impl Drop for Charge {
    fn drop(&mut self) {
        LIVE.fetch_sub(self.0, Ordering::Relaxed);
    }
}
impl SourceBudget for Budget {
    fn allocate(&self, minimum: usize) -> Allocate<'_> {
        Box::pin(async move { Ok(allocation(minimum)) })
    }
}
fn allocation(bytes: usize) -> ChargedBuffer {
    let live = LIVE.fetch_add(bytes, Ordering::Relaxed) + bytes;
    PEAK.fetch_max(live, Ordering::Relaxed);
    ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    ChargedBuffer::new(vec![0; bytes], Charge(bytes))
}
fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
async fn consume(bytes: &SourceBytes) -> Result<Vec<u8>> {
    let mut cursor = bytes.open(Arc::new(Budget));
    let mut buffer = allocation(PAGE_BYTES);
    let mut result = Vec::new();
    loop {
        let chunk = cursor.read_chunk(buffer).await?;
        result.extend_from_slice(&chunk.buffer.as_ref()[..chunk.bytes_read]);
        buffer = chunk.buffer;
        if chunk.bytes_read == 0 {
            break;
        }
    }
    Ok(result)
}
async fn check_text(
    captured: &maka_event_log::context::semantic::CapturedSource,
    body: &maka_event_log::context::semantic::PayloadSource,
    span: TextSpan,
) -> Result<()> {
    let source = captured.text(body, span)?;
    let raw = consume(source.bytes()).await?;
    let decoded: String = serde_json::from_slice(&raw)?;
    if decoded.len() as u64 != span.measure.bytes
        || Sha256::digest(decoded.as_bytes()).as_slice() != span.measure.sha256
    {
        return Err("text descriptor commitment changed".into());
    }
    Ok(())
}
async fn check_json(
    captured: &maka_event_log::context::semantic::CapturedSource,
    body: &maka_event_log::context::semantic::PayloadSource,
    span: JsonSpan,
) -> Result<()> {
    let source = captured.json(body, span)?;
    let raw = consume(source.bytes()).await?;
    if raw.len() as u64 != span.measure.bytes
        || Sha256::digest(&raw).as_slice() != span.measure.sha256
    {
        return Err("JSON descriptor commitment changed".into());
    }
    let _: serde_json::Value = serde_json::from_slice(&raw)?;
    Ok(())
}
fn plain(invocation: &Invocation, fact: Fact, seconds: u64) -> Result<EventWrite> {
    let identity = format!(
        "bench-{}-{}",
        fact.kind(),
        fact.operation_id().unwrap_or("boundary")
    );
    let mut event = RuntimeEvent::new(invocation.clone(), fact);
    event.id = identity;
    event.recorded_at = UNIX_EPOCH + std::time::Duration::from_secs(seconds);
    Ok(EventWrite::plain(event)?)
}
async fn append_tool(
    session: &SessionStore,
    invocation: &Invocation,
    step: &str,
    text: &str,
    index: u64,
) -> Result<(EventWrite, u64, u64)> {
    use maka_agent_facts::{
        context::ModelPurpose,
        model::{
            ModelEvent, ModelFinishReason,
            assembly::{AttemptBinding, AttemptWriter},
        },
    };
    let time = UNIX_EPOCH + std::time::Duration::from_secs(index * 2 + 1);
    let source = session
        .read_model_view(&invocation.session_id, Some(&invocation.invocation_id))
        .await?;
    session
        .append(
            &plain(
                invocation,
                Fact::ModelRequested {
                    source_capture: maka_agent_facts::event::SourceCapture {
                        publication_watermark: source.selection.captured_through,
                        prior_unknown: false,
                    },
                    context_breakdown: None,
                    item_acceptance: false,
                    step_id: step.into(),
                    model_id: "test".into(),
                    purpose: ModelPurpose::Main,
                    context: None,
                    source_scope: source.source_evidence.scope,
                    source_high_water: source.source_evidence.high_water,
                    source_digest: source.source_evidence.digest,
                    input_digest: "fixture".into(),
                    route_identity: format!("sha256:{}", "a".repeat(64)),
                    checkpoint_event_id: source.baseline.map(|baseline| baseline.event_id),
                    effective_source_digest: Some(source.effective_source_digest),
                },
                index * 2 + 1,
            )?
            .with_quote(maka_agent_facts::pricing::Quote {
                provider_id: "fixture".into(),
                revision: 1,
                pricing: Some(maka_agent_facts::pricing::Pricing {
                    model_key: "fixture:test".into(),
                    input_usd_per_million: 1.0,
                    output_usd_per_million: 2.0,
                    cache_read_usd_per_million: None,
                    cache_write_usd_per_million: None,
                }),
            })?,
        )
        .await?;
    let mut writer = AttemptWriter::new(
        AttemptBinding {
            invocation: invocation.clone(),
            step_id: step.into(),
            purpose: ModelPurpose::Main,
        },
        false,
    )?;
    writer.push(ModelEvent::ToolCall(serde_json::from_value(json!({"id":step,"name":"Read","input":{"kind":"json","data":{"path":"fixture"}},"provider_executed":false}))?),time)?;
    let observations = writer.push(
        ModelEvent::Finished {
            reason: ModelFinishReason::ToolCalls,
            usage: Default::default(),
            provider_options: None,
        },
        time,
    )?;
    for observation in observations {
        let mut event = RuntimeEvent::new(
            invocation.clone(),
            Fact::ModelObserved {
                step_id: step.into(),
                event: observation,
            },
        );
        // The observation kind differentiates the part and terminal witness.
        event.id = format!(
            "observed-{step}-{}",
            digest(&serde_json::to_vec(&event.fact)?)
        );
        event.recorded_at = time;
        session.append(&EventWrite::plain(event)?).await?;
    }
    let output = writer.completed()?.completion();
    session
        .append(&plain(
            invocation,
            Fact::ModelCompleted {
                step_id: step.into(),
                output,
            },
            index * 2 + 1,
        )?)
        .await?;
    let operation = format!("{step}:{step}");
    session
        .append(&plain(
            invocation,
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: operation.clone(),
                call: ToolCallIdentity::provider(step.into(), step.into()),
                name: "Read".into(),
                input: json!({"path":"fixture"}),
            },
            index * 2 + 1,
        )?)
        .await?;
    let output = ToolOutput::Text(text.into());
    let projection = match index % 3 {
        0 => DurableToolProjection::Json {
            value: json!({"event":index,"text":text}),
        },
        1 => DurableToolProjection::Text { text: text.into() },
        _ => DurableToolProjection::Content {
            parts: (0..9)
                .map(|part| ProjectionPart::Text {
                    text: format!("part-{part}:{text}"),
                })
                .collect(),
        },
    };
    let (write, _) = EventWrite::tool_success(
        format!("result-{step}"),
        UNIX_EPOCH + std::time::Duration::from_secs(index * 2 + 2),
        invocation.clone(),
        operation,
        ToolSuccess::projected(output, projection),
    )?;
    let start = Instant::now();
    let sequence = session.append(&write).await?;
    Ok((write, sequence, start.elapsed().as_nanos() as u64))
}
#[derive(Default)]
struct Samples(BTreeMap<&'static str, Vec<u64>>);
impl Samples {
    fn add(&mut self, operation: &'static str, start: Instant) {
        self.0
            .entry(operation)
            .or_default()
            .push(start.elapsed().as_nanos() as u64);
    }
    fn report(self) -> serde_json::Value {
        let mut output = serde_json::Map::new();
        for (operation, mut values) in self.0 {
            values.sort_unstable();
            let at = |quantile: usize| values[((values.len() - 1) * quantile) / 100];
            output.insert(operation.into(),json!({"samples":values.len(),"min_ns":values[0],"p50_ns":at(50),"p95_ns":at(95),"p99_ns":at(99),"max_ns":values[values.len()-1],"values_ns":values}));
        }
        output.into()
    }
}
fn io_stats() -> serde_json::Value {
    match std::fs::read_to_string("/proc/self/io") {
        Ok(value) => json!({"value":value}),
        Err(error) => json!({"unavailable":error.to_string()}),
    }
}
fn usage() -> serde_json::Value {
    #[cfg(unix)]
    {
        let mut value = std::mem::MaybeUninit::<libc::rusage>::uninit();
        // SAFETY: getrusage initializes this correctly sized output on success.
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, value.as_mut_ptr()) } == 0 {
            // SAFETY: the successful call initialized every field.
            let value = unsafe { value.assume_init() };
            let micros = |time: libc::timeval| {
                i128::from(time.tv_sec) * 1_000_000 + i128::from(time.tv_usec)
            };
            return json!({"user_us":micros(value.ru_utime),"system_us":micros(value.ru_stime),"max_rss_native_units":value.ru_maxrss,"minor_faults":value.ru_minflt,"major_faults":value.ru_majflt,"block_inputs":value.ru_inblock,"block_outputs":value.ru_oublock});
        }
    }
    serde_json::Value::Null
}
fn resource_summary(stats: &maka_event_log::connection::SqliteResourceStats) -> serde_json::Value {
    json!({"id":stats.connection_id,"cache_bytes":stats.cache_bytes,"cache_hits":stats.cache_hits,"cache_misses":stats.cache_misses,"cache_spills":stats.cache_spills,"cached_statements":stats.cached_statements})
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str, default: &str| {
        arguments
            .iter()
            .position(|arg| arg == name)
            .and_then(|index| arguments.get(index + 1))
            .cloned()
            .unwrap_or_else(|| default.into())
    };
    let directory = PathBuf::from(value("--database", "/tmp/maka-event-storage-bench"));
    let mode = value("--mode", "create");
    if !matches!(mode.as_str(), "create" | "read") {
        return Err("mode must be create or read".into());
    }
    let events: usize = value("--events", "128").parse()?;
    let body_bytes: usize = value("--body-bytes", "65536").parse()?;
    let iterations: usize = value("--iterations", "10").parse()?;
    if events == 0 || iterations == 0 {
        return Err("events and iterations must be positive".into());
    }
    std::fs::create_dir_all(&directory)?;
    let namespaces = RootNamespaces {
        ownership: directory.join("ownership"),
        control: directory.join("control"),
    };
    let owner = if mode == "create" {
        RootOwner::create(&directory.join("root"), &namespaces)?
    } else {
        RootOwner::open(&directory.join("root"), &namespaces)?
    };
    let root = RootStore::open(Arc::new(owner)).await?;
    let mut samples = Samples::default();
    let before_io = io_stats();
    let before_usage = usage();
    let mut manifest = serde_json::Value::Null;
    if mode == "create" {
        let session = root.create_session("bench", "bench", &json!({}), 1).await?;
        let invocation = Invocation {
            session_id: "bench".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        session
            .append(&plain(
                &invocation,
                Fact::InvocationOpened {
                    configuration: None,
                    input: InvocationInput::Message {
                        content: "storage measurement".into(),
                        source_messages: vec![],
                        request_fingerprint: None,
                    },
                },
                0,
            )?)
            .await?;
        let pattern = "line: storage \\\"payload\\\"\n";
        let mut body = pattern.repeat(body_bytes.div_ceil(pattern.len()));
        body.truncate(body_bytes);
        let mut payloads = serde_json::Map::new();
        for index in 0..events {
            let operation = format!("tool-{index}");
            let text = format!("event-{index:016x}:{body}:end-{index:016x}");
            let start = Instant::now();
            let (write, sequence, settled_ns) =
                append_tool(&session, &invocation, &operation, &text, index as u64).await?;
            samples.add("append_attempt", start);
            samples
                .0
                .entry("append_tool_settled")
                .or_default()
                .push(settled_ns);
            if let Fact::ToolSettled {
                outcome:
                    maka_agent_facts::event::ToolOutcome::Succeeded {
                        model_projection, ..
                    },
                ..
            } = &write.event().fact
            {
                let projection = serde_json::to_vec(model_projection)?;
                payloads.insert(sequence.to_string(),json!({"bytes":projection.len(),"digest":digest(&projection),"first_digest":digest(&projection[..projection.len().min(64)]),"tail_digest":digest(&projection[projection.len().saturating_sub(64)..])}));
            }
        }
        session
            .append(&plain(
                &invocation,
                Fact::InvocationEnded {
                    outcome: InvocationOutcome::Completed,
                },
                events as u64 * 2 + 1,
            )?)
            .await?;
        let prefix = session
            .scoped_prefix(
                LogScope::Session { id: "bench".into() },
                usize::MAX,
                usize::MAX,
            )
            .await?;
        let inventory = root.preview_bundle("bench").await?;
        let (_, export) = root
            .export_bundle("bench", &inventory.subtree_digest, tokio::io::sink())
            .await?;
        manifest = json!({"events":events,"body_bytes":body_bytes,"prefix_digest":prefix.digest,"export_digest":export.digest,"events_digest":digest(&serde_json::to_vec(&prefix.events)?),"payloads":payloads,"canonical_events":prefix.events.len()});
        std::fs::write(
            directory.join("fixture.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
    }
    if manifest.is_null() {
        manifest = serde_json::from_slice(&std::fs::read(directory.join("fixture.json"))?)?;
    }
    let expected = manifest["events"].as_u64().ok_or("fixture lacks count")? as usize;
    let session = root.session("bench").await?;
    let view = session.read_model_view("bench", None).await?;
    let scope = session.execution_scope(None).await?;
    let running = scope.store();
    let lease = scope.accept();
    let captured = running.capture_source(view.selection).await?;
    let mut completed_bytes = 0u64;
    let mut completed_rows = 0u64;
    let mut descriptors = Sha256::new();
    let mut directory_buffer = allocation(32 * 1024);
    let mut directory_pages = 0u64;
    let mut child_pages = 0u64;
    // The first pass validates descriptors and warms application/SQLite caches.
    for iteration in 0..=iterations {
        let start = Instant::now();
        let metadata = session.read_model_view("bench", None).await?;
        std::hint::black_box(metadata.source_evidence.digest);
        if iteration > 0 {
            samples.add("model_view", start);
        }
        let start = Instant::now();
        let mut cursor = None;
        let mut payloads = Vec::new();
        loop {
            let mut page = captured.directory_page(cursor, directory_buffer).await?;
            directory_pages += 1;
            while let Some(row) = page.next_row()? {
                completed_rows += 1;
                std::hint::black_box((&row.directory, &row.payload));
                if iteration == 0 {
                    descriptors.update(serde_json::to_vec(&(
                        &row.row.id,
                        &row.directory,
                        &row.payload,
                    ))?);
                }
                if matches!(row.directory, RowDirectory::ToolResult { .. }) {
                    let body = captured
                        .describe_payload(&row.row)?
                        .ok_or("tool lacks body")?;
                    let length = body.byte_len().ok_or("tool lacks length")?;
                    let evidence = manifest["payloads"]
                        .get(row.row.id.source_sequence.to_string())
                        .ok_or("unexpected payload identity")?
                        .clone();
                    if length != evidence["bytes"].as_u64().ok_or("missing payload length")? {
                        return Err("payload length changed".into());
                    }
                    payloads.push((
                        body,
                        length,
                        evidence,
                        row.payload.ok_or("missing typed payload")?,
                    ));
                }
            }
            cursor = page.next;
            directory_buffer = page.into_buffer();
            if cursor.is_none() {
                break;
            }
        }
        if iteration > 0 {
            samples.add("directory_page_all", start);
        }
        if payloads.len() != expected {
            return Err(format!("expected {expected} tool results, got {}", payloads.len()).into());
        }
        let start = Instant::now();
        for (body, length, evidence, _) in &payloads {
            let source = captured.byte_range(body, 0, (*length).min(64))?;
            let mut reader = source.open(Arc::new(Budget));
            let read = reader.read_chunk(allocation(64)).await?;
            if read.bytes_read != (*length).min(64) as usize {
                return Err("short first read".into());
            }
            completed_bytes += read.bytes_read as u64;
            if digest(&read.buffer.as_ref()[..read.bytes_read])
                != evidence["first_digest"]
                    .as_str()
                    .ok_or("missing first digest")?
            {
                return Err("first window changed".into());
            }
        }
        if iteration > 0 {
            samples.add("first_64_all", start);
        }
        let start = Instant::now();
        for (body, length, evidence, _) in &payloads {
            let count = (*length).min(64);
            let source = captured.byte_range(body, length - count, count)?;
            let mut reader = source.open(Arc::new(Budget));
            let read = reader.read_chunk(allocation(64)).await?;
            if read.bytes_read != count as usize {
                return Err("short tail read".into());
            }
            completed_bytes += read.bytes_read as u64;
            if digest(&read.buffer.as_ref()[..read.bytes_read])
                != evidence["tail_digest"]
                    .as_str()
                    .ok_or("missing tail digest")?
            {
                return Err("tail window changed".into());
            }
        }
        if iteration > 0 {
            samples.add("tail_64_all", start);
        }
        let start = Instant::now();
        for (body, _, evidence, _) in &payloads {
            let (sha, bytes) = captured
                .with_sequential_source(body, |reader| {
                    let mut buffer = [0u8; PAGE_BYTES];
                    let mut sha = Sha256::new();
                    let mut bytes = 0;
                    loop {
                        let count = reader.read(&mut buffer)?;
                        if count == 0 {
                            break;
                        }
                        sha.update(&buffer[..count]);
                        bytes += count as u64;
                    }
                    Ok((hex::encode(sha.finalize()), bytes))
                })
                .await?;
            if sha
                != evidence["digest"]
                    .as_str()
                    .ok_or("missing expected digest")?
            {
                return Err("projection bytes changed".into());
            }
            completed_bytes += bytes;
        }
        if iteration > 0 {
            samples.add("sequential_all", start);
        }
        let start = Instant::now();
        for (body, _, _, directory) in &payloads {
            match directory {
                PayloadDirectory::Tool(ToolDirectory::Text(span)) => {
                    check_text(&captured, body, *span).await?
                }
                PayloadDirectory::Tool(ToolDirectory::Json(span)) => {
                    check_json(&captured, body, *span).await?
                }
                PayloadDirectory::Tool(ToolDirectory::Content { parts }) => {
                    let mut after = None;
                    let mut count = 0;
                    let mut buffer = allocation(1024);
                    loop {
                        let mut page = captured
                            .child_page(body, ListKind::ToolParts, after, buffer)
                            .await?;
                        child_pages += 1;
                        while let Some(child) = page.next_child()? {
                            if iteration == 0 {
                                descriptors.update(serde_json::to_vec(&child)?);
                            }
                            let ChildDirectory::ToolPart(ToolPartDirectory::Text(span)) = child
                            else {
                                return Err("unexpected child".into());
                            };
                            check_text(&captured, body, span).await?;
                            count += 1;
                        }
                        after = page.next;
                        buffer = page.into_buffer();
                        if after.is_none() {
                            break;
                        }
                    }
                    if count != *parts {
                        return Err("child list changed".into());
                    }
                }
                _ => return Err("unexpected tool directory".into()),
            }
        }
        if iteration > 0 {
            samples.add("descriptor_leaves_all", start);
        }
        let start = Instant::now();
        let prefix = session
            .scoped_prefix(
                LogScope::Session { id: "bench".into() },
                usize::MAX,
                usize::MAX,
            )
            .await?;
        if prefix.digest
            != manifest["prefix_digest"]
                .as_str()
                .ok_or("missing prefix digest")?
        {
            return Err("event proof changed".into());
        }
        if prefix.events.len()
            != manifest["canonical_events"]
                .as_u64()
                .ok_or("missing event count")? as usize
        {
            return Err("event count changed".into());
        }
        if digest(&serde_json::to_vec(&prefix.events)?)
            != manifest["events_digest"]
                .as_str()
                .ok_or("missing event content digest")?
        {
            return Err("event content changed".into());
        }
        if iteration > 0 {
            samples.add("prefix_all", start);
        }
        let start = Instant::now();
        let inventory = root.preview_bundle("bench").await?;
        let (_, export) = root
            .export_bundle("bench", &inventory.subtree_digest, tokio::io::sink())
            .await?;
        if export.digest
            != manifest["export_digest"]
                .as_str()
                .ok_or("missing root digest")?
        {
            return Err("original canonical bytes changed".into());
        }
        if iteration > 0 {
            samples.add("export_all", start);
        }
    }
    manifest["descriptor_digest"] = hex::encode(descriptors.finalize()).into();
    let resources: Vec<_>=root.sqlite_resource_stats().await?.iter().map(|owner|json!({"writer":resource_summary(&owner.writer),"readers":owner.readers.iter().map(|reader|reader.as_ref().map(resource_summary)).collect::<Vec<_>>()})).collect();
    let after_io = io_stats();
    drop(captured);
    drop(running);
    lease.finish();
    root.close().await?;
    let mut database_bytes = 0;
    for entry in std::fs::read_dir(directory.join("root/runtime-partitions"))? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            database_bytes += entry.metadata()?.len();
        }
    }
    println!(
        "{}",
        json!({"mode":mode,"fixture":manifest,"iterations":iterations,"profile":if cfg!(debug_assertions){"debug"}else{"release"},"samples":samples.report(),"completed_rows":completed_rows,"completed_bytes":completed_bytes,"directory_pages":directory_pages,"child_pages":child_pages,"peak_charged_bytes":PEAK.load(Ordering::Relaxed),"charged_allocations":ALLOCATIONS.load(Ordering::Relaxed),"errors":0,"database_bytes_after_close":database_bytes,"io_before":before_io,"io_after":after_io,"sqlite_resources":resources,"usage_before":before_usage,"usage_after":usage(),"timestamp":SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs()})
    );
    Ok(())
}
