//! System UI driven from JS: the status bar and alerts / action sheets.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    ptr::NonNull,
    rc::Rc,
    time::{Duration, Instant},
};

use block2::RcBlock;
use nsh_core::{
    Dialog, DialogButtonStyle, EventKind, EventPayload, PayloadValue, StatusBarConfig,
    StatusBarStyle,
    platform::{Appearance, clipboard},
};
use nsh_engine::EngineControl;
use objc2::{
    AllocAnyThread, ClassType, MainThreadMarker, MainThreadOnly,
    rc::Retained,
    runtime::{AnyObject, Bool, ProtocolObject},
};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{
    NSAttributedString, NSData, NSDictionary, NSError, NSNotification, NSNotificationCenter,
    NSObjectProtocol, NSOperationQueue, NSPropertyListReadOptions, NSPropertyListSerialization,
    NSRange, NSString, NSURL,
};
use objc2_ui_kit::{
    NSAttributedStringDocumentFormats, NSDocumentTypeDocumentAttribute,
    NSDocumentTypeDocumentOption, NSHTMLTextDocumentType, NSRTFDTextDocumentType,
    NSRTFTextDocumentType, UIAlertAction, UIAlertActionStyle, UIAlertController,
    UIAlertControllerStyle, UIApplication, UIDevice, UIDeviceOrientation, UIInterfaceOrientation,
    UIInterfaceOrientationMask, UIPopoverArrowDirection, UIStatusBarAnimation, UIStatusBarStyle,
    UITextField, UITextFieldTextDidChangeNotification, UITextInput, UIUserInterfaceIdiom,
    UIUserInterfaceStyle, UIView, UIViewController, UIWindowSceneGeometryPreferencesIOS,
};

thread_local! {
    /// The status bar the app asked for (one per process, like the bar).
    static STATUS_BAR: Cell<StatusBarConfig> = Cell::new(StatusBarConfig::default());
    /// The appearance the app asked for last (`setColorScheme`), for what
    /// is not a subview of a surface: the status bar, alerts, modals.
    static APPEARANCE: Cell<UIUserInterfaceStyle> = const { Cell::new(UIUserInterfaceStyle::Unspecified) };
    /// The orientations the page shown asked for (`supportedOrientations`;
    /// empty: the app's), one per process like the status bar.
    static ORIENTATIONS: Cell<UIInterfaceOrientationMask> = const { Cell::new(UIInterfaceOrientationMask(0)) };
    /// How the app's own pages (no page's setting) showed the screen when
    /// a page's setting came, to turn back to when it goes and the device
    /// says nothing (lying flat). Like `ORIENTATIONS` and `TURNING`, one
    /// per process, not per scene: right for a phone's single window; on
    /// an iPad with several scenes, one scene's turn can be recorded for
    /// another.
    static APP_ORIENTATION: Cell<UIInterfaceOrientation> = const { Cell::new(UIInterfaceOrientation::Unknown) };
    /// A turn asked for on the app's own pages, and when: the scene shows
    /// the old orientation until it is done.
    static TURNING: Cell<Option<(UIInterfaceOrientation, Instant)>> = const { Cell::new(None) };
    /// Whether NSH has the device report its orientation: from a page's
    /// setting until the app's own orientations apply again.
    static WATCHING: Cell<bool> = const { Cell::new(false) };
}

/// How long a turn asked for may take before the scene shows it.
const TURN_TIME: Duration = Duration::from_secs(2);

/// The tint of a surface's alerts and action sheets for its design tokens
/// ([`nsh_core::Command::Tokens`]): the theme's `primary` when the app has
/// a theme of its own (tokens other than the default theme's), else `None`
/// (the system's).
pub(crate) fn alert_tint(
    tokens: &nsh_core::element::Tokens,
) -> Option<nsh_core::element::AdaptiveColor> {
    let themed = nsh_base::tokens_of(None).is_ok_and(|d| *tokens != d);
    tokens.color("primary").filter(|_| themed)
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
                style_presented(&c, style);
            }
            c.setNeedsStatusBarAppearanceUpdate();
            controller = c.presentedViewController();
        }
    }
}

