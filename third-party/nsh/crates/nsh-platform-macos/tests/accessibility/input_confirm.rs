//! Semantic AppKit `AXConfirm` handling on native text inputs:
//! single-line (`NSTextField` / `NshFieldCell` / `NshFieldEditor`), masked
//! (`NSSecureTextField` / `NshSecureFieldCell`), multiline (`NSTextView`),
//! disabled/readonly guards, IME composition, and ordinary blur.

use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use nsh_core::{
    SubmitBehavior,
    element::{Root, input},
    prelude::*,
};
use nsh_platform_macos::{
    AppOptions, AppView,
    objc2::{
        MainThreadMarker, MainThreadOnly, Message, msg_send, rc::Retained, runtime::AnyObject, sel,
    },
    objc2_app_kit::{
        NSAccessibility, NSAccessibilityConfirmAction, NSApplication, NSBackingStoreType,
        NSTextField, NSTextInputClient, NSTextView, NSView, NSWindow, NSWindowStyleMask,
    },
    objc2_foundation::{NSArray, NSDate, NSPoint, NSRange, NSRect, NSRunLoop, NSSize, NSString},
};

static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn record(event: impl Into<String>) {
    EVENTS.lock().unwrap().push(event.into());
}

fn take_events() -> Vec<String> {
    std::mem::take(&mut *EVENTS.lock().unwrap())
}

#[component]
fn Screen() -> impl IntoElement {
    let draft = signal(String::from("https://example.com"));
    let field = |id: &'static str| input().test_id(id).w(px(260.0)).h(px(32.0));
    view()
        .flex_1()
        .gap(px(6.0))
        .child(
            field("submit")
                .value(draft)
                .submit_behavior(SubmitBehavior::Submit)
                .on_change(move |text: &str| draft.set(text.to_owned()))
                .on_key_press(|key: &str| record(format!("submit key:{key}")))
                .on_submit(|text: &str| record(format!("submit submit:{text}")))
                .on_blur(|| record("submit blur")),
        )
        .child(
            field("blur-submit")
                .default_value("blur-val")
                .submit_behavior(SubmitBehavior::BlurAndSubmit)
                .on_submit(|text: &str| record(format!("blur-submit submit:{text}")))
                .on_blur(|| record("blur-submit blur")),
        )
        .child(
            field("no-listener")
                .default_value("quiet")
                .submit_behavior(SubmitBehavior::Submit)
                .on_blur(|| record("no-listener blur")),
        )
        .child(
            field("multiline")
                .default_value("line1")
                .multiline(true)
                .submit_behavior(SubmitBehavior::Newline)
                .on_submit(|text: &str| record(format!("multiline submit:{text}")))
                .on_blur(|| record("multiline blur")),
        )
        .child(
            field("multiline-submit")
                .default_value("multi-ok")
                .multiline(true)
                .submit_behavior(SubmitBehavior::Submit)
                .on_submit(|text: &str| record(format!("multiline-submit submit:{text}"))),
        )
        .child(
            field("disabled")
                .default_value("locked")
                .disabled(true)
                .submit_behavior(SubmitBehavior::Submit)
                .on_submit(|text: &str| record(format!("disabled submit:{text}"))),
        )
        .child(
            field("readonly")
                .default_value("fixed")
                .readonly(true)
                .submit_behavior(SubmitBehavior::Submit)
                .on_submit(|text: &str| record(format!("readonly submit:{text}"))),
        )
        .child(
            field("secure")
                .default_value("s3cr3t")
                .masked(true)
                .submit_behavior(SubmitBehavior::Submit)
                .on_submit(|text: &str| record(format!("secure submit:{text}")))
                .on_blur(|| record("secure blur")),
        )
}

fn pump(ms: u64) {
    let deadline = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < deadline {
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(
            Instant::now() < deadline,
            "{what} timed out; events: {:?}",
            EVENTS.lock().unwrap()
        );
        pump(10);
    }
}

fn find_view(root: &NSView, matches: &dyn Fn(&NSView) -> bool) -> Option<Retained<NSView>> {
    if matches(root) {
        return Some(root.retain());
    }
    root.subviews()
        .iter()
        .find_map(|child| find_view(&child, matches))
}

fn find_by_id(root: &NSView, id: &str) -> Option<Retained<NSView>> {
    find_view(root, &|view| {
        view.accessibilityIdentifier()
            .is_some_and(|ident| ident.to_string() == id)
    })
}

fn find_field(root: &NSView, id: &str) -> Retained<NSTextField> {
    let container = find_by_id(root, id).unwrap_or_else(|| panic!("missing input {id}"));
    find_view(&container, &|view| {
        view.downcast_ref::<NSTextField>().is_some()
    })
    .unwrap_or_else(|| panic!("missing NSTextField for {id}"))
    .downcast::<NSTextField>()
    .unwrap()
}

fn find_text_view(root: &NSView, id: &str) -> Retained<NSTextView> {
    let container = find_by_id(root, id).unwrap_or_else(|| panic!("missing input {id}"));
    find_view(&container, &|view| {
        view.downcast_ref::<NSTextView>().is_some()
    })
    .unwrap_or_else(|| panic!("missing NSTextView for {id}"))
    .downcast::<NSTextView>()
    .unwrap()
}

