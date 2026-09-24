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

mod view;
use super::draft::Input;
use maka_protocol::turn::{StorageRef, TurnStartMessage};
use serde::{Deserialize, Serialize};
pub(super) use view::rows;

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Resource {
    Attachment { index: usize },
    Quote { index: usize },
    Directory { index: usize },
    Selection { provider: String, index: usize },
    Inline { index: usize },
}

#[derive(Default)]
pub(super) struct Browser {
    pub visible: bool,
}

impl Input {
    pub(super) fn resources(&self) -> Vec<Resource> {
        let content = &self.original.content;
        (0..content.attachments.iter().flatten().count())
            .map(|index| Resource::Attachment { index })
            .chain(
                (0..content.quotes.iter().flatten().count()).map(|index| Resource::Quote { index }),
            )
            .chain(
                (0..content.directory_references.iter().flatten().count())
                    .map(|index| Resource::Directory { index }),
            )
            .chain(
                self.original
                    .input_selections
                    .iter()
                    .flat_map(|(provider, values)| {
                        (0..values.len()).map(move |index| Resource::Selection {
                            provider: provider.clone(),
                            index,
                        })
                    }),
            )
            .chain(
                (0..content.inline_references.iter().flatten().count())
                    .map(|index| Resource::Inline { index }),
            )
            .collect()
    }
    pub(super) fn included(&self, resource: &Resource) -> bool {
        !self.excluded.contains(resource)
    }
    pub(super) fn toggle(&mut self, resource: &Resource) {
        if matches!(resource, Resource::Inline { .. }) || !self.resources().contains(resource) {
            return;
        }
        if let Some(index) = self.excluded.iter().position(|key| key == resource) {
            self.excluded.remove(index);
        } else {
            self.excluded.push(resource.clone());
        }
    }
    pub(super) fn validate_resources(&self) -> Result<(), String> {
        let resources = self.resources();
        let mut seen = std::collections::HashSet::new();
        if self.excluded.len() > resources.len()
            || self.excluded.iter().any(|key| {
                matches!(key, Resource::Inline { .. })
                    || !resources.contains(key)
                    || !seen.insert(key)
            })
        {
            return Err("Invalid excluded revision resource".into());
        }
        Ok(())
    }
    pub(super) fn message(&self) -> TurnStartMessage {
        let mut content = self.content.clone();
        let retain = |index, key: fn(usize) -> Resource| self.included(&key(index));
        content.attachments = content
            .attachments
            .map(|values| {
                values
                    .into_iter()
                    .enumerate()
                    .filter(|(i, _)| retain(*i, |index| Resource::Attachment { index }))
                    .map(|(_, v)| v)
                    .collect()
            })
            .filter(|values: &Vec<_>| !values.is_empty());
        content.quotes = content
            .quotes
            .map(|values| {
                values
                    .into_iter()
                    .enumerate()
                    .filter(|(i, _)| retain(*i, |index| Resource::Quote { index }))
                    .map(|(_, v)| v)
                    .collect()
            })
            .filter(|values: &Vec<_>| !values.is_empty());
        content.directory_references = content
            .directory_references
            .map(|values| {
                values
                    .into_iter()
                    .enumerate()
                    .filter(|(i, _)| retain(*i, |index| Resource::Directory { index }))
                    .map(|(_, v)| v)
                    .collect()
            })
            .filter(|values: &Vec<_>| !values.is_empty());
        if !self.directories.is_empty() {
            content
                .directory_references
                .get_or_insert_with(Vec::new)
                .extend(self.directories.clone());
        }
        let mut input_selections: maka_runtime::input::Selections = self
            .original
            .input_selections
            .iter()
            .filter_map(|(provider, values)| {
                let selected: Vec<_> = values
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| {
                        self.included(&Resource::Selection {
                            provider: provider.clone(),
                            index: *index,
                        })
                    })
                    .map(|(_, value)| value.clone())
                    .collect();
                (!selected.is_empty()).then(|| (provider.clone(), selected))
            })
            .collect();
        if !self.skills.is_empty() {
            let values = input_selections
                .entry(crate::pages::skills::PROVIDER.into())
                .or_default();
            for item in &self.skills {
                if !values.contains(&item.id) {
                    values.push(item.id.clone());
                }
            }
        }
        TurnStartMessage {
            content,
            input_selections,
        }
    }
}

/// Frozen requests carry only included resources. Validate their metadata and
/// target ownership without inventing mappings for excluded source attachments.
pub(super) fn validate_frozen(
    inputs: &[Input],
    batch: &maka_protocol::turn::TurnBatchStartInput,
) -> Result<(), String> {
    validate_mapped(inputs, batch, true)
}

