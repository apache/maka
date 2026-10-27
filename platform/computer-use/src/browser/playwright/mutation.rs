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

//! Locator mutations retain the selected DOM object through dispatch and cleanup.

use super::*;

mod clipboard;
mod geometry;
mod keyboard;
mod shortcut;

const ELEMENT: &str = include_str!("mutation/element.js");

struct MutationContext<'a> {
    document: &'a crate::BrowserDocument,
    deadline: tokio::time::Instant,
    cancellation: &'a CancellationToken,
    resources: &'a Resources,
    language: Language,
    cursor: &'a crate::cursor::Spec,
}

struct Selected {
    object: String,
    frame: frames::Frame,
    used: Vec<frames::Frame>,
}

pub(in crate::browser) fn validate_mutation(
    operation: &BrowserMutationOperation,
) -> Result<(), ToolError> {
    if operation
        .timeout_ms()
        .is_some_and(|value| !value.is_finite() || value <= 0.0 || value.fract() != 0.0)
    {
        return Err(failed("timeoutMs must be a positive integer"));
    }
    match operation {
        BrowserMutationOperation::Press { value, .. } => {
            keyboard::chord(&shortcut::normalize(value))?;
        }
        BrowserMutationOperation::SelectOption { values, .. } => {
            if values.is_empty() {
                return Err(failed("locator.selectOption requires at least one value"));
            }
            if values.iter().any(|value| {
                value
                    .index
                    .is_some_and(|index| !index.is_finite() || index < 0.0 || index.fract() != 0.0)
            }) {
                return Err(failed("index must be a non-negative integer"));
            }
            if values.iter().any(|value| {
                value.value.is_none() && value.label.is_none() && value.index.is_none()
            }) {
                return Err(failed(
                    "locator.selectOption requires a value, label, or index",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn timeout(operation: &BrowserMutationOperation) -> Duration {
    let maximum = if matches!(
        operation,
        BrowserMutationOperation::PressSequentially { .. }
    ) {
        5000.0
    } else {
        3000.0
    };
    Duration::from_secs_f64(operation.timeout_ms().unwrap_or(3000.0).min(maximum) / 1000.0)
}

// Raw AX names have a small preprocessing layer before the shared key layout.
// Keep it local: locator keyboard names retain their existing behavior.
fn accessibility_key_names(value: &str) -> String {
    value
        .split('+')
        .map(|key| {
            if key.len() == 1 {
                return key.to_owned();
            }
            let lower = key.to_ascii_lowercase();
            let modifier = lower
                .strip_suffix("_l")
                .or_else(|| lower.strip_suffix("_r"));
            if let Some(base @ ("alt" | "control" | "meta" | "super" | "shift")) = modifier {
                base.to_owned()
            } else {
                key.replace('_', "")
            }
        })
        .collect::<Vec<_>>()
        .join("+")
}

fn check_cancelled(cancellation: &CancellationToken, dispatched: bool) -> Result<(), ToolError> {
    if cancellation.is_cancelled() && dispatched {
        return Err(ToolError::OutcomeUnknown(
            "Browser mutation cancelled after a page effect; do not replay".into(),
        ));
    }
    check_input(cancellation)
}

impl Tab {
    pub(in crate::browser) async fn accessibility_key(
        &mut self,
        index: Option<u64>,
        value: &str,
        cancellation: &CancellationToken,
        language: Language,
        cursor: &crate::cursor::Spec,
    ) -> Result<(), ToolError> {
        let document = self.document();
        let frame = match index {
            Some(index) => self
                .verify_element(index, language)
                .await?
                .frame
                .ok_or_else(|| failed("keyboard target frame was not proven"))?,
            None => self.main_frame().await?,
        };
        let mut used = vec![frame.clone()];
        if frame.parent.is_some() {
            let frames = self.frames().await?;
            while let Some(parent) = used.last().and_then(|frame| frame.parent.as_deref()) {
                let ancestor = frames
                    .iter()
                    .find(|frame| frame.id == parent)
                    .ok_or_else(|| failed("keyboard target ancestor frame changed"))?;
                if used.iter().any(|frame| frame.id == ancestor.id) {
                    return Err(failed("keyboard target frame ancestry is invalid"));
                }
                used.push(ancestor.clone());
            }
        }
        let resources = Resources::new();
        let result = async {
            let engine = self.playwright_engine(&frame, &resources).await?;
            let object = cdp_value(self.frame_observation(
                frame.session.as_deref(), "Runtime.callFunctionOn", json!({
                    "objectId":engine,"functionDeclaration":"function(){return document.documentElement;}",
                    "returnByValue":false,"objectGroup":resources.group,
                }),
            ).await?)?["objectId"].as_str()
                .ok_or_else(|| failed("current browser document is unavailable"))?.to_owned();
            let selected = Selected { object, frame: frame.clone(), used };
            let target_macos = self.locator_target_macos(&selected, &resources).await?;
            let chord = Self::locator_chord(&accessibility_key_names(value), target_macos)?;
            let context = MutationContext {
                document: &document,
                deadline: tokio::time::Instant::now() + Duration::from_secs(3),
                cancellation, resources: &resources, language, cursor,
            };
            // Recheck the same authorized document after metadata preparation.
            let proof = self.origin_proof.clone()
                .ok_or_else(|| failed("keyboard input lost its admitted document"))?;
            proof.check_current(self).await?;
            check_input(cancellation)?;
            self.locator_document_current(&selected, &context).await?;
            if let Some(operation) = shortcut::clipboard(&chord, target_macos) {
                self.locator_current_clipboard(&selected, operation, &context).await
            } else {
                self.before_input(cancellation, language).await?;
                self.locator_key(&chord, cancellation, Some(target_macos)).await
            }
        }.await;
        // This is the same admitted operation and isolated utility object group,
        // not another invocation or keyboard owner.
        resources.cleanup(self).await;
        result.map_err(|error| {
            if cancellation.is_cancelled()
                && resources.mutated.load(std::sync::atomic::Ordering::Relaxed)
                && matches!(error, ToolError::Failed(_))
            {
                ToolError::OutcomeUnknown(format!(
                    "{error}; cancellation followed a page effect; do not replay"
                ))
            } else {
                error
            }
        })
    }

    async fn locator_input_target(
        &self,
        selected: &Selected,
        resources: &Resources,
    ) -> Result<Selected, ToolError> {
        let engine = self.playwright_engine(&selected.frame, resources).await?;
        let reply = self.frame_observation(selected.frame.session.as_deref(), "Runtime.callFunctionOn", json!({
            "objectId":engine,"functionDeclaration":"function(element){return this.retarget(element,'follow-label');}",
            "arguments":[{"objectId":selected.object}],"returnByValue":false,"objectGroup":resources.group,
        })).await?;
        let object = cdp_value(reply)?["objectId"]
            .as_str()
            .ok_or_else(|| failed("editable input target is unavailable"))?
            .to_owned();
        Ok(Selected {
            object,
            frame: selected.frame.clone(),
            used: selected.used.clone(),
        })
    }

    async fn locator_target_macos(
        &self,
        selected: &Selected,
        resources: &Resources,
    ) -> Result<bool, ToolError> {
        let engine = self.playwright_engine(&selected.frame, resources).await?;
        let reply=self.frame_observation(selected.frame.session.as_deref(),"Runtime.callFunctionOn",json!({
            "objectId":engine,"functionDeclaration":"function(){return navigator.userAgentData?.platform ?? navigator.platform;}",
            "returnByValue":true,"objectGroup":resources.group,
        })).await?;
        let value = cdp_value(reply)?;
        let platform = value["value"]
            .as_str()
            .ok_or_else(|| failed("browser platform is unavailable"))?;
        Ok(platform == "macOS" || platform.starts_with("Mac"))
    }

    fn locator_chord(value: &str, target_macos: bool) -> Result<keyboard::Chord, ToolError> {
        let value = shortcut::normalize(value);
        let replacement = if target_macos { "Meta" } else { "Control" };
        let value = value
            .split('+')
            .map(|part| {
                if part == "ControlOrMeta" {
                    replacement
                } else {
                    part
                }
            })
            .collect::<Vec<_>>()
            .join("+");
        keyboard::chord(&value)
    }

    async fn locator_click_options(
        &self,
        selected: &Selected,
        options: &BrowserClickOptions,
        resources: &Resources,
    ) -> Result<BrowserClickOptions, ToolError> {
        let mut options = options.clone();
        if options
            .modifiers
            .contains(&BrowserKeyboardModifier::ControlOrMeta)
        {
            let resolved = if self.locator_target_macos(selected, resources).await? {
                BrowserKeyboardModifier::Meta
            } else {
                BrowserKeyboardModifier::Control
            };
            for modifier in &mut options.modifiers {
                if *modifier == BrowserKeyboardModifier::ControlOrMeta {
                    *modifier = resolved;
                }
            }
        }
        Ok(options)
    }

    async fn locator_element(&mut self, query: &str, resources: &Resources) -> Attempt<Selected> {
        let SelectorScope {
            frame,
            used,
            segment,
        } = self.playwright_scope(query, resources).await?;
        let object = self.playwright_element(&frame, &segment, resources).await?;
        Ok(Selected {
            object,
            frame,
            used,
        })
    }

    async fn locator_element_script(
        &self,
        selected: &Selected,
        request: Value,
        resources: &Resources,
        effect: Option<&CancellationToken>,
    ) -> Result<Value, ToolError> {
        let engine = self.playwright_engine(&selected.frame, resources).await?;
        let params = json!({
            "objectId":engine,
            "functionDeclaration":ELEMENT,
            "arguments":[{"objectId":selected.object},{"value":request}],
            "awaitPromise":true,
            "returnByValue":true,
            "objectGroup":resources.group,
        });
        let reply = if let Some(cancellation) = effect {
            if !self.frame_scopes_current(&selected.used).await? {
                return Err(failed("frame changed before locator effect"));
            }
            check_input(cancellation)?;
            resources
                .mutated
                .store(true, std::sync::atomic::Ordering::Relaxed);
            self.frame_request(
                selected.frame.session.as_deref(),
                "Runtime.callFunctionOn",
                params,
            )
            .await?
        } else {
            self.frame_observation(
                selected.frame.session.as_deref(),
                "Runtime.callFunctionOn",
                params,
            )
            .await?
        };
        Ok(cdp_value(reply)?["value"].clone())
    }

    async fn locator_document_current(
        &mut self,
        selected: &Selected,
        context: &MutationContext<'_>,
    ) -> Result<(), ToolError> {
        let MutationContext {
            document,
            deadline,
            cancellation,
            resources,
            language,
            ..
        } = *context;
        check_input(cancellation)?;
        if tokio::time::Instant::now() >= deadline {
            return Err(
                if resources.mutated.load(std::sync::atomic::Ordering::Relaxed) {
                    ToolError::OutcomeUnknown(
                        "Locator deadline exceeded after a page effect; do not replay".into(),
                    )
                } else {
                    failed("Playwright selector deadline exceeded")
                },
            );
        }
        self.refresh_info(language).await?;
        if self.document() != *document || !self.frame_scopes_current(&selected.used).await? {
            return Err(failed("document or frame changed before locator input"));
        }
        check_input(cancellation)
    }

    async fn locator_current(
        &mut self,
        selected: &Selected,
        context: &MutationContext<'_>,
        focused: Option<bool>,
    ) -> Result<(), ToolError> {
        self.locator_document_current(selected, context).await?;
        let state = self
            .locator_element_script(
                selected,
                json!({"kind":"verify","requireEditable":focused.unwrap_or(false),"exactTarget":true}),
                context.resources,
                None,
            )
            .await?;
        if state["connected"] != true {
            return Err(failed("Element is not connected"));
        }
        if focused.is_some() && state["focused"] != true {
            return Err(failed("Element is not focused"));
        }
        check_input(context.cancellation)
    }

    async fn locator_prepare(
        &mut self,
        query: &str,
        operation: &BrowserMutationOperation,
        context: &MutationContext<'_>,
    ) -> Result<Selected, ToolError> {
        let MutationContext {
            deadline,
            cancellation,
            resources,
            ..
        } = *context;
        let request = match operation {
            BrowserMutationOperation::Click { options }
            | BrowserMutationOperation::DoubleClick { options } => {
                json!({"kind":"preparePointer","force":options.force})
            }
            BrowserMutationOperation::SetChecked { .. } => json!({"kind":"verify"}),
            BrowserMutationOperation::SelectOption { .. } => json!({"kind":"prepareSelect"}),
            BrowserMutationOperation::Press { .. } => {
                json!({"kind":"prepareText","requireEditable":false})
            }
            _ => json!({"kind":"prepareText","requireEditable":true}),
        };
        loop {
            let attempt = async {
                let selected = self.locator_element(query, resources).await?;
                self.locator_current(&selected, context, None)
                    .await
                    .map_err(AttemptError::Fatal)?;
                let result = self
                    .locator_element_script(&selected, request.clone(), resources, None)
                    .await?;
                if result["status"] == "retry" {
                    return Err(AttemptError::Retry(failed(
                        result["message"].as_str().unwrap_or("element is not ready"),
                    )));
                }
                Ok(selected)
            };
            // Only the observation phase can be abandoned or repeated. The
            // returned DOM object is retained for all subsequent page effects.
            let result = tokio::select! {
                biased;
                ()=cancellation.cancelled()=>return Err(failed("Browser mutation cancelled")),
                result=tokio::time::timeout_at(deadline,attempt)=>result.map_err(|_|failed("Playwright selector deadline exceeded"))?,
            };
            match result {
                Ok(selected) => return Ok(selected),
                Err(AttemptError::Fatal(error)) => return Err(error),
                Err(AttemptError::Retry(error)) => {
                    if tokio::time::Instant::now() >= deadline {
                        return Err(error);
                    }
                    tokio::select! {
                        biased;
                        ()=cancellation.cancelled()=>return Err(failed("Browser mutation cancelled")),
                        ()=tokio::time::sleep_until((tokio::time::Instant::now()+Duration::from_millis(100)).min(deadline))=>{},
                    }
                }
            }
        }
    }

    pub(in crate::browser) async fn playwright_mutation(
        &mut self,
        plan: &LocatorPlan,
        operation: BrowserMutationOperation,
        document: crate::BrowserDocument,
        cursor: &crate::cursor::Spec,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        validate_mutation(&operation)?;
        let resources = Resources::new();
        let deadline = tokio::time::Instant::now() + timeout(&operation);
        let context = MutationContext {
            document: &document,
            deadline,
            cancellation,
            resources: &resources,
            language,
            cursor,
        };
        let result = async {
            tokio::select! {
                biased;
                ()=cancellation.cancelled()=>return Err(failed("Browser mutation cancelled")),
                ready=tokio::time::timeout_at(deadline,self.verify(language))=>ready.map_err(|_|failed("Playwright selector deadline exceeded"))??,
            }
            let selected = self
                .locator_prepare(
                    &plan.selector,
                    &operation,
                    &context,
                )
                .await?;
            let selected = if matches!(operation,
                BrowserMutationOperation::Fill {..}|BrowserMutationOperation::Type {..}|BrowserMutationOperation::PressSequentially {..}
            ) { self.locator_input_target(&selected, &resources).await? } else { selected };
            self.locator_dispatch(
                &selected,
                &operation,
                &context,
            )
            .await
        }
        .await;
        resources.cleanup(self).await;
        result
            .map_err(|error| {
                if cancellation.is_cancelled()
                    && resources.mutated.load(std::sync::atomic::Ordering::Relaxed)
                    && matches!(error, ToolError::Failed(_))
                {
                    ToolError::OutcomeUnknown(format!(
                        "{error}; cancellation followed a page effect; do not replay"
                    ))
                } else {
                    error
                }
            })
            .map(|()| Value::Null)
    }

    async fn locator_dispatch(
        &mut self,
        selected: &Selected,
        operation: &BrowserMutationOperation,
        context: &MutationContext<'_>,
    ) -> Result<(), ToolError> {
        let MutationContext {
            deadline,
            cancellation,
            resources,
            ..
        } = *context;
        check_input(cancellation)?;
        match operation {
            BrowserMutationOperation::Click { options }
            | BrowserMutationOperation::DoubleClick { options } => {
                let options = self
                    .locator_click_options(selected, options, resources)
                    .await?;
                let point = self
                    .locator_pointer(selected, options.force, resources, cancellation)
                    .await?;
                if context.cursor.enabled {
                    let _ = self
                        .draw_cursor(
                            context.cursor,
                            Some(point),
                            "click",
                            "update",
                            context.language,
                        )
                        .await;
                }
                self.locator_current(selected, context, None).await?;
                self.locator_click(
                    point,
                    &options,
                    if matches!(operation, BrowserMutationOperation::DoubleClick { .. }) {
                        2
                    } else {
                        1
                    },
                    cancellation,
                )
                .await
            }
            BrowserMutationOperation::SetChecked { checked, options } => {
                let state = self
                    .locator_element_script(
                        selected,
                        json!({"kind":"readChecked"}),
                        resources,
                        None,
                    )
                    .await?;
                if state["checked"] == *checked {
                    return Ok(());
                }
                if !checked && state["isRadio"] == true {
                    return Err(failed("Cannot uncheck a radio button"));
                }
                let point = self
                    .locator_pointer(selected, options.force, resources, cancellation)
                    .await?;
                if context.cursor.enabled {
                    let _ = self
                        .draw_cursor(
                            context.cursor,
                            Some(point),
                            "click",
                            "update",
                            context.language,
                        )
                        .await;
                }
                self.locator_current(selected, context, None).await?;
                self.locator_click(
                    point,
                    &BrowserClickOptions {
                        force: options.force,
                        timeout_ms: options.timeout_ms,
                        ..BrowserClickOptions::default()
                    },
                    1,
                    cancellation,
                )
                .await?;
                let state = self
                    .locator_element_script(
                        selected,
                        json!({"kind":"readChecked"}),
                        resources,
                        None,
                    )
                    .await?;
                if state["checked"] != *checked {
                    return Err(failed(format!(
                        "Click did not change checked state to {checked}"
                    )));
                }
                Ok(())
            }
            BrowserMutationOperation::SelectOption { values, .. } => {
                self.locator_current(selected, context, None).await?;
                self.locator_element_script(
                    selected,
                    json!({"kind":"selectOption","selections":values}),
                    resources,
                    Some(cancellation),
                )
                .await?;
                Ok(())
            }
            BrowserMutationOperation::Fill { value, .. }
            | BrowserMutationOperation::Type { value, .. } => {
                self.locator_current(selected, context, None).await?;
                let prepared = self
                    .locator_element_script(
                        selected,
                        json!({"kind":if matches!(operation,BrowserMutationOperation::Fill {..}) {"fill"}else{"type"},"value":value,"requireEditable":true}),
                        resources,
                        Some(cancellation),
                    )
                    .await?;
                if prepared["status"] == "needsinput" {
                    self.locator_document_current(selected, context).await?;
                    self.locator_virtual_text(
                        selected,
                        value,
                        matches!(operation, BrowserMutationOperation::Fill { .. }),
                        context,
                    )
                    .await?;
                }
                Ok(())
            }
            BrowserMutationOperation::Press { value, .. } => {
                let target_macos = self.locator_target_macos(selected, resources).await?;
                let chord = Self::locator_chord(value, target_macos)?;
                if let Some(operation) = shortcut::clipboard(&chord, target_macos) {
                    self.locator_clipboard(selected, operation, context).await
                } else {
                    self.locator_element_script(
                        selected,
                        json!({"kind":"focus","requireEditable":false}),
                        resources,
                        Some(cancellation),
                    )
                    .await?;
                    self.locator_current(selected, context, Some(false)).await?;
                    self.locator_key(&chord, cancellation, Some(target_macos))
                        .await
                }
            }
            BrowserMutationOperation::PressSequentially { value, .. } => {
                self.locator_element_script(
                    selected,
                    json!({"kind":"focus","requireEditable":true}),
                    resources,
                    Some(cancellation),
                )
                .await?;
                let mut characters = value.chars().peekable();
                let mut progressed = false;
                while let Some(character) = characters.next() {
                    check_cancelled(cancellation, true)?;
                    if tokio::time::Instant::now() >= deadline {
                        return Err(ToolError::OutcomeUnknown(
                            "Sequential input deadline exceeded after focusing; do not replay"
                                .into(),
                        ));
                    }
                    self.locator_current(selected, context, Some(true)).await.map_err(|error| {
                        if progressed && matches!(error,ToolError::Failed(_)) {ToolError::OutcomeUnknown(format!("{error}; sequential input was partially delivered; do not replay"))}else{error}
                    })?;
                    if let Some(key) = keyboard::character(character) {
                        self.locator_key(
                            &keyboard::Chord {
                                modifiers: Vec::new(),
                                key,
                                mask: 0,
                            },
                            cancellation,
                            None,
                        )
                        .await?;
                    } else {
                        self.frame_request(
                            None,
                            "Input.insertText",
                            json!({"text":character.to_string()}),
                        )
                        .await?;
                    }
                    progressed = true;
                    if characters.peek().is_some() {
                        tokio::select! {
                            biased;
                            ()=cancellation.cancelled()=>return Err(ToolError::OutcomeUnknown("Sequential input cancelled after dispatch; do not replay".into())),
                            ()=tokio::time::sleep(Duration::from_millis(50))=>{},
                        }
                    }
                }
                Ok(())
            }
        }
    }

    async fn locator_key_event(
        &self,
        key: &keyboard::KeyDescription,
        down: bool,
        modifiers: u32,
        repeat: bool,
        commands: &[&str],
    ) -> Result<(), ToolError> {
        let mut event = json!({
            "type":if down && key.text.is_empty() {"rawKeyDown"}else if down {"keyDown"}else{"keyUp"},
            "key":key.key,"code":key.code,"windowsVirtualKeyCode":key.key_code,
            "modifiers":modifiers,"location":key.location,"isKeypad":key.location==3,"autoRepeat":repeat,
        });
        if down {
            event["text"] = json!(key.text);
            event["unmodifiedText"] = json!(key.text);
            if !commands.is_empty() {
                event["commands"] = json!(commands);
            }
        }
        self.frame_request(None, "Input.dispatchKeyEvent", event)
            .await?;
        Ok(())
    }

    async fn locator_key(
        &self,
        chord: &keyboard::Chord,
        cancellation: &CancellationToken,
        target_macos: Option<bool>,
    ) -> Result<(), ToolError> {
        let mut down = Vec::new();
        let mut modifiers = 0;
        let result = async {
            for (index, key) in chord
                .modifiers
                .iter()
                .chain(std::iter::once(&chord.key))
                .enumerate()
            {
                check_cancelled(cancellation, !down.is_empty())?;
                if index == chord.modifiers.len() {
                    modifiers = chord.mask;
                }
                modifiers |= key.modifier_mask();
                let repeat = down
                    .iter()
                    .any(|pressed: &&keyboard::KeyDescription| pressed.code == key.code);
                // Even an unknown key-down reply requires an attempted release.
                down.push(key);
                let commands = target_macos
                    .map(|mac| {
                        shortcut::edit_commands(
                            &keyboard::Chord {
                                modifiers: Vec::new(),
                                key: key.clone(),
                                mask: modifiers,
                            },
                            mac,
                        )
                    })
                    .unwrap_or_default();
                self.locator_key_event(key, true, modifiers, repeat, &commands)
                    .await?;
            }
            Ok::<_, ToolError>(())
        }
        .await;
        let mut cleanup = None;
        for key in down.into_iter().rev() {
            modifiers &= !key.modifier_mask();
            if let Err(error) = self
                .locator_key_event(&key.for_modifiers(modifiers), false, modifiers, false, &[])
                .await
            {
                cleanup = Some(error);
            }
        }
        if let Some(error) = cleanup {
            return Err(ToolError::CleanupUnconfirmed(format!(
                "locator key release was not acknowledged: {error}"
            )));
        }
        result
    }

    async fn locator_click(
        &self,
        point: [f64; 2],
        options: &BrowserClickOptions,
        count: u32,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        let keys = keyboard::mouse_modifiers(&options.modifiers)?;
        let button = match options.button.unwrap_or_default() {
            BrowserMouseButton::Left => "left",
            BrowserMouseButton::Right => "right",
            BrowserMouseButton::Middle => "middle",
        };
        let mut down = Vec::new();
        let mut modifiers = 0;
        let result = async {
            for key in &keys {
                check_cancelled(cancellation, !down.is_empty())?;
                modifiers |= key.modifier_mask();
                down.push(key);
                self.locator_key_event(key, true, modifiers, false, &[]).await?;
            }
            check_cancelled(cancellation, !down.is_empty())?;
            self.frame_request(None,"Input.dispatchMouseEvent",json!({"type":"mouseMoved","x":point[0],"y":point[1],"modifiers":modifiers})).await?;
            for click_count in 1..=count {
                check_cancelled(cancellation, true)?;
                let pressed=self.frame_request(None,"Input.dispatchMouseEvent",json!({"type":"mousePressed","x":point[0],"y":point[1],"button":button,"clickCount":click_count,"modifiers":modifiers})).await;
                let released=self.frame_request(None,"Input.dispatchMouseEvent",json!({"type":"mouseReleased","x":point[0],"y":point[1],"button":button,"clickCount":click_count,"modifiers":modifiers})).await;
                released.map_err(|error|ToolError::CleanupUnconfirmed(format!("locator mouse release was not acknowledged: {error}")))?;
                pressed?;
            }
            Ok(())
        }.await;
        let mut cleanup = None;
        for key in down.into_iter().rev() {
            modifiers &= !key.modifier_mask();
            if let Err(error) = self
                .locator_key_event(&key.for_modifiers(modifiers), false, modifiers, false, &[])
                .await
            {
                cleanup = Some(error);
            }
        }
        if let Some(error) = cleanup {
            return Err(ToolError::CleanupUnconfirmed(format!(
                "locator click modifier release was not acknowledged: {error}"
            )));
        }
        result
    }
}

#[cfg(test)]
mod accessibility_keyboard_tests {
    use super::*;

    #[test]
    fn raw_ax_modifier_suffixes_and_function_keys_use_existing_layout() {
        for (input, code) in [
            ("Alt", "AltLeft"),
            ("Control", "ControlLeft"),
            ("Meta", "MetaLeft"),
            ("Super", "MetaLeft"),
            ("Shift", "ShiftLeft"),
        ] {
            for side in ['L', 'R'] {
                let value = accessibility_key_names(&format!("{input}_{side}+F_12"));
                let chord = Tab::locator_chord(&value, false).unwrap();
                assert_eq!(chord.modifiers.len(), 1);
                assert_eq!(chord.modifiers[0].code, code);
                assert_eq!(chord.key.code, "F12");
            }
        }
        assert_eq!(accessibility_key_names("ControlLeft++"), "ControlLeft++");
        assert_eq!(accessibility_key_names("_"), "_");
        assert_eq!(accessibility_key_names("Page_Down"), "PageDown");
        assert!(
            Tab::locator_chord("Control_L+F12", false).is_err(),
            "raw AX adaptation must not silently change locator names"
        );
    }
}
