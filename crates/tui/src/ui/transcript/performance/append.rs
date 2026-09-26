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

//! The append workload crosses from inline layout into prepared windows.
use super::*;
use std::time::Duration;

impl Benchmark {
    pub(super) fn settle_appended(&mut self) -> Value {
        let start = Instant::now();
        let mut frames = 0;
        loop {
            render(&mut self.view, &mut self.terminal).unwrap();
            frames += 1;
            if self.view.motion_wait().is_none() {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(20),
                "append did not settle"
            );
            std::thread::yield_now();
        }
        let settled_ns = start.elapsed().as_nanos();
        let tail = self.sources.last().unwrap();
        let block = &self.view.blocks[&tail.key];
        assert!(block.large.as_ref().is_some_and(|state| state.ready()));
        assert!(block.visual_current());
        let expected: String = (0..tail.revision)
            .map(|index| format!("\n// append {index} 中文 🦀"))
            .collect();
        assert!(
            block
                .message_text()
                .is_some_and(|text| text.ends_with(&expected)),
            "the complete semantic suffix must contain every append"
        );
        let buffer = self.terminal.backend().buffer();
        let screen = buffer
            .content
            .chunks(usize::from(buffer.area.width))
            .map(|row| row.iter().map(|cell| cell.symbol()).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            screen.contains(&format!("append {}", tail.revision - 1)),
            "{screen}"
        );
        assert!(block.visual_lines().len() <= usize::from(self.size.1) * 4);
        json!({
            "type": "settlement", "benchmark": "transcript_viewport_v3",
            "initial_width": self.initial_size.0, "initial_height": self.initial_size.1,
            "initial_logical_lines": self.sources.len() * 10, "appends": tail.revision,
            "remaining_settle_ns": settled_ns, "frames": frames,
            "tail_bytes": tail.text.len(), "cached_visual_lines": block.visual_lines().len(),
            "semantic_suffix_bytes": expected.len(), "contract_ok": true,
        })
    }
}

#[test]
fn a_growing_record_settles_every_append_after_crossing_the_inline_boundary() {
    let mut benchmark = Benchmark::new(100, (55, 24));
    assert_eq!(
        benchmark.measure(Phase::First, 0, false)["contract_ok"],
        true
    );
    let mut transitions = 0;
    for index in 0..320 {
        let sample = benchmark.measure(Phase::OneBlockAppend, index, false);
        assert_eq!(sample["contract_ok"], true, "{sample}");
        transitions += usize::from(sample["tail_layout"] == "transition");
    }
    assert_eq!(transitions, 1);
    assert_eq!(benchmark.settle_appended()["appends"], 320);
}
