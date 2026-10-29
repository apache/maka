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

//! Small request overlays over a fixed, already projected history view.
use maka_agent_facts::context::PreparedContextBreakdown;
use maka_agent_facts::model::prompt_source::source::{
    MessageMetadata, MessageRecipe, MessageSource, NextRecipe, RecipeCursor, RecipeIdentity,
    RecipeSource,
};
use maka_model::prompt::{Prompt, PromptCursor, PromptSource};
use std::{collections::VecDeque, sync::Arc};
mod owned_overlay;
mod wire;
pub(crate) use owned_overlay::OwnedOverlay;

#[derive(Clone)]
pub(super) struct PreparedPrompt {
    body: Prompt,
    resources: Option<maka_model::ModelPreparationResources>,
    arena: Option<crate::history::capture_arena::CaptureArena>,
    resident_bytes: usize,
    preparation: Option<Arc<crate::history::preparation::RequestPreparation>>,
    wire: Option<maka_agent_facts::model::prompt_source::PreparedWire>,
    system: Option<OwnedOverlay>,
    prefix: Arc<Vec<OwnedOverlay>>,
    suffix: Arc<Vec<OwnedOverlay>>,
    recipe_source: Option<Arc<dyn MessageSource>>,
    overlay_owner: Option<Arc<OverlayOwner>>,
    overlay_resident_bytes: usize,
}

impl PreparedPrompt {
    pub fn new(body: Prompt) -> Self {
        let recipe_source = body.recipes().cloned();
        Self {
            body,
            resources: None,
            arena: None,
            resident_bytes: 0,
            preparation: None,
            wire: None,
            system: None,
            prefix: Arc::new(Vec::new()),
            suffix: Arc::new(Vec::new()),
            recipe_source,
            overlay_owner: None,
            overlay_resident_bytes: 0,
        }
    }

    pub fn from_history(history: Arc<crate::history::FrozenHistory>) -> Self {
        let mut prompt = Self::new(history.prompt());
        prompt.resources = Some(history.resources().clone());
        prompt.resident_bytes = history.resident_bytes();
        prompt.preparation = Some(history.preparation());
        prompt.arena = Some(history.arena().clone());
        prompt
    }

    pub fn with_resources(mut self, resources: maka_model::ModelPreparationResources) -> Self {
        self.resources = Some(resources);
        self
    }

