//! Surface-wide commands and the environment: dialogs, announcements,
//! the clipboard, exiting; the system's settings followed into
//! [`Environment`].
//!
//! Dialogs are `NSAlert`s shown as sheets on the surface's window (they
//! never block the main thread).
//!
//! The environment follows:
//! - the color scheme: the app's appearance (`nsh.json` `"appearance"`,
//!   `setColorScheme`; [`set_appearance`]) when it forces one, else the
//!   root view's effective appearance (the window's, the system's), live;
//! - the locale (`Intl`'s default): `NSLocale.currentLocale` (the region
//!   format of System Settings), live;
//! - right to left: the user's first preferred language;
//! - reduce motion and VoiceOver: `NSWorkspace`'s accessibility settings,
//!   live;
//! - the pixel ratio: the window's backing scale factor;
//! - the OS version: `NSProcessInfo.operatingSystemVersion`.
//!
//! The font scale is 1 (macOS has no text size setting apps follow), the
//! safe area and keyboard height are zero: desktop windows have neither.
//!
//! The app's appearance is set on the root view too, so the AppKit views
//! it hosts (text fields, scroll bars) match the app. The surface's
//! background, under the root view (which has none of its own), is the
//! app's: the opaque background of its top view when that fills the root,
//! else white / neutral-950 by the scheme (as the Linux backend's). It
//! shows where the app has not drawn yet, as in the area a window grows
//! by before the layout at its new size arrives.
//!
//! The status bar has no desktop equivalent. The clipboard is the general
//! pasteboard; `hasText` only looks at the types on offer.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::{Rc, Weak},
};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use nsh_core::{
    Command, Dialog, DialogButtonStyle, EventKind, EventPayload, NodeId, PayloadValue, ROOT_ID,
    geometry::px, platform::clipboard,
};
use nsh_engine::{ColorScheme, Edges, Environment, Idiom, Locale, Os};
use objc2::{
    AllocAnyThread, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
};
use objc2_app_kit::{
    NSAccessibilityPriorityLevel, NSAlert, NSAlertFirstButtonReturn, NSAlertStyle, NSAppearance,
    NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSAttributedStringAppKitDocumentFormats, NSAttributedStringDocumentFormats,
    NSBitmapImageFileType, NSBitmapImageRep, NSDocumentTypeDocumentAttribute,
    NSExcludedElementsDocumentAttribute, NSHTMLTextDocumentType, NSModalResponse, NSPasteboard,
    NSPasteboardTypeRTF, NSPasteboardTypeRTFD, NSPasteboardTypeString, NSScreen, NSWorkspace,
    NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification,
};
use objc2_foundation::{
    NSArray, NSAttributedString, NSCurrentLocaleDidChangeNotification, NSData, NSDictionary,
    NSKeyValueObservingOptions, NSLocale, NSLocaleLanguageDirection, NSNotification,
    NSNotificationCenter, NSObject, NSObjectNSKeyValueObserverRegistration, NSObjectProtocol,
    NSOperationQueue, NSProcessInfo, NSPropertyListReadOptions, NSPropertyListSerialization,
    NSRange, NSString, NSURL, ns_string,
};

use crate::surface::Surface;

/// A dialog shown on a surface's window.
struct Shown {
    surface: Weak<Surface>,
    alert: Retained<NSAlert>,
    answer: Rc<DialogAnswer>,
}

#[derive(Default)]
struct System {
    installed: bool,
    surfaces: Vec<Weak<Surface>>,
    /// Notification observers, kept for as long as the thread runs.
    observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
    /// Observes `NSWorkspace.voiceOverEnabled`.
    voice_over: Option<Retained<Observer>>,
    dialogs: Vec<Shown>,
}

thread_local! {
    static SYSTEM: RefCell<System> = RefCell::default();
}

define_class!(
    /// Hears key-value changes of the system's settings.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "NshSystemObserver"]
    struct Observer;

    unsafe impl NSObjectProtocol for Observer {}

    impl Observer {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe(
            &self,
            _key_path: Option<&NSString>,
            _object: Option<&AnyObject>,
            _change: Option<&AnyObject>,
            _context: *mut std::ffi::c_void,
        ) {
            system_changed();
        }
    }
);

/// The window or its screen changed (scale, ...).
pub(crate) fn window_changed(surface: &Rc<Surface>) {
    crate::chrome::window_changed(surface);
    update(surface);
}

/// The root view's effective appearance changed (the system's, the
/// window's).
pub(crate) fn appearance_changed(surface: &Rc<Surface>) {
    update(surface);
}

