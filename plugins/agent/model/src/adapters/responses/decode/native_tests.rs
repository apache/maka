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
use maka_agent_facts::context::ModelOperation;
fn decoder() -> Decoder {
    Decoder::new(None, &[]).operation(ModelOperation::CodexCompaction)
}
fn item() -> Value {
    json!({"type":"compaction","encrypted_content":"opaque","extra":{"preserved":true}})
}
fn done(item: Value) -> Value {
    json!({"type":"response.output_item.done","item":item})
}
fn terminal(kind: &str, output: Vec<Value>) -> Value {
    json!({"type":kind,"response":{"id":"response","output":output,"usage":{"input_tokens":20,"output_tokens":7}}})
}
#[test]
fn native_result_is_opaque_metadata_only_after_completion() {
    let mut decoder = decoder();
    assert!(decoder.push(done(item())).unwrap().is_empty());
    assert!(!decoder.finished());
    assert!(!decoder.retained_output_safe());
    let events = decoder
        .push(terminal("response.completed", vec![item()]))
        .unwrap();
    assert!(events.iter().any(|event| matches!(event,ModelEvent::Finished { provider_options:Some(options),.. } if options["openai"]["compaction"] == item())));
    assert!(decoder.finished());
}
#[test]
fn native_result_requires_unique_item_and_complete_stream() {
    assert!(
        decoder()
            .push(terminal("response.completed", vec![]))
            .is_err()
    );
    assert!(
        decoder()
            .push(terminal("response.completed", vec![item(), item()]))
            .is_err()
    );
    let mut incomplete = decoder();
    incomplete.push(done(item())).unwrap();
    assert!(incomplete.end().is_err());
    assert!(
        incomplete
            .push(terminal("response.incomplete", vec![item()]))
            .is_err()
    );
    let mut duplicate = decoder();
    duplicate.push(done(item())).unwrap();
    assert!(duplicate.push(done(item())).is_err());
    assert!(
        decoder()
            .push(done(json!({"type":"compaction","encrypted_content":""})))
            .is_err()
    );
    assert!(Decoder::new(None, &[]).push(done(item())).is_err());
}