    pub fn active(&self) -> Option<Arc<maka_capabilities::model_preparation::ActivePreparation>> {
        self.preparation
            .as_ref()
            .and_then(|preparation| preparation.active())
    }
    pub fn with_preparation_from(mut self, original: &Self) -> Self {
        self.preparation = original.preparation.clone();
        self.overlay_owner = original.overlay_owner.clone();
        self.overlay_resident_bytes = 0;
        self
    }
    pub fn without_wire(&self) -> Self {
        let mut source = self.clone();
        source.wire = None;
        source
    }
    pub async fn promote(
        &self,
        peak: usize,
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(), crate::RunError> {
        let preparation = self
            .preparation
            .as_ref()
            .ok_or_else(|| crate::RunError::Internal("source lacks its staging account".into()))?;
        preparation
            .promote(peak, cancellation)
            .await
            .map_err(crate::RunError::preparation)
    }
    pub fn resident_bytes(&self) -> usize {
        self.resident_bytes
    }
    pub fn backed_wire_bytes() -> usize {
        wire::backed_resident_bytes()
    }
    pub fn with_resident_bytes(mut self, bytes: usize) -> Self {
        self.resident_bytes = bytes;
        self
    }
    pub fn is_generated(&self) -> bool {
        self.body.memory_messages().is_some()
    }

    pub fn resources(&self) -> Option<&maka_model::ModelPreparationResources> {
        self.resources.as_ref()
    }
    pub fn arena(&self) -> Option<&crate::history::capture_arena::CaptureArena> {
        self.arena.as_ref()
    }
    pub fn with_arena(mut self, arena: crate::history::capture_arena::CaptureArena) -> Self {
        self.arena = Some(arena);
        self
    }
    pub async fn close(&self) -> std::io::Result<()> {
        if let Some(arena) = &self.arena {
            arena.close().await?;
        }
        Ok(())
    }

    pub fn overlay_plan_bytes(system: bool, checkpoint: bool, summary: bool) -> usize {
        let adapters =
            Self::overlay_metadata_bytes(system, usize::from(checkpoint), usize::from(summary));
        if adapters == 0 {
            return 0;
        }
        // The source template and one attempt/fit view can coexist.
        2 * adapters
            + usize::from(checkpoint) * OwnedOverlay::checkpoint_metadata_bytes()
            + usize::from(summary) * OwnedOverlay::user_metadata_bytes()
            + 2 * (2 * std::mem::size_of::<usize>() + std::mem::size_of::<Vec<OwnedOverlay>>())
    }

    pub async fn initialize_overlays(
        &mut self,
        system: Option<Arc<String>>,
        context: Arc<maka_event_log::context::ContextView>,
        checkpoint_label: &'static str,
        summary: bool,
    ) -> Result<(), crate::RunError> {
        let bytes = Self::overlay_plan_bytes(system.is_some(), context.baseline.is_some(), summary);
        if bytes == 0 {
            return Ok(());
        }
        let preparation = self.preparation.as_ref().ok_or_else(|| {
            crate::RunError::Internal("request overlays lack their staging account".into())
        })?;
        let owner = Arc::new(OverlayOwner {
            _lease: preparation
                .directory(bytes)
                .map_err(crate::RunError::Preparation)?,
        });
        self.overlay_owner = Some(owner.clone());
        self.overlay_resident_bytes = bytes;
        let arena = self.arena.as_ref().ok_or_else(|| {
            crate::RunError::Internal("request overlays lack their original worker".into())
        })?;
        let (system, checkpoint) = arena
            .with_writer(move |_| {
                let system = system.map(|text| OwnedOverlay::system(text).bound(owner.clone()));
                let checkpoint = OwnedOverlay::checkpoint(context, checkpoint_label)
                    .map(|overlay| overlay.bound(owner));
                Ok((system, checkpoint))
            })
            .await
            .map_err(crate::RunError::Preparation)?;
        self.system = system;
        self.prefix = Arc::new(checkpoint.into_iter().collect());
        self.rebuild_recipes();
        Ok(())
    }

    pub async fn freeze_summary_instruction(
        &self,
        text: Arc<String>,
    ) -> Result<OwnedOverlay, crate::RunError> {
        let owner = self.overlay_owner.clone().ok_or_else(|| {
            crate::RunError::Internal("summary instruction lacks its reserved overlay owner".into())
        })?;
        self.arena
            .as_ref()
            .ok_or_else(|| {
                crate::RunError::Internal("summary instruction lacks its original worker".into())
            })?
            .with_writer(move |_| Ok(OwnedOverlay::user(text).bound(owner)))
            .await
            .map_err(crate::RunError::Preparation)
    }

    pub fn push(&mut self, message: OwnedOverlay) {
        self.wire = None;
        self.recipe_source = None;
        let suffix = Arc::make_mut(&mut self.suffix);
        suffix.reserve_exact(1);
        suffix.push(message);
        self.rebuild_recipes();
    }

    fn rebuild_recipes(&mut self) {
        let Some(body) = self.body.recipes().cloned() else {
            return;
        };
        if self.system.is_none() && self.prefix.is_empty() && self.suffix.is_empty() {
            self.recipe_source = Some(body);
            return;
        }
        self.recipe_source = Some(Arc::new(RecipeOverlay {
            _owner: self.overlay_owner.clone(),
            segments: [
                self.system.as_ref().map(OwnedOverlay::source),
                (!self.prefix.is_empty())
                    .then(|| Arc::new(OwnedList(self.prefix.clone())) as Arc<dyn MessageSource>),
                Some(body),
                (!self.suffix.is_empty())
                    .then(|| Arc::new(OwnedList(self.suffix.clone())) as Arc<dyn MessageSource>),
            ],
        }));
    }

    pub async fn compile_wire(
        &mut self,
        language: maka_agent_facts::language::Language,
        provider: &maka_model::ProviderConfig,
        options: &serde_json::Value,
        tools: &[maka_model::ToolDefinition],
        cancellation: &tokio_util::sync::CancellationToken,
    ) -> Result<(), crate::RunError> {
        wire::compile(self, language, provider, options, tools, cancellation).await
    }

    pub fn breakdown(&self) -> PreparedContextBreakdown {
        let mut result = self.body.breakdown().clone();
        for overlay in self
            .system
            .iter()
            .chain(self.prefix.iter())
            .chain(self.suffix.iter())
        {
            result.accumulate(overlay.breakdown());
        }
        result
    }

    /// New request allocations; frozen input DTO text is shared outside this account.
    pub fn overlay_bytes(&self) -> usize {
        self.overlay_resident_bytes
    }
    pub fn overlay_metadata_bytes(system: bool, prefix: usize, suffix: usize) -> usize {
        if !system && prefix == 0 && suffix == 0 {
            return 0;
        }
        let arc_header = 2 * std::mem::size_of::<usize>();
        usize::from(system)
            * (OwnedOverlay::system_metadata_bytes()
                + OwnedOverlay::system_binding_metadata_bytes())
            + (prefix + suffix)
                * (OwnedOverlay::user_binding_metadata_bytes()
                    + std::mem::size_of::<OwnedOverlay>())
            + (usize::from(prefix != 0) + usize::from(suffix != 0))
                * (arc_header + std::mem::size_of::<OwnedList>())
            + arc_header
            + std::mem::size_of::<RecipeOverlay>()
            + arc_header
            + std::mem::size_of::<OverlayOwner>()
    }
    pub fn freeze_overlays(&mut self) -> Result<(), crate::RunError> {
        if self.overlay_owner.is_some() {
            return Ok(());
        }
        let bytes = Self::overlay_metadata_bytes(
            self.system.is_some(),
            self.prefix.capacity(),
            self.suffix.capacity(),
        );
        if bytes == 0 {
            return Ok(());
        }
        let preparation = self.preparation.as_ref().ok_or_else(|| {
            crate::RunError::Internal("request overlays lack their staging account".into())
        })?;
        self.recipe_source = None;
        let owner = Arc::new(OverlayOwner {
            _lease: preparation
                .directory(bytes)
                .map_err(crate::RunError::Preparation)?,
        });
        if let Some(system) = &mut self.system {
            *system = system.bound(owner.clone());
        }
        for overlay in Arc::make_mut(&mut self.prefix)
            .iter_mut()
            .chain(Arc::make_mut(&mut self.suffix).iter_mut())
        {
            *overlay = overlay.bound(owner.clone());
        }
        self.overlay_owner = Some(owner);
        self.overlay_resident_bytes = bytes;
        self.rebuild_recipes();
        Ok(())
    }

    pub fn model(&self) -> Prompt {
        #[derive(serde::Serialize)]
        struct Identity<'a> {
            domain: &'static str,
            body: &'a str,
            system: Option<&'a str>,
            prefix: Identities<'a>,
            suffix: Identities<'a>,
        }
        let identity = crate::runner::digest(&Identity {
            domain: "maka.prepared-prompt.v1",
            body: self.body.identity(),
            system: self.system.as_ref().map(OwnedOverlay::identity),
            prefix: Identities(&self.prefix),
            suffix: Identities(&self.suffix),
        })
        .expect("prepared overlays are serializable");
        let count = self.body.len()
            + usize::from(self.system.is_some())
            + self.prefix.len()
            + self.suffix.len();
        let mut prompt = if let Some(recipes) = self.recipes() {
            Prompt::from_recipes(recipes, identity, count, self.breakdown())
        } else {
            Prompt::new(
                Arc::new(Overlay(self.clone())),
                identity,
                count,
                self.breakdown(),
            )
        };
        if let Some(provider) = self.body.normalization() {
            prompt = prompt.with_normalization(provider.clone());
        }
        if let Some(instructions) = self
            .system
            .iter()
            .chain(self.prefix.iter())
            .chain(self.suffix.iter())
            .find_map(OwnedOverlay::instructions)
        {
            prompt = prompt.with_instruction_source(instructions);
        } else {
            prompt = prompt.with_instructions_from(&self.body);
        }
        if let Some(wire) = &self.wire {
            prompt = prompt.with_wire(
                wire.format,
                wire.codec.clone(),
                wire.identity.clone(),
                wire.source.clone(),
            );
        }
        prompt
    }

