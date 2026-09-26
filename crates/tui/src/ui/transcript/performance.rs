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

//! Opt-in CPU/cache samples from the public renderer, never terminal presentation or RSS.
use super::{tests::locale, tests::render, *};
use ratatui::{Terminal, backend::TestBackend};
use serde_json::{Value, json};
use std::time::Instant;

mod append;
mod large;

#[derive(Clone, Copy, Default)]
pub(super) struct DrawStats {
    pub layout_ns: u128,
    pub after_layout_ns: u128,
    pub visited_blocks: usize,
    pub painted_rows: usize,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    First,
    Stable,
    Scroll,
    OneBlockAppend,
    Resize,
}

struct Source {
    key: MessageKey,
    text: String,
    revision: u64,
}

struct Benchmark {
    view: Transcript,
    terminal: Terminal<TestBackend>,
    sources: Vec<Source>,
    initial_size: (u16, u16),
    size: (u16, u16),
    logical_lines: usize,
    source_bytes: usize,
    i18n: I18n,
}

impl Benchmark {
    fn new(blocks: usize, size: (u16, u16)) -> Self {
        let sources: Vec<_> = (0..blocks)
            .map(|index| {
                // Ten source lines, including blanks and fence delimiters. Half
                // the fences remain open, as they would during a streamed reply.
                let text = format!(
                    "# Entry {index}\n\nEnglish text with **bold**, `inline code`, and a long wrapping sentence.\n中文正文，包含标点、换行和足够长的句子来观察窄窗重排。\nEmoji 🦀 🚀 👩‍💻 and markdown *emphasis* remain readable.\n\n```rust\nfn entry_{index}() {{ println!(\"hello\"); }}\nlet message = \"中文 🚀\";\n{}",
                    if index % 2 == 0 { "```" } else { "// Still streaming" }
                );
                assert_eq!(text.lines().count(), 10);
                Source {
                    key: MessageKey::new("performance", format!("entry-{index}"), Part::Text),
                    text,
                    revision: 0,
                }
            })
            .collect();
        Self {
            view: Transcript {
                measurement: Some(DrawStats::default()),
                ..Default::default()
            },
            terminal: Terminal::new(TestBackend::new(size.0, size.1)).unwrap(),
            logical_lines: blocks * 10,
            source_bytes: sources.iter().map(|source| source.text.len()).sum(),
            sources,
            initial_size: size,
            size,
            i18n: locale(),
        }
    }

    fn reconcile(&mut self, live: bool) {
        if live {
            self.view.begin_stream();
        } else {
            self.view.begin();
        }
        for source in &self.sources {
            self.view.upsert(
                source.key.clone(),
                Revision::Live(source.revision),
                Kind::Assistant,
                || source.text.clone().into(),
            );
        }
        self.view.finish([], &self.i18n);
    }

