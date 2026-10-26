//! System UI driven from JS: the status bar and alerts / action sheets.

use std::{cell::Cell, rc::Rc};

use block2::RcBlock;
use nsh_core::{
    Dialog, DialogButtonStyle, EventKind, EventPayload, PayloadValue, StatusBarConfig,
    StatusBarStyle,
    platform::{Appearance, clipboard},
};
use nsh_engine::EngineControl;
use objc2::{MainThreadMarker, MainThreadOnly, rc::Retained, runtime::Bool};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSData, NSDictionary, NSString, NSURL};
use objc2_ui_kit::{
    UIAlertAction, UIAlertActionStyle, UIAlertController, UIAlertControllerStyle, UIApplication,
    UIDevice, UIPopoverArrowDirection, UIStatusBarAnimation, UIStatusBarStyle,
    UIUserInterfaceIdiom, UIUserInterfaceStyle, UIView, UIViewController,
};

thread_local! {
    /// The status bar the app asked for (one per process, like the bar).
    static STATUS_BAR: Cell<StatusBarConfig> = Cell::new(StatusBarConfig::default());
    /// The appearance the app asked for last (`setColorScheme`), for what
    /// is not a subview of a surface: the status bar, alerts, modals.
    static APPEARANCE: Cell<UIUserInterfaceStyle> = const { Cell::new(UIUserInterfaceStyle::Unspecified) };
}

/// The appearance the app asked for (`Unspecified`: the system's).
pub(crate) fn appearance() -> UIUserInterfaceStyle {
    APPEARANCE.get()
}

/// Applies the app's appearance to the surface `root` and to what is
/// shown outside of it (the status bar's default style, alerts and modals
/// shown from now on).
pub(crate) fn set_appearance(appearance: Appearance, root: &UIView) {
    let style = match appearance {
        Appearance::System => UIUserInterfaceStyle::Unspecified,
        Appearance::Light => UIUserInterfaceStyle::Light,
        Appearance::Dark => UIUserInterfaceStyle::Dark,
    };
    APPEARANCE.set(style);
    root.setOverrideUserInterfaceStyle(style);
    if let Some(window) = root.window() {
        let mut controller = window.rootViewController();
        while let Some(c) = controller {
            if c.isViewLoaded()
                && c.view()
                    .is_some_and(|v| !v.isDescendantOfView(root) && !root.isDescendantOfView(&v))
            {
                // Modals the surface presented.
                c.setOverrideUserInterfaceStyle(style);
            }
            c.setNeedsStatusBarAppearanceUpdate();
            controller = c.presentedViewController();
        }
    }
}

/// The status bar style the app asked for, for view controllers'
/// `preferredStatusBarStyle` (embedders forward theirs here too).
pub fn preferred_status_bar_style() -> UIStatusBarStyle {
    match STATUS_BAR.get().style {
        // The default follows the app's appearance when it has one.
        StatusBarStyle::Default => match APPEARANCE.get() {
            UIUserInterfaceStyle::Dark => UIStatusBarStyle::LightContent,
            UIUserInterfaceStyle::Light => UIStatusBarStyle::DarkContent,
            _ => UIStatusBarStyle::Default,
        },
        StatusBarStyle::Light => UIStatusBarStyle::LightContent,
        StatusBarStyle::Dark => UIStatusBarStyle::DarkContent,
    }
}

/// Whether the app hid the status bar, for `prefersStatusBarHidden`.
pub fn prefers_status_bar_hidden() -> bool {
    STATUS_BAR.get().hidden
}

/// How status bar changes animate, for `preferredStatusBarUpdateAnimation`.
pub fn status_bar_animation() -> UIStatusBarAnimation {
    if STATUS_BAR.get().animated {
        UIStatusBarAnimation::Fade
    } else {
        UIStatusBarAnimation::None
    }
}

/// Applies `config`: asks the controllers of `view`'s window to update.
pub(crate) fn set_status_bar(config: StatusBarConfig, view: &UIView) {
    STATUS_BAR.set(config);
    let Some(window) = view.window() else { return };
    let update = move || {
        let mut controller = window.rootViewController();
        while let Some(c) = controller {
            c.setNeedsStatusBarAppearanceUpdate();
            controller = c.presentedViewController();
        }
    };
    if config.animated {
        let block = RcBlock::new(update);
        UIView::animateWithDuration_animations(0.25, &block, view.mtm());
    } else {
        update();
    }
}