/// The color scheme: the app's appearance, else the root view's.
pub(crate) fn color_scheme(surface: &Surface) -> ColorScheme {
    let system = if surface
        .root
        .ns()
        .effectiveAppearance()
        .name()
        .to_string()
        .contains("Dark")
    {
        ColorScheme::Dark
    } else {
        ColorScheme::Light
    };
    surface.appearance.get().resolve(system)
}

/// Starts following the system's settings.
pub(crate) fn watch_environment(surface: &Rc<Surface>) {
    install(surface.mtm);
    SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        s.surfaces.retain(|w| w.strong_count() > 0);
        s.surfaces.push(Rc::downgrade(surface));
    });
    update(surface);
    environment_applied(surface);
}

/// Installs the watchers of the system's settings (once per thread).
fn install(mtm: MainThreadMarker) {
    if SYSTEM.with(|s| std::mem::replace(&mut s.borrow_mut().installed, true)) {
        return;
    }
    let workspace = NSWorkspace::sharedWorkspace();
    let block = RcBlock::new(|_: NonNull<NSNotification>| system_changed());
    let queue = NSOperationQueue::mainQueue();
    // SAFETY: immutable constants; the block is called on the main queue,
    // and the observers are kept (and never removed) while the thread runs.
    let observers = unsafe {
        vec![
            workspace
                .notificationCenter()
                .addObserverForName_object_queue_usingBlock(
                    Some(NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
                    None,
                    Some(&queue),
                    &block,
                ),
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(NSCurrentLocaleDidChangeNotification),
                None,
                Some(&queue),
                &block,
            ),
        ]
    };
    // VoiceOver posts no notification: its setting is observed.
    // SAFETY: NSObject's initializer.
    let observer: Retained<Observer> = unsafe { msg_send![Observer::alloc(mtm), init] };
    // SAFETY: the observer is kept (and never removed) while the thread
    // runs; `voiceOverEnabled` is a KVO-compliant property of the
    // workspace.
    unsafe {
        workspace.addObserver_forKeyPath_options_context(
            &observer,
            ns_string!("voiceOverEnabled"),
            NSKeyValueObservingOptions::New,
            std::ptr::null_mut(),
        );
    }
    SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        s.observers = observers;
        s.voice_over = Some(observer);
    });
}

/// A system setting changed: tells every surface.
fn system_changed() {
    let surfaces: Vec<Rc<Surface>> = SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        s.surfaces.retain(|w| w.strong_count() > 0);
        s.surfaces.iter().filter_map(Weak::upgrade).collect()
    });
    for surface in surfaces {
        update(&surface);
    }
}

/// The embedding app set its locale or text size
/// ([`crate::AppView::set_locale`]): the system's settings are read again,
/// with the host's over them.
pub(crate) fn host_environment_changed(surface: &Surface) {
    update(surface);
}

/// Writes the system's settings and the surface's own values into its
/// environment.
fn update(surface: &Surface) {
    let workspace = NSWorkspace::sharedWorkspace();
    let mut env: Environment = surface.environment.get();
    env.color_scheme = color_scheme(surface);
    env.locale = current_locale();
    env.font_scale = 1.0;
    env.reduce_motion = workspace.accessibilityDisplayShouldReduceMotion();
    env.screen_reader = workspace.isVoiceOverEnabled();
    env.rtl = preferred_language_rtl();
    env.pixel_ratio = pixel_ratio(surface);
    env.os = Os::MacOs;
    env.os_version = os_version();
    env.idiom = Idiom::Desktop;
    env.safe_area = Edges::default();
    env.keyboard_height = px(0.0);
    surface.set_environment(env);
}

/// The surface's environment changed: its background follows the scheme.
pub(crate) fn environment_applied(surface: &Surface) {
    follow_background(surface);
}