    fn measure(&mut self, phase: Phase, index: usize, warmup: bool) -> Value {
        let builds = self.view.builds;
        let cached_before = self.view.cached.clone();
        let tail_before = self.sources.last().unwrap().text.len();
        let operation = Instant::now();
        let mut reconcile_ns = None;
        match phase {
            Phase::First => {
                let start = Instant::now();
                self.reconcile(false);
                reconcile_ns = Some(start.elapsed().as_nanos());
            }
            Phase::Stable => {}
            Phase::Scroll => self
                .view
                .scroll(index.is_multiple_of(2), usize::from(self.size.1 / 2)),
            Phase::OneBlockAppend => {
                self.view.latest();
                let tail = self.sources.last_mut().unwrap();
                let addition = format!("\n// append {} 中文 🦀", tail.revision);
                self.source_bytes += addition.len();
                tail.text.push_str(&addition);
                tail.revision += 1;
                self.logical_lines += 1;
                let start = Instant::now();
                self.reconcile(true);
                reconcile_ns = Some(start.elapsed().as_nanos());
            }
            Phase::Resize => {
                self.size = if self.size == (120, 40) {
                    (55, 24)
                } else {
                    (120, 40)
                };
                self.terminal.backend_mut().resize(self.size.0, self.size.1);
                self.terminal
                    .resize(Rect::new(0, 0, self.size.0, self.size.1))
                    .unwrap();
            }
        }
        let frame = Instant::now();
        let error = render(&mut self.view, &mut self.terminal).err();
        let frame_ns = frame.elapsed().as_nanos();
        let operation_ns = operation.elapsed().as_nanos();
        // Snapshot and JSON construction are deliberately outside all timed regions.
        let stats = self.view.measurement.unwrap();
        let rebuilds = self.view.builds - builds;
        let mut layout_lines = 0;
        let mut layout_bytes = 0;
        let mut syntax_bytes = 0;
        let mut geometry_bytes = 0;
        for block in self.view.blocks.values() {
            layout_lines += block.visual_lines().len();
            geometry_bytes += block.geometry_bytes();
            if let Some(layout) = &block.layout {
                layout_bytes += layout.bytes;
            }
            syntax_bytes += block.markdown.syntax_bytes();
        }
        let tail_bytes = self.sources.last().unwrap().text.len();
        let tail_layout = if tail_bytes <= super::large::INLINE_BYTES {
            "inline"
        } else if tail_before <= super::large::INLINE_BYTES {
            "transition"
        } else {
            "prepared"
        };
        let expected_rebuilds = match phase {
            Phase::First | Phase::Resize => self.view.cached.len(),
            Phase::Stable => 0,
            Phase::Scroll => self.view.cached.difference(&cached_before).count(),
            Phase::OneBlockAppend => usize::from(tail_bytes <= super::large::INLINE_BYTES),
        };
        json!({
            "type": "sample", "benchmark": "transcript_viewport_v3",
            "phase": phase, "sample": index, "warmup": warmup,
            "initial_width": self.initial_size.0, "initial_height": self.initial_size.1,
            "width": self.size.0, "height": self.size.1,
            "initial_logical_lines": self.sources.len() * 10,
            "logical_lines": self.logical_lines, "source_bytes": self.source_bytes,
            "tail_bytes": tail_bytes, "tail_layout": tail_layout,
            "operation_ns": operation_ns, "reconcile_ns": reconcile_ns,
            "frame_ns": frame_ns, "layout_ns": stats.layout_ns,
            "after_layout_ns": stats.after_layout_ns,
            "builds_total": self.view.builds, "rebuilds": rebuilds,
            "expected_rebuilds": expected_rebuilds,
            "retained_blocks": self.view.blocks.len(), "ordered_blocks": self.view.order.len(),
            "layout_visited_blocks": stats.visited_blocks,
            "cached_visual_lines": layout_lines, "visual_lines_with_gaps": self.view.total,
            "layout_accounted_bytes": layout_bytes, "syntax_accounted_bytes": syntax_bytes,
            "cache_accounted_bytes": geometry_bytes,
            "painted_rows": stats.painted_rows, "viewport_top": self.view.top,
            "error": error,
            "contract_ok": error.is_none() && rebuilds == expected_rebuilds
                && self.view.blocks.len() == self.sources.len()
                && stats.visited_blocks <= usize::from(self.size.1) * 6 + 4
                && self.view.cached.len() < self.view.order.len()
                && stats.painted_rows <= usize::from(self.size.1),
        })
    }
}

