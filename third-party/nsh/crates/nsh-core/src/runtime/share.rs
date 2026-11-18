//! `nsh`'s `Share`: the system's share sheet ([`crate::share`]). The app
//! hands it text, a link or local files and the user picks where they go.
//! Needs the `share` capability when the app declares capabilities (else
//! `show` rejects with `ERR_ACCESS_DENIED`); each file is checked against
//! `capabilities.fs.read` as `fs/promises` reads it.

use crate::{
    element::{JsError, JsObject, Later, NodeRef, PropEnum, System, codes, module},
    share::{ShareError, ShareRequest},
};

/// The system's share sheet.
#[module]
pub(crate) struct Share;

#[module]
impl Share {
    /// Resolves with whether the share sheet shows here: on iOS, Android,
    /// macOS and in browsers with `navigator.share`, when the `share`
    /// capability is granted; `false` elsewhere, where `show` rejects with
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.
    pub(crate) fn available() -> Later<bool> {
        Later::new(async { Ok::<_, JsError>(crate::prelude::share_available().await) })
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
    /// for a file that does not exist, and
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the platform has no
    /// share sheet, or none for this content (a file outside an Android
    /// app's own storage, a file a browser does not share).
    pub(crate) fn show(content: ShareContent, sys: System) -> Result<Later<ShareResult>, JsError> {
        if !sys.access.allows_share() {
            return Err(JsError::access_denied(
                crate::share::NOT_GRANTED,
                "share",
                "",
            ));
        }
        let request = content.request(&sys)?;
        Ok(Later::new(async move {
            match crate::prelude::share(request).await {
                Ok(outcome) => Ok(ShareResult {
                    action: match outcome.action {
                        crate::share::ShareAction::Dismissed => ShareAction::Dismissed,
                        _ => ShareAction::Shared,
                    },
                    target: outcome.target,
                }),
                Err(error) => Err(js_error(error)),
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
    /// The request this content makes, its files granted and resolved, or
    /// why it makes none.
    fn request(self, sys: &System) -> Result<ShareRequest, JsError> {
        let files = self.files.unwrap_or_default();
        if files.len() > crate::share::MAX_FILES {
            return Err(JsError::Range(format!(
                "share: at most {} files",
                crate::share::MAX_FILES
            )));
        }
        for (name, value) in [("title", &self.title), ("text", &self.text)] {
            if value
                .as_ref()
                .is_some_and(|v| v.len() > crate::share::MAX_TEXT_BYTES)
            {
                return Err(JsError::Range(format!(
                    "share: `{name}` has at most {} bytes",
                    crate::share::MAX_TEXT_BYTES
                )));
            }
        }
        if self
            .url
            .as_ref()
            .is_some_and(|url| url.len() > crate::share::MAX_URL_BYTES)
        {
            return Err(JsError::Range(format!(
                "share: `url` has at most {} bytes",
                crate::share::MAX_URL_BYTES
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
            request
                .files
                .push(crate::runtime::fs::shared_file(sys, file)?);
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

/// A failed share as JS gets it: an `Error` with the failure's `code`.
fn js_error(error: ShareError) -> JsError {
    match error.code.as_deref() {
        Some(codes::ACCESS_DENIED) => JsError::access_denied(error.message, "share", ""),
        Some(code) => JsError::Error(error.message.clone()).with_code(code),
        None => JsError::Error(error.message),
    }
}