/// Sets the surface's background (see the module doc), if it changed.
fn follow_background(surface: &Surface) {
    let app = surface
        .root
        .container()
        .subviews()
        .firstObject()
        .and_then(|v| crate::view::NshView::from_ns(&v))
        .and_then(|top| {
            let root = surface.root.state().frame;
            let s = top.state();
            let fills = s.frame.origin.x.0 <= 0.0
                && s.frame.origin.y.0 <= 0.0
                && s.frame.origin.x.0 + s.frame.size.width.0 >= root.size.width.0
                && s.frame.origin.y.0 + s.frame.size.height.0 >= root.size.height.0;
            let color = s.background();
            (fills && color.0 & 0xff == 0xff).then_some(color)
        });
    let color = app.unwrap_or(
        if surface.environment.get().color_scheme == ColorScheme::Dark {
            nsh_core::Color::rgba(10, 10, 10, 255)
        } else {
            nsh_core::Color::rgba(255, 255, 255, 255)
        },
    );
    if surface.background.replace(Some(color)) == Some(color) {
        return;
    }
    // The root's own layer is the app's (its style); the view holding it
    // is the surface's.
    let Some(layer) = crate::view::superview(surface.root.ns()).and_then(|v| v.layer()) else {
        surface.background.set(None);
        return;
    };
    crate::surface::quiet(|| layer.setBackgroundColor(Some(&crate::text::cg_color(color))));
}

/// Device pixels per point of the surface's window (or the main screen's).
fn pixel_ratio(surface: &Surface) -> f32 {
    let root = surface.root.ns();
    let scale = match root.window() {
        Some(window) => window.backingScaleFactor(),
        None => NSScreen::mainScreen(surface.mtm).map_or(2.0, |s| s.backingScaleFactor()),
    };
    scale as f32
}

/// The user's region format (`NSLocale.currentLocale`), `Intl`'s default.
fn current_locale() -> Locale {
    let identifier = NSLocale::currentLocale().localeIdentifier().to_string();
    Locale::parse(&identifier).unwrap_or_default()
}

/// Whether the user's first language is written right to left (as React
/// Native decides; the app's own localizations do not matter).
fn preferred_language_rtl() -> bool {
    NSLocale::preferredLanguages()
        .firstObject()
        .is_some_and(|language| {
            NSLocale::characterDirectionForLanguage(&language)
                == NSLocaleLanguageDirection::RightToLeft
        })
}

/// The macOS version, read once.
fn os_version() -> (u16, u16) {
    static VERSION: std::sync::OnceLock<(u16, u16)> = std::sync::OnceLock::new();
    *VERSION.get_or_init(|| {
        let v = NSProcessInfo::processInfo().operatingSystemVersion();
        (v.majorVersion as u16, v.minorVersion as u16)
    })
}

/// A command not addressed to a kind of view.
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    match command {
        Command::Dialog(dialog) => show_dialog(surface, dialog),
        Command::Desktop(command) => crate::chrome::command(surface, command),
        Command::Announce(text) => crate::access::announce(
            surface.root.ns(),
            text,
            NSAccessibilityPriorityLevel::Medium,
        ),
        Command::SetClipboard(text) => {
            let pasteboard = NSPasteboard::generalPasteboard();
            pasteboard.clearContents();
            // SAFETY: an immutable AppKit constant.
            pasteboard
                .setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
        }
        Command::ReadClipboard { id, has_only } => read_clipboard(surface, *id, *has_only),
        Command::SetClipboardImage(uri) => set_clipboard_image(uri),
        Command::ReadClipboardImage { id, has_only } => {
            read_clipboard_image(surface, *id, *has_only)
        }
        Command::ReadClipboardFiles { id } => read_clipboard_files(surface, *id),
        Command::PickImages { id, request } => crate::picker::pick_images(surface, *id, *request),
        Command::OpenUrl { id, url } => {
            let opened = open_url(url);
            surface.event(
                ROOT_ID,
                EventKind::OpenUrl,
                EventPayload::Map(vec![
                    ("id", PayloadValue::Number(*id as f64)),
                    ("opened", PayloadValue::Bool(opened)),
                ]),
            );
        }
        Command::Back => crate::navigation::default_back(surface),
        Command::ExitApp => {
            // Closing calls the window delegate synchronously, which stops
            // the surface and clears its mounter. Wait until this batch has
            // released the mounter's mutable borrow.
            let key = surface.key();
            DispatchQueue::main().exec_async(move || {
                if let Some(surface) = Surface::with_key(key)
                    && let Some(window) = surface.root.ns().window()
                {
                    window.close();
                }
            });
        }
        // The status bar is a phone's; layout animations arrive as mount
        // items.
        Command::StatusBar(_) | Command::SetStatusBar(_) | Command::LayoutAnimation(_) => {}
        other => log::debug!("macos: command {other:?} is not supported"),
    }
}

/// A batch was applied.
pub(crate) fn end_batch(surface: &Surface) {
    follow_background(surface);
}