    /// Every clone shares the same frozen overlay directory and body owners.
    pub fn recipes(&self) -> Option<Arc<dyn MessageSource>> {
        self.recipe_source.clone()
    }

    pub fn open(&self) -> Box<dyn PromptCursor> {
        if self.is_generated() {
            Overlay(self.clone()).open()
        } else {
            self.model().open()
        }
    }
}

struct Identities<'a>(&'a [OwnedOverlay]);
impl serde::Serialize for Identities<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.0.iter().map(OwnedOverlay::identity))
    }
}
struct OwnedList(Arc<Vec<OwnedOverlay>>);
impl RecipeSource<MessageRecipe> for OwnedList {
    fn len(&self) -> usize {
        self.0.len()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        Box::new(OwnedCursor {
            entries: self.0.clone(),
            position: start,
        })
    }
}
impl MessageSource for OwnedList {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        Box::new(OwnedMetadata {
            entries: self.0.clone(),
            position: start,
        })
    }
    fn prefix_identity(&self, count: usize) -> RecipeIdentity<'_> {
        Box::pin(async move {
            if count > self.0.len() {
                return Err(std::io::Error::other("overlay prefix exceeds directory"));
            }
            crate::runner::digest(&Identities(&self.0[..count])).map_err(std::io::Error::other)
        })
    }
}
struct OwnedCursor {
    entries: Arc<Vec<OwnedOverlay>>,
    position: usize,
}
impl RecipeCursor<MessageRecipe> for OwnedCursor {
    fn next(&mut self) -> NextRecipe<'_, MessageRecipe> {
        Box::pin(async move {
            let result = self.entries.get(self.position).map(OwnedOverlay::recipe);
            self.position += usize::from(result.is_some());
            Ok(result)
        })
    }
}
struct OwnedMetadata {
    entries: Arc<Vec<OwnedOverlay>>,
    position: usize,
}
impl RecipeCursor<MessageMetadata> for OwnedMetadata {
    fn next(&mut self) -> NextRecipe<'_, MessageMetadata> {
        Box::pin(async move {
            let result = self
                .entries
                .get(self.position)
                .map(|entry| entry.metadata(self.position));
            self.position += usize::from(result.is_some());
            Ok(result)
        })
    }
}

