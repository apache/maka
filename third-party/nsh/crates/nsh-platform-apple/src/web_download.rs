//! A `WKWebView`'s downloads, shared by the macOS and iOS backends: WebKit's
//! `WKDownload` is the transfer, and the core decides every download's
//! destination, cancellation and lifetime.
//!
//! A navigation delegate turns a navigation into a download
//! ([`is_download`] for a response, [`should_download`] for an action) and
//! hands WebKit's `WKDownload` to [`Transport::adopt`]. WebKit then asks the
//! transport for a destination; the transport reports the offer
//! (`EventKind::DownloadOffer`) from that callback, where the response's MIME
//! type, declared size, final URL and suggested name are known, and holds
//! WebKit's completion handler until the core answers with
//! [`Transport::start`] (write into this path) or [`Transport::cancel`]
//! (write nothing). The finish and failure callbacks report
//! `EventKind::DownloadEnd`.
//!
//! This crate never decides a state, names a destination or touches a file
//! policy: staging and publication are `nsh-core`'s. It creates no file —
//! WebKit creates the staging leaf the core named — and it deletes none. The
//! only file system access is one `metadata` of a finished staging file, to
//! report its size.
//!
//! All callbacks arrive on the main thread, where the transport and its
//! `WKDownloadDelegate` live. Every native block holds only the transport's
//! state, never a host, and reports continue after the web view is released
//! (the core's teardown needs the stop confirmation to clean its staging
//! directory).

use std::{
    cell::RefCell,
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
};

use nsh_core::{
    EventKind, EventPayload,
    webview::{
        DownloadEnd, DownloadOffer, DownloadOutcome, WebDownloadSource, download_end,
        download_offer,
    },
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, NSObject, NSObjectProtocol},
};
use objc2_foundation::{NSData, NSError, NSString, NSURL, NSURLRequest, NSURLResponse};

/// Where a transport reports what WebKit did, as the core's internal
/// download events: the kind and the payload the core's constructor made.
/// The platform dispatches it to the web view's node (never to an app
/// listener), even after the view is released.
pub type Emit = Rc<dyn Fn(EventKind, EventPayload)>;

/// The `WKDownload`s of one web view, with WebKit's download delegate.
///
/// Made once per web view, on the main thread, and dropped with its host
/// (which stops everything through [`Self::cancel_all`]).
pub struct Transport {
    state: Rc<State>,
    delegate: Retained<DownloadDelegate>,
}

impl Transport {
    /// The transport of a web view, reporting through `emit`.
    pub fn new(mtm: MainThreadMarker, emit: Emit) -> Rc<Self> {
        let state = Rc::new(State {
            emit,
            active: RefCell::new(HashMap::new()),
        });
        let delegate = DownloadDelegate::new(mtm, state.clone());
        Rc::new(Self { state, delegate })
    }

    /// Takes `download` as this view's: from now on the delegate reports
    /// its offer when WebKit asks for a destination. A download already
    /// adopted is left as it is.
    pub fn adopt(&self, download: &AnyObject) {
        let key = download_key(download);
        if self.state.active.borrow().contains_key(&key) {
            return;
        }
        // SAFETY: `download` is a live WKDownload; the transport's delegate
        // outlives the download (the host keeps both).
        let _: () = unsafe { msg_send![download, setDelegate: &*self.delegate] };
        // SAFETY: WKDownload's and NSURLRequest's documented API.
        let (id, url, method) = unsafe {
            let uuid: Retained<AnyObject> =
                msg_send![AnyClass::get(c"NSUUID").expect("Foundation"), UUID];
            let id: Retained<NSString> = msg_send![&uuid, UUIDString];
            let request: Option<Retained<NSURLRequest>> = msg_send![download, originalRequest];
            let url = request
                .as_ref()
                .and_then(|r| r.URL())
                .and_then(|u| u.absoluteString())
                .map(|s| s.to_string())
                .unwrap_or_default();
            let method = request
                .as_ref()
                .and_then(|r| r.HTTPMethod())
                .map(|m| m.to_string());
            (id.to_string().to_lowercase(), url, method)
        };
        // SAFETY: `download` is a live WKDownload this transport delegates.
        let Some(download) =
            (unsafe { Retained::retain(download as *const AnyObject as *mut AnyObject) })
        else {
            return;
        };
        self.state.active.borrow_mut().insert(
            key,
            Entry {
                download,
                id,
                url,
                method,
                offered: false,
                decide: None,
                staging: None,
            },
        );
    }