/// The app stopped: its dialogs go too, unanswered.
pub(crate) fn clear(surface: &Surface) {
    let dialogs = SYSTEM.with(|s| {
        let mut s = s.borrow_mut();
        let (dialogs, kept): (Vec<Shown>, Vec<Shown>) =
            std::mem::take(&mut s.dialogs).into_iter().partition(|d| {
                d.surface
                    .upgrade()
                    .is_none_or(|s| std::ptr::eq(&*s, surface))
            });
        s.dialogs = kept;
        dialogs
    });
    for dialog in dialogs {
        dialog.answer.answered.set(true);
        let sheet = dialog.alert.window();
        if let Some(parent) = sheet.sheetParent() {
            parent.endSheet(&sheet);
        }
    }
}

/// The app's appearance (`setColorScheme`, `nsh.json`): the environment,
/// the hosted AppKit views and the dialogs follow.
pub(crate) fn set_appearance(surface: &Rc<Surface>, appearance: nsh_core::platform::Appearance) {
    if surface.appearance.replace(appearance) == appearance {
        return;
    }
    surface
        .root
        .ns()
        .setAppearance(ns_appearance(appearance).as_deref());
    update(surface);
}

/// The AppKit appearance of `appearance` (`None`: the system's).
fn ns_appearance(appearance: nsh_core::platform::Appearance) -> Option<Retained<NSAppearance>> {
    use nsh_core::platform::Appearance;
    // SAFETY: immutable AppKit constants.
    let name = match appearance {
        Appearance::Light => unsafe { NSAppearanceNameAqua },
        Appearance::Dark => unsafe { NSAppearanceNameDarkAqua },
        Appearance::System => return None,
    };
    NSAppearance::appearanceNamed(name)
}

/// Gives a new window the app's appearance (`nsh.json`), so it opens in
/// it rather than flashing the system's.
pub(crate) fn open_window(
    window: &objc2_app_kit::NSWindow,
    appearance: nsh_core::platform::Appearance,
) {
    if let Some(appearance) = ns_appearance(appearance) {
        window.setAppearance(Some(&appearance));
    }
}

/// Reports one dialog's answer, once.
struct DialogAnswer {
    id: u32,
    surface: Weak<Surface>,
    answered: Cell<bool>,
}

impl DialogAnswer {
    fn answer(&self, index: i32) {
        if self.answered.replace(true) {
            return;
        }
        let Some(surface) = self.surface.upgrade() else {
            return;
        };
        surface.event(
            ROOT_ID,
            EventKind::Dialog,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(self.id as f64)),
                ("index", PayloadValue::Number(index as f64)),
            ]),
        );
    }
}

/// Shows `dialog` as a sheet on the surface's window, its buttons in the
/// dialog's order (see the comment on `order`); the cancel button answers
/// Escape. Answers the button's index; -1 when the dialog cannot be shown.
fn show_dialog(surface: &Rc<Surface>, dialog: &Dialog) {
    let mtm = surface.mtm;
    let answer = Rc::new(DialogAnswer {
        id: dialog.id,
        surface: Rc::downgrade(surface),
        answered: Cell::new(false),
    });
    let Some(window) = surface.root.ns().window() else {
        log::warn!("macos: a dialog needs the surface in a window");
        return answer.answer(-1);
    };
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Informational);
    match (&dialog.title, &dialog.message) {
        (Some(title), message) => {
            alert.setMessageText(&NSString::from_str(title));
            if let Some(message) = message {
                alert.setInformativeText(&NSString::from_str(message));
            }
        }
        (None, Some(message)) => alert.setMessageText(&NSString::from_str(message)),
        (None, None) => {}
    }
    // `AlertDialog` always brings the app's actions (it rejects none): no
    // label of NSH's own.
    let buttons = &dialog.buttons[..];
    let cancel = buttons
        .iter()
        .position(|b| b.style == DialogButtonStyle::Cancel);
    // NSAlert lays two buttons out in a row, its first button rightmost,
    // and stacks three or more, its first button on top, except that it
    // moves the Return button to the top. As on iOS, buttons in a row read
    // in order with the cancel button leftmost, stacked ones (and an
    // action sheet's options) in order with the cancel button last. Only
    // an alert in a row has a default button (Return): its last regular
    // one, rightmost; Return would reorder a stack. `order[n]` is the
    // index of the alert's button n.
    let stacked = dialog.sheet || buttons.len() >= 3;
    let mut order: Vec<usize> = (0..buttons.len()).filter(|i| Some(*i) != cancel).collect();
    if !stacked {
        order.reverse();
    }
    order.extend(cancel);
    let default = (0..buttons.len())
        .rev()
        .find(|i| buttons[*i].style == DialogButtonStyle::Default)
        .filter(|_| !stacked);
    for &index in &order {
        let b = &buttons[index];
        let button = alert.addButtonWithTitle(&NSString::from_str(&b.text));
        let key = if Some(index) == default {
            ns_string!("\r")
        } else if b.style == DialogButtonStyle::Cancel {
            ns_string!("\u{1b}")
        } else {
            ns_string!("")
        };
        button.setKeyEquivalent(key);
        if b.style == DialogButtonStyle::Destructive {
            button.setHasDestructiveAction(true);
        }
    }
    // The sheet takes the surface's appearance, which the app may force.
    alert
        .window()
        .setAppearance(Some(&surface.root.ns().effectiveAppearance()));
    let handler = {
        let answer = answer.clone();
        let alert = alert.clone();
        RcBlock::new(move |response: NSModalResponse| {
            SYSTEM.with(|s| {
                s.borrow_mut()
                    .dialogs
                    .retain(|d| !std::ptr::eq(&*d.alert, &*alert))
            });
            let index = usize::try_from(response - NSAlertFirstButtonReturn)
                .ok()
                .and_then(|n| order.get(n))
                .map_or(-1, |i| *i as i32);
            answer.answer(index);
        })
    };
    SYSTEM.with(|s| {
        s.borrow_mut().dialogs.push(Shown {
            surface: Rc::downgrade(surface),
            alert: alert.clone(),
            answer,
        })
    });
    alert.beginSheetModalForWindow_completionHandler(&window, Some(&handler));
}

