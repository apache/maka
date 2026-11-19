//! A clipboard of the embedder's own: when the core has one
//! ([`crate::Core::set_clipboard`]), the app's clipboard calls (`nsh/base`'s
//! `Clipboard`, `setString`, `getString`, `hasString`) are served from it
//! rather than the system's, so that a test's clipboard is its own and the
//! machine's stays as it was (`nsh test --target`). Text inputs' own copy
//! and paste stay the system's.

use std::sync::Mutex;

use crate::element::ClipboardItem;

/// What the app's clipboard calls keep.
pub trait ClipboardBackend: Send + Sync {
    /// The text it holds.
    fn text(&self) -> Option<String>;
    /// Holds `text` from now on, alone (`None`: nothing).
    fn set_text(&self, text: Option<String>);
    /// The item it holds (`Clipboard.write`), every format it keeps; a
    /// backend that keeps text only holds an item of its text.
    fn item(&self) -> Option<ClipboardItem> {
        self.text().map(|text| ClipboardItem { text, html: None })
    }
    /// Holds `item` from now on (`None`: nothing, as after an image was
    /// copied, which the backend does not keep). A backend that keeps text
    /// only keeps the item's text.
    fn set_item(&self, item: Option<ClipboardItem>) {
        self.set_text(item.map(|item| item.text));
    }
}

/// A clipboard in memory.
#[derive(Debug, Default)]
pub struct MemoryClipboard {
    item: Mutex<Option<ClipboardItem>>,
}

impl MemoryClipboard {
    /// A clipboard holding `text` at first.
    pub fn new(text: Option<String>) -> MemoryClipboard {
        MemoryClipboard {
            item: Mutex::new(text.map(|text| ClipboardItem { text, html: None })),
        }
    }
}

impl ClipboardBackend for MemoryClipboard {
    fn text(&self) -> Option<String> {
        self.item().map(|item| item.text)
    }

    fn set_text(&self, text: Option<String>) {
        self.set_item(text.map(|text| ClipboardItem { text, html: None }));
    }

    fn item(&self) -> Option<ClipboardItem> {
        self.item.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set_item(&self, item: Option<ClipboardItem>) {
        *self.item.lock().unwrap_or_else(|e| e.into_inner()) = item;
    }
}
