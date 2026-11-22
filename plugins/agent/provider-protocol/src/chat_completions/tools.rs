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

use super::response::ToolDelta;
use crate::{
    Error, Result,
    input::Extensions,
    output::{Event, ToolCall},
};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
enum Arguments {
    #[default]
    Undetermined,
    Other,
    Structured {
        stack: Vec<char>,
        quoted: bool,
        escaped: bool,
        complete: bool,
    },
}
impl Arguments {
    fn append(&mut self, delta: &str) {
        for c in delta.chars() {
            match self {
                Self::Undetermined if c.is_whitespace() => {}
                Self::Undetermined => {
                    *self = if matches!(c, '{' | '[') {
                        Self::Structured {
                            stack: vec![c],
                            quoted: false,
                            escaped: false,
                            complete: false,
                        }
                    } else {
                        Self::Other
                    }
                }
                Self::Structured {
                    stack,
                    quoted,
                    escaped,
                    complete: false,
                } => {
                    if *quoted {
                        if *escaped {
                            *escaped = false;
                        } else if c == '\\' {
                            *escaped = true;
                        } else if c == '"' {
                            *quoted = false;
                        }
                    } else if c == '"' {
                        *quoted = true;
                    } else if matches!(c, '{' | '[') {
                        stack.push(c);
                    } else if matches!(c, '}' | ']') {
                        let expected = if c == '}' { '{' } else { '[' };
                        if stack.pop() != Some(expected) {
                            *self = Self::Other;
                        } else if stack.is_empty() {
                            *self = Self::Structured {
                                stack: vec![],
                                quoted: false,
                                escaped: false,
                                complete: true,
                            };
                        }
                    }
                }
                _ => {}
            }
        }
    }
    fn complete(&self) -> bool {
        matches!(self, Self::Structured { complete: true, .. })
    }
}

struct Call {
    id: String,
    index: Option<f64>,
    name: String,
    arguments: String,
    structure: Arguments,
    metadata: Extensions,
}
#[derive(Default)]
pub(super) struct Tracker {
    calls: Vec<Call>,
    by_id: HashMap<String, Vec<usize>>,
    by_index: HashMap<String, Vec<usize>>,
    used_ids: HashSet<String>,
    next_suffix: HashMap<String, usize>,
}
#[derive(Clone, Copy)]
enum Resolution {
    New,
    Existing(usize),
    Ambiguous,
}