/// Answers the oldest dialog shown on `surface` as a user would: presses
/// its button titled `button`, or closes it without one (`None`).
#[cfg(feature = "dev")]
pub(crate) fn answer_dialog(surface: &Rc<Surface>, button: Option<&str>) -> Result<(), String> {
    let alert = SYSTEM
        .with(|s| {
            s.borrow()
                .dialogs
                .iter()
                .find(|d| d.surface.upgrade().is_some_and(|x| Rc::ptr_eq(&x, surface)))
                .map(|d| d.alert.clone())
        })
        .ok_or("no dialog is shown")?;
    match button {
        Some(text) => {
            let buttons = alert.buttons();
            let found = buttons
                .iter()
                .find(|b| b.title().to_string() == text)
                .ok_or_else(|| format!("the dialog has no button {text:?}"))?;
            // SAFETY: a button of a live alert, clicked on the main thread
            // with no sender, as a user's click has none to hand over.
            unsafe { found.performClick(None) };
        }
        None => {
            let window = surface.root.ns().window().ok_or("the window is gone")?;
            window.endSheet_returnCode(&alert.window(), objc2_app_kit::NSModalResponseCancel);
        }
    }
    Ok(())
}

/// The pasteboard types of images NSH reads and writes, by MIME type, in
/// the order they are read: the first one the pasteboard holds wins.
const IMAGE_TYPES: [(&str, &str); 6] = [
    ("image/png", "public.png"),
    ("image/jpeg", "public.jpeg"),
    ("image/gif", "com.compuserve.gif"),
    ("image/webp", "org.webmproject.webp"),
    ("image/bmp", "com.microsoft.bmp"),
    ("image/tiff", "public.tiff"),
];

/// `Clipboard.writeImage`: the image of a `data:` URI on the pasteboard,
/// under its own type (and TIFF too, which every AppKit app reads, unless
/// it is TIFF already).
fn set_clipboard_image(uri: &str) {
    let Some((mime, bytes)) = clipboard::decode_data_uri(uri) else {
        log::warn!("Clipboard.writeImage: not a base64 data: URI");
        return;
    };
    let Some((_, kind)) = IMAGE_TYPES.iter().find(|(m, _)| *m == mime) else {
        log::warn!("Clipboard.writeImage: unsupported image type {mime}");
        return;
    };
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    let data = NSData::with_bytes(&bytes);
    pasteboard.setData_forType(Some(&data), &NSString::from_str(kind));
    if *kind != "public.tiff"
        && let Some(tiff) =
            NSBitmapImageRep::imageRepWithData(&data).and_then(|r| r.TIFFRepresentation())
    {
        pasteboard.setData_forType(Some(&tiff), &NSString::from_str("public.tiff"));
    }
}

