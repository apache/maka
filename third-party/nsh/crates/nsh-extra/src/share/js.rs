//! `Share`'s JS face (TS: `import { Share } from "nsh-extra"`), named as
//! its TypeScript types (`ShareContent`, `ShareResult`, `ShareAction`).

use nsh_core::{element::NodeRef, prelude::*};

use super::{MAX_FILES, MAX_TEXT_BYTES, MAX_URL_BYTES, NOT_GRANTED, ShareRequest};

/// The system's share sheet. Needs the `share` capability when the app
/// declares capabilities (else `show` rejects with `ERR_ACCESS_DENIED`);
/// each file is checked against `capabilities.fs.read` as `fs/promises`
/// reads it.
#[module]
pub(crate) struct Share;

#[module]
impl Share {
    /// Resolves with whether the share sheet shows here: on iOS, Android,
    /// macOS and in browsers with `navigator.share`, when the `share`
    /// capability is granted; `false` elsewhere, where `show` rejects with
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
    pub(crate) async fn available() -> bool {
        super::available().await
    }

    /// Shows the system's share sheet for `content`: its text, its link
    /// and its local files (absolute paths, or `${dataDir}/…`), with its
    /// title as a mail's subject where the target takes one. On an iPad and
    /// on macOS the sheet points at `anchor` (a `ref`), else at the middle
    /// of the window. Resolves with `{ action: "shared", target }` once the
    /// user shared (the target finished, on iOS and macOS; the user chose
    /// an app, on Android; `target` names it where the platform tells,
    /// else `null`), or `{ action: "dismissed", target: null }` when they
    /// closed the sheet or a later `show` replaced it. Rejects with a
    /// `TypeError` for content with nothing to share (empty text is none)
    /// or a URL that is not shared (`file:`, `javascript:`, relative), a
    /// `RangeError` for content over the limits (1 MiB of text, 16 KiB of
    /// URL, 100 files), `ERR_ACCESS_DENIED` when the
    /// `share` capability or a file's `fs.read` grant is missing, `ENOENT`
    /// for a file that does not exist, `EISDIR` for a folder, and
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the platform has no
    /// share sheet, or none for this content (a file outside an Android
    /// app's own storage, a file a browser does not share).
    pub(crate) fn show(content: ShareContent, sys: System) -> Result<Later<ShareResult>, JsError> {
        if !sys.access.allows_share() {
            return Err(JsError::access_denied(NOT_GRANTED, "share", ""));
        }
        let request = content.request(&sys)?;
        Ok(Later::new(async move {
            match super::show(request).await {
                Ok(outcome) => Ok(ShareResult {
                    action: match outcome.action {
                        super::ShareAction::Dismissed => ShareAction::Dismissed,
                        _ => ShareAction::Shared,
                    },
                    target: outcome.target,
                }),
                Err(error) => Err(error.to_js()),
            }
        }))
    }
}

/// What `Share.show` shares: at least one of `text`, `url` and `files`.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct ShareContent {
    /// A title for what is shared: a mail's subject, the sheet's heading
    /// where the platform shows one.
    title: Option<String>,
    /// Text to share.
    text: Option<String>,
    /// A link to share (absolute; `https:`, `mailto:`, an app's scheme).
    url: Option<String>,
    /// Local files to share: absolute paths or `${dataDir}/…`, each granted
    /// by `capabilities.fs.read`.
    files: Option<Vec<String>>,
    /// The view the sheet points at where it shows as a popover (iPad,
    /// macOS; a `ref`); the middle of the window when not given.
    anchor: Option<NodeRef>,
}

impl ShareContent {
    /// Content of only `files`, as an app passes them.
    #[cfg(test)]
    pub(super) fn files(files: &[&str]) -> Self {
        Self {
            files: Some(files.iter().map(|file| (*file).to_owned()).collect()),
            ..Self::default()
        }
    }

    /// The request this content makes, its files granted and resolved, or
    /// why it makes none.
    pub(super) fn request(self, sys: &System) -> Result<ShareRequest, JsError> {
        let files = self.files.unwrap_or_default();
        if files.len() > MAX_FILES {
            return Err(JsError::Range(format!("share: at most {MAX_FILES} files")));
        }
        for (name, value) in [("title", &self.title), ("text", &self.text)] {
            if value.as_ref().is_some_and(|v| v.len() > MAX_TEXT_BYTES) {
                return Err(JsError::Range(format!(
                    "share: `{name}` has at most {MAX_TEXT_BYTES} bytes"
                )));
            }
        }
        if self
            .url
            .as_ref()
            .is_some_and(|url| url.len() > MAX_URL_BYTES)
        {
            return Err(JsError::Range(format!(
                "share: `url` has at most {MAX_URL_BYTES} bytes"
            )));
        }
        let mut request = ShareRequest {
            title: self.title,
            text: self.text,
            url: self.url,
            anchor: self.anchor.map(|node| node.0),
            ..ShareRequest::default()
        };
        for file in &files {
            request.files.push(sys.readable_file(file)?);
        }
        request.check().map_err(JsError::Type)?;
        Ok(request)
    }
}

/// What the user did with the share sheet.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub(crate) enum ShareAction {
    /// They shared (see `Share.show`).
    Shared,
    /// They closed the sheet without sharing.
    #[default]
    Dismissed,
}

/// How `Share.show` ended.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct ShareResult {
    /// `"shared"` or `"dismissed"`.
    action: ShareAction,
    /// Where it was shared, where the platform tells (iOS's activity type,
    /// Android's package, macOS's service); `null` elsewhere and when
    /// dismissed.
    target: Option<String>,
}
