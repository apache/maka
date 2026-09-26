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

//! Measure individual UI frames separately from background preparation and settling.
use super::*;
use std::time::Duration;

fn sample(
    view: &mut Transcript,
    terminal: &mut Terminal<TestBackend>,
    phase: &str,
    index: usize,
    shape: &str,
    source: &str,
) -> Value {
    let start = Instant::now();
    let mut frames = Vec::new();
    let mut max_rows = 0;
    let mut max_bytes = 0;
    loop {
        let frame = Instant::now();
        render(view, terminal).unwrap();
        frames.push(frame.elapsed().as_nanos());
        let block = view.blocks.values().next().unwrap();
        max_rows = max_rows.max(block.visual_lines().len());
        max_bytes = max_bytes.max(block.geometry_bytes());
        if view.motion_wait().is_none() {
            break;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "large {shape} {phase} did not settle"
        );
        // The measurement runs without a terminal event loop or presentation clock.
        // Yield to the preparation worker; do not include this in individual frames.
        std::thread::yield_now();
    }
    let settled_ns = start.elapsed().as_nanos();
    let first_frame_ns = frames[0];
    let size = terminal.size().unwrap();
    let block = view.blocks.values().next().unwrap();
    let geometry_current = block.visual_current();
    let final_rows = block.visual_lines().len();
    let semantic_bytes = block.semantic.as_ref().map_or(0, |text| text.len());
    // A resize may display the last committed window while its replacement is
    // measured. Both benchmark sizes are at most 40 rows high.
    let contract_ok = geometry_current
        && final_rows > 0
        && final_rows <= usize::from(size.height) * 4
        && max_rows <= 40 * 4;
    frames.sort_unstable();
    let row = json!({
        "type": "sample", "benchmark": "transcript_large_record_v1",
        "phase": phase, "sample": index, "warmup": index < 2, "shape": shape,
        "width": size.width, "height": size.height, "source_bytes": source.len(),
        "source_lines": source.lines().count(), "settled_ns": settled_ns,
        "frames": frames.len(), "first_frame_ns": first_frame_ns,
        "frame_p50_ns": frames[frames.len().div_ceil(2) - 1],
        "frame_p95_ns": frames[(frames.len() * 95).div_ceil(100) - 1],
        "frame_max_ns": frames.last().unwrap(),
        "max_cached_visual_rows": max_rows, "final_cached_visual_rows": final_rows,
        "max_accounted_bytes": max_bytes, "semantic_bytes": semantic_bytes,
        "contract_ok": contract_ok,
    });
    assert!(contract_ok, "{row}");
    row
}

#[test]
#[ignore = "release UI-frame and preparation measurement; run alone with --nocapture"]
fn large_record_cpu_and_settle_samples() {
    let release_profile = !cfg!(debug_assertions);
    assert!(release_profile, "run this measurement with --release");
    let mut samples = Vec::new();
    for lines in [1_000, 10_000] {
        for shape in ["markdown", "table"] {
            let source = if shape == "table" {
                format!(
                    "| Index | Progress | Detail |\n| ---: | :--- | --- |\n{}",
                    (0..lines)
                        .map(|index| format!("| {index} | **Reviewed** | 完整记录与下一步 🦀 |\n"))
                        .collect::<String>()
                )
            } else {
                format!(
                    "# Large report\n\n{}",
                    "Unicode **progress**: 卡片已核对，下一步继续。 🚀\n\n".repeat(lines / 2)
                )
            };
            for size in [(120, 40), (55, 24)] {
                for index in 0..8 {
                    let mut view = Transcript::default();
                    let mut terminal = Terminal::new(TestBackend::new(size.0, size.1)).unwrap();
                    let key = MessageKey::new("performance", "large", Part::Text);
                    let mut text = source.clone();
                    view.begin();
                    view.upsert(key.clone(), Revision::Durable(1), Kind::Assistant, || {
                        text.clone().into()
                    });
                    view.finish([], &locale());
                    samples.push(sample(
                        &mut view,
                        &mut terminal,
                        "first",
                        index,
                        shape,
                        &text,
                    ));
                    samples.push(sample(
                        &mut view,
                        &mut terminal,
                        "stable",
                        index,
                        shape,
                        &text,
                    ));
                    view.scroll(true, usize::from(size.1 / 2));
                    samples.push(sample(
                        &mut view,
                        &mut terminal,
                        "scroll",
                        index,
                        shape,
                        &text,
                    ));
                    let resized = if size.0 == 120 { (55, 24) } else { (120, 40) };
                    terminal.backend_mut().resize(resized.0, resized.1);
                    terminal
                        .resize(Rect::new(0, 0, resized.0, resized.1))
                        .unwrap();
                    samples.push(sample(
                        &mut view,
                        &mut terminal,
                        "resize",
                        index,
                        shape,
                        &text,
                    ));
                    view.latest();
                    text.push_str("\n\nAppended result — 已完成。\n");
                    view.begin_stream();
                    view.upsert(key, Revision::Live(2), Kind::Assistant, || {
                        text.clone().into()
                    });
                    view.finish([], &locale());
                    samples.push(sample(
                        &mut view,
                        &mut terminal,
                        "append",
                        index,
                        shape,
                        &text,
                    ));
                }
            }
        }
    }
    println!(
        "{}",
        json!({
            "type": "metadata", "benchmark": "transcript_large_record_v1",
            "executable": std::env::current_exe().unwrap(), "samples": samples.len(),
            "renderer": "Transcript::draw / ratatui Terminal<TestBackend>",
            "clock": "std::time::Instant elapsed wall time in nanoseconds",
            "first_frame_ns": "first complete UI frame after the requested change",
            "settled_ns": "draw/yield loop including preparation and bookkeeping; not paced terminal presentation",
            "frame_quantiles": "complete frames until no further layout wake is requested; nearest rank",
            "max_accounted_bytes": "geometry, prepared document and semantic accounting; not allocator bytes or RSS",
            "warmup_policy": "two warmup runs retained per shape/size/scale, then six measured runs",
            "limits": "source creation/reconciliation excluded; no Host, transport, PTY or physical display",
        })
    );
    for sample in samples {
        println!("{sample}");
    }
}