/// `Clipboard.readImage` / `hasImage`: answers read `id` with the
/// pasteboard's first image of [`IMAGE_TYPES`]; a TIFF becomes PNG (an
/// image source of any platform), off the main thread.
fn read_clipboard_image(surface: &Rc<Surface>, id: u32, has_only: bool) {
    let pasteboard = NSPasteboard::generalPasteboard();
    // The types on offer: reading them is no paste (no privacy notice).
    let kind = pasteboard.types().and_then(|types| {
        IMAGE_TYPES
            .iter()
            .map(|(_, kind)| NSString::from_str(kind))
            .find(|kind| types.containsObject(kind))
    });
    let data = kind
        .as_ref()
        .filter(|_| !has_only)
        .and_then(|kind| pasteboard.dataForType(kind));
    let Some(data) = data else {
        let payload = clipboard::image_answer(id, kind.is_some(), None);
        surface.event(ROOT_ID, EventKind::Clipboard, payload);
        return;
    };
    let bytes = data.to_vec();
    let key = surface.key();
    DispatchQueue::global_queue(dispatch2::GlobalQueueIdentifier::Priority(
        dispatch2::DispatchQueueGlobalPriority::Default,
    ))
    .exec_async(move || {
        let png = clipboard::Image::sniff(&bytes)
            .filter(|i| i.mime != "image/tiff")
            .is_none()
            .then(|| to_png(&bytes))
            .flatten();
        let bytes = png.as_deref().unwrap_or(&bytes);
        let payload = clipboard::image_answer(id, true, clipboard::Image::sniff(bytes));
        DispatchQueue::main().exec_async(move || {
            if let Some(surface) = Surface::with_key(key) {
                surface.event(ROOT_ID, EventKind::Clipboard, payload);
            }
        });
    });
}

/// What `pasteboard` holds, read as the user pastes into an input
/// (`onPaste`): its text, the same content as HTML ([`pasted_html`]), each
/// item's image (as it is in [`IMAGE_TYPES`], a TIFF or BMP as PNG) and
/// local files' `file:` URLs (a file copied in the Finder is its URL, not
/// the icon it carries).
pub(crate) fn pasted(pasteboard: &NSPasteboard) -> nsh_core::PasteEvent {
    // SAFETY: an immutable AppKit constant.
    let string = unsafe { NSPasteboardTypeString };
    let mut paste = nsh_core::PasteEvent::new(
        pasteboard
            .stringForType(string)
            .map(|s| s.to_string())
            .unwrap_or_default(),
    );
    paste.html = pasted_html(pasteboard).unwrap_or_default();
    let file_url = NSString::from_str("public.file-url");
    for item in pasteboard
        .pasteboardItems()
        .map(|i| i.to_vec())
        .unwrap_or_default()
    {
        if let Some(uri) = item.stringForType(&file_url) {
            if crate::file_drop::is_local_uri(&uri) {
                paste.uris.push(uri.to_string());
            }
            continue;
        }
        let image = IMAGE_TYPES.iter().find_map(|(mime, kind)| {
            item.dataForType(&NSString::from_str(kind))
                .map(|data| (*mime, data.to_vec()))
        });
        let Some((mime, bytes)) = image else {
            continue;
        };
        let bytes = match mime {
            "image/tiff" | "image/bmp" => to_png(&bytes).unwrap_or(bytes),
            _ => bytes,
        };
        paste.files.push(nsh_core::PastedFile::image(bytes));
    }
    paste
}

/// The pasteboard's formatted content as HTML: `public.html` as browsers,
/// office suites and most editors copy it; else the main resource of a web
/// archive (Safari, Mail); else RTF (TextEdit, Notes, Pages), written as
/// HTML by AppKit with its styles inline, as the editors' parsers read
/// them.
fn pasted_html(pasteboard: &NSPasteboard) -> Option<String> {
    if let Some(html) = pasteboard.stringForType(&NSString::from_str("public.html")) {
        return Some(html.to_string());
    }
    if let Some(archive) = pasteboard.dataForType(&NSString::from_str("com.apple.webarchive"))
        && let Some(html) = web_archive_html(&archive)
    {
        return Some(html);
    }
    // SAFETY: immutable AppKit constants.
    let (rtfd, rtf) = unsafe { (NSPasteboardTypeRTFD, NSPasteboardTypeRTF) };
    let text = if let Some(data) = pasteboard.dataForType(rtfd) {
        // SAFETY: `data` is the pasteboard's RTFD; no document attributes
        // are asked for.
        unsafe {
            NSAttributedString::initWithRTFD_documentAttributes(
                NSAttributedString::alloc(),
                &data,
                None,
            )
        }
    } else if let Some(data) = pasteboard.dataForType(rtf) {
        // SAFETY: as above, with RTF.
        unsafe {
            NSAttributedString::initWithRTF_documentAttributes(
                NSAttributedString::alloc(),
                &data,
                None,
            )
        }
    } else {
        None
    }?;
    attributed_html(&text)
}