/// The controller to present over: the top one of `view`'s window.
pub(crate) fn top_controller(view: &UIView) -> Option<Retained<UIViewController>> {
    let mut top = view.window()?.rootViewController()?;
    while let Some(next) = top.presentedViewController() {
        if next.isBeingDismissed() {
            break;
        }
        top = next;
    }
    Some(top)
}

/// Reports one dialog's answer, once.
struct DialogAnswer {
    id: u32,
    control: EngineControl,
    answered: Cell<bool>,
}

impl DialogAnswer {
    fn answer(&self, index: i32) {
        if self.answered.replace(true) {
            return;
        }
        self.control.dispatch_event(
            nsh_core::ROOT_ID,
            EventKind::Dialog,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(self.id as f64)),
                ("index", PayloadValue::Number(index as f64)),
            ]),
        );
    }
}

/// Shows `dialog` over `view`'s window (a `UIAlertController`).
pub(crate) fn show_dialog(dialog: &Dialog, view: &UIView, control: &EngineControl) {
    let mtm = view.mtm();
    let answer = Rc::new(DialogAnswer {
        id: dialog.id,
        control: control.clone(),
        answered: Cell::new(false),
    });
    let Some(top) = top_controller(view) else {
        log::warn!("no window to show a dialog in");
        return answer.answer(-1);
    };
    let style = if dialog.sheet {
        UIAlertControllerStyle::ActionSheet
    } else {
        UIAlertControllerStyle::Alert
    };
    let title = dialog.title.as_deref().map(NSString::from_str);
    let message = dialog.message.as_deref().map(NSString::from_str);
    let alert = UIAlertController::alertControllerWithTitle_message_preferredStyle(
        title.as_deref(),
        message.as_deref(),
        style,
        mtm,
    );
    alert.setOverrideUserInterfaceStyle(appearance());
    for (index, button) in dialog.buttons.iter().enumerate() {
        let style = match button.style {
            DialogButtonStyle::Default => UIAlertActionStyle::Default,
            DialogButtonStyle::Cancel => UIAlertActionStyle::Cancel,
            DialogButtonStyle::Destructive => UIAlertActionStyle::Destructive,
        };
        let answer = answer.clone();
        let handler = RcBlock::new(move |_| answer.answer(index as i32));
        let action = UIAlertAction::actionWithTitle_style_handler(
            Some(&NSString::from_str(&button.text)),
            style,
            Some(&handler),
            mtm,
        );
        alert.addAction(&action);
    }
    let phone = UIDevice::currentDevice(mtm).userInterfaceIdiom() == UIUserInterfaceIdiom::Phone;
    if dialog.sheet
        && !phone
        && !dialog
            .buttons
            .iter()
            .any(|b| b.style == DialogButtonStyle::Cancel)
    {
        // A popover hides its cancel action and runs it on a tap outside:
        // one that answers "dismissed". It is never shown, so it has no
        // title (labels all come from the app).
        let answer = answer.clone();
        let handler = RcBlock::new(move |_| answer.answer(-1));
        let action = UIAlertAction::actionWithTitle_style_handler(
            None,
            UIAlertActionStyle::Cancel,
            Some(&handler),
            mtm,
        );
        alert.addAction(&action);
    }
    if let Some(popover) = alert.popoverPresentationController() {
        // iPad and Mac: an action sheet is a popover; anchor it at the
        // bottom center of the surface, without an arrow.
        let bounds = view.bounds();
        popover.setSourceView(Some(view));
        popover.setSourceRect(CGRect::new(
            CGPoint::new(bounds.size.width / 2.0, bounds.size.height),
            CGSize::ZERO,
        ));
        popover.setPermittedArrowDirections(UIPopoverArrowDirection::empty());
    }
    top.presentViewController_animated_completion(&alert, true, None);
}

