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

use maka_agent_facts::tools::ToolError;
use objc2::runtime::ProtocolObject;
use objc2_app_kit::{NSPasteboard, NSPasteboardItem, NSPasteboardWriting};
use objc2_foundation::{NSArray, NSData, NSString};

type Items = Vec<Vec<(String, Vec<u8>)>>;
const OWNER: &str = "org.apache.maka.cua-paste.owner";
pub(crate) struct Restore {
    items: Items,
    change: isize,
    marker: String,
    armed: bool,
}

pub(crate) fn replace(text: &str, html: bool) -> Result<Restore, ToolError> {
    let pasteboard = NSPasteboard::generalPasteboard();
    let before = pasteboard.changeCount();
    let mut items = Vec::new();
    let mut bytes = 0;
    if let Some(current) = pasteboard.pasteboardItems() {
        for item in current.iter() {
            let mut formats = Vec::new();
            for kind in item.types().iter() {
                let data = item
                    .dataForType(&kind)
                    .ok_or_else(|| failed("clipboard content could not be preserved"))?;
                bytes += data.length();
                if bytes > 16 * 1024 * 1024 {
                    return Err(failed(
                        "clipboard preservation exceeds 16 MiB; use typeText",
                    ));
                }
                formats.push((kind.to_string(), data.to_vec()));
            }
            items.push(formats);
        }
    }
    if pasteboard.changeCount() != before {
        return Err(failed(
            "clipboard changed during capture; paste was not started",
        ));
    }
    let marker = uuid::Uuid::new_v4().to_string();
    // NSPasteboard's HTML importer otherwise guesses a legacy encoding for
    // fragments. The bridge's strings are UTF-8, including non-Latin text.
    let data = if html {
        format!("<meta charset=\"utf-8\">{text}").into_bytes()
    } else {
        text.as_bytes().to_vec()
    };
    let item = vec![vec![
        (
            if html {
                "public.html"
            } else {
                "public.utf8-plain-text"
            }
            .into(),
            data,
        ),
        (OWNER.into(), marker.as_bytes().to_vec()),
    ]];
    if let Err(error) = write(&pasteboard, &item) {
        write(&pasteboard, &items).map_err(|restore| {
            ToolError::CleanupUnconfirmed(format!(
                "clipboard write failed ({error}); restoration failed ({restore})"
            ))
        })?;
        return Err(error);
    }
    Ok(Restore {
        items,
        change: pasteboard.changeCount(),
        marker,
        armed: true,
    })
}
impl Restore {
    /// Preserve an intervening user/application copy rather than overwriting it.
    pub(crate) fn restore(mut self) -> Result<bool, ToolError> {
        self.finish()
    }
    fn finish(&mut self) -> Result<bool, ToolError> {
        self.armed = false;
        let pasteboard = NSPasteboard::generalPasteboard();
        if pasteboard.changeCount() != self.change
            || pasteboard
                .dataForType(&NSString::from_str(OWNER))
                .is_none_or(|data| data.to_vec() != self.marker.as_bytes())
        {
            return Ok(false);
        }
        write(&pasteboard, &self.items).map_err(|error| {
            ToolError::CleanupUnconfirmed(format!("clipboard restoration failed: {error}"))
        })?;
        Ok(true)
    }
}
impl Drop for Restore {
    fn drop(&mut self) {
        if self.armed
            && let Err(error) = self.finish()
        {
            eprintln!("Computer Use clipboard cleanup failed: {error}");
        }
    }
}
fn write(pasteboard: &NSPasteboard, items: &Items) -> Result<(), ToolError> {
    let mut objects = Vec::new();
    for formats in items {
        let item = NSPasteboardItem::new();
        for (kind, bytes) in formats {
            let data = NSData::with_bytes(bytes);
            if !item.setData_forType(&data, &NSString::from_str(kind)) {
                return Err(failed("clipboard format could not be written"));
            }
        }
        objects.push(ProtocolObject::<dyn NSPasteboardWriting>::from_retained(
            item,
        ));
    }
    pasteboard.clearContents();
    if !objects.is_empty() && !pasteboard.writeObjects(&NSArray::from_retained_slice(&objects)) {
        return Err(failed("clipboard write was refused"));
    }
    Ok(())
}
fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