pub(super) fn validate_mapped(
    inputs: &[Input],
    batch: &maka_protocol::turn::TurnBatchStartInput,
    include_files: bool,
) -> Result<(), String> {
    for (input, message) in inputs.iter().zip(&batch.messages) {
        let mut expected = input.message();
        let old = expected.content.attachments.as_deref().unwrap_or_default();
        let new = message.content.attachments.as_deref().unwrap_or_default();
        let additions = if include_files { input.files.len() } else { 0 };
        if old.len() + additions != new.len() {
            return Err("Changed frozen revision attachments".into());
        }
        for (old, new) in old.iter().zip(new) {
            let mut metadata = new.clone();
            metadata.storage_ref = old.storage_ref.clone();
            if metadata != *old
                || !matches!(&new.storage_ref, StorageRef::SessionFile {session_id,..} if session_id == &batch.session_id)
            {
                return Err("Invalid frozen revision attachment".into());
            }
        }
        if include_files {
            for (file, attachment) in input.files.iter().zip(&new[old.len()..]) {
                if file.attachment.as_ref() != Some(attachment) {
                    return Err("Changed revision upload reference".into());
                }
            }
        }
        expected.content.attachments = message.content.attachments.clone();
        expected
            .content
            .validate_admission(
                !expected.input_selections.is_empty()
                    || (!include_files && !input.files.is_empty()),
            )
            .map_err(|e| e.to_string())?;
        if expected != *message {
            return Err("Changed frozen revision input".into());
        }
    }
    if batch.max_steps.is_some()
        || inputs
            .iter()
            .any(|input| input.original.turn_orchestration != batch.turn_orchestration)
    {
        return Err("Changed frozen revision intent".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::revision::draft;
    use serde_json::json;

    #[test]
    fn exclusions_keep_positions_and_target_mapping_while_frozen_requests_reject_changed_metadata()
    {
        let sources = maka_protocol::session::sources::decode_output(&json!({
            "sessionId":"source","turnId":"old","messages":[{
                "messageId":"m","content":{"text":"@a.rs","displayText":"shown",
                    "attachments":[
                        {"kind":"other","name":"same.txt","mimeType":"text/plain","bytes":1,"ref":{"kind":"session_file","sessionId":"source","relativePath":"first"}},
                        {"kind":"other","name":"same.txt","mimeType":"text/plain","bytes":1,"ref":{"kind":"session_file","sessionId":"source","relativePath":"second"}}
                    ],
                    "quotes":[{"text":"same"},{"text":"same"}],
                    "directoryReferences":[{"hostId":"host","path":"/workspace"}]
                },"inputSelections":{"skills":["review","build"]}
            }]
        })).unwrap();
        let mut input = Input::new(sources.messages[0].clone());
        for key in [
            Resource::Attachment { index: 0 },
            Resource::Quote { index: 0 },
            Resource::Directory { index: 0 },
            Resource::Selection {
                provider: "skills".into(),
                index: 0,
            },
        ] {
            input.toggle(&key);
        }
        input.replace("shown".into(), false).unwrap();
        input.validate().unwrap();
        let message = input.message();
        assert_eq!(message.content.attachments.as_ref().unwrap().len(), 1);
        assert_eq!(message.content.quotes.as_ref().unwrap().len(), 1);
        assert!(message.content.directory_references.is_none());
        assert_eq!(message.input_selections["skills"], ["build"]);
        let restored: Input =
            serde_json::from_value(serde_json::to_value(&input).unwrap()).unwrap();
        assert_eq!(restored.message(), message);
        let mut target = sources.clone();
        target.session_id = "target".into();
        for (index, attachment) in target.messages[0]
            .content
            .attachments
            .as_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            attachment.storage_ref = StorageRef::SessionFile {
                session_id: "target".into(),
                relative_path: format!("mapped-{index}"),
            };
        }
        let batch = draft::batch(std::slice::from_ref(&restored), &target, "new").unwrap();
        assert!(
            batch.messages[0].content.display_text.is_none(),
            "normalization is preserved"
        );
        assert!(
            matches!(&batch.messages[0].content.attachments.as_ref().unwrap()[0].storage_ref,
            StorageRef::SessionFile{relative_path,..} if relative_path == "mapped-1")
        );
        validate_frozen(std::slice::from_ref(&restored), &batch).unwrap();
        let mut changed = batch.clone();
        changed.messages[0].content.attachments.as_mut().unwrap()[0].name = "other".into();
        assert!(validate_frozen(std::slice::from_ref(&restored), &changed).is_err());
        changed = batch;
        changed.messages[0].input_selections.clear();
        assert!(validate_frozen(&[restored], &changed).is_err());
        for bad in [
            Resource::Attachment { index: 90 },
            Resource::Inline { index: 0 },
            Resource::Quote { index: 0 },
        ] {
            let mut malformed = input.clone();
            malformed.excluded.push(bad);
            assert!(
                malformed.validate().is_err(),
                "unknown, immutable or duplicate exclusion"
            );
        }
        for key in input.excluded.clone() {
            input.toggle(&key);
        }
        assert_eq!(
            input.message().content.attachments,
            sources.messages[0].content.attachments
        );
        assert_eq!(
            input.message().input_selections,
            sources.messages[0].input_selections
        );
    }
}
