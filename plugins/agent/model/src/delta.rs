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

use crate::{Emission, ModelEvent};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::OwnedSemaphorePermit;

/// Bound individual journal observations independently of provider chunk sizes.
/// Splitting is linear and retains provider metadata once, on the first chunk.
pub(crate) enum DeltaKind {
    Part(Option<Value>),
    ToolInput,
}

pub(crate) struct PendingDelta {
    id: String,
    text: String,
    offset: usize,
    kind: DeltaKind,
    reservation: Option<Arc<OwnedSemaphorePermit>>,
}

impl PendingDelta {
    pub fn new(
        id: String,
        text: String,
        kind: DeltaKind,
        reservation: Option<Arc<OwnedSemaphorePermit>>,
    ) -> Self {
        Self {
            id,
            text,
            offset: 0,
            kind,
            reservation,
        }
    }
}

impl Iterator for PendingDelta {
    type Item = Emission;

    fn next(&mut self) -> Option<Self::Item> {
        if self.offset == self.text.len() {
            return None;
        }
        let end = match &self.kind {
            DeltaKind::Part(_) => {
                let mut end = (self.offset + 8 * 1024).min(self.text.len());
                while !self.text.is_char_boundary(end) {
                    end -= 1;
                }
                end
            }
            DeltaKind::ToolInput => {
                // The watch budget counts JSON bytes. Reserve its quotes too;
                // an ASCII control may need six bytes despite one raw byte.
                let mut encoded = 2;
                let mut end = self.offset;
                for ch in self.text[self.offset..].chars() {
                    let bytes = match ch {
                        '"' | '\\' | '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 2,
                        '\0'..='\u{1f}' => 6,
                        _ => ch.len_utf8(),
                    };
                    if encoded + bytes > 8 * 1024 {
                        break;
                    }
                    encoded += bytes;
                    end += ch.len_utf8();
                }
                end
            }
        };
        let text = self.text[self.offset..end].to_owned();
        self.offset = end;
        let event = match &mut self.kind {
            DeltaKind::Part(provider_options) => ModelEvent::PartDelta {
                id: self.id.clone(),
                text,
                provider_options: provider_options.take(),
            },
            DeltaKind::ToolInput => ModelEvent::ToolInputDelta {
                id: self.id.clone(),
                text,
            },
        };
        Some(Emission {
            event,
            reservation: self.reservation.clone(),
        })
    }
}