struct OverlayOwner {
    _lease: maka_model::DirectoryLease,
}
struct RecipeOverlay {
    _owner: Option<Arc<OverlayOwner>>,
    segments: [Option<Arc<dyn MessageSource>>; 4],
}
impl RecipeSource<MessageRecipe> for RecipeOverlay {
    fn len(&self) -> usize {
        self.segments
            .iter()
            .flatten()
            .map(|segment| segment.len())
            .sum()
    }
    fn open(&self, start: usize) -> Box<dyn RecipeCursor<MessageRecipe>> {
        let mut offset = 0;
        let mut cursors = VecDeque::new();
        for segment in self.segments.iter().flatten() {
            if start < offset + segment.len() {
                cursors.push_back(segment.open(start.saturating_sub(offset)));
            }
            offset += segment.len();
        }
        Box::new(RecipeOverlayCursor { cursors })
    }
}
impl MessageSource for RecipeOverlay {
    fn open_metadata(&self, start: usize) -> Box<dyn RecipeCursor<MessageMetadata>> {
        let mut offset = 0;
        let mut cursors = VecDeque::new();
        for segment in self.segments.iter().flatten() {
            if start < offset + segment.len() {
                cursors.push_back((offset, segment.open_metadata(start.saturating_sub(offset))));
            }
            offset += segment.len();
        }
        Box::new(RecipeMetadataCursor { cursors })
    }
    fn prefix_identity(&self, messages: usize) -> RecipeIdentity<'_> {
        Box::pin(async move {
            use sha2::Digest;
            if messages > self.len() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "logical prefix exceeds request directory",
                ));
            }
            let mut hash = sha2::Sha256::new();
            hash.update(b"maka.logical-prefix\0");
            let mut cursor = self.open_metadata(0);
            for _ in 0..messages {
                let message = cursor.next().await?.ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "request metadata ended before its declared length",
                    )
                })?;
                hash.update((message.logical_identity.len() as u64).to_le_bytes());
                hash.update(message.logical_identity.as_bytes());
            }
            Ok(hex::encode(hash.finalize()))
        })
    }
}
struct RecipeMetadataCursor {
    cursors: VecDeque<(usize, Box<dyn RecipeCursor<MessageMetadata>>)>,
}
impl RecipeCursor<MessageMetadata> for RecipeMetadataCursor {
    fn next(&mut self) -> NextRecipe<'_, MessageMetadata> {
        Box::pin(async move {
            loop {
                let Some((offset, cursor)) = self.cursors.front_mut() else {
                    return Ok(None);
                };
                if let Some(mut message) = cursor.next().await? {
                    message.message_index += *offset;
                    return Ok(Some(message));
                }
                self.cursors.pop_front();
            }
        })
    }
}
struct RecipeOverlayCursor {
    cursors: VecDeque<Box<dyn RecipeCursor<MessageRecipe>>>,
}
impl RecipeCursor<MessageRecipe> for RecipeOverlayCursor {
    fn next(&mut self) -> NextRecipe<'_, MessageRecipe> {
        Box::pin(async move {
            loop {
                let Some(cursor) = self.cursors.front_mut() else {
                    return Ok(None);
                };
                if let Some(message) = cursor.next().await? {
                    return Ok(Some(message));
                }
                self.cursors.pop_front();
            }
        })
    }
}