/// The HTML of a web archive's main resource (`WebMainResource`'s
/// `WebResourceData`), decoded as its `WebResourceTextEncodingName` says
/// (UTF-8 when it names none).
fn web_archive_html(archive: &NSData) -> Option<String> {
    // SAFETY: `archive` is plist data; a null format is allowed.
    let plist = unsafe {
        NSPropertyListSerialization::propertyListWithData_options_format_error(
            archive,
            NSPropertyListReadOptions::Immutable,
            std::ptr::null_mut(),
        )
    }
    .ok()?;
    let archive = plist.downcast_ref::<NSDictionary>()?;
    let main = archive.objectForKey(&NSString::from_str("WebMainResource"))?;
    let main = main.downcast_ref::<NSDictionary>()?;
    let data = main.objectForKey(&NSString::from_str("WebResourceData"))?;
    let encoding = main
        .objectForKey(&NSString::from_str("WebResourceTextEncodingName"))
        .and_then(|e| e.downcast_ref::<NSString>().map(|e| e.to_string()));
    Some(decode_text(
        &data.downcast_ref::<NSData>()?.to_vec(),
        encoding.as_deref(),
    ))
}

/// Text `bytes` in `encoding` (an IANA name): UTF-16 as it names it or as
/// a byte order mark says, else UTF-8.
fn decode_text(bytes: &[u8], encoding: Option<&str>) -> String {
    let encoding = encoding.map(str::to_ascii_lowercase);
    let big_endian = match (encoding.as_deref(), bytes) {
        (Some("utf-16be"), _) | (_, [0xfe, 0xff, ..]) => true,
        (Some("utf-16" | "utf-16le"), _) | (_, [0xff, 0xfe, ..]) => false,
        _ => return String::from_utf8_lossy(bytes).into_owned(),
    };
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| {
            if big_endian {
                u16::from_be_bytes(*c)
            } else {
                u16::from_le_bytes(*c)
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
        .trim_start_matches('\u{feff}')
        .to_owned()
}

/// `text` written as HTML by AppKit, without the document around it (its
/// head and style sheet), so its styles are inline.
fn attributed_html(text: &NSAttributedString) -> Option<String> {
    let excluded = NSArray::from_retained_slice(
        &[
            "doctype", "html", "head", "body", "xml", "style", "meta", "title",
        ]
        .map(NSString::from_str),
    );
    // SAFETY: immutable AppKit constants.
    let (kind, html, excluded_key) = unsafe {
        (
            NSDocumentTypeDocumentAttribute,
            NSHTMLTextDocumentType,
            NSExcludedElementsDocumentAttribute,
        )
    };
    let attributes = NSDictionary::<NSString, AnyObject>::from_slices(
        &[kind, excluded_key],
        &[html.as_ref(), excluded.as_ref()],
    );
    let range = NSRange::new(0, text.length());
    // SAFETY: the attributes are the document type and an array of strings,
    // as AppKit takes them.
    let data = unsafe { text.dataFromRange_documentAttributes_error(range, &attributes) }.ok()?;
    Some(String::from_utf8_lossy(&data.to_vec()).into_owned())
}

/// Whether `pasteboard` holds what a text view's own paste leaves out:
/// images or local files (reading the types is no paste: no privacy
/// notice).
pub(crate) fn has_pasted_files(pasteboard: &NSPasteboard) -> bool {
    pasteboard.types().is_some_and(|types| {
        IMAGE_TYPES
            .iter()
            .map(|(_, kind)| *kind)
            .chain(["public.file-url"])
            .any(|kind| types.containsObject(&NSString::from_str(kind)))
    })
}

/// Encoded image `bytes` (a TIFF) encoded again as PNG.
fn to_png(bytes: &[u8]) -> Option<Vec<u8>> {
    let rep = NSBitmapImageRep::imageRepWithData(&NSData::with_bytes(bytes))?;
    // SAFETY: an empty dictionary of properties is valid for every type.
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }?;
    Some(png.to_vec())
}

/// `Clipboard.readFiles`: the local files' `file:` URLs on the pasteboard
/// (one item each, as Finder copies them).
fn read_clipboard_files(surface: &Rc<Surface>, id: u32) {
    let pasteboard = NSPasteboard::generalPasteboard();
    let kind = NSString::from_str("public.file-url");
    let files: Vec<String> = pasteboard
        .pasteboardItems()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.stringForType(&kind))
                .filter(|uri| crate::file_drop::is_local_uri(uri))
                .map(|uri| uri.to_string())
                .collect()
        })
        .unwrap_or_default();
    surface.event(
        ROOT_ID,
        EventKind::Clipboard,
        clipboard::files_answer(id, &files),
    );
}