/// Where a user taps to answer the alert shown over `window`: the middle
/// of its button titled `button` (window points), or `None`'s: an action
/// sheet's popover closes with a tap outside it.
#[cfg(feature = "dev")]
pub(crate) fn dialog_point(
    window: &objc2_ui_kit::UIWindow,
    button: Option<&str>,
) -> Result<(f64, f64), String> {
    let mut top = window.rootViewController().ok_or("no dialog is shown")?;
    while let Some(next) = top.presentedViewController() {
        top = next;
    }
    let alert = top
        .downcast::<UIAlertController>()
        .map_err(|_| "no dialog is shown")?;
    let Some(text) = button else {
        if alert.popoverPresentationController().is_some() {
            return Ok((2.0, 2.0));
        }
        return Err("the dialog can only be answered with a button".into());
    };
    let view = alert.view().ok_or("the dialog shows nothing")?;
    let label =
        find_label(&view, text).ok_or_else(|| format!("the dialog has no button {text:?}"))?;
    let r = label.convertRect_toView(label.bounds(), Some(window));
    Ok((
        r.origin.x + r.size.width / 2.0,
        r.origin.y + r.size.height / 2.0,
    ))
}

/// The label showing `text` in `view`'s subtree.
#[cfg(feature = "dev")]
fn find_label(view: &UIView, text: &str) -> Option<Retained<objc2_ui_kit::UILabel>> {
    if let Some(label) = view.downcast_ref::<objc2_ui_kit::UILabel>()
        && label.text().is_some_and(|t| t.to_string() == text)
    {
        return Some(objc2::Message::retain(label));
    }
    view.subviews().iter().find_map(|v| find_label(&v, text))
}

/// `openUrl`: opens `url` with `UIApplication.open` (the app's own
/// application, the embedding app's when NSH is embedded) and reports
/// whether the system opened it ([`EventKind::OpenUrl`] `id`). A scheme no
/// app handles reports `false`.
pub(crate) fn open_url(id: u32, url: &str, control: &EngineControl) {
    let control = control.clone();
    let answer = move |opened: bool| {
        control.dispatch_event(
            nsh_core::ROOT_ID,
            EventKind::OpenUrl,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(id as f64)),
                ("opened", PayloadValue::Bool(opened)),
            ]),
        );
    };
    let (Some(mtm), Some(url)) = (
        MainThreadMarker::new(),
        NSURL::URLWithString(&NSString::from_str(url)),
    ) else {
        return answer(false);
    };
    let completion = RcBlock::new(move |opened: Bool| answer(opened.as_bool()));
    // SAFETY: an empty dictionary is valid options; UIKit calls the
    // completion on the main thread.
    unsafe {
        UIApplication::sharedApplication(mtm).openURL_options_completionHandler(
            &url,
            &NSDictionary::new(),
            Some(&completion),
        )
    };
}

/// `Clipboard.writeText`: puts `text` on the general pasteboard.
pub(crate) fn set_clipboard(text: &str) {
    // SAFETY: a plain setter of the general pasteboard.
    unsafe {
        objc2_ui_kit::UIPasteboard::generalPasteboard().setString(Some(&NSString::from_str(text)))
    };
}

/// `Clipboard.readText` / `hasText`: whether the general pasteboard
/// holds text and, unless `has_only`, the text. `hasStrings` does not read
/// it, so it shows no paste notice.
pub(crate) fn read_clipboard(has_only: bool) -> (bool, Option<String>) {
    let board = objc2_ui_kit::UIPasteboard::generalPasteboard();
    if has_only {
        // SAFETY: a plain getter.
        return (unsafe { board.hasStrings() }, None);
    }
    // SAFETY: a plain getter.
    let text = unsafe { board.string() }.map(|s| s.to_string());
    (text.is_some(), text)
}

/// Pasteboard types of images read as they are (others become PNG through
/// `UIImage`), by MIME type.
const IMAGE_TYPES: [(&str, &str); 3] = [
    ("image/png", "public.png"),
    ("image/jpeg", "public.jpeg"),
    ("image/gif", "com.compuserve.gif"),
];

/// `Clipboard.writeImage`: the image of a `data:` URI on the general
/// pasteboard, under its own type.
pub(crate) fn set_clipboard_image(uri: &str) {
    let Some((mime, bytes)) = clipboard::decode_data_uri(uri) else {
        log::warn!("Clipboard.writeImage: not a base64 data: URI");
        return;
    };
    let kind = match IMAGE_TYPES.iter().find(|(m, _)| *m == mime) {
        Some((_, kind)) => *kind,
        None if mime.starts_with("image/") => "public.image",
        None => {
            log::warn!("Clipboard.writeImage: unsupported image type {mime}");
            return;
        }
    };
    let board = objc2_ui_kit::UIPasteboard::generalPasteboard();
    board.setData_forPasteboardType(&NSData::with_bytes(&bytes), &NSString::from_str(kind));
}