    /// Starts download `id` into `staging`: WebKit writes the file itself,
    /// so `staging` must not exist yet (the core owns the directory and the
    /// path's uniqueness). Answers once WebKit accepted the destination.
    pub fn start(&self, id: &str, staging: &Path) -> Result<(), String> {
        let decide = {
            let mut active = self.state.active.borrow_mut();
            let entry = active
                .values_mut()
                .find(|entry| entry.id == id)
                .ok_or_else(|| format!("no download with id `{id}`"))?;
            if entry.staging.is_some() {
                return Err(format!("download `{id}` is already started"));
            }
            let decide = entry
                .decide
                .take()
                .ok_or_else(|| format!("download `{id}` has not asked for a destination yet"))?;
            entry.staging = Some(staging.to_path_buf());
            decide
        };
        // Outside the borrow: WebKit may call back while the decision runs.
        // Its return is the native acceptance the core waits for.
        let destination = file_url(staging);
        decide.call(Some(&*destination));
        Ok(())
    }

    /// Stops download `id`; nothing it wrote may be published. `stopped`
    /// runs once WebKit has stopped writing (at once for a download that
    /// never had a writer), where the caller settles its request and the
    /// core may remove the staging directory.
    pub fn cancel(&self, id: &str, stopped: impl FnOnce() + 'static) -> Result<(), String> {
        let entry = self.take(id)?;
        match (entry.decide, entry.staging.is_some()) {
            // WebKit has not been told a destination yet: releasing the
            // decision cancels the download, and nothing was written.
            (Some(decide), _) => {
                decide.call(None);
                stopped();
            }
            // Writing: WebKit's completion says when it stopped. The
            // delegate is cleared first, so a failure callback from the
            // cancellation reports nothing (and no `DownloadEnd` follows
            // this reply).
            (None, true) => {
                // The block is an `Fn`: `stopped` is taken once.
                let stopped = RefCell::new(Some(stopped));
                let done = block2::RcBlock::new(move |_resume: *mut NSData| {
                    if let Some(stopped) = stopped.borrow_mut().take() {
                        stopped();
                    }
                });
                // SAFETY: the retained WKDownload is live, and its delegate
                // (this transport's) outlives the call.
                unsafe {
                    let _: () =
                        msg_send![&entry.download, setDelegate: std::ptr::null::<AnyObject>()];
                    let _: () = msg_send![&entry.download, cancel: &*done];
                }
            }
            // Nothing had a writer yet (no destination was accepted): the
            // transfer is discarded at once and its later destination, if
            // WebKit asks, is refused (the entry is gone).
            (None, false) => {
                let done = block2::RcBlock::new(|_resume: *mut NSData| {});
                // SAFETY: the retained WKDownload is live; the completion
                // block holds nothing.
                unsafe {
                    let _: () =
                        msg_send![&entry.download, setDelegate: std::ptr::null::<AnyObject>()];
                    let _: () = msg_send![&entry.download, cancel: &*done];
                }
                stopped();
            }
        }
        Ok(())
    }

    /// The web view is going: stops every writer. A transfer whose writer
    /// had begun is reported failed only when WebKit says writing stopped,
    /// so the core never removes a directory that is still being written;
    /// a held offer is reported stopped too: the core may already have
    /// staged its output while the start command is still queued.
    pub fn cancel_all(&self) {
        let entries = std::mem::take(&mut *self.state.active.borrow_mut());
        for entry in entries.into_values() {
            let started = entry.staging.is_some();
            match (entry.decide, started) {
                (Some(decide), _) => {
                    decide.call(None);
                    if entry.offered {
                        report_gone(&self.state, &entry.id);
                    }
                }
                (None, true) => {
                    // The stop confirmation outlives this transport: the
                    // block keeps the state (and its emit) and the native
                    // object alive until WebKit calls it.
                    let state = self.state.clone();
                    let id = entry.id.clone();
                    let download = entry.download.clone();
                    let done = block2::RcBlock::new(move |_resume: *mut NSData| {
                        let _ = &download;
                        report_gone(&state, &id);
                    });
                    // SAFETY: the retained WKDownload is live; the block
                    // holds what it needs.
                    unsafe {
                        let _: () =
                            msg_send![&entry.download, setDelegate: std::ptr::null::<AnyObject>()];
                        let _: () = msg_send![&entry.download, cancel: &*done];
                    }
                }
                (None, false) => {
                    // SAFETY: the retained WKDownload is live; the
                    // completion block holds nothing.
                    let done = block2::RcBlock::new(|_resume: *mut NSData| {});
                    unsafe {
                        let _: () =
                            msg_send![&entry.download, setDelegate: std::ptr::null::<AnyObject>()];
                        let _: () = msg_send![&entry.download, cancel: &*done];
                    }
                }
            }
        }
    }