#[test]
#[ignore = "release CPU/cache measurement; run alone with --nocapture"]
fn transcript_cpu_cache_samples() {
    let release_profile = !cfg!(debug_assertions);
    assert!(release_profile, "run this measurement with --release");
    let mut samples = Vec::new();
    let mut settlements = Vec::new();
    for blocks in [100, 1_000] {
        for size in [(120, 40), (55, 24)] {
            let mut benchmark = Benchmark::new(blocks, size);
            // Each first-frame sample has a fresh Transcript and TestBackend.
            // This is a cold component cache, not a cold process or disk cache.
            for index in 0..22 {
                if index > 0 {
                    benchmark = Benchmark::new(blocks, size);
                }
                samples.push(benchmark.measure(Phase::First, index, index < 2));
            }
            for (phase, warmups, measured) in [
                (Phase::Stable, 20, 200),
                (Phase::Scroll, 20, 200),
                (Phase::Resize, 2, 20),
                (Phase::OneBlockAppend, 20, 300),
            ] {
                for index in 0..warmups + measured {
                    samples.push(benchmark.measure(phase, index, index < warmups));
                }
            }
            settlements.push(benchmark.settle_appended());
        }
    }
    println!(
        "{}",
        json!({
            "type": "metadata", "benchmark": "transcript_viewport_v3",
            "executable": std::env::current_exe().unwrap(),
            "package_version": env!("CARGO_PKG_VERSION"),
            "os": std::env::consts::OS, "arch": std::env::consts::ARCH,
            "debug_assertions": cfg!(debug_assertions), "samples": samples.len(),
            "renderer": "Transcript::draw / ratatui Terminal<TestBackend>",
            "first": "fresh component caches; source generation and Terminal allocation excluded",
            "sequence": "first, stable, scroll, resize, append; resize keeps original source size",
            "clock": "std::time::Instant elapsed wall time in nanoseconds",
            "operation_ns": "local mutation/reconciliation/resize plus complete TestBackend frame",
            "frame_ns": "Terminal::draw including transcript layout, render, buffer diff and backend",
            "layout_ns": "Transcript viewport lookup, row index maintenance and local block rebuilds",
            "after_layout_ns": "remaining Transcript::draw: anchors, selection, visible rows and scrollbar",
            "painted_rows": "rows submitted to Paragraph, including gaps; not changed backend cells",
            "rebuilds": "eager inline Layout rebuilds only; zero does not mean no prepared-window layout work",
            "layout_visited_blocks": "eager layout_block visits only; prepared cursor work is not counted here",
            "layout_accounted_bytes": "eager Layout.bytes only; prepared windows are included in cache_accounted_bytes",
            "cached_visual_lines": "currently displayed committed or preview geometry, including prepared windows; excludes separately retained cursor rows",
            "cache_accounted_bytes": "Block.geometry_bytes: eager/preview geometry, syntax, prepared state and unshared semantic text; not allocator bytes or RSS",
            "append_settlement": "remaining settling time after the last of 320 unchanged samples, outside sample timing; latest rendered marker and complete semantic suffix must settle; not overall append-to-display latency",
            "logical_lines": "source lines including blank lines and fence delimiters, before markdown and wrapping",
            "visual_lines_with_gaps": "rendered layout rows plus inter-block gaps at the current width",
            "warmup_policy": "warmup samples retained and flagged; exclude them from reported quantiles",
            "quantile_policy": "nearest rank: sorted[ceil(p * n) - 1], group by phase/size/scale",
            "limits": "component CPU/cache only; no Host, transport, PTY, window present or RSS measurement",
        })
    );
    let mut failures = 0;
    for sample in samples {
        failures += usize::from(sample["contract_ok"] != true);
        println!("{sample}");
    }
    for settlement in settlements {
        println!("{settlement}");
    }
    assert_eq!(
        failures, 0,
        "see raw samples for structural cache/viewport failures"
    );
}

#[test]
fn layout_work_depends_on_viewport_not_history_length() {
    for blocks in [100, 1_000] {
        let mut benchmark = Benchmark::new(blocks, (120, 40));
        let first = benchmark.measure(Phase::First, 0, false);
        assert!(first["contract_ok"].as_bool().unwrap(), "{first}");
        assert!(first["rebuilds"].as_u64().unwrap() < 20, "{first}");
        assert!(
            first["cached_visual_lines"].as_u64().unwrap() < 160,
            "{first}"
        );
        for (phase, index) in [
            (Phase::Stable, 0),
            (Phase::Scroll, 0),
            (Phase::Scroll, 1),
            (Phase::Resize, 0),
            (Phase::OneBlockAppend, 0),
        ] {
            let row = benchmark.measure(phase, index, false);
            assert!(row["contract_ok"].as_bool().unwrap(), "{row}");
        }
    }
}