/// `Clipboard.readImage` / `hasImage`: the answer to read `id`. `hasImages`
/// does not read the pasteboard, so it shows no paste notice.
pub(crate) fn read_clipboard_image(id: u32, has_only: bool) -> EventPayload {
    let board = objc2_ui_kit::UIPasteboard::generalPasteboard();
    // SAFETY: a plain getter.
    let has = unsafe { board.hasImages() };
    if has_only || !has {
        return clipboard::image_answer(id, has, None);
    }
    let data = IMAGE_TYPES
        .iter()
        .find_map(|(_, kind)| board.dataForPasteboardType(&NSString::from_str(kind)))
        // SAFETY: a plain getter.
        .or_else(|| unsafe { board.image() }.and_then(|image| image.png_representation()));
    let bytes = data.map(|d| d.to_vec()).unwrap_or_default();
    clipboard::image_answer(id, true, clipboard::Image::sniff(&bytes))
}

/// What `board` holds, read as the user pastes into an input (`onPaste`):
/// its text, its images (as they are in [`IMAGE_TYPES`], else PNG) and its
/// local files' `file:` URLs (Mac Catalyst).
pub(crate) fn pasted(board: &objc2_ui_kit::UIPasteboard) -> nsh_core::PasteEvent {
    // SAFETY: plain getters of the pasteboard, read on the user's paste.
    unsafe {
        let mut paste = nsh_core::PasteEvent::new(
            board
                .hasStrings()
                .then(|| board.string())
                .flatten()
                .map(|s| s.to_string())
                .unwrap_or_default(),
        );
        if board.hasImages() {
            let first = IMAGE_TYPES
                .iter()
                .find_map(|(_, kind)| board.dataForPasteboardType(&NSString::from_str(kind)));
            match first {
                Some(data) if board.numberOfItems() <= 1 => {
                    paste.files.push(nsh_core::PastedFile::image(data.to_vec()));
                }
                _ => {
                    for image in board.images().map(|i| i.to_vec()).unwrap_or_default() {
                        if let Some(png) = image.png_representation() {
                            paste.files.push(nsh_core::PastedFile::image(png.to_vec()));
                        }
                    }
                }
            }
        }
        if let Some(urls) = board.hasURLs().then(|| board.URLs()).flatten() {
            paste.uris = urls
                .iter()
                .filter(|url| url.isFileURL())
                .filter_map(|url| url.absoluteString())
                .map(|s| s.to_string())
                .collect();
        }
        paste
    }
}

/// `Clipboard.readFiles`: the `file:` URLs on the general pasteboard
/// (files copied in the Finder, on Mac Catalyst).
pub(crate) fn read_clipboard_files(id: u32) -> EventPayload {
    let board = objc2_ui_kit::UIPasteboard::generalPasteboard();
    // SAFETY: plain getters.
    let urls = unsafe { board.hasURLs().then(|| board.URLs()).flatten() };
    let files: Vec<String> = urls
        .map(|urls| {
            urls.iter()
                .filter(|url| url.isFileURL())
                .filter_map(|url| url.absoluteString())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    clipboard::files_answer(id, &files)
}

/// `announce`: VoiceOver reads `text`.
pub(crate) fn announce(text: &str) {
    let text = NSString::from_str(text);
    // SAFETY: announcements take the message as an NSString.
    unsafe {
        objc2_ui_kit::UIAccessibilityPostNotification(
            objc2_ui_kit::UIAccessibilityAnnouncementNotification,
            Some(&text),
        )
    };
}

/// `setAccessibilityFocus`: VoiceOver moves to `view`.
pub(crate) fn accessibility_focus(view: &UIView) {
    // SAFETY: layout changes take the element to focus.
    unsafe {
        objc2_ui_kit::UIAccessibilityPostNotification(
            objc2_ui_kit::UIAccessibilityLayoutChangedNotification,
            Some(view),
        )
    };
}