    /// Removes and returns the entry of download `id`.
    fn take(&self, id: &str) -> Result<Entry, String> {
        let mut active = self.state.active.borrow_mut();
        let Some(key) = active
            .iter()
            .find_map(|(key, entry)| (entry.id == id).then_some(*key))
        else {
            return Err(format!("no download with id `{id}`"));
        };
        active
            .remove(&key)
            .ok_or_else(|| format!("no download with id `{id}`"))
    }
}

/// Reports download `id` as failed because its web view went away.
fn report_gone(state: &State, id: &str) {
    let end = DownloadEnd {
        id: id.to_owned(),
        outcome: DownloadOutcome::Failed {
            code: Some("ERR_NSH_DOWNLOAD_TEARDOWN".into()),
            message: "the web view went away".to_owned(),
        },
    };
    (state.emit)(EventKind::DownloadEnd, download_end(&end));
}

/// The transport's downloads and how they are reported.
struct State {
    emit: Emit,
    active: RefCell<HashMap<usize, Entry>>,
}

/// One download WebKit gave the transport.
struct Entry {
    download: Retained<AnyObject>,
    id: String,
    /// The URL the request asked for, until the response's final one is
    /// known.
    url: String,
    method: Option<String>,
    /// The offer reached the core: it knows this download.
    offered: bool,
    /// WebKit's destination decision, until the core answers it.
    decide: Option<Decide>,
    /// Where the core said to write, once it answered.
    staging: Option<PathBuf>,
}

/// WebKit's destination decision for one download: a `Block_copy` of the
/// completion handler, owned until the core accepts (a destination URL) or
/// cancels (null).
struct Decide {
    block: *mut block2::Block<dyn Fn(*mut NSURL) + 'static>,
}

impl Decide {
    /// Copies `completion`: WebKit keeps a completion handler callable
    /// after its delegate method returns, but the Rust borrow does not
    /// outlive the call.
    fn new(completion: &block2::Block<dyn Fn(*mut NSURL)>) -> Self {
        let copy = completion.copy();
        // SAFETY: the pointer's metadata is the block's; only the trait
        // object's (phantom) lifetime differs, and the copy outlives this
        // borrow because it is a `Block_copy` WebKit may call later.
        let block = block2::RcBlock::into_raw(copy).cast::<()>()
            as *mut block2::Block<dyn Fn(*mut NSURL) + 'static>;
        Decide { block }
    }

    /// Answers with `url` (`None`: cancel). Consumes the decision.
    fn call(self, url: Option<&NSURL>) {
        let block = self.block;
        std::mem::forget(self);
        let url = url.map_or(std::ptr::null_mut(), |url| {
            url as *const NSURL as *mut NSURL
        });
        // SAFETY: `block` is the +1 this `Decide` owns, and it is called
        // once (`call` consumes it).
        if let Some(block) = unsafe { block2::RcBlock::from_raw(block) } {
            block.call((url,));
        }
    }
}

impl Drop for Decide {
    fn drop(&mut self) {
        if !self.block.is_null() {
            // SAFETY: owns the only reference to the copy made in `new`.
            unsafe {
                drop(block2::RcBlock::from_raw(self.block));
            }
        }
    }
}

/// Ivars of [`DownloadDelegate`].
struct DelegateIvars {
    state: Rc<State>,
}

