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

use super::{ThinkingLevel, Value, json};

pub(super) fn chat_completions(
    name: &str,
    level: Option<ThinkingLevel>,
    parallel: Option<bool>,
) -> Value {
    let mut options = json!({});
    if let Some(level) = level {
        options["reasoningEffort"] = match level {
            ThinkingLevel::Off => json!("none"),
            level => json!(level),
        };
    }
    // Compatible adapters only send the switch for a declared capability.
    if let Some(parallel) = parallel {
        options["parallel_tool_calls"] = json!(parallel);
    }
    if options.as_object().unwrap().is_empty() {
        json!({})
    } else {
        json!({camel_case(name): options})
    }
}

// Match model-factory.ts and the SDK alias: /[_-]([a-z])/g.
fn camel_case(name: &str) -> String {
    let mut chars = name.chars().peekable();
    let mut result = String::with_capacity(name.len());
    while let Some(ch) = chars.next() {
        if matches!(ch, '_' | '-') && chars.peek().is_some_and(char::is_ascii_lowercase) {
            result.push(chars.next().unwrap().to_ascii_uppercase());
        } else {
            result.push(ch);
        }
    }
    result
}
