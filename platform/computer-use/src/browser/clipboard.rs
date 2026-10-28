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

//! Virtual clipboard values and atomic memory operations. One backend API
//! context owns one store. Page bindings, origin admission, and transactions
//! spanning page effects belong to the adapter; this core performs no CDP or
//! native clipboard operations.

use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
#[cfg(any(feature = "native-desktop", test))]
use tokio::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PresentationStyle {
    Unspecified,
    Inline,
    Attachment,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum Payload {
    Text { text: String },
    Base64 { base64: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "EntryInput")]
pub struct Entry {
    mime_type: String,
    #[serde(flatten)]
    payload: Payload,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntryInput {
    mime_type: String,
    #[serde(default, deserialize_with = "present")]
    text: Option<String>,
    #[serde(default, deserialize_with = "present")]
    base64: Option<String>,
}

// The public schema permits omission, but rejects a present null value.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl TryFrom<EntryInput> for Entry {
    type Error = ValidationError;

    fn try_from(input: EntryInput) -> Result<Self, Self::Error> {
        let payload = match (input.text, input.base64) {
            (Some(text), None) => Payload::Text { text },
            (None, Some(base64)) => Payload::Base64 { base64 },
            _ => return Err(ValidationError::Payload),
        };
        Self::new(input.mime_type, payload)
    }
}

impl Entry {
    pub fn new(mime_type: String, payload: Payload) -> Result<Self, ValidationError> {
        if mime_type.is_empty() {
            return Err(ValidationError::MimeType);
        }
        if let Payload::Base64 { base64 } = &payload
            && !valid_base64(base64)
        {
            return Err(ValidationError::Base64);
        }
        Ok(Self { mime_type, payload })
    }

    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub fn payload(&self) -> &Payload {
        &self.payload
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "ItemInput")]
pub struct Item {
    entries: Vec<Entry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    presentation_style: Option<PresentationStyle>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ItemInput {
    entries: Vec<Entry>,
    #[serde(default, deserialize_with = "present")]
    presentation_style: Option<PresentationStyle>,
}

impl TryFrom<ItemInput> for Item {
    type Error = ValidationError;

    fn try_from(input: ItemInput) -> Result<Self, Self::Error> {
        Self::new(input.entries, input.presentation_style)
    }
}

impl Item {
    pub fn new(
        entries: Vec<Entry>,
        presentation_style: Option<PresentationStyle>,
    ) -> Result<Self, ValidationError> {
        if entries.is_empty() {
            return Err(ValidationError::Entries);
        }
        Ok(Self {
            entries,
            presentation_style,
        })
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn presentation_style(&self) -> Option<PresentationStyle> {
        self.presentation_style
    }
}

/// A valid replacement. An initially empty clipboard is readable, but an empty
/// replacement is not a valid write.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Items(Vec<Item>);

impl Items {
    #[cfg(any(feature = "native-desktop", test))]
    pub(crate) fn text(text: String) -> Self {
        Self(vec![Item {
            entries: vec![Entry {
                mime_type: "text/plain".into(),
                payload: Payload::Text { text },
            }],
            presentation_style: Some(PresentationStyle::Unspecified),
        }])
    }
    pub fn new(items: Vec<Item>) -> Result<Self, ValidationError> {
        if items.is_empty() {
            return Err(ValidationError::Items);
        }
        Ok(Self(items))
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) fn into_vec(self) -> Vec<Item> {
        self.0
    }
}

impl<'de> Deserialize<'de> for Items {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(Vec::<Item>::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValidationError {
    Items,
    Entries,
    MimeType,
    Payload,
    Base64,
}

impl fmt::Display for ValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Items => "clipboard write requires at least one item",
            Self::Entries => "clipboard item requires at least one entry",
            Self::MimeType => "clipboard entry requires a nonempty MIME type",
            Self::Payload => "clipboard entry requires exactly one text or base64 payload",
            Self::Base64 => "clipboard entry contains invalid base64",
        })
    }
}

impl std::error::Error for ValidationError {}

// HTML's forgiving base64 grammar, as used by atob: five ASCII whitespace
// bytes are ignored, padding is optional but must complete a quartet, and
// unused low bits need not be zero. Validation preserves the original payload.
fn valid_base64(input: &str) -> bool {
    let mut symbols = 0usize;
    let mut padding = 0usize;
    for byte in input.bytes() {
        match byte {
            b' ' | b'\t' | b'\n' | b'\r' | 0x0c => continue,
            b'=' => padding += 1,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' if padding == 0 => {}
            _ => return false,
        }
        symbols += 1;
    }
    if padding == 0 {
        symbols % 4 != 1
    } else {
        padding <= 2 && symbols.is_multiple_of(4)
    }
}

#[derive(Default)]
#[cfg(any(feature = "native-desktop", test))]
pub(crate) struct Store {
    items: Mutex<Vec<Item>>,
}

#[cfg(any(feature = "native-desktop", test))]
impl Store {
    #[cfg(feature = "native-desktop")]
    pub(crate) async fn access<R>(&self, operation: impl FnOnce(&mut Vec<Item>) -> R) -> R {
        operation(&mut *self.items.lock().await)
    }
    #[cfg(feature = "native-desktop")]
    pub(crate) fn try_access(&self) -> Option<tokio::sync::MutexGuard<'_, Vec<Item>>> {
        self.items.try_lock().ok()
    }
    #[cfg(feature = "native-desktop")]
    pub(crate) async fn wait_available(&self) {
        drop(self.items.lock().await);
    }
    #[cfg(test)]
    pub async fn read(&self) -> Vec<Item> {
        self.items.lock().await.clone()
    }

    #[cfg(test)]
    pub async fn read_text(&self) -> String {
        let items = self.items.lock().await;
        match items
            .iter()
            .flat_map(|item| &item.entries)
            .find(|entry| entry.mime_type == "text/plain")
            .map(|entry| &entry.payload)
        {
            Some(Payload::Text { text }) => text.clone(),
            Some(Payload::Base64 { .. }) | None => String::new(),
        }
    }

    #[cfg(test)]
    pub async fn write(&self, items: Items) {
        *self.items.lock().await = items.0;
    }

    #[cfg(test)]
    pub async fn write_text(&self, text: String) {
        *self.items.lock().await = Items::text(text).0;
    }

    pub async fn clear(&self) {
        self.items.lock().await.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::{future::Future, task::Poll};

    fn items(value: Value) -> Items {
        serde_json::from_value(value).unwrap()
    }

    #[tokio::test]
    async fn text_roundtrip_preserves_empty_unicode_and_read_independence() {
        let store = Store::default();
        assert!(store.read().await.is_empty());
        assert_eq!(store.read_text().await, "");
        for text in ["", "Café 日本語 🐧\n\0", "plain text"] {
            store.write_text(text.into()).await;
            assert_eq!(store.read_text().await, text);
            let mut copy = store.read().await;
            assert_eq!(
                serde_json::to_value(&copy).unwrap(),
                json!([{"entries":[{"mimeType":"text/plain","text":text}],"presentationStyle":"unspecified"}])
            );
            copy[0].entries.clear();
            assert_eq!(store.read_text().await, text);
            assert_eq!(store.read().await[0].entries().len(), 1);
        }
    }

    #[tokio::test]
    async fn rich_roundtrip_preserves_order_styles_payload_and_first_plain_entry() {
        let store = Store::default();
        let value = json!([
            {"entries":[{"mimeType":" text/PLAIN ","text":"not normalized"},{"mimeType":"text/html","text":"<b>hello</b>"}],"presentationStyle":"inline"},
            {"entries":[{"mimeType":"image/png","base64":"Z \ti=="},{"mimeType":"text/plain","base64":"Zmlyc3Q"}],"presentationStyle":"attachment"},
            {"entries":[{"mimeType":"text/plain","text":"later plain text"},{"mimeType":"text/plain","text":"duplicate MIME is allowed"}]}
        ]);
        store.write(items(value.clone())).await;
        assert_eq!(serde_json::to_value(store.read().await).unwrap(), value);
        assert_eq!(store.read_text().await, "");
        let read = store.read().await;
        assert_eq!(read[0].entries()[0].mime_type(), " text/PLAIN ");
        assert_eq!(
            read[0].presentation_style(),
            Some(PresentationStyle::Inline)
        );
        assert_eq!(
            read[1].entries()[0].payload(),
            &Payload::Base64 {
                base64: "Z \ti==".into()
            }
        );
        store
            .write(items(json!([{"entries":[{"mimeType":"text/plain","text":""},{"mimeType":"text/plain","text":"later"}]}])))
            .await;
        assert_eq!(store.read_text().await, "");
    }

    #[tokio::test]
    async fn invalid_replacements_leave_existing_data_unchanged() {
        let store = Store::default();
        store.write_text("existing".into()).await;
        let original = store.read().await;
        for value in [
            json!(null),
            json!({}),
            json!([]),
            json!([null]),
            json!([{}]),
            json!([{"entries":[]}]),
            json!([{"entries":[{"text":"x"}]}]),
            json!([{"entries":[{"mimeType":"","text":"x"}]}]),
            json!([{"entries":[{"mimeType":"text/plain"}]}]),
            json!([{"entries":[{"mimeType":"text/plain","text":"x","base64":"eA=="}]}]),
            json!([{"entries":[{"mimeType":"text/plain","text":null}]}]),
            json!([{"entries":[{"mimeType":"text/plain","text":"x","base64":null}]}]),
            json!([{"entries":[{"mimeType":"text/plain","text":3}]}]),
            json!([{"entries":[{"mimeType":"text/plain","base64":"A"}]}]),
            json!([{"entries":[{"mimeType":"text/plain","text":"x"}],"presentationStyle":null}]),
            json!([{"entries":[{"mimeType":"text/plain","text":"x"}],"presentationStyle":"INLINE"}]),
        ] {
            assert!(
                serde_json::from_value::<Items>(value.clone()).is_err(),
                "{value}"
            );
            assert_eq!(store.read().await, original);
        }
        let value =
            items(json!([{"entries":[{"mimeType":" ","text":"","ignored":true}],"ignored":true}]));
        assert_eq!(
            serde_json::to_value(value).unwrap(),
            json!([{"entries":[{"mimeType":" ","text":""}]}])
        );
    }

    #[test]
    fn base64_acceptance_matches_observed_atob_boundaries() {
        for (input, accepted) in [
            ("", true),
            (" ", true),
            ("A", false),
            ("AA", true),
            ("AAA", true),
            ("AAAA", true),
            ("AA=", false),
            ("AA==", true),
            ("AA===", false),
            ("AAA=", true),
            ("AAA==", false),
            ("AAAA=", false),
            ("A===", false),
            ("=", false),
            ("====", false),
            ("Zg", true),
            ("Zh", true),
            ("Zi", true),
            ("Zg==", true),
            ("Zh==", true),
            ("Z i==", true),
            ("Z\t\ni\r\x0c==", true),
            ("Zg\x0b==", false),
            ("Zg\u{a0}==", false),
            ("Zg===", false),
            ("Zg=", false),
            ("Zg==A", false),
            ("__8=", false),
            ("//9=", true),
            ("AA\0==", false),
            ("π", false),
        ] {
            assert_eq!(valid_base64(input), accepted, "{input:?}");
        }
    }

    #[tokio::test]
    async fn queued_reads_and_writes_are_ordered_and_new_stores_are_independent() {
        let store = Store::default();
        let held = store.items.lock().await;
        let mut first = Box::pin(store.write_text("first".into()));
        let mut read = Box::pin(store.read_text());
        let mut second = Box::pin(store.write_text("second".into()));
        std::future::poll_fn(|context| {
            assert!(first.as_mut().poll(context).is_pending());
            assert!(read.as_mut().poll(context).is_pending());
            assert!(second.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(held);
        first.await;
        assert_eq!(read.await, "first");
        second.await;
        assert_eq!(store.read_text().await, "second");
        let replacement = Store::default();
        assert!(replacement.read().await.is_empty());
        store.clear().await;
        assert!(store.read().await.is_empty());
    }
}