define_class!(
    /// WebKit's `WKDownloadDelegate` for one web view's downloads. WebKit
    /// holds it weakly (the transport owns it), and every callback reaches
    /// only the transport's state.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    #[name = "NshWebDownloadDelegate"]
    struct DownloadDelegate;

    unsafe impl NSObjectProtocol for DownloadDelegate {}

    impl DownloadDelegate {
        /// WebKit has the response and waits for a destination: report the
        /// offer with what the response says, and hold the decision until
        /// the core answers.
        #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
        fn decide_destination(
            &self,
            download: &AnyObject,
            response: &NSURLResponse,
            suggested: &NSString,
            done: &block2::Block<dyn Fn(*mut NSURL)>,
        ) {
            let key = download_key(download);
            let offer = {
                let mut active = self.ivars().state.active.borrow_mut();
                let Some(entry) = active.get_mut(&key) else {
                    drop(active);
                    done.call((std::ptr::null_mut(),));
                    return;
                };
                if entry.offered {
                    // A second destination request: the first decision was
                    // answered already.
                    drop(active);
                    done.call((std::ptr::null_mut(),));
                    return;
                }
                let url = response
                    .URL()
                    .and_then(|url| url.absoluteString())
                    .map(|url| url.to_string())
                    .unwrap_or_else(|| entry.url.clone());
                let declared = declared_bytes(response);
                entry.offered = true;
                entry.decide = Some(Decide::new(done));
                DownloadOffer {
                    id: entry.id.clone(),
                    url,
                    filename: file_name(&suggested.to_string()),
                    mime_type: response.MIMEType().map(|mime| mime.to_string()),
                    bytes: declared,
                    method: entry.method.clone(),
                    source: WebDownloadSource::Transfer,
                }
            };
            // Reported outside the borrow: a sink dispatches an event whose
            // handling may reach this transport again.
            (self.ivars().state.emit)(EventKind::DownloadOffer, download_offer(&offer));
        }

        /// WebKit finished writing the staging file: report its size.
        #[unsafe(method(downloadDidFinish:))]
        fn finished(&self, download: &AnyObject) {
            let Some(entry) = self
                .ivars()
                .state
                .active
                .borrow_mut()
                .remove(&download_key(download))
            else {
                return;
            };
            if !entry.offered {
                return;
            }
            let end = match &entry.staging {
                Some(staging) => match std::fs::metadata(staging) {
                    Ok(metadata) => DownloadEnd {
                        id: entry.id.clone(),
                        outcome: DownloadOutcome::Finished {
                            bytes: metadata.len(),
                        },
                    },
                    Err(error) => DownloadEnd {
                        id: entry.id.clone(),
                        outcome: DownloadOutcome::Failed {
                            code: None,
                            message: format!(
                                "cannot read the finished download `{}`: {error}",
                                staging.display()
                            ),
                        },
                    },
                },
                None => DownloadEnd {
                    id: entry.id.clone(),
                    outcome: DownloadOutcome::Failed {
                        code: None,
                        message: "the download finished before it started".to_owned(),
                    },
                },
            };
            (self.ivars().state.emit)(EventKind::DownloadEnd, download_end(&end));
        }

        /// WebKit stopped before finishing: report why. A cancellation the
        /// transport started removed its entry first, so it reports nothing
        /// here.
        #[unsafe(method(download:didFailWithError:resumeData:))]
        fn failed(&self, download: &AnyObject, error: &NSError, _resume: Option<&NSData>) {
            let Some(mut entry) = self
                .ivars()
                .state
                .active
                .borrow_mut()
                .remove(&download_key(download))
            else {
                return;
            };
            // WebKit requires its destination callback to be answered even
            // when the transfer fails before the app chooses a path.
            if let Some(decide) = entry.decide.take() {
                decide.call(None);
            }
            if !entry.offered {
                return;
            }
            let end = DownloadEnd {
                id: entry.id.clone(),
                outcome: DownloadOutcome::Failed {
                    code: None,
                    message: error.localizedDescription().to_string(),
                },
            };
            (self.ivars().state.emit)(EventKind::DownloadEnd, download_end(&end));
        }
    }
);

