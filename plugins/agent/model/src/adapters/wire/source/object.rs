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

//! Provider object fields with finite replacements and a forward opaque-field cursor.
use super::{FragmentSequence, SourceFragment as F, quoted};
use bytes::Bytes;
use maka_agent_facts::model::prompt_source::source::{
    ByteCursor, ByteSource, ChargedBuffer, JsonSource, ReadSource, SourceBudget, SourceBytes,
    SourceRead, TextEncoding, TextSource,
    json::{self, ObjectCursor},
};
use std::{io, sync::Arc};
struct Field {
    name: &'static str,
    value: Arc<[F]>,
}
struct Object {
    source: Option<JsonSource>,
    fields: Arc<[Field]>,
    finals: Arc<[Field]>,
    overlay: bool,
}
fn arc(layout: std::alloc::Layout) -> io::Result<usize> {
    let (layout, _) = std::alloc::Layout::new::<[usize; 2]>()
        .extend(layout)
        .map_err(io::Error::other)?;
    Ok(layout.pad_to_align().size())
}
fn add(total: &mut usize, bytes: usize) -> io::Result<()> {
    *total = total
        .checked_add(bytes)
        .ok_or_else(|| io::Error::other("provider object metadata overflow"))?;
    Ok(())
}
fn make_fields(values: Vec<(&'static str, Vec<F>)>, owned: &mut usize) -> io::Result<Arc<[Field]>> {
    add(
        owned,
        arc(std::alloc::Layout::array::<Field>(values.len()).map_err(io::Error::other)?)?,
    )?;
    let mut output = Vec::with_capacity(values.len());
    for (name, value) in values {
        add(
            owned,
            arc(std::alloc::Layout::array::<F>(value.len()).map_err(io::Error::other)?)?,
        )?;
        for fragment in &value {
            match fragment {
                F::OwnedLiteral { capacity, .. } => add(owned, *capacity)?,
                F::OwnedRaw { metadata_bytes, .. } | F::OwnedJsonString { metadata_bytes, .. } => {
                    add(owned, *metadata_bytes)?
                }
                _ => {}
            }
        }
        output.push(Field {
            name,
            value: value.into(),
        });
    }
    Ok(output.into())
}
pub(super) fn allocation_shape(arities: &[usize], child_owned: usize) -> io::Result<usize> {
    let mut owned = arc(std::alloc::Layout::new::<Object>())?;
    add(
        &mut owned,
        arc(std::alloc::Layout::array::<Field>(arities.len()).map_err(io::Error::other)?)?,
    )?;
    add(
        &mut owned,
        arc(std::alloc::Layout::array::<Field>(0).map_err(io::Error::other)?)?,
    )?;
    for count in arities {
        add(
            &mut owned,
            arc(std::alloc::Layout::array::<F>(*count).map_err(io::Error::other)?)?,
        )?;
    }
    add(&mut owned, child_owned)?;
    Ok(owned)
}

pub(super) fn plan(
    source: Option<JsonSource>,
    values: Vec<(&'static str, Vec<F>)>,
    finals: Vec<(&'static str, Vec<F>)>,
    overlay: bool,
) -> io::Result<Vec<F>> {
    let mut owned = arc(std::alloc::Layout::new::<Object>())?;
    let fields = make_fields(values, &mut owned)?;
    let finals = make_fields(finals, &mut owned)?;
    Ok(vec![F::owned_raw(
        JsonSource::new(SourceBytes::Source(Arc::new(Object {
            source,
            fields,
            finals,
            overlay,
        }))),
        owned,
    )])
}
#[derive(Clone, Copy)]
enum Phase {
    Base,
    Original,
    Append,
    Finals,
    Close,
    Done,
}
impl ByteSource for Object {
    fn len(&self) -> Option<u64> {
        None
    }
    fn open(&self, budget: Arc<dyn SourceBudget>) -> Box<dyn ByteCursor> {
        Box::new(Cursor {
            source: self.source.clone(),
            fields: self.fields.clone(),
            finals: self.finals.clone(),
            overlay: self.overlay,
            budget,
            cursor: None,
            initialized: false,
            phase: if self.overlay {
                Phase::Base
            } else {
                Phase::Original
            },
            index: 0,
            seen: vec![false; self.fields.len()],
            final_seen: vec![false; self.finals.len()],
            selected: Vec::new(),
            active: Some(FragmentSequence::new(Arc::from([F::literal(b"{")]))),
            first: true,
        })
    }
}
struct Cursor {
    source: Option<JsonSource>,
    fields: Arc<[Field]>,
    finals: Arc<[Field]>,
    overlay: bool,
    budget: Arc<dyn SourceBudget>,
    cursor: Option<ObjectCursor>,
    initialized: bool,
    phase: Phase,
    index: usize,
    seen: Vec<bool>,
    final_seen: Vec<bool>,
    selected: Vec<Option<JsonSource>>,
    active: Option<FragmentSequence>,
    first: bool,
}
fn key(name: &'static str) -> TextSource {
    TextSource::new(
        SourceBytes::Inline(Bytes::from_static(name.as_bytes())),
        TextEncoding::Utf8,
    )
}
impl Cursor {
    async fn initialize(&mut self) -> io::Result<()> {
        if self.initialized {
            return Ok(());
        }
        self.initialized = true;
        if let Some(source) = &self.source {
            if self.overlay {
                let names: Vec<&str> = self.fields.iter().map(|field| field.name).collect();
                self.selected = json::fields(source, &names, self.budget.clone())
                    .await?
                    .into_iter()
                    .map(|field| field.map(|field| field.source))
                    .collect();
            }
            self.cursor = Some(ObjectCursor::open(source.clone(), self.budget.clone()).await?);
        }
        Ok(())
    }
    async fn next_field(&mut self) -> io::Result<Option<(Vec<F>, Arc<[F]>)>> {
        loop {
            match self.phase {
                Phase::Base => {
                    if let Some(field) = self.fields.get(self.index) {
                        let index = self.index;
                        self.index += 1;
                        let final_field = self
                            .finals
                            .iter()
                            .enumerate()
                            .find(|(_, last)| last.name == field.name);
                        let value = if let Some((index, last)) = final_field {
                            self.final_seen[index] = true;
                            last.value.clone()
                        } else if let Some(Some(source)) = self.selected.get(index) {
                            Arc::from([F::Raw(source.clone())])
                        } else {
                            field.value.clone()
                        };
                        return Ok(Some((quoted(key(field.name)), value)));
                    }
                    self.phase = Phase::Original;
                    self.index = 0;
                }
                Phase::Original => {
                    let field = match &mut self.cursor {
                        Some(cursor) => {
                            cursor
                                .next_named_spans(
                                    self.fields
                                        .iter()
                                        .chain(self.finals.iter())
                                        .map(|field| field.name),
                                )
                                .await?
                        }
                        None => None,
                    };
                    if let Some((field, matching)) = field {
                        let source = self.source.as_ref().expect("object source cursor");
                        let key_bytes = source.bytes().slice(field.key_range)?;
                        let value_source =
                            JsonSource::new(source.bytes().slice(field.value_range)?);
                        if self.overlay && matching.is_some_and(|index| index < self.fields.len()) {
                            continue;
                        }
                        let value = if let Some(index) =
                            matching.filter(|index| *index < self.fields.len())
                        {
                            self.seen[index] = true;
                            self.fields[index].value.clone()
                        } else if let Some(index) = matching {
                            let index = index - self.fields.len();
                            self.final_seen[index] = true;
                            self.finals[index].value.clone()
                        } else {
                            Arc::from([F::Raw(value_source)])
                        };
                        return Ok(Some((vec![F::Raw(JsonSource::new(key_bytes))], value)));
                    }
                    self.phase = if self.overlay {
                        Phase::Finals
                    } else {
                        Phase::Append
                    };
                    self.index = 0;
                }
                Phase::Append => {
                    while let Some(field) = self.fields.get(self.index) {
                        let index = self.index;
                        self.index += 1;
                        if !self.seen[index] {
                            return Ok(Some((quoted(key(field.name)), field.value.clone())));
                        }
                    }
                    self.phase = Phase::Finals;
                    self.index = 0;
                }
                Phase::Finals => {
                    while let Some(field) = self.finals.get(self.index) {
                        let index = self.index;
                        self.index += 1;
                        if !self.final_seen[index] {
                            return Ok(Some((quoted(key(field.name)), field.value.clone())));
                        }
                    }
                    self.phase = Phase::Close;
                    return Ok(None);
                }
                Phase::Close | Phase::Done => return Ok(None),
            }
        }
    }
}
impl ByteCursor for Cursor {
    fn read_chunk(&mut self, mut buffer: ChargedBuffer) -> ReadSource<'_> {
        Box::pin(async move {
            self.initialize().await?;
            let mut written = 0;
            while written < buffer.as_mut().len() {
                if let Some(active) = &mut self.active {
                    let (count, done) = active
                        .copy(&mut buffer.as_mut()[written..], self.budget.clone())
                        .await?;
                    written += count;
                    if !done {
                        break;
                    }
                    self.active = None;
                }
                if matches!(self.phase, Phase::Done) {
                    break;
                }
                if let Some((name, value)) = self.next_field().await? {
                    let mut fragments = Vec::with_capacity(6 + value.len());
                    if !self.first {
                        fragments.push(F::literal(b","));
                    }
                    self.first = false;
                    fragments.extend(name);
                    fragments.push(F::literal(b":"));
                    fragments.extend(value.iter().cloned());
                    self.active = Some(FragmentSequence::new(fragments.into()));
                } else {
                    self.active = Some(FragmentSequence::new(Arc::from([F::literal(b"}")])));
                    self.phase = Phase::Done;
                }
            }
            Ok(SourceRead {
                buffer,
                bytes_read: written,
                eof: matches!(self.phase, Phase::Done) && self.active.is_none(),
            })
        })
    }
}
