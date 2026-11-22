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

//! Keyboard clipboard actions use the same virtual store as browser page APIs.

use super::*;

const CLIPBOARD: &str = include_str!("clipboard.js");

async fn lock<'a>(
    store: &'a crate::browser_clipboard::Store,
    context: &MutationContext<'_>,
) -> Result<tokio::sync::MutexGuard<'a, Vec<ClipboardItem>>, ToolError> {
    loop {
        check_input(context.cancellation)?;
        if let Some(items) = store.try_access() {
            return Ok(items);
        }
        tokio::select! {
            biased;
            ()=context.cancellation.cancelled()=>return Err(failed("Browser clipboard cancelled")),
            ()=context.clock.elapsed()=>return Err(failed("Browser clipboard deadline exceeded")),
            ()=store.wait_available()=>{},
        }
    }
}

pub(super) enum VirtualTextMode {
    Locator { replace: bool },
    Cua { rich: bool },
}

impl Tab {
    pub(super) async fn locator_virtual_text(
        &mut self,
        selected: &Selected,
        value: &str,
        replace: bool,
        context: &MutationContext<'_>,
    ) -> Result<(), ToolError> {
        let items = ClipboardItems::text(value.to_owned());
        self.locator_virtual_items(
            selected,
            &items,
            VirtualTextMode::Locator { replace },
            context,
        )
        .await
    }

    pub(super) async fn locator_virtual_items(
        &mut self,
        selected: &Selected,
        items: &ClipboardItems,
        mode: VirtualTextMode,
        context: &MutationContext<'_>,
    ) -> Result<(), ToolError> {
        let (plain_text_only, replace, rich_text_fallback) = match mode {
            VirtualTextMode::Locator { replace } => (true, replace, false),
            VirtualTextMode::Cua { rich } => (!rich, false, rich),
        };
        // The embedding Host supplies the same optional automatic page bridge
        // used by the explicit clipboard API. This admitted text command itself
        // owns its synchronous paste effect and never borrows the OS clipboard.
        if self.clipboard_authorization.is_some() && self.dialog_host.is_some() {
            let turn = self.last_turn.clone();
            self.ensure_clipboard_bridge(
                &turn,
                crate::browser::BrowserCall::new(
                    context.invocation,
                    context.cancellation,
                    context.language,
                ),
            )
            .await?;
        }
        let store = self.clipboard_store.clone();
        let _items = lock(&store, context).await?;
        self.locator_document_current(selected, context).await?;
        self.locator_clipboard_script(
            selected,
            json!({
                "kind":"paste","items":items,
                "plainTextOnly":plain_text_only,"replaceInputValue":replace,"currentActiveElement":true,
                "richTextFallback":rich_text_fallback,
            }),
            None,
            context,
        )
        .await?;
        Ok(())
    }

    async fn locator_clipboard_script(
        &self,
        selected: &Selected,
        request: Value,
        prepared: Option<&str>,
        context: &MutationContext<'_>,
    ) -> Result<Value, ToolError> {
        let engine = self
            .playwright_engine(&selected.frame, context.resources)
            .await?;
        let prepared = prepared
            .map(|object| json!({"objectId":object}))
            .unwrap_or_else(|| json!({"value":null}));
        if !self.frame_scopes_current(&selected.used).await? {
            return Err(failed("frame changed before clipboard effect"));
        }
        check_input(context.cancellation)?;
        context
            .resources
            .mutated
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let reply = self
            .frame_request(
                selected.frame.session.as_deref(),
                "Runtime.callFunctionOn",
                json!({
                    "objectId":engine,"functionDeclaration":CLIPBOARD,
                    "arguments":[{"objectId":selected.object},{"value":request},prepared],
                    "awaitPromise":true,"returnByValue":false,"objectGroup":context.resources.group,
                }),
            )
            .await?;
        cdp_value(reply)
    }

    pub(super) async fn locator_clipboard(
        &mut self,
        selected: &Selected,
        operation: shortcut::ClipboardShortcut,
        context: &MutationContext<'_>,
    ) -> Result<(), ToolError> {
        self.clipboard_operation(selected, operation, context, false)
            .await
    }

    pub(super) async fn locator_current_clipboard(
        &mut self,
        selected: &Selected,
        operation: shortcut::ClipboardShortcut,
        context: &MutationContext<'_>,
    ) -> Result<(), ToolError> {
        self.clipboard_operation(selected, operation, context, true)
            .await
    }

    async fn clipboard_operation(
        &mut self,
        selected: &Selected,
        operation: shortcut::ClipboardShortcut,
        context: &MutationContext<'_>,
        current_active: bool,
    ) -> Result<(), ToolError> {
        if matches!(operation, shortcut::ClipboardShortcut::Refuse) {
            return Err(failed(
                "Extension clipboard shortcuts are disabled; use Browser Use virtual clipboard commands instead.",
            ));
        }
        let turn = self.last_turn.clone();
        self.ensure_clipboard_bridge(
            &turn,
            crate::browser::BrowserCall::new(
                context.invocation,
                context.cancellation,
                context.language,
            ),
        )
        .await?;
        let store = self.clipboard_store.clone();
        let mut items = lock(&store, context).await?;
        if current_active {
            self.locator_document_current(selected, context).await?;
        } else {
            self.locator_current(selected, context, None).await?;
            self.locator_element_script(
                selected,
                json!({"kind":"focus","requireEditable":false}),
                context.resources,
                Some(context.cancellation),
            )
            .await?;
            self.locator_current(selected, context, Some(false)).await?;
        }
        match operation {
            shortcut::ClipboardShortcut::Paste { plain_text_only } => {
                if items.is_empty() {
                    return Err(failed("Browser Use virtual clipboard has no data to paste"));
                }
                self.locator_clipboard_script(
                    selected,
                    json!({"kind":"paste","items":&*items,"plainTextOnly":plain_text_only,"currentActiveElement":current_active}),
                    None,
                    context,
                )
                .await?;
            }
            shortcut::ClipboardShortcut::Copy | shortcut::ClipboardShortcut::Cut => {
                let cut = matches!(operation, shortcut::ClipboardShortcut::Cut);
                let prepared = self
                    .locator_clipboard_script(
                        selected,
                        json!({"kind":if cut {"cut"}else{"copy"},"currentActiveElement":current_active}),
                        None,
                        context,
                    )
                    .await?;
                let object = prepared["objectId"]
                    .as_str()
                    .ok_or_else(|| failed("virtual clipboard preparation is unavailable"))?;
                let reply = self.frame_observation(selected.frame.session.as_deref(),"Runtime.callFunctionOn",json!({
                    "objectId":object,"functionDeclaration":"function(){return {items:this.items??null,hasCut:!!this.cut};}",
                    "returnByValue":true,"objectGroup":context.resources.group,
                })).await?;
                let capture = cdp_value(reply)?["value"].clone();
                let replacement = capture["items"].clone();
                if !replacement.is_null() {
                    let replacement: ClipboardItems =
                        serde_json::from_value(replacement).map_err(failed)?;
                    check_cancelled(context.cancellation, true)?;
                    *items = replacement.into_vec();
                    if cut && capture["hasCut"] == true {
                        // The record belongs to this invocation's object group.
                        // Commit never re-resolves a selector or another target.
                        self.locator_clipboard_script(
                            selected,
                            json!({"kind":"commitCut"}),
                            Some(object),
                            context,
                        )
                        .await?;
                    }
                }
            }
            shortcut::ClipboardShortcut::Refuse => unreachable!("refused before clipboard access"),
        }
        Ok(())
    }
}
