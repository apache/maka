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

#[cfg(test)]
mod tests;

impl Checkpoint {
    pub(in crate::apps) fn admit_field(
        &mut self,
        id: &str,
        value: &Value,
        drafts: &BTreeMap<String, Value>,
    ) -> bool {
        let Some(mut edited) = self.view.clone() else {
            return false;
        };
        let mut secret = false;
        for field in &mut edited.fields {
            let proposed = if field.id == id {
                Some(value)
            } else {
                drafts.get(&field.id)
            };
            match (&mut field.control, proposed) {
                (Control::Toggle { value }, Some(Value::Bool(proposed))) => *value = *proposed,
                (Control::Choice { value, .. }, Some(Value::String(proposed))) => {
                    *value = proposed.clone()
                }
                (
                    Control::Text {
                        value,
                        secret: masked,
                        ..
                    },
                    Some(Value::String(proposed)),
                ) => {
                    *value = proposed.clone();
                    secret |= field.id == id && *masked;
                }
                _ => return false,
            }
        }
        if edited.validate().is_err() {
            return false;
        }
        if !secret {
            self.drafts.insert(id.into(), value.clone());
        }
        self.admit_cursors_ref()
    }

    pub(in crate::apps) fn admit_cursors(mut self) -> bool {
        self.admit_cursors_ref()
    }

    fn admit_cursors_ref(&mut self) -> bool {
        // Selection changes do not need admission. Reserve every legal cursor
        // and anchor representation here (null can exceed a short offset).
        for (id, cursor) in &mut self.cursors {
            let Some(text) = self.drafts.get(id).and_then(Value::as_str) else {
                return false;
            };
            *cursor = Cursor::largest(text);
        }
        self.validate(&self.root).is_ok()
    }
}