/// Gives a modal the app's appearance, and its presentation's container
/// too: a sheet's background (iOS 26's glass) is drawn there, which takes
/// the window's appearance, not the modal's.
pub(crate) fn style_presented(c: &UIViewController, style: UIUserInterfaceStyle) {
    c.setOverrideUserInterfaceStyle(style);
    if let Some(p) = c.presentationController() {
        if let Some(container) = p.containerView() {
            container.setOverrideUserInterfaceStyle(style);
        }
        // The view UIKit wraps a sheet in (its background, iOS 26's glass).
        let mut view = p.presentedView();
        while let Some(v) = view {
            if p.containerView().is_some_and(|c| *c == *v) {
                break;
            }
            v.setOverrideUserInterfaceStyle(style);
            view = v.superview();
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

/// The orientations of [`nsh_core::ModalConfig::PORTRAIT`] bits.
pub(crate) fn orientation_mask(bits: u8) -> UIInterfaceOrientationMask {
    use nsh_core::ModalConfig as M;
    let mut mask = UIInterfaceOrientationMask::empty();
    for (bit, m) in [
        (M::PORTRAIT, UIInterfaceOrientationMask::Portrait),
        (
            M::PORTRAIT_UPSIDE_DOWN,
            UIInterfaceOrientationMask::PortraitUpsideDown,
        ),
        (M::LANDSCAPE_LEFT, UIInterfaceOrientationMask::LandscapeLeft),
        (
            M::LANDSCAPE_RIGHT,
            UIInterfaceOrientationMask::LandscapeRight,
        ),
    ] {
        if bits & bit != 0 {
            mask |= m;
        }
    }
    mask
}

/// The orientations the page shown asked for, for view controllers'
/// `supportedInterfaceOrientations` (`None`: the controller's own).
pub(crate) fn page_orientations() -> Option<UIInterfaceOrientationMask> {
    let mask = ORIENTATIONS.get();
    (!mask.is_empty()).then_some(mask)
}

/// Applies the page's `supportedOrientations` ([`nsh_core::Command::Orientations`]):
/// asks the controllers of `view`'s window to rotate to them.
pub(crate) fn set_orientations(bits: u8, view: &UIView) {
    let mask = orientation_mask(bits);
    let was_own = ORIENTATIONS.get().is_empty();
    ORIENTATIONS.set(mask);
    // How the device is held, to turn back to when the orientations widen
    // again: reported while a page's setting applies, read before the
    // reports stop.
    let device = UIDevice::currentDevice(view.mtm());
    if !mask.is_empty() && !WATCHING.replace(true) {
        device.beginGeneratingDeviceOrientationNotifications();
    }
    let held = device.orientation();
    if mask.is_empty() && WATCHING.replace(false) {
        device.endGeneratingDeviceOrientationNotifications();
    }
    let Some(window) = view.window() else { return };
    let mut controller = window.rootViewController();
    // iOS 16 asks each controller again; before, one call for the window.
    if !controller.as_ref().is_some_and(|c| {
        c.respondsToSelector(objc2::sel!(setNeedsUpdateOfSupportedInterfaceOrientations))
    }) {
        #[allow(deprecated)]
        UIViewController::attemptRotationToDeviceOrientation(view.mtm());
        return;
    }
    // iOS 16 only turns the screen when its orientation is no longer
    // allowed: when the orientations widen again (back from a landscape
    // page), the screen would stay as the page turned it. NSH turns it
    // itself, only in its own window (a host app's turns as its
    // controllers say).
    let own = controller
        .as_ref()
        .is_some_and(|c| c.isKindOfClass(crate::app::RootController::class()));
    let scene = window.windowScene().filter(|_| own);
    if let Some(scene) = &scene
        && was_own
        && !mask.is_empty()
    {
        // A page's setting comes: remember how the app's pages show the
        // screen, unless a turn back to it is not done yet.
        let shown = scene.effectiveGeometry().interfaceOrientation();
        let turning = TURNING
            .take()
            .is_some_and(|(to, at)| shown != to && at.elapsed() < TURN_TIME);
        if !turning {
            APP_ORIENTATION.set(shown);
        }
    }
    let mut top = None;
    while let Some(c) = controller {
        c.setNeedsUpdateOfSupportedInterfaceOrientations();
        controller = c.presentedViewController();
        top = Some(c);
    }
    let (Some(top), Some(scene)) = (top, scene) else {
        return;
    };
    // The way the device is held, as iOS did before 16 (a device turned
    // left shows the interface turned right, and back); a device lying
    // flat says nothing, so back on the app's own pages the screen turns
    // as they showed it.
    let wanted = match held {
        UIDeviceOrientation::Portrait => UIInterfaceOrientation::Portrait,
        UIDeviceOrientation::PortraitUpsideDown => UIInterfaceOrientation::PortraitUpsideDown,
        UIDeviceOrientation::LandscapeLeft => UIInterfaceOrientation::LandscapeRight,
        UIDeviceOrientation::LandscapeRight => UIInterfaceOrientation::LandscapeLeft,
        _ if mask.is_empty() => APP_ORIENTATION.get(),
        _ => return,
    };
    if wanted == UIInterfaceOrientation::Unknown {
        return;
    }
    let wanted_mask = UIInterfaceOrientationMask(1 << wanted.0);
    if scene.effectiveGeometry().interfaceOrientation() == wanted
        || !top.supportedInterfaceOrientations().contains(wanted_mask)
    {
        return;
    }
    if mask.is_empty() {
        APP_ORIENTATION.set(wanted);
        TURNING.set(Some((wanted, Instant::now())));
    }
    let preferences = UIWindowSceneGeometryPreferencesIOS::initWithInterfaceOrientations(
        UIWindowSceneGeometryPreferencesIOS::alloc(),
        wanted_mask,
    );
    let failed = RcBlock::new(|error: NonNull<NSError>| {
        // SAFETY: UIKit passes a valid NSError for the call.
        let error = unsafe { error.as_ref() };
        log::warn!(
            "the screen did not turn back: {}",
            error.localizedDescription()
        );
    });
    scene.requestGeometryUpdateWithPreferences_errorHandler(&preferences, Some(&failed));
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
    /// Its presentation finished: it can be dismissed.
    presented: Cell<bool>,
    /// The app closed it ([`close_dialog`]); dismissed as soon as it can be.
    closed: Cell<bool>,
    /// Its surface's alerts, which it leaves once answered.
    dialogs: std::rc::Weak<RefCell<HashMap<u32, ShownDialog>>>,
    /// The alert's text field (`Dialog::input`), whose text goes with the
    /// answer.
    field: RefCell<Option<objc2::rc::Weak<UITextField>>>,
    /// Follows the field's text to enable the actions while it is required.
    observer: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>>,
}

/// A surface's alerts shown and not answered yet, by dialog id: what
/// [`close_dialog`] takes back.
pub(crate) type Dialogs = Rc<RefCell<HashMap<u32, ShownDialog>>>;

/// An alert on the screen, for [`close_dialog`].
pub(crate) struct ShownDialog {
    alert: objc2::rc::Weak<UIAlertController>,
    answer: Rc<DialogAnswer>,
}

impl DialogAnswer {
    fn answer(&self, index: i32) {
        if self.answered.replace(true) {
            return;
        }
        self.stop_following();
        if let Some(dialogs) = self.dialogs.upgrade()
            && let Ok(mut dialogs) = dialogs.try_borrow_mut()
        {
            dialogs.remove(&self.id);
        }
        let mut payload = vec![
            ("id", PayloadValue::Number(self.id as f64)),
            ("index", PayloadValue::Number(index as f64)),
        ];
        if let Some(field) = self.field.borrow().as_ref() {
            let text = field.load().and_then(|f| f.text());
            let text = text.map(|t| t.to_string()).unwrap_or_default();
            payload.push(("value", PayloadValue::Str(text)));
        }
        self.control.dispatch_event(
            nsh_core::ROOT_ID,
            EventKind::Dialog,
            EventPayload::Map(payload),
        );
    }

    /// Stops following the field's text, once the alert is answered.
    fn stop_following(&self) {
        if let Some(observer) = self.observer.take() {
            // SAFETY: the observer `addObserverForName…` returned.
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer.as_ref()) };
        }
    }
}

/// Adds the text field of `dialog`'s input to `alert`, which has its
/// actions already: return chooses its default action (UIKit's preferred
/// one, drawn bold), and while a required field is empty only its cancel
/// actions are enabled.
fn add_text_field(alert: &UIAlertController, dialog: &Dialog, answer: &Rc<DialogAnswer>) {
    let Some(input) = dialog.input.as_ref().filter(|_| !dialog.sheet) else {
        return;
    };
    alert.addTextFieldWithConfigurationHandler(None);
    let Some(field) = alert.textFields().and_then(|f| f.firstObject()) else {
        return;
    };
    field.setText(Some(&NSString::from_str(&input.text)));
    field.setPlaceholder(
        input
            .placeholder
            .as_deref()
            .map(NSString::from_str)
            .as_deref(),
    );
    *answer.field.borrow_mut() = Some(objc2::rc::Weak::from_retained(&field));
    let actions = alert.actions();
    if let Some(default) = nsh_core::dialog_default_button(&dialog.buttons)
        && default < actions.count()
    {
        alert.setPreferredAction(Some(&actions.objectAtIndex(default)));
    }
    if !input.required {
        return;
    }
    let enable = {
        let alert = objc2::rc::Weak::new(alert);
        let buttons = dialog.buttons.clone();
        let input = input.clone();
        move |text: &str| {
            let Some(alert) = alert.load() else { return };
            for (action, button) in alert.actions().iter().zip(&buttons) {
                action.setEnabled(input.enables(button, text));
            }
        }
    };
    enable(&input.text);
    let watched = objc2::rc::Weak::from_retained(&field);
    let block = RcBlock::new(move |_: NonNull<NSNotification>| {
        let text = watched.load().and_then(|f| f.text());
        enable(&text.map(|t| t.to_string()).unwrap_or_default());
    });
    // SAFETY: the block touches the alert on the main queue it is
    // delivered on, and `stop_following` removes the observer.
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(UITextFieldTextDidChangeNotification),
            Some(&field),
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    *answer.observer.borrow_mut() = Some(observer);
}

/// Shows `dialog` over `view`'s window (a `UIAlertController`), tinted
/// with `tint` ([`alert_tint`]).
pub(crate) fn show_dialog(
    dialog: &Dialog,
    tint: Option<nsh_core::element::AdaptiveColor>,
    view: &UIView,
    control: &EngineControl,
    dialogs: &Dialogs,
) {
    let mtm = view.mtm();
    let answer = Rc::new(DialogAnswer {
        id: dialog.id,
        control: control.clone(),
        answered: Cell::new(false),
        presented: Cell::new(false),
        closed: Cell::new(false),
        dialogs: Rc::downgrade(dialogs),
        field: RefCell::new(None),
        observer: RefCell::new(None),
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
    if let (Some(tint), Some(shown)) = (tint, alert.view()) {
        // UIKit draws the regular and cancel actions in the tint and
        // destructive ones red (iOS 17); iOS 26's alerts keep their own
        // colors.
        let dark = match appearance() {
            UIUserInterfaceStyle::Unspecified => {
                let traits = objc2_ui_kit::UITraitEnvironment::traitCollection(view);
                (unsafe { traits.userInterfaceStyle() }) == UIUserInterfaceStyle::Dark
            }
            style => style == UIUserInterfaceStyle::Dark,
        };
        let (r, g, b, a) =
            nsh_core::Color::from(if dark { tint.dark } else { tint.light }).to_f64();
        let color = objc2_ui_kit::UIColor::colorWithRed_green_blue_alpha(r, g, b, a);
        unsafe { shown.setTintColor(Some(&color)) };
    }
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
    add_text_field(&alert, dialog, &answer);
    let select_all = dialog
        .input
        .as_ref()
        .is_some_and(|i| i.select_all && !dialog.sheet);
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
    let weak = objc2::rc::Weak::from_retained(&alert);
    dialogs.borrow_mut().insert(
        dialog.id,
        ShownDialog {
            alert: weak.clone(),
            answer: answer.clone(),
        },
    );
    // Closed while it was still coming up: UIKit cannot dismiss it before
    // its presentation ends, so it goes then.
    let presented = RcBlock::new(move || {
        answer.presented.set(true);
        // The field has the keyboard now: select its text without the
        // edit menu `selectAll:` brings up.
        if select_all && let Some(field) = answer.field.borrow().as_ref().and_then(|f| f.load()) {
            let range = field.textRangeFromPosition_toPosition(
                &field.beginningOfDocument(),
                &field.endOfDocument(),
            );
            field.setSelectedTextRange(range.as_deref());
        }
        if answer.closed.get()
            && let Some(alert) = weak.load()
        {
            alert.dismissViewControllerAnimated_completion(true, None);
        }
    });
    top.presentViewController_animated_completion(&alert, true, Some(&presented));
}

/// Takes back the alert [`show_dialog`] showed as `id` (`Command::CloseDialog`):
/// the core answered it already, so it reports nothing.
pub(crate) fn close_dialog(dialogs: &Dialogs, id: u32) {
    let Some(shown) = dialogs.borrow_mut().remove(&id) else {
        return;
    };
    shown.answer.answered.set(true);
    shown.answer.stop_following();
    shown.answer.closed.set(true);
    if shown.answer.presented.get()
        && let Some(alert) = shown.alert.load()
        && !alert.isBeingDismissed()
    {
        alert.dismissViewControllerAnimated_completion(true, None);
    }
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

/// `Clipboard.write`: puts `text` and `html` on the general pasteboard as
/// one item (plain text and `public.html`), as a browser copies them.
pub(crate) fn set_clipboard_html(text: &str, html: &str) {
    let kinds = [
        NSString::from_str("public.utf8-plain-text"),
        NSString::from_str("public.html"),
    ];
    let values = [NSString::from_str(text), NSString::from_str(html)];
    let kinds: Vec<&NSString> = kinds.iter().map(|k| &**k).collect();
    let values: Vec<&AnyObject> = values.iter().map(|v| v.as_ref()).collect();
    let item = NSDictionary::from_slices(&kinds, &values);
    let board = objc2_ui_kit::UIPasteboard::generalPasteboard();
    // SAFETY: UIPasteboard's setter of items (type to value).
    let _: () = unsafe {
        objc2::msg_send![&board, setItems: &*objc2_foundation::NSArray::from_retained_slice(&[item])]
    };
}

/// `Clipboard.readText` / `hasText`: whether the general pasteboard
/// holds text and, unless `has_only`, the text. `hasStrings` does not read
/// it, so it shows no paste notice.
///
/// The third value says the person refused the read: iOS's paste prompt
/// answered with Don't Allow Paste (or pasting from other apps denied in
/// Settings) leaves `string` `nil` while `hasStrings` still says the
/// board holds text.
pub(crate) fn read_clipboard(has_only: bool) -> (bool, Option<String>, bool) {
    let board = objc2_ui_kit::UIPasteboard::generalPasteboard();
    if has_only {
        // SAFETY: a plain getter.
        return (unsafe { board.hasStrings() }, None, false);
    }
    // SAFETY: a plain getter.
    let text = unsafe { board.string() }.map(|s| s.to_string());
    // SAFETY: a plain getter, which shows no paste prompt.
    let denied = text.is_none() && unsafe { board.hasStrings() };
    (text.is_some(), text, denied)
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
/// its text, the same content as HTML ([`pasted_html`]), its images (as
/// they are in [`IMAGE_TYPES`], else PNG) and its local files' `file:` URLs
/// (Mac Catalyst).
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
        paste.html = pasted_html(board).unwrap_or_default();
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

/// The pasteboard's formatted content as HTML: `public.html` as browsers,
/// office suites and most editors copy it; else the main resource of a web
/// archive (Safari, Mail); else RTF (Notes, Pages, TextEdit on Mac
/// Catalyst), written as HTML by UIKit.
fn pasted_html(board: &objc2_ui_kit::UIPasteboard) -> Option<String> {
    let data = |kind: &str| board.dataForPasteboardType(&NSString::from_str(kind));
    if let Some(html) = data("public.html") {
        return Some(decode_text(&html.to_vec(), None));
    }
    if let Some(archive) = data("com.apple.webarchive")
        && let Some(html) = web_archive_html(&archive)
    {
        return Some(html);
    }
    // SAFETY: immutable UIKit constants.
    let (rtfd, rtf) = unsafe { (NSRTFDTextDocumentType, NSRTFTextDocumentType) };
    let (bytes, kind) = data("com.apple.flat-rtfd")
        .map(|d| (d, rtfd))
        .or_else(|| data("public.rtf").map(|d| (d, rtf)))?;
    // SAFETY: immutable UIKit constants.
    let (kind_option, kind_attribute, html) = unsafe {
        (
            NSDocumentTypeDocumentOption,
            NSDocumentTypeDocumentAttribute,
            NSHTMLTextDocumentType,
        )
    };
    let options =
        NSDictionary::<NSString, AnyObject>::from_slices(&[kind_option], &[kind.as_ref()]);
    // SAFETY: the options name the data's document type, as UIKit takes
    // them; no document attributes are asked for.
    let text = unsafe {
        NSAttributedString::initWithData_options_documentAttributes_error(
            NSAttributedString::alloc(),
            &bytes,
            &options,
            None,
        )
    }
    .ok()?;
    let attributes =
        NSDictionary::<NSString, AnyObject>::from_slices(&[kind_attribute], &[html.as_ref()]);
    // SAFETY: the attributes are the document type, as UIKit takes them.
    let data = unsafe {
        text.dataFromRange_documentAttributes_error(NSRange::new(0, text.length()), &attributes)
    }
    .ok()?;
    Some(String::from_utf8_lossy(&data.to_vec()).into_owned())
}

/// The HTML of a web archive's main resource (`WebMainResource`'s
/// `WebResourceData`), decoded as its `WebResourceTextEncodingName` says.
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
    let main = plist
        .downcast_ref::<NSDictionary>()?
        .objectForKey(&NSString::from_str("WebMainResource"))?;
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

/// `Haptics` of `nsh/mobile`: UIKit's feedback generator for `haptic`
/// plays it (nothing on devices without a Taptic Engine, or with system
/// haptics off).
// `initWithStyle:` is deprecated from iOS 17.5 for `feedbackGeneratorForView:`,
// which iOS 15 lacks.
#[allow(deprecated)]
pub(crate) fn haptic(haptic: nsh_core::Haptic) {
    use nsh_core::{Haptic, HapticImpact, HapticNotification};
    use objc2_ui_kit::{
        UIImpactFeedbackGenerator, UIImpactFeedbackStyle, UINotificationFeedbackGenerator,
        UINotificationFeedbackType, UISelectionFeedbackGenerator,
    };
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let impact = |style| {
        UIImpactFeedbackGenerator::initWithStyle(mtm.alloc(), style).impactOccurred();
    };
    let notification = |kind| UINotificationFeedbackGenerator::new(mtm).notificationOccurred(kind);
    match haptic {
        Haptic::Selection => UISelectionFeedbackGenerator::new(mtm).selectionChanged(),
        Haptic::Impact(HapticImpact::Light) => impact(UIImpactFeedbackStyle::Light),
        Haptic::Impact(HapticImpact::Medium) => impact(UIImpactFeedbackStyle::Medium),
        Haptic::Impact(HapticImpact::Heavy) => impact(UIImpactFeedbackStyle::Heavy),
        Haptic::Impact(HapticImpact::Soft) => impact(UIImpactFeedbackStyle::Soft),
        Haptic::Impact(HapticImpact::Rigid) => impact(UIImpactFeedbackStyle::Rigid),
        Haptic::Notification(HapticNotification::Success) => {
            notification(UINotificationFeedbackType::Success)
        }
        Haptic::Notification(HapticNotification::Warning) => {
            notification(UINotificationFeedbackType::Warning)
        }
        Haptic::Notification(HapticNotification::Error) => {
            notification(UINotificationFeedbackType::Error)
        }
        // `Haptic`, `HapticImpact` and `HapticNotification` are non-exhaustive.
        _ => {}
    }
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

#[cfg(test)]
mod tests {
    use super::alert_tint;

    /// A surface's alert tint comes from its own tokens alone (each
    /// `Mounter` keeps its own): a themed surface tints with its `primary`,
    /// one without a theme keeps the system's.
    #[test]
    fn a_surfaces_alert_tint_comes_from_its_own_tokens() {
        let plain = nsh_base::tokens_of(None).unwrap();
        let mut themed = plain.clone();
        let ink = plain.color("foreground").unwrap();
        themed.set_color("primary", ink);

        let a = alert_tint(&themed);
        let b = alert_tint(&plain);

        assert_eq!(a, Some(ink));
        assert_eq!(b, None);
    }
}
