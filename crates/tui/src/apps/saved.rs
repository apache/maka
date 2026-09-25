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
use maka_plugins::terminal_ui::view::View;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Pending {
    pub input: Input,
    pub proposal: Option<maka_plugins::authorization::Request>,
    pub recovery: Option<Value>,
    /// A key or password this submission carried was not saved with it, so
    /// only its outcome can be checked; it cannot be sent again.
    #[serde(default)]
    pub withheld: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Checkpoint {
    root: String,
    key: Key,
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
        if !self.key.valid()
            || !self.key.serves(&self.entry)
            || (self.entry.descriptor.context == Context::Session) != self.key.session.is_some()
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
impl Instance {
    fn checkpoint(&self, root: &str, key: &Key) -> Option<Checkpoint> {
        if !self.keeps() {
            return None;
        }
        let view = self.view.clone()?;
        // Keys and passwords never reach the disk: a secret field saves as
        // its initial value, in drafts and in a frozen submission alike.
        let secrets: BTreeMap<&str, &str> = view
            .fields
            .iter()
            .filter_map(|field| match &field.control {
                Control::Text {
                    value,
                    secret: true,
                    ..
                } => Some((field.id.as_str(), value.as_str())),
                _ => None,
            })
            .collect();
        let mut drafts = self.drafts.clone();
        let mut cursors: BTreeMap<_, _> = self
            .editors
            .iter()
            .map(|(id, editor)| (id.clone(), editor.cursor()))
            .collect();
        for (id, initial) in &secrets {
            drafts.insert((*id).into(), Value::String((*initial).into()));
            let mut editor = crate::editor::Editor::default();
            editor.insert(initial);
            cursors.insert((*id).into(), editor.cursor());
        }
        let pending = self.unresolved.clone().map(|mut pending| {
            if let Input::Submit { fields, .. } = &mut pending.input {
                for (id, initial) in &secrets {
                    if let Some(value) = fields.get_mut(*id)
                        && value.as_str() != Some(initial)
                    {
                        *value = Value::String((*initial).into());
                        pending.withheld = true;
                    }
                }
            }
            pending
        });
        Some(Checkpoint {
            root: root.into(),
            key: key.clone(),
            entry: self.entry.clone()?,
            view,
            route: self.route.clone(),
            drafts,
            cursors,
            pending,
        })
    }
    fn restore(checkpoint: Checkpoint) -> Result<Self, String> {
        let mut instance = Self::new(Some(checkpoint.entry), Value::Null);
        instance.install(checkpoint.view);
        instance.route = checkpoint.route;
        instance.drafts = checkpoint.drafts;
        for (id, cursor) in checkpoint.cursors {
            let editor = instance
                .editors
                .get_mut(&id)
                .ok_or("Missing plugin editor")?;
            let initial = editor.text().to_owned();
            editor.clear_if_unchanged(&initial);
            editor.insert(instance.drafts[&id].as_str().ok_or("Invalid plugin text")?);
            editor.clear_history();
            editor.restore_cursor(cursor)?;
        }
        instance.unresolved = checkpoint.pending;
        instance.live = None;
        instance.blocked = true;
        instance.message = Some(Notice::Local(if instance.unresolved.is_some() {
            "extensions-unknown"
        } else {
            "extensions-restored"
        }));
        Ok(instance)
    }
}
impl Apps {
    /// What must survive a restart: drafts, blocked forms and open writes.
    pub fn checkpoints(&self, root: &str) -> Vec<Checkpoint> {
        self.instances
            .iter()
            .filter_map(|(key, instance)| instance.checkpoint(root, key))
            .collect()
    }
    pub fn restore(&mut self, checkpoints: Vec<Checkpoint>) -> Result<(), String> {
        for checkpoint in checkpoints {
            checkpoint.validate(&checkpoint.root)?;
            let key = checkpoint.key.clone();
            self.instances
                .insert(key.clone(), Instance::restore(checkpoint)?);
            self.recent.push(key);
        }
        Ok(())
    }
}
impl App {
    pub fn apps_after_checkpoint(
        &mut self,
        request: &Request,
        result: &Result<(), String>,
    ) -> bool {
        let Some(state) = request
            .key
            .as_ref()
            .and_then(|key| self.apps.instances.get_mut(key))
        else {
            return false;
        };
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
        state.message = Some(Notice::Local("extensions-save-failed"));
        false
    }
}