impl Tracker {
    fn matching(&self, calls: Vec<usize>, start: bool) -> Resolution {
        if calls.is_empty() {
            return Resolution::New;
        }
        if !start && calls.len() == 1 {
            return Resolution::Existing(calls[0]);
        }
        let unfinished: Vec<_> = calls
            .iter()
            .copied()
            .filter(|i| !self.calls[*i].structure.complete())
            .collect();
        if unfinished.len() == 1 {
            Resolution::Existing(unfinished[0])
        } else if unfinished.len() > 1 || !start {
            Resolution::Ambiguous
        } else {
            Resolution::New
        }
    }
    fn resolve(
        &self,
        id: Option<&str>,
        index: Option<f64>,
        name: Option<&str>,
        start: bool,
        empty: bool,
    ) -> Resolution {
        let indexed = index.and_then(|i| self.by_index.get(&i.to_string()));
        let matches: Vec<_> = indexed
            .into_iter()
            .flatten()
            .copied()
            .filter(|i| name.is_none_or(|n| self.calls[*i].name == n))
            .collect();
        if let Some(id) = id {
            if let Some(identified) = self.by_id.get(id) {
                if index.is_some() {
                    let common = matches
                        .into_iter()
                        .filter(|i| identified.contains(i))
                        .collect();
                    let resolved = self.matching(common, start);
                    if !matches!(resolved, Resolution::New) {
                        return resolved;
                    }
                    if name.is_some() {
                        return Resolution::New;
                    }
                    if indexed.is_some() {
                        return Resolution::Ambiguous;
                    }
                    return self.matching(identified.clone(), false);
                }
                if let Some(name) = name {
                    return self.matching(
                        identified
                            .iter()
                            .copied()
                            .filter(|i| self.calls[*i].name == name)
                            .collect(),
                        start,
                    );
                }
                return self.matching(identified.clone(), false);
            }
            if !matches.is_empty() {
                return if start {
                    Resolution::New
                } else {
                    self.matching(matches, name.is_some() && empty)
                };
            }
            return Resolution::New;
        }
        if indexed.is_some() {
            return self.matching(matches, start);
        }
        if name.is_some() {
            return Resolution::New;
        }
        self.matching((0..self.calls.len()).collect(), false)
    }
    fn unique(&mut self, wire: Option<&str>, generate_id: &mut dyn FnMut() -> String) -> String {
        if let Some(wire) = wire
            && self.used_ids.insert(wire.to_owned())
        {
            return wire.to_owned();
        }
        let generated = generate_id();
        let generated = if generated.trim().is_empty() {
            "tool-call".to_owned()
        } else {
            generated
        };
        if self.used_ids.insert(generated.clone()) {
            return generated;
        }
        let initial = *self.next_suffix.get(&generated).unwrap_or(&1);
        for suffix in initial..=initial + self.used_ids.len() {
            let candidate = format!("{generated}-{suffix}");
            if self.used_ids.insert(candidate.clone()) {
                self.next_suffix.insert(generated, suffix + 1);
                return candidate;
            }
        }
        unreachable!("one of N+1 suffixes is absent from a set of N IDs")
    }
    pub(super) fn push(
        &mut self,
        delta: &ToolDelta,
        key: &str,
        generate_id: &mut dyn FnMut() -> String,
    ) -> Result<Vec<Event>> {
        let wire_name = delta.function.name.as_deref();
        let id = delta.id.as_deref().filter(|v| !v.trim().is_empty());
        let name = wire_name.filter(|v| !v.trim().is_empty());
        let index = delta.index;
        let args = delta.function.arguments.as_deref();
        let trimmed = args.unwrap_or("").trim_start();
        let start = name.is_some() && (trimmed.starts_with('{') || trimmed.starts_with('['));
        let resolved = self.resolve(
            id,
            index,
            name,
            start,
            args.is_none_or(|v| v.trim().is_empty()),
        );
        let mut events = vec![];
        let position = match resolved {
            Resolution::Ambiguous => return Ok(events),
            Resolution::New => {
                if wire_name.is_some_and(|v| v.trim().is_empty()) {
                    return Ok(events);
                }
                let name = name.ok_or_else(|| {
                    Error::invalid(
                        "Expected 'function.name' to be a string.",
                        serde_json::to_value(delta).expect("wire delta"),
                    )
                })?;
                let id = self.unique(id, generate_id);
                let arguments = args.unwrap_or("").to_owned();
                let mut structure = Arguments::default();
                structure.append(&arguments);
                events.push(Event::ToolStart {
                    id: id.clone(),
                    name: name.into(),
                    provider_executed: false,
                    dynamic: false,
                    extensions: None,
                });
                if !arguments.is_empty() {
                    events.push(Event::ToolDelta {
                        id: id.clone(),
                        text: arguments.clone(),
                    });
                }
                self.calls.push(Call {
                    id,
                    index,
                    name: name.into(),
                    arguments,
                    structure,
                    metadata: delta.signature(key),
                });
                self.calls.len() - 1
            }
            Resolution::Existing(position) => {
                if let Some(args) = args {
                    let call = &mut self.calls[position];
                    call.structure.append(args);
                    call.arguments.push_str(args);
                    events.push(Event::ToolDelta {
                        id: call.id.clone(),
                        text: args.into(),
                    });
                }
                position
            }
        };
        if let Some(id) = delta.id.as_deref().filter(|v| !v.trim().is_empty()) {
            let indices = self.by_id.entry(id.into()).or_default();
            if !indices.contains(&position) {
                indices.push(position);
            }
        }
        if let Some(index) = index {
            let indices = self.by_index.entry(index.to_string()).or_default();
            if !indices.contains(&position) {
                indices.push(position);
            }
        }
        Ok(events)
    }
    pub(super) fn finish(&mut self) -> Vec<Event> {
        let mut order: Vec<_> = (0..self.calls.len()).collect();
        if self.calls.iter().all(|c| c.index.is_some()) {
            order.sort_by(|a, b| {
                self.calls[*a]
                    .index
                    .unwrap()
                    .total_cmp(&self.calls[*b].index.unwrap())
                    .then(a.cmp(b))
            });
        }
        let mut events = vec![];
        for position in order {
            let call = &mut self.calls[position];
            events.push(Event::ToolEnd {
                id: call.id.clone(),
            });
            events.push(Event::ToolCall(ToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                input: std::mem::take(&mut call.arguments),
                provider_executed: false,
                dynamic: false,
                extensions: call.metadata.take(),
            }));
        }
        self.calls.clear();
        self.by_id.clear();
        self.by_index.clear();
        self.used_ids.clear();
        events
    }
}