struct Overlay(PreparedPrompt);
impl PromptSource for Overlay {
    fn open(&self) -> Box<dyn PromptCursor> {
        Box::new(Cursor {
            system: self.0.system.clone(),
            prefix: self.0.prefix.clone(),
            prefix_offset: 0,
            body: self.0.body.open(),
            suffix: self.0.suffix.clone(),
            body_done: false,
            offset: 0,
        })
    }
}
struct Cursor {
    system: Option<OwnedOverlay>,
    prefix: Arc<Vec<OwnedOverlay>>,
    prefix_offset: usize,
    body: Box<dyn PromptCursor>,
    suffix: Arc<Vec<OwnedOverlay>>,
    body_done: bool,
    offset: usize,
}
impl PromptCursor for Cursor {
    fn next(&mut self) -> maka_agent_facts::model::prompt_source::Next<'_> {
        Box::pin(async move {
            if let Some(system) = self.system.take() {
                return Ok(Some(system.owned_message()));
            }
            if let Some(message) = self.prefix.get(self.prefix_offset) {
                self.prefix_offset += 1;
                return Ok(Some(message.owned_message()));
            }
            if !self.body_done {
                if let Some(message) = self.body.next().await? {
                    return Ok(Some(message));
                }
                self.body_done = true;
            }
            let message = self
                .suffix
                .get(self.offset)
                .map(OwnedOverlay::owned_message);
            self.offset += usize::from(message.is_some());
            Ok(message)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::model::prompt_source::{
        PreparedWire, WireCursor, WireFormat, WireSource,
    };

    #[tokio::test]
    async fn promotion_preserves_cancellation_and_closed_resource_failure() {
        use tokio_util::sync::CancellationToken;

        let resources = maka_model::ModelPreparationResources::new(Default::default()).unwrap();
        let staged = resources.reserve_staging(1).await.unwrap();
        let mut prompt = PreparedPrompt::new(Prompt::from_messages(Vec::new()));
        prompt.preparation = Some(crate::history::preparation::RequestPreparation::new(staged));
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(matches!(
            prompt.promote(1, &cancellation).await,
            Err(crate::RunError::Cancelled)
        ));

        resources.close();
        let result = prompt.promote(1, &CancellationToken::new()).await;
        assert!(matches!(
            result,
            Err(crate::RunError::Preparation(error))
                if error.kind() == std::io::ErrorKind::BrokenPipe
        ));
    }

    struct UnreadableHistory;
    impl PromptSource for UnreadableHistory {
        fn open(&self) -> Box<dyn PromptCursor> {
            panic!("request identity must not traverse history")
        }
    }
    impl WireSource for UnreadableHistory {
        fn open(&self, _: usize) -> Box<dyn WireCursor> {
            panic!("request identity must not encode body")
        }
    }

    #[test]
    fn final_request_identity_binds_wire_root_and_captures_absent_instructions_without_reads() {
        let mut prompt = PreparedPrompt::new(Prompt::new(
            Arc::new(UnreadableHistory),
            "semantic-root",
            1000,
            PreparedContextBreakdown::default(),
        ));
        prompt.wire = Some(PreparedWire {
            format: WireFormat::ChatCompletions,
            codec: "codec-one".into(),
            identity: "wire-one".into(),
            source: Arc::new(UnreadableHistory),
        });
        let first = prompt.model();
        assert_eq!(first.instructions(), Some(""));
        prompt.wire.as_mut().unwrap().identity = "wire-two".into();
        assert_ne!(
            first.identity(),
            prompt.model().identity(),
            "a changed prepared wire root changes input evidence"
        );
        prompt.wire.as_mut().unwrap().identity = "wire-one".into();
        prompt.wire.as_mut().unwrap().codec = "codec-two".into();
        assert_ne!(
            first.identity(),
            prompt.model().identity(),
            "codec revisions are part of input evidence"
        );
    }
}