fn confirm_allowed(object: &AnyObject) -> bool {
    // SAFETY: tested AppKit cell/view implements NSAccessibility.
    unsafe {
        msg_send![
            object,
            isAccessibilitySelectorAllowed: sel!(accessibilityPerformConfirm)
        ]
    }
}

fn perform_confirm(object: &AnyObject) -> bool {
    // SAFETY: tested AppKit cell/view implements accessibilityPerformConfirm.
    unsafe { msg_send![object, accessibilityPerformConfirm] }
}

fn perform_legacy_confirm(object: &AnyObject) {
    // SAFETY: immutable AppKit accessibility action constant and legacy dispatch selector.
    unsafe {
        let action: &NSString = NSAccessibilityConfirmAction;
        let _: () = msg_send![object, accessibilityPerformAction: action];
    }
}

fn confirm_action_count(object: &AnyObject) -> usize {
    // SAFETY: tested AppKit cell implements accessibilityActionNames.
    let actions: Option<Retained<NSArray<NSString>>> =
        unsafe { msg_send![object, accessibilityActionNames] };
    // SAFETY: immutable AppKit accessibility action constant.
    let confirm = unsafe { NSAccessibilityConfirmAction };
    actions
        .map(|list| list.iter().filter(|name| &**name == confirm).count())
        .unwrap_or(0)
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    let _application = NSApplication::sharedApplication(mtm);
    // SAFETY: ordinary AppKit window, kept alive until the test ends.
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(0., 0.), NSSize::new(400., 460.)),
            NSWindowStyleMask::Titled,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    let app = AppView::new(
        mtm,
        AppOptions {
            size: (400, 460),
            ..Default::default()
        },
    );
    window.setContentView(Some(&app.view()));
    window.orderFrontRegardless();
    app.load(Root::of::<Screen>().into());
    let root = app.view();
    until("inputs mounted", || find_by_id(&root, "secure").is_some());
    pump(40);
    take_events();

    // 1. Unfocused single-line input rejects AXConfirm and omits it from actions.
    let submit_field = find_field(&root, "submit");
    let submit_cell = submit_field.cell().expect("NSTextField cell");
    assert!(!confirm_allowed(&submit_cell));
    assert_eq!(confirm_action_count(&submit_cell), 0);
    assert!(!perform_confirm(&submit_cell));
    perform_legacy_confirm(&submit_cell);
    pump(40);
    assert!(
        take_events().is_empty(),
        "unfocused AXConfirm must not submit"
    );

    // 2. Focused SubmitBehavior::Submit advertises AXConfirm once and submits
    //    live draft without fabricating KeyPress("Enter") or blurring.
    assert!(window.makeFirstResponder(Some(&submit_field)));
    pump(40);
    let editor = submit_field
        .currentEditor()
        .expect("focused field editor")
        .downcast::<NSTextView>()
        .unwrap();
    editor.setString(&NSString::from_str("https://nsh.dev/docs"));
    pump(40);
    assert!(confirm_allowed(&submit_cell));
    assert_eq!(confirm_action_count(&submit_cell), 1);
    assert!(perform_confirm(&submit_cell));
    until("cell confirm submit", || {
        EVENTS
            .lock()
            .unwrap()
            .iter()
            .any(|e| e == "submit submit:https://nsh.dev/docs")
    });
    assert_eq!(take_events(), ["submit submit:https://nsh.dev/docs"]);
    assert!(
        submit_field.currentEditor().is_some(),
        "Submit must keep focus"
    );

    // Legacy accessibilityPerformAction:AXConfirm on the cell submits once too.
    perform_legacy_confirm(&submit_cell);
    until("legacy cell confirm submit", || {
        EVENTS
            .lock()
            .unwrap()
            .iter()
            .any(|e| e == "submit submit:https://nsh.dev/docs")
    });
    assert_eq!(take_events(), ["submit submit:https://nsh.dev/docs"]);
    assert!(submit_field.currentEditor().is_some());

    // Direct calls on the field and field editor each submit once.
    assert!(perform_confirm(&submit_field));
    until("field confirm submit", || {
        !EVENTS.lock().unwrap().is_empty()
    });
    assert_eq!(take_events(), ["submit submit:https://nsh.dev/docs"]);
    assert!(perform_confirm(&editor));
    until("editor confirm submit", || {
        !EVENTS.lock().unwrap().is_empty()
    });
    assert_eq!(take_events(), ["submit submit:https://nsh.dev/docs"]);

    // 3. IME composition: AXConfirm unmarks composition without submitting;
    //    subsequent AXConfirm submits once.
    let marked = NSString::from_str("한글");
    let caret = NSRange::new(marked.length(), 0);
    let replace = NSRange::new(objc2_foundation::NSNotFound as usize, 0);
    // SAFETY: NSTextInputClient method on the focused field editor.
    unsafe {
        let _: () = msg_send![
            &*editor,
            setMarkedText: &*marked,
            selectedRange: caret,
            replacementRange: replace
        ];
    }
    assert!(editor.hasMarkedText());
    pump(20);
    take_events();
    assert!(perform_confirm(&submit_cell));
    pump(40);
    assert!(!editor.hasMarkedText(), "AXConfirm must commit marked text");
    let ime_events = take_events();
    assert!(
        !ime_events
            .iter()
            .any(|e| e.starts_with("submit submit:") || e == "submit key:Enter"),
        "AXConfirm during IME composition must not submit or emit Enter: {ime_events:?}"
    );
    assert!(perform_confirm(&submit_cell));
    until("post-IME confirm submit", || {
        !EVENTS.lock().unwrap().is_empty()
    });
    assert_eq!(take_events(), ["submit submit:https://nsh.dev/docs한글"]);

    // 4. Ordinary blur emits only blur (0 submissions), then unfocused AXConfirm fails.
    assert!(window.makeFirstResponder(None));
    until("ordinary blur", || {
        EVENTS.lock().unwrap().iter().any(|e| e == "submit blur")
    });
    assert_eq!(take_events(), ["submit blur"]);
    assert!(!confirm_allowed(&submit_cell));
    assert!(!perform_confirm(&submit_cell));
    pump(40);
    assert!(take_events().is_empty());

    // 5. SubmitBehavior::BlurAndSubmit submits once and blurs.
    let blur_submit = find_field(&root, "blur-submit");
    let blur_submit_cell = blur_submit.cell().expect("blur-submit cell");
    assert!(window.makeFirstResponder(Some(&blur_submit)));
    pump(40);
    assert!(confirm_allowed(&blur_submit_cell));
    assert!(perform_confirm(&blur_submit_cell));
    until("blur-and-submit events", || {
        let events = EVENTS.lock().unwrap();
        events.iter().any(|e| e == "blur-submit submit:blur-val")
            && events.iter().any(|e| e == "blur-submit blur")
    });
    let events = take_events();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.starts_with("blur-submit submit:"))
            .count(),
        1
    );
    assert!(blur_submit.currentEditor().is_none());

    // 6. SubmitBehavior::Submit without on_submit listener rejects AXConfirm
    //    and does not fall through to AppKit blur.
    let no_listener = find_field(&root, "no-listener");
    let no_listener_cell = no_listener.cell().expect("no-listener cell");
    assert!(window.makeFirstResponder(Some(&no_listener)));
    pump(40);
    assert!(!confirm_allowed(&no_listener_cell));
    assert_eq!(confirm_action_count(&no_listener_cell), 0);
    assert!(!perform_confirm(&no_listener_cell));
    perform_legacy_confirm(&no_listener_cell);
    pump(40);
    assert!(
        no_listener.currentEditor().is_some(),
        "rejected legacy AXConfirm must not fall through to AppKit blur"
    );
    assert!(take_events().is_empty());

    // 7. Multiline Newline rejects AXConfirm; multiline Submit accepts it.
    let multiline = find_text_view(&root, "multiline");
    assert!(window.makeFirstResponder(Some(&multiline)));
    pump(40);
    take_events();
    assert!(!confirm_allowed(&multiline));
    assert!(!perform_confirm(&multiline));
    perform_legacy_confirm(&multiline);
    pump(40);
    assert_eq!(take_events(), Vec::<String>::new());

    let multiline_submit = find_text_view(&root, "multiline-submit");
    assert!(window.makeFirstResponder(Some(&multiline_submit)));
    pump(40);
    take_events();
    assert!(confirm_allowed(&multiline_submit));
    assert!(perform_confirm(&multiline_submit));
    until("multiline submit", || !EVENTS.lock().unwrap().is_empty());
    assert_eq!(take_events(), ["multiline-submit submit:multi-ok"]);

    // 8. Disabled and readonly fields reject AXConfirm.
    for id in ["disabled", "readonly"] {
        let f = find_field(&root, id);
        let cell = f.cell().expect("cell");
        let _ = window.makeFirstResponder(Some(&f));
        pump(30);
        take_events();
        assert!(!confirm_allowed(&cell), "{id} must reject AXConfirm");
        assert!(!perform_confirm(&cell), "{id} must not confirm");
        perform_legacy_confirm(&cell);
        pump(30);
        assert_eq!(take_events(), Vec::<String>::new(), "{id} must not submit");
    }

    // 9. Masked SecureField uses NshSecureFieldCell and submits once on AXConfirm.
    let secure = find_field(&root, "secure");
    let secure_cell = secure.cell().expect("secure cell");
    assert_eq!(
        secure_cell.class().name().to_str().unwrap(),
        "NshSecureFieldCell"
    );
    assert!(window.makeFirstResponder(Some(&secure)));
    pump(40);
    take_events();
    assert!(confirm_allowed(&secure_cell));
    assert_eq!(confirm_action_count(&secure_cell), 1);
    assert!(perform_confirm(&secure_cell));
    until("secure confirm submit", || {
        !EVENTS.lock().unwrap().is_empty()
    });
    assert_eq!(take_events(), ["secure submit:s3cr3t"]);
    assert!(secure.currentEditor().is_some());

    window.close();
    println!("input AXConfirm accessibility: ok");
}
