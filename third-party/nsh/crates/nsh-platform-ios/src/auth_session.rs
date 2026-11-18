//! Web sign-in sessions ([`nsh_core::auth_session`]):
//! `ASWebAuthenticationSession`, presented over the surface's window. Its
//! completion answers the root's `AuthSession` event: the callback URL, a
//! cancellation (the user closed the page or declined the alert asking to
//! sign in), or why it failed. A new session, or the app closing it,
//! cancels the surface's session still showing, whose late answer the core
//! ignores.

use std::{cell::RefCell, rc::Rc};

use block2::RcBlock;
use nsh_core::{
    EventKind, ROOT_ID,
    auth_session::{AuthSessionError, AuthSessionOutcome, AuthSessionPage},
};
use nsh_engine::EngineControl;
use objc2::{
    AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained, runtime::ProtocolObject,
};
use objc2_authentication_services::{
    ASWebAuthenticationPresentationContextProviding, ASWebAuthenticationSession,
    ASWebAuthenticationSessionErrorCode, ASWebAuthenticationSessionErrorDomain,
};
use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_ui_kit::{UIView, UIWindow};

/// What a session's provider holds: the window it shows over.
pub(crate) struct ProviderIvars {
    window: Retained<UIWindow>,
}

define_class!(
    /// Tells the session which window to show over (the surface's).
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ProviderIvars]
    pub(crate) struct Provider;

    unsafe impl NSObjectProtocol for Provider {}

    // The protocol's one method is bound only for macOS (its anchor type
    // is `UIWindow` here), so the trait has no item for it; it is still
    // defined in this block, which registers it for the protocol (a
    // method defined elsewhere fails the protocol's check when the class
    // is first used in debug builds).
    unsafe impl ASWebAuthenticationPresentationContextProviding for Provider {
        #[unsafe(method_id(presentationAnchorForWebAuthenticationSession:))]
        fn anchor(&self, _session: &ASWebAuthenticationSession) -> Retained<UIWindow> {
            self.ivars().window.clone()
        }
    }
);

/// The session the surface shows, if any.
struct Running {
    id: u32,
    session: Retained<ASWebAuthenticationSession>,
    /// The session holds its provider weakly.
    _provider: Retained<Provider>,
}

/// The surface's sign-in session (one at a time).
#[derive(Default, Clone)]
pub(crate) struct Current(Rc<RefCell<Option<Running>>>);

/// Shows sign-in session `id` for `page` over `root`'s window; the root's
/// `AuthSession` event answers it once.
pub(crate) fn open(
    id: u32,
    page: &AuthSessionPage,
    root: &UIView,
    current: &Current,
    control: &EngineControl,
) {
    let fail = |message: String| {
        let error = AuthSessionError::failed(message);
        control.dispatch_event(ROOT_ID, EventKind::AuthSession, error.payload(id));
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return fail("openAuthSession: not on the main thread".into());
    };
    let Some(window) = root.window() else {
        return fail("openAuthSession: the surface is in no window".into());
    };
    let Some(url) = NSURL::URLWithString(&NSString::from_str(&page.url)) else {
        return fail(format!("openAuthSession: not a URL ({})", page.url));
    };
    // The core answered the earlier session as cancelled already; close
    // its page. Its completion still comes, under its own id.
    if let Some(earlier) = current.0.borrow_mut().take() {
        // SAFETY: a session the surface started, on the main thread.
        unsafe { earlier.session.cancel() };
    }
    let answer = {
        let control = control.clone();
        let current = current.clone();
        RcBlock::new(move |callback: *mut NSURL, error: *mut NSError| {
            // SAFETY: the completion gets a URL or an error, each null or
            // valid for the call.
            let (callback, error) = unsafe { (callback.as_ref(), error.as_ref()) };
            let payload = match (callback, error) {
                (Some(callback), _) => match callback.absoluteString() {
                    Some(url) => AuthSessionOutcome::Completed(url.to_string()).payload(id),
                    None => AuthSessionOutcome::Cancelled.payload(id),
                },
                (None, Some(error)) if cancelled(error) => {
                    AuthSessionOutcome::Cancelled.payload(id)
                }
                (None, Some(error)) => AuthSessionError::failed(format!(
                    "openAuthSession: {}",
                    error.localizedDescription()
                ))
                .payload(id),
                (None, None) => AuthSessionOutcome::Cancelled.payload(id),
            };
            {
                let mut running = current.0.borrow_mut();
                if running.as_ref().is_some_and(|r| r.id == id) {
                    *running = None;
                }
            }
            control.dispatch_event(ROOT_ID, EventKind::AuthSession, payload);
        })
    };
    let scheme = NSString::from_str(&page.callback_scheme);
    // SAFETY: an http(s) URL (the core checked it), a scheme, and a block
    // of the completion's signature, which the session copies.
    // `initWithURL:callback:completionHandler:` needs iOS 17.4; the scheme
    // initializer works on every iOS the runtime supports.
    #[allow(deprecated)]
    let session = unsafe {
        ASWebAuthenticationSession::initWithURL_callbackURLScheme_completionHandler(
            ASWebAuthenticationSession::alloc(),
            &url,
            Some(&scheme),
            RcBlock::as_ptr(&answer),
        )
    };
    let provider = Provider::alloc(mtm).set_ivars(ProviderIvars { window });
    // SAFETY: `NSObject`'s `init` on a provider just allocated.
    let provider: Retained<Provider> = unsafe { msg_send![super(provider), init] };
    // SAFETY: setters of a session not yet started; the provider is kept
    // alive with the session (`Running`).
    let started = unsafe {
        session.setPresentationContextProvider(Some(ProtocolObject::from_ref(&*provider)));
        session.setPrefersEphemeralWebBrowserSession(page.ephemeral);
        session.start()
    };
    if !started {
        return fail("openAuthSession: the sign-in page could not be shown".into());
    }
    *current.0.borrow_mut() = Some(Running {
        id,
        session,
        _provider: provider,
    });
}

/// Closes session `id` if the surface still shows it: the app closed it,
/// and the core answered it already. Its completion still comes, under
/// its id, which the core no longer waits for.
pub(crate) fn close(id: u32, current: &Current) {
    let running = {
        let mut current = current.0.borrow_mut();
        if current.as_ref().is_none_or(|r| r.id != id) {
            return;
        }
        current.take()
    };
    if let Some(running) = running {
        // SAFETY: a session the surface started, on the main thread.
        unsafe { running.session.cancel() };
    }
}

/// Whether `error` is the user's cancellation: the page closed, or the
/// alert asking to sign in declined.
fn cancelled(error: &NSError) -> bool {
    // SAFETY: a constant the framework defines.
    let domain = unsafe { ASWebAuthenticationSessionErrorDomain };
    &*error.domain() == domain
        && error.code() == ASWebAuthenticationSessionErrorCode::CanceledLogin.0
}