/// `Clipboard.readText` / `hasText`: answers read `id` with whether the
/// clipboard holds text and, unless `has_only`, the text.
/// Opens `url` in the app that handles its scheme (`NSWorkspace`): whether
/// one took it.
pub(crate) fn open_url(url: &str) -> bool {
    let Some(url) = NSURL::URLWithString(&NSString::from_str(url)) else {
        return false;
    };
    NSWorkspace::sharedWorkspace().openURL(&url)
}

fn read_clipboard(surface: &Rc<Surface>, id: u32, has_only: bool) {
    let pasteboard = NSPasteboard::generalPasteboard();
    // SAFETY: an immutable AppKit constant.
    let string = unsafe { NSPasteboardTypeString };
    // The types on offer: reading them is no paste (no privacy notice).
    let has = pasteboard
        .types()
        .is_some_and(|types| types.containsObject(string));
    let text = (has && !has_only)
        .then(|| pasteboard.stringForType(string))
        .flatten()
        .map(|s| s.to_string());
    let mut fields = vec![
        ("id", PayloadValue::Number(id as f64)),
        ("has", PayloadValue::Bool(has)),
    ];
    if let Some(text) = text {
        fields.push(("text", PayloadValue::Str(text)));
    }
    surface.event(ROOT_ID, EventKind::Clipboard, EventPayload::Map(fields));
}

#[cfg(test)]
mod tests {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{
        NSData, NSDictionary, NSPropertyListFormat, NSPropertyListSerialization, NSString,
    };

    use super::pasted_html;

    /// A private pasteboard holding `bytes` as `kind`.
    fn board(kind: &str, bytes: &[u8]) -> objc2::rc::Retained<NSPasteboard> {
        let board = NSPasteboard::pasteboardWithUniqueName();
        board.clearContents();
        board.setData_forType(Some(&NSData::with_bytes(bytes)), &NSString::from_str(kind));
        board
    }

    #[test]
    fn html_as_browsers_copy_it() {
        let board = board("public.html", b"<p>a <b>b</b></p>");
        assert_eq!(pasted_html(&board).as_deref(), Some("<p>a <b>b</b></p>"));
    }

    #[test]
    fn web_archive_main_resource() {
        let html = "<p>caf\u{e9} <b>b</b></p>";
        let main = NSDictionary::<NSString, AnyObject>::from_slices(
            &[
                &*NSString::from_str("WebResourceData"),
                &*NSString::from_str("WebResourceTextEncodingName"),
            ],
            &[
                NSData::with_bytes(html.as_bytes()).as_ref(),
                NSString::from_str("UTF-8").as_ref(),
            ],
        );
        let archive = NSDictionary::<NSString, AnyObject>::from_slices(
            &[&*NSString::from_str("WebMainResource")],
            &[main.as_ref()],
        );
        // SAFETY: a dictionary of strings and data is a property list.
        let plist = unsafe {
            NSPropertyListSerialization::dataWithPropertyList_format_options_error(
                &archive,
                NSPropertyListFormat::BinaryFormat_v1_0,
                0,
            )
        }
        .unwrap()
        .to_vec();
        let board = board("com.apple.webarchive", &plist);
        assert_eq!(pasted_html(&board).as_deref(), Some(html));
    }

    #[test]
    fn rtf_as_html_with_inline_styles() {
        let rtf = br"{\rtf1\ansi{\fonttbl\f0 Helvetica;}\f0 a \b bold\b0  \i it\i0\par}";
        let board = board("public.rtf", rtf);
        let html = pasted_html(&board).unwrap();
        assert!(html.contains("<b>bold</b>"), "{html}");
        assert!(html.contains("<i>it</i>"), "{html}");
        assert!(!html.contains("<style"), "{html}");
    }

    #[test]
    fn no_formatted_content() {
        let board = board("public.utf8-plain-text", b"plain");
        assert_eq!(pasted_html(&board), None);
    }
}
