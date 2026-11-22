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

#[test]
fn text_scan_observes_cancellation_after_a_real_read_before_publishing_a_page() {
    struct Source {
        cancellation: CancellationToken,
        reads: usize,
    }
    impl Read for Source {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            buffer[..6].copy_from_slice(b"first\n");
            self.cancellation.cancel();
            Ok(6)
        }
    }
    let cancellation = CancellationToken::new();
    let mut source = Source {
        cancellation: cancellation.clone(),
        reads: 0,
    };
    let input: maka_agent_facts::read::ReadInput =
        serde_json::from_value(serde_json::json!({"path":"file","limit":1})).unwrap();
    let result = text_page(
        &mut source,
        &input.resolve().unwrap(),
        maka_agent_facts::read::MAX_PAGE_CHARS,
        &cancellation,
    );
    assert!(matches!(result, Err(ToolError::Failed(message)) if message == "Read cancelled"));
    assert_eq!(source.reads, 1);
}