impl DownloadDelegate {
    fn new(mtm: MainThreadMarker, state: Rc<State>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(DelegateIvars { state });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// The file URL of `path`, for WebKit's destination decision.
fn file_url(path: &Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

/// The size `response` declares for the bytes the file receives, when it
/// describes them: a `Content-Length` of an encoded body (`Content-Encoding`
/// other than `identity`) does not.
fn declared_bytes(response: &NSURLResponse) -> Option<u64> {
    let length = response.expectedContentLength();
    if length < 0 {
        return None;
    }
    let Some(http) = AnyClass::get(c"NSHTTPURLResponse") else {
        return Some(length as u64);
    };
    // SAFETY: `isKindOfClass:` and `valueForHTTPHeaderField:`, the latter
    // only for an HTTP response.
    unsafe {
        let is_http: Bool = msg_send![response, isKindOfClass: http];
        if !is_http.as_bool() {
            return Some(length as u64);
        }
        let encoding: Option<Retained<NSString>> = msg_send![
            response,
            valueForHTTPHeaderField: &*NSString::from_str("Content-Encoding")
        ];
        match encoding {
            Some(encoding) if !encoding.to_string().trim().eq_ignore_ascii_case("identity") => None,
            _ => Some(length as u64),
        }
    }
}

/// Whether a `WKNavigationResponse` is a file to save: the main frame's, of
/// a type WebKit cannot show or sent as an attachment. Both backends turn
/// such a response into a download when the app asks for downloads.
pub fn is_download(response: &AnyObject) -> bool {
    // SAFETY: WKNavigationResponse's documented API.
    unsafe {
        let main: Bool = msg_send![response, isForMainFrame];
        if !main.as_bool() {
            return false;
        }
        let shows: Bool = msg_send![response, canShowMIMEType];
        if !shows.as_bool() {
            return true;
        }
        let inner: Option<Retained<AnyObject>> = msg_send![response, response];
        let Some(inner) = inner else {
            return false;
        };
        let Some(http) = AnyClass::get(c"NSHTTPURLResponse") else {
            return false;
        };
        let is_http: Bool = msg_send![&*inner, isKindOfClass: http];
        if !is_http.as_bool() {
            return false;
        }
        let disposition: Option<Retained<NSString>> = msg_send![
            &*inner,
            valueForHTTPHeaderField: &*NSString::from_str("Content-Disposition")
        ];
        disposition.is_some_and(|d| is_attachment(&d.to_string()))
    }
}

/// Whether a `WKNavigationAction` asks for a download (`<a download>`),
/// where WebKit knows the selector (macOS 11.3, iOS 14.5) and says yes.
pub fn should_download(action: &AnyObject) -> bool {
    // SAFETY: WKNavigationAction's `shouldPerformDownload`, asked only where
    // it exists.
    unsafe {
        let known: Bool = msg_send![
            action,
            respondsToSelector: objc2::sel!(shouldPerformDownload)
        ];
        known.as_bool() && {
            let should: Bool = msg_send![action, shouldPerformDownload];
            should.as_bool()
        }
    }
}

/// Whether a `Content-Disposition` value says attachment.
pub fn is_attachment(disposition: &str) -> bool {
    disposition
        .split(';')
        .next()
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("attachment"))
}

/// A file name for a server's suggested one: its last component, without
/// separators or a leading dot, at most 200 bytes; `download` when nothing
/// is left.
pub fn file_name(suggested: &str) -> String {
    let last = suggested.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut name: String = last
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, ':' | '\u{061c}' | '\u{200e}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{206f}')
        })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .to_owned();
    if name.len() > 200 {
        // Preserve a normal extension while shortening the stem on UTF-8 boundaries.
        let extension = name
            .rsplit_once('.')
            .map(|(_, ext)| format!(".{ext}"))
            .filter(|ext| ext.len() + name.chars().next().map_or(0, char::len_utf8) <= 200);
        if let Some(extension) = &extension {
            name.truncate(name.len() - extension.len());
        }
        let limit = 200 - extension.as_ref().map_or(0, String::len);
        while name.len() > limit {
            name.pop();
        }
        if let Some(extension) = extension {
            name.push_str(&extension);
        }
    }
    if name.is_empty() {
        "download".to_owned()
    } else {
        name
    }
}

/// The last path segment of `url`, without its query or fragment.
pub fn url_file_name(url: &str) -> &str {
    let end = url.find(['?', '#']).unwrap_or(url.len());
    url[..end].rsplit('/').next().unwrap_or_default()
}

fn download_key(download: &AnyObject) -> usize {
    download as *const AnyObject as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downloads_get_safe_file_names() {
        assert!(is_attachment("attachment; filename=\"report.pdf\""));
        assert!(is_attachment("  Attachment "));
        assert!(!is_attachment("inline; filename=attachment.pdf"));
        assert_eq!(file_name("report.pdf"), "report.pdf");
        assert_eq!(file_name("../../etc/passwd"), "passwd");
        assert_eq!(file_name("C:\\x\\y.csv"), "y.csv");
        assert_eq!(file_name(".hidden"), "hidden");
        assert_eq!(file_name("a:b\u{7}.txt"), "ab.txt");
        assert_eq!(file_name(""), "download");
        assert_eq!(file_name(".."), "download");
        assert_eq!(file_name(&"x".repeat(300)).len(), 200);
        assert_eq!(file_name("invoice\u{202e}fdp.exe"), "invoicefdp.exe");
        assert_eq!(
            file_name(
                "\u{061c}\u{200e}\u{200f}\u{202a}\u{202b}\u{202c}\u{202d}\u{2066}\u{2067}\u{2068}\u{2069}report.pdf"
            ),
            "report.pdf"
        );
        let long = file_name(&format!("{}.pdf", "文".repeat(100)));
        assert!(long.len() <= 200);
        assert!(long.ends_with(".pdf"));
        let long_extension = file_name(&format!("文.{}", "x".repeat(198)));
        assert!(long_extension.len() <= 200);
        assert!(!long_extension.starts_with('.'));
        assert_eq!(file_name(&format!("{}.txt", "\u{7}".repeat(300))), "txt");
        assert_eq!(
            url_file_name("https://example.com/files/report.pdf?v=2#p1"),
            "report.pdf"
        );
        assert_eq!(file_name(url_file_name("https://example.com/")), "download");
    }
}
