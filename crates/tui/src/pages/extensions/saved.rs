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
use crate::editor::saved::Cursor;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Pending {
    pub input: Input,
    pub proposal: Option<maka_plugins::authorization::Request>,
    pub recovery: Option<Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    root: String,
    session: Option<String>,
    entry: TerminalViewProjection,
    view: View,
    route: Value,
    drafts: BTreeMap<String, Value>,
    cursors: BTreeMap<String, Cursor>,
    pending: Option<Pending>,
}
impl Checkpoint {
    pub fn validate(&self, root: &str) -> Result<(), String> {
        if self.root != root
            || serde_json::to_vec(self).map_err(|e| e.to_string())?.len()
                > 4 * maka_plugins::terminal_ui::view::MAX_BYTES
        {
            return Err("Invalid plugin checkpoint identity or size".into());
        }
        self.view.validate().map_err(|e| e.to_string())?;
        Input::Read {
            route: self.route.clone(),
            locale: "en".into(),
        }
        .validate()
        .map_err(|e| e.to_string())?;
        maka_protocol::plugin::decode_output(
            maka_protocol::Operation::PluginPlatformQuery,
            &serde_json::json!({
                "view":"terminal_views", "items":[self.entry], "nextCursor":null
            }),
        )
        .map_err(|e| e.to_string())?;
        if self
            .session
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
            || self.entry.descriptor.context == Context::Session && self.session.is_none()
            || self.drafts.len() != self.view.fields.len()
        {
            return Err("Invalid plugin checkpoint context or fields".into());
        }
        let mut edited = self.view.clone();
        let mut text_fields = 0;
        for field in &mut edited.fields {
            match (&mut field.control, self.drafts.get(&field.id)) {
                (Control::Toggle { value }, Some(Value::Bool(draft))) => *value = *draft,
                (Control::Choice { value, .. }, Some(Value::String(draft))) => {
                    *value = draft.clone()
                }
                (Control::Text { value, .. }, Some(Value::String(draft))) => {
                    *value = draft.clone();
                    text_fields += 1;
                    self.cursors
                        .get(&field.id)
                        .ok_or("Missing plugin cursor")?
                        .validate(draft)?;
                }
                _ => return Err("Invalid plugin checkpoint field".into()),
            }
        }
        if text_fields != self.cursors.len() {
            return Err("Invalid plugin checkpoint cursors".into());
        }
        edited.validate().map_err(|e| e.to_string())?;
        if let Some(pending) = &self.pending {
            let Input::Submit {
                route,
                revision,
                action,
                fields,
                grant,
                locale,
            } = &pending.input
            else {
                return Err("Invalid frozen plugin submission".into());
            };
            let mut expected = self
                .view
                .submission(self.route.clone(), action, fields.clone(), locale.clone())
                .map_err(|e| e.to_string())?;
            if let Input::Submit {
                grant: expected_grant,
                ..
            } = &mut expected
            {
                *expected_grant = *grant;
            }
            if route != &self.route
                || revision != &self.view.revision
                || expected != pending.input
                || fields
                    .iter()
                    .any(|(key, value)| self.drafts.get(key) != Some(value))
                || self.view.action(action).map(|item| &item.recovery) != Some(&pending.recovery)
            {
                return Err("Frozen plugin intent does not match its form".into());
            }
            if let Some(proposal) = &pending.proposal {
                proposal.validate().map_err(|e| e.to_string())?;
                if grant.is_some() {
                    return Err("Invalid frozen authorization".into());
                }
            }
        }
        Ok(())
    }
}
impl State {
    pub fn checkpoint(&self, root: &str) -> Option<Checkpoint> {
        if !(self.dirty() || self.blocked || self.unresolved.is_some()) {
            return None;
        }
        Some(Checkpoint {
            root: root.into(),
            session: self.session.clone(),
            entry: self.entry.clone()?,
            view: self.view.clone()?,
            route: self.route.clone(),
            drafts: self.drafts.clone(),
            cursors: self
                .editors
                .iter()
                .map(|(id, editor)| (id.clone(), editor.cursor()))
                .collect(),
            pending: self.unresolved.clone(),
        })
    }
    pub fn restore(&mut self, checkpoint: Checkpoint) -> Result<(), String> {
        checkpoint.validate(&checkpoint.root)?;
        self.install(checkpoint.view);
        self.entry = Some(checkpoint.entry);
        self.session = checkpoint.session;
        self.route = checkpoint.route;
        self.drafts = checkpoint.drafts;
        for (id, cursor) in checkpoint.cursors {
            let editor = self.editors.get_mut(&id).ok_or("Missing plugin editor")?;
            let initial = editor.text().to_owned();
            editor.clear_if_unchanged(&initial);
            editor.insert(self.drafts[&id].as_str().ok_or("Invalid plugin text")?);
            editor.clear_history();
            editor.restore_cursor(cursor)?;
        }
        self.unresolved = checkpoint.pending;
        self.blocked = true;
        self.loaded = true;
        self.message = Some(Message::Local(if self.unresolved.is_some() {
            "extensions-unknown"
        } else {
            "extensions-restored"
        }));
        Ok(())
    }
}
impl App {
    pub fn extensions_after_checkpoint(
        &mut self,
        request: &Request,
        result: &Result<(), String>,
    ) -> bool {
        let state = &mut self.extensions;
        if !state.saving || request.generation != state.generation {
            return false;
        }
        state.saving = false;
        if result.is_ok()
            && !self.closing
            && matches!(&self.connection,
            ConnectionState::Connected { root_id, epoch } if *root_id == request.root && *epoch == request.epoch)
        {
            return true;
        }
        state.busy = false;
        state.writing = false;
        state.blocked = true;
        state.message = Some(Message::Local("extensions-save-failed"));
        false
    }
}
