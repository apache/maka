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

//! The screenshot stage: the display its window covers, frozen, to select a region of.
//!
//! The picture stays on the native side: the stage draws it, reads its pixels and puts the
//! selection on the pasteboard. The UI opens one stage per display and closes them all when one
//! reports `copied` or `cancel`.

mod area;

use area::{Area, Edges, Pixel, target};
use block2::RcBlock;
use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_engine::JsonValue;
use nsh_platform_macos::{
    ComponentContext, Components, NativeComponent,
    objc2::{
        AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class,
        msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject},
    },
    objc2_app_kit::{
        NSAutoresizingMaskOptions, NSBezierPath, NSBitmapImageFileType, NSBitmapImageRep, NSColor,
        NSColorSpace, NSCursor, NSEvent, NSEventModifierFlags, NSFont, NSFontAttributeName,
        NSForegroundColorAttributeName, NSGraphicsContext, NSImage, NSImageInterpolation,
        NSImageScaling, NSImageView, NSPasteboard, NSPasteboardTypePNG, NSPasteboardTypeString,
        NSPasteboardTypeTIFF, NSResponder, NSScreen, NSStringDrawing, NSTrackingArea,
        NSTrackingAreaOptions, NSView, NSWindingRule, NSWorkspace,
    },
    objc2_foundation::{
        NSArray, NSBundle, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSPoint,
        NSRect, NSSize, NSString,
    },
};
use objc2_core_foundation::{CFRetained, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGDirectDisplayID, CGDisplayBounds, CGImage, CGPreflightScreenCaptureAccess,
    CGRequestScreenCaptureAccess, CGWarpMouseCursorPosition, CGWindowListCopyWindowInfo,
    CGWindowListOption,
};
use objc2_screen_capture_kit::{
    SCCaptureResolutionType, SCContentFilter, SCScreenshotManager, SCShareableContent,
    SCStreamConfiguration, SCWindow,
};
use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
    sync::Arc,
};

const NAME: &str = "maka.screenshot";
/// Points from the selection's border that still grab it.
const BORDER_SLOP: f64 = 6.0;
const HANDLE: f64 = 6.0;
/// A press that moves less than this many points is a click: it takes the hovered target.
const CLICK_SLOP: f64 = 3.0;
/// Pixels across the magnifier, odd so that one is in the middle.
const LOUPE_PIXELS: i64 = 15;
const LOUPE_CELL: f64 = 8.0;
/// Windows smaller than this many points on a side are not targets (shadows, slivers).
const SMALLEST_WINDOW: f64 = 8.0;

pub(crate) fn register(components: &Components, mtm: MainThreadMarker) {
    components.register(
        NAME,
        Rc::new(move |context| Box::new(StageComponent::new(mtm, context))),
    );
}

/// The frozen display.
struct Shot {
    image: CFRetained<CGImage>,
    /// Picture pixels per point.
    scale: f64,
    whole: Area,
    /// The on-screen windows, front to back.
    windows: Vec<Area>,
    /// The display's top left in global points, from the primary display's top left.
    origin: CGPoint,
}

impl Shot {
    fn rect(&self, area: Area) -> NSRect {
        NSRect::new(
            NSPoint::new(area.x as f64 / self.scale, area.y as f64 / self.scale),
            NSSize::new(
                area.width as f64 / self.scale,
                area.height as f64 / self.scale,
            ),
        )
    }

    fn pixel(&self, point: NSPoint) -> Pixel {
        (
            ((point.x * self.scale).floor() as i64).clamp(0, self.whole.right()),
            ((point.y * self.scale).floor() as i64).clamp(0, self.whole.bottom()),
        )
    }

    fn crop(&self, area: Area) -> Option<CFRetained<CGImage>> {
        let rect = CGRect::new(
            CGPoint::new(area.x as f64, area.y as f64),
            CGSize::new(area.width as f64, area.height as f64),
        );
        CGImage::with_image_in_rect(Some(&self.image), rect)
    }

    fn color(&self, pixel: Pixel) -> Option<String> {
        let one = self.crop(Area::spanning(pixel, pixel))?;
        let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &one);
        let color = rep
            .colorAtX_y(0, 0)?
            .colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        let byte = |c: f64| (c.clamp(0.0, 1.0) * 255.0).round() as u8;
        Some(format!(
            "#{:02X}{:02X}{:02X}",
            byte(color.redComponent()),
            byte(color.greenComponent()),
            byte(color.blueComponent())
        ))
    }
}

#[derive(Clone, Copy)]
enum Gesture {
    Idle,
    Drawing { anchor: Pixel, moved: bool },
    Moving { grab: Pixel, start: Area },
    Resizing { edges: Edges, start: Area },
}

enum Phase {
    /// Waiting for the picture while the screen shows through.
    Capturing,
    Frozen(Shot),
    /// The UI says why; any press or key closes the stage.
    Failed,
}

struct StageState {
    context: ComponentContext,
    picture: Retained<NSImageView>,
    phase: RefCell<Phase>,
    started: Cell<bool>,
    pointer: Cell<Pixel>,
    selection: Cell<Option<Area>>,
    gesture: Cell<Gesture>,
}

define_class!(
    #[unsafe(super(NSView, NSResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MakaScreenshotStage"]
    #[ivars = StageState]
    struct Stage;
    unsafe impl NSObjectProtocol for Stage {}
    impl Stage {
        #[unsafe(method(isFlipped))]
        fn is_flipped(&self) -> bool { true }
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool { true }
        #[unsafe(method(acceptsFirstMouse:))]
        fn accepts_first_mouse(&self, _event: Option<&NSEvent>) -> bool { true }
        #[unsafe(method(mouseDownCanMoveWindow))]
        fn mouse_down_can_move_window(&self) -> bool { false }
        #[unsafe(method(viewDidMoveToWindow))]
        fn view_did_move_to_window(&self) {
            if self.window().is_none() || self.ivars().started.replace(true) { return; }
            let stage = MainThreadBound::new(self.retain(), self.mtm());
            // The window is placed on its display once this turn of the run loop ends.
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
                stage.get(mtm).capture();
            });
        }
        #[unsafe(method(drawRect:))]
        fn draw_rect(&self, _dirty: NSRect) { self.draw(); }
        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, event: &NSEvent) {
            if let Some(window) = self.window() && !window.isKeyWindow() {
                window.makeKeyWindow();
                window.makeFirstResponder(Some(self));
            }
            NSCursor::crosshairCursor().set();
            self.hover(event);
        }
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) { self.press(event); }
        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) { self.drag(event); }
        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) { self.release(); }
        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, _event: &NSEvent) {
            // One step back at a time: first the selection, then the stage.
            if self.ivars().selection.take().is_some() {
                self.ivars().gesture.set(Gesture::Idle);
                self.setNeedsDisplay(true);
            } else {
                self.emit("cancel");
            }
        }
        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) { self.key(event); }
    }
);

impl Stage {
    fn new(mtm: MainThreadMarker, context: ComponentContext) -> Retained<Self> {
        let picture = NSImageView::new(mtm);
        picture.setImageScaling(NSImageScaling::ScaleAxesIndependently);
        let allocated = Self::alloc(mtm).set_ivars(StageState {
            context,
            picture,
            phase: RefCell::new(Phase::Capturing),
            started: Cell::new(false),
            pointer: Cell::new((0, 0)),
            selection: Cell::new(None),
            gesture: Cell::new(Gesture::Idle),
        });
        // SAFETY: NSView's designated initializer, with all subclass ivars initialized.
        let stage: Retained<Self> =
            unsafe { msg_send![super(allocated), initWithFrame: NSRect::ZERO] };
        // SAFETY: the owner is the view the area is added to, which keeps it no longer than itself.
        let tracking = unsafe {
            NSTrackingArea::initWithRect_options_owner_userInfo(
                NSTrackingArea::alloc(),
                NSRect::ZERO,
                NSTrackingAreaOptions::MouseMoved
                    | NSTrackingAreaOptions::ActiveAlways
                    | NSTrackingAreaOptions::InVisibleRect,
                Some(&stage),
                None,
            )
        };
        stage.addTrackingArea(&tracking);
        stage
    }

    fn emit(&self, name: &str) {
        self.ivars().context.emit(name, JsonValue::Null);
    }

    fn fail(&self, message: String, permission: bool) {
        *self.ivars().phase.borrow_mut() = Phase::Failed;
        self.ivars().context.emit(
            "failed",
            serde_json::json!({ "message": message, "permission": permission }),
        );
    }

    fn capture(&self) {
        let Some(window) = self.window() else { return };
        window.makeFirstResponder(Some(self));
        let Some(screen) = window.screen() else {
            return self.fail("the screenshot window is on no display".into(), false);
        };
        if AnyClass::get(c"SCScreenshotManager").is_none() {
            return self.fail("screenshots need macOS 14 or later".into(), false);
        }
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess();
            return self.fail("Screen Recording permission is missing".into(), true);
        }
        let Some(display) = display_of(&screen) else {
            return self.fail("the display has no display ID".into(), false);
        };
        let scale = screen.backingScaleFactor();
        let origin = CGDisplayBounds(display).origin;
        let windows = windows_on(origin, scale);
        let stage = Arc::new(MainThreadBound::new(self.retain(), self.mtm()));
        let found = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                // SAFETY: ScreenCaptureKit passes content or an error, alive for the call.
                let request = match unsafe { content.as_ref() } {
                    Some(content) => request(content, display, scale),
                    None => Err(describe(error)),
                };
                let (filter, configuration) = match request {
                    Ok(request) => request,
                    Err(message) => return deliver(stage.clone(), Err(message)),
                };
                let stage = stage.clone();
                let windows = windows.clone();
                let taken = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
                    let shot = match NonNull::new(image) {
                        // SAFETY: a CGImage ScreenCaptureKit owns; retained to keep it past the call.
                        Some(image) => Ok(unsafe { CFRetained::retain(image) }),
                        None => Err(describe(error)),
                    }
                    .map(|image| Shot {
                        whole: Area {
                            x: 0,
                            y: 0,
                            width: CGImage::width(Some(&image)) as i64,
                            height: CGImage::height(Some(&image)) as i64,
                        },
                        image,
                        scale,
                        windows: windows.clone(),
                        origin,
                    });
                    deliver(stage.clone(), shot);
                });
                // SAFETY: the filter and configuration are built above; the block lives until it runs.
                unsafe {
                    SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(
                        &filter,
                        &configuration,
                        Some(&taken),
                    );
                }
            },
        );
        // SAFETY: the block takes the documented content-or-error arguments.
        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                false, true, &found,
            );
        }
    }

    fn freeze(&self, mut shot: Shot) {
        if !matches!(*self.ivars().phase.borrow(), Phase::Capturing) {
            return;
        }
        let whole = shot.whole;
        let smallest = (SMALLEST_WINDOW * shot.scale) as i64;
        shot.windows = shot
            .windows
            .iter()
            .filter_map(|window| window.intersection(whole))
            .filter(|window| window.width >= smallest && window.height >= smallest)
            .collect();
        let size = NSSize::new(
            whole.width as f64 / shot.scale,
            whole.height as f64 / shot.scale,
        );
        let image = NSImage::initWithCGImage_size(NSImage::alloc(), &shot.image, size);
        self.ivars().picture.setImage(Some(&image));
        *self.ivars().phase.borrow_mut() = Phase::Frozen(shot);
        self.setNeedsDisplay(true);
        self.emit("ready");
    }

    fn pixel(&self, event: &NSEvent) -> Option<Pixel> {
        let point = self.convertPoint_fromView(event.locationInWindow(), None);
        match &*self.ivars().phase.borrow() {
            Phase::Frozen(shot) => Some(shot.pixel(point)),
            _ => None,
        }
    }

    fn hover(&self, event: &NSEvent) {
        if let Some(pixel) = self.pixel(event) {
            self.ivars().pointer.set(pixel);
            self.setNeedsDisplay(true);
        }
    }

    /// Whether the press or key only closes the stage: it never froze.
    fn closes(&self) -> bool {
        match &*self.ivars().phase.borrow() {
            Phase::Frozen(_) => false,
            Phase::Capturing => false,
            Phase::Failed => true,
        }
    }

    fn press(&self, event: &NSEvent) {
        if self.closes() {
            return self.emit("cancel");
        }
        let Some(pixel) = self.pixel(event) else {
            return;
        };
        let state = self.ivars();
        state.pointer.set(pixel);
        let slop = self.points_to_pixels(BORDER_SLOP);
        if let Some(selection) = state.selection.get() {
            if event.clickCount() >= 2 && selection.contains(pixel) {
                return self.copy();
            }
            let edges = selection.edges_at(pixel, slop);
            if edges.any() {
                return state.gesture.set(Gesture::Resizing {
                    edges,
                    start: selection,
                });
            }
            if selection.contains(pixel) {
                return state.gesture.set(Gesture::Moving {
                    grab: pixel,
                    start: selection,
                });
            }
        } else if event.clickCount() >= 2 {
            return self.copy();
        }
        state.gesture.set(Gesture::Drawing {
            anchor: pixel,
            moved: false,
        });
    }

    fn drag(&self, event: &NSEvent) {
        let Some(pixel) = self.pixel(event) else {
            return;
        };
        let state = self.ivars();
        state.pointer.set(pixel);
        let Some(whole) = self.whole() else { return };
        match state.gesture.get() {
            Gesture::Idle => {}
            Gesture::Drawing { anchor, moved } => {
                let slop = self.points_to_pixels(CLICK_SLOP);
                if moved || (pixel.0 - anchor.0).abs() >= slop || (pixel.1 - anchor.1).abs() >= slop
                {
                    state.selection.set(Some(Area::spanning(anchor, pixel)));
                    state.gesture.set(Gesture::Drawing {
                        anchor,
                        moved: true,
                    });
                }
            }
            Gesture::Moving { grab, start } => state.selection.set(Some(
                start.moved((pixel.0 - grab.0, pixel.1 - grab.1), whole),
            )),
            Gesture::Resizing { edges, start } => {
                state.selection.set(Some(start.resized(edges, pixel)))
            }
        }
        self.setNeedsDisplay(true);
    }

    fn release(&self) {
        let state = self.ivars();
        if let Gesture::Drawing { moved: false, .. } = state.gesture.get() {
            state.selection.set(self.hovered());
        }
        state.gesture.set(Gesture::Idle);
        self.setNeedsDisplay(true);
    }

    fn key(&self, event: &NSEvent) {
        const ESCAPE: u16 = 53;
        const RETURN: u16 = 36;
        const ENTER: u16 = 76;
        const LEFT: u16 = 123;
        const RIGHT: u16 = 124;
        const DOWN: u16 = 125;
        const UP: u16 = 126;
        let code = event.keyCode();
        if code == ESCAPE || self.closes() {
            return self.emit("cancel");
        }
        let Some(whole) = self.whole() else { return };
        let step = match code {
            RETURN | ENTER => return self.copy(),
            LEFT => (-1, 0),
            RIGHT => (1, 0),
            UP => (0, -1),
            DOWN => (0, 1),
            _ => {
                let typed = event.charactersIgnoringModifiers();
                if typed.is_some_and(|typed| typed.to_string().eq_ignore_ascii_case("c")) {
                    self.copy_color();
                }
                return;
            }
        };
        let state = self.ivars();
        match state.selection.get() {
            Some(selection) if event.modifierFlags().contains(NSEventModifierFlags::Shift) => {
                let corner = (selection.right() + step.0, selection.bottom() + step.1);
                let corner = (corner.0.max(selection.x), corner.1.max(selection.y));
                let grown = Area::spanning((selection.x, selection.y), corner);
                state.selection.set(grown.intersection(whole));
            }
            Some(selection) => state.selection.set(Some(selection.moved(step, whole))),
            None => {
                let (x, y) = state.pointer.get();
                let pixel = (
                    (x + step.0).clamp(0, whole.right()),
                    (y + step.1).clamp(0, whole.bottom()),
                );
                state.pointer.set(pixel);
                self.warp(pixel);
            }
        }
        self.setNeedsDisplay(true);
    }

    fn warp(&self, pixel: Pixel) {
        if let Phase::Frozen(shot) = &*self.ivars().phase.borrow() {
            let at = CGPoint::new(
                shot.origin.x + (pixel.0 as f64 + 0.5) / shot.scale,
                shot.origin.y + (pixel.1 as f64 + 0.5) / shot.scale,
            );
            CGWarpMouseCursorPosition(at);
        }
    }

    fn whole(&self) -> Option<Area> {
        match &*self.ivars().phase.borrow() {
            Phase::Frozen(shot) => Some(shot.whole),
            _ => None,
        }
    }

    /// The window under the pointer, or the whole display.
    fn hovered(&self) -> Option<Area> {
        match &*self.ivars().phase.borrow() {
            Phase::Frozen(shot) => Some(target(
                &shot.windows,
                self.ivars().pointer.get(),
                shot.whole,
            )),
            _ => None,
        }
    }

    fn points_to_pixels(&self, points: f64) -> i64 {
        match &*self.ivars().phase.borrow() {
            Phase::Frozen(shot) => (points * shot.scale).round() as i64,
            _ => points as i64,
        }
    }

    fn copy(&self) {
        let area = self.ivars().selection.get().or_else(|| self.hovered());
        let copied = match (&*self.ivars().phase.borrow(), area) {
            (Phase::Frozen(shot), Some(area)) => shot
                .crop(area)
                .ok_or_else(|| "cannot crop the screenshot".to_owned())
                .and_then(|image| put_image(&image)),
            _ => return,
        };
        match copied {
            Ok(()) => self.emit("copied"),
            Err(message) => self.fail(message, false),
        }
    }

    fn copy_color(&self) {
        let color = match &*self.ivars().phase.borrow() {
            Phase::Frozen(shot) => shot.color(self.ivars().pointer.get()),
            _ => None,
        };
        if let Some(color) = color {
            let pasteboard = NSPasteboard::generalPasteboard();
            pasteboard.clearContents();
            // SAFETY: an extern static AppKit defines.
            pasteboard.setString_forType(&NSString::from_str(&color), unsafe {
                NSPasteboardTypeString
            });
            self.emit("copied");
        }
    }

    fn draw(&self) {
        let phase = self.ivars().phase.borrow();
        let Phase::Frozen(shot) = &*phase else { return };
        let state = self.ivars();
        let bounds = self.bounds();
        let selection = state.selection.get();
        let focus =
            selection.unwrap_or_else(|| target(&shot.windows, state.pointer.get(), shot.whole));
        let focus_rect = shot.rect(focus);

        let shade = NSBezierPath::bezierPathWithRect(bounds);
        shade.appendBezierPathWithRect(focus_rect);
        shade.setWindingRule(NSWindingRule::EvenOdd);
        NSColor::colorWithWhite_alpha(0.0, 0.45).setFill();
        shade.fill();

        let accent = NSColor::colorWithSRGBRed_green_blue_alpha(0.16, 0.56, 1.0, 1.0);
        accent.setStroke();
        let border = NSBezierPath::bezierPathWithRect(inset(focus_rect, 0.5));
        border.setLineWidth(1.0);
        border.stroke();

        let gesture = state.gesture.get();
        if selection.is_some() && !matches!(gesture, Gesture::Drawing { .. }) {
            for (x, y) in handles(focus_rect) {
                let handle = NSRect::new(
                    NSPoint::new(x - HANDLE / 2.0, y - HANDLE / 2.0),
                    NSSize::new(HANDLE, HANDLE),
                );
                accent.setFill();
                NSBezierPath::fillRect(handle);
                NSColor::whiteColor().setStroke();
                NSBezierPath::strokeRect(handle);
            }
        }

        let size = format!("{} × {}", focus.width, focus.height);
        let above = focus_rect.origin.y - 24.0;
        let at = NSPoint::new(
            focus_rect.origin.x,
            if above >= 0.0 {
                above
            } else {
                focus_rect.origin.y + 4.0
            },
        );
        label(&size, at);

        let selecting = matches!(gesture, Gesture::Drawing { .. } | Gesture::Resizing { .. });
        if selection.is_none() || selecting {
            loupe(shot, state.pointer.get(), bounds);
        }
    }
}

struct StageComponent {
    container: Retained<NSView>,
    stage: Retained<Stage>,
}

impl StageComponent {
    fn new(mtm: MainThreadMarker, context: ComponentContext) -> Self {
        let stage = Stage::new(mtm, context);
        let fill = NSAutoresizingMaskOptions::ViewWidthSizable
            | NSAutoresizingMaskOptions::ViewHeightSizable;
        let container = NSView::new(mtm);
        // The picture sits under the stage, which only draws the selection over it.
        stage.ivars().picture.setAutoresizingMask(fill);
        stage.setAutoresizingMask(fill);
        container.addSubview(&stage.ivars().picture);
        container.addSubview(&stage);
        Self { container, stage }
    }
}

impl NativeComponent for StageComponent {
    fn view(&self) -> Retained<NSView> {
        self.container.clone()
    }

    fn set_prop(&mut self, _name: &str, _value: Option<&JsonValue>) {}

    fn command(&mut self, name: &str, _args: &JsonValue) {
        // A build macOS has not seen is missing from the privacy list until it is dragged in.
        if name == "revealApplication" {
            let application = NSBundle::mainBundle().bundleURL();
            NSWorkspace::sharedWorkspace()
                .activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&[application]));
            // The stage floats above Finder.
            self.stage.emit("cancel");
        }
    }
}

fn deliver(stage: Arc<MainThreadBound<Retained<Stage>>>, shot: Result<Shot, String>) {
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
        let stage = stage.get(mtm);
        match shot {
            Ok(shot) => stage.freeze(shot),
            Err(message) => stage.fail(message, false),
        }
    });
}

fn describe(error: *mut NSError) -> String {
    // SAFETY: ScreenCaptureKit's error argument, null or alive for the call.
    match unsafe { error.as_ref() } {
        Some(error) => error.localizedDescription().to_string(),
        None => "ScreenCaptureKit returned no picture".into(),
    }
}

fn request(
    content: &SCShareableContent,
    display: CGDirectDisplayID,
    scale: f64,
) -> Result<(Retained<SCContentFilter>, Retained<SCStreamConfiguration>), String> {
    // SAFETY: plain property reads of the content ScreenCaptureKit handed over.
    unsafe {
        let screen = content
            .displays()
            .iter()
            .find(|candidate| candidate.displayID() == display)
            .ok_or("ScreenCaptureKit does not list the display")?;
        // Maka's floating windows: these stages and a launcher still fading out. Its
        // ordinary windows stay, so Maka can be captured too.
        let pid = std::process::id() as i32;
        let own: Vec<Retained<SCWindow>> = content
            .windows()
            .iter()
            .filter(|window| {
                window.windowLayer() != 0
                    && window
                        .owningApplication()
                        .is_some_and(|application| application.processID() == pid)
            })
            .collect();
        let filter = SCContentFilter::initWithDisplay_excludingWindows(
            SCContentFilter::alloc(),
            &screen,
            &NSArray::from_retained_slice(&own),
        );
        let configuration = SCStreamConfiguration::new();
        configuration.setWidth((screen.width() as f64 * scale).round() as usize);
        configuration.setHeight((screen.height() as f64 * scale).round() as usize);
        configuration.setShowsCursor(false);
        configuration.setCaptureResolution(SCCaptureResolutionType::Best);
        Ok((filter, configuration))
    }
}

fn display_of(screen: &NSScreen) -> Option<CGDirectDisplayID> {
    let number = screen
        .deviceDescription()
        .objectForKey(&NSString::from_str("NSScreenNumber"))?
        .downcast::<NSNumber>()
        .ok()?;
    Some(number.unsignedIntValue())
}

/// The on-screen windows of the normal level, front to back, in pixels of the display at `origin`.
fn windows_on(origin: CGPoint, scale: f64) -> Vec<Area> {
    let Some(list) = CGWindowListCopyWindowInfo(
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements,
        0,
    ) else {
        return Vec::new();
    };
    // SAFETY: CFArray is toll-free bridged to NSArray, and the window server's entries are
    // dictionaries with string keys; `list` outlives the borrow.
    let list: &NSArray<NSDictionary<NSString, AnyObject>> =
        unsafe { &*CFRetained::as_ptr(&list).as_ptr().cast() };
    let number = |info: &NSDictionary<NSString, AnyObject>, key: &str| {
        info.objectForKey(&NSString::from_str(key))?
            .downcast::<NSNumber>()
            .ok()
            .map(|number| number.doubleValue())
    };
    list.iter()
        .filter_map(|info| {
            if number(&info, "kCGWindowLayer")? != 0.0 || number(&info, "kCGWindowAlpha")? == 0.0 {
                return None;
            }
            let bounds = info
                .objectForKey(&NSString::from_str("kCGWindowBounds"))?
                .downcast::<NSDictionary>()
                .ok()?;
            // SAFETY: the window server keys a window's bounds by string.
            let bounds: Retained<NSDictionary<NSString, AnyObject>> =
                unsafe { Retained::cast_unchecked(bounds) };
            let pixel = |value: f64, start: f64| ((value - start) * scale).round() as i64;
            let left = number(&bounds, "X")?;
            let top = number(&bounds, "Y")?;
            let right = left + number(&bounds, "Width")?;
            let bottom = top + number(&bounds, "Height")?;
            (right > left && bottom > top).then(|| {
                Area::spanning(
                    (pixel(left, origin.x), pixel(top, origin.y)),
                    (pixel(right, origin.x) - 1, pixel(bottom, origin.y) - 1),
                )
            })
        })
        .collect()
}

fn put_image(image: &CGImage) -> Result<(), String> {
    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), image);
    // SAFETY: an empty property dictionary, which PNG encoding accepts.
    let png = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("cannot encode the screenshot as PNG")?;
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    // SAFETY: extern statics AppKit defines.
    unsafe {
        pasteboard.setData_forType(Some(&png), NSPasteboardTypePNG);
        if let Some(tiff) = rep.TIFFRepresentation() {
            pasteboard.setData_forType(Some(&tiff), NSPasteboardTypeTIFF);
        }
    }
    Ok(())
}

fn inset(rect: NSRect, by: f64) -> NSRect {
    NSRect::new(
        NSPoint::new(rect.origin.x + by, rect.origin.y + by),
        NSSize::new(
            (rect.size.width - 2.0 * by).max(0.0),
            (rect.size.height - 2.0 * by).max(0.0),
        ),
    )
}

fn handles(rect: NSRect) -> [(f64, f64); 8] {
    let (x, y) = (rect.origin.x, rect.origin.y);
    let (w, h) = (rect.size.width, rect.size.height);
    [
        (x, y),
        (x + w / 2.0, y),
        (x + w, y),
        (x, y + h / 2.0),
        (x + w, y + h / 2.0),
        (x, y + h),
        (x + w / 2.0, y + h),
        (x + w, y + h),
    ]
}

fn text_attributes() -> Retained<NSDictionary<NSString, AnyObject>> {
    let font = NSFont::monospacedDigitSystemFontOfSize_weight(12.0, 0.0);
    let color = NSColor::whiteColor();
    // SAFETY: extern statics AppKit defines.
    let keys = unsafe { [NSFontAttributeName, NSForegroundColorAttributeName] };
    NSDictionary::from_slices(&keys, &[&**font as &AnyObject, &**color as &AnyObject])
}

/// White text on a dark plate with its top left at `at`.
fn label(text: &str, at: NSPoint) {
    let text = NSString::from_str(text);
    let attributes = text_attributes();
    // SAFETY: string-keyed attributes with an NSFont and an NSColor.
    let size = unsafe { text.sizeWithAttributes(Some(&attributes)) };
    let plate = NSRect::new(at, NSSize::new(size.width + 12.0, size.height + 6.0));
    NSColor::colorWithWhite_alpha(0.0, 0.75).setFill();
    NSBezierPath::bezierPathWithRoundedRect_xRadius_yRadius(plate, 4.0, 4.0).fill();
    // SAFETY: as above.
    unsafe {
        text.drawAtPoint_withAttributes(NSPoint::new(at.x + 6.0, at.y + 3.0), Some(&attributes))
    };
}

/// The pixels around `pixel`, magnified next to it, with its position and color.
fn loupe(shot: &Shot, pixel: Pixel, bounds: NSRect) {
    let side = LOUPE_PIXELS as f64 * LOUPE_CELL;
    let info = 44.0;
    let pointer = NSPoint::new(pixel.0 as f64 / shot.scale, pixel.1 as f64 / shot.scale);
    let x = if pointer.x + 20.0 + side <= bounds.size.width {
        pointer.x + 20.0
    } else {
        pointer.x - 20.0 - side
    };
    let y = if pointer.y + 20.0 + side + info <= bounds.size.height {
        pointer.y + 20.0
    } else {
        pointer.y - 20.0 - side - info
    };
    let frame = NSRect::new(NSPoint::new(x, y), NSSize::new(side, side));
    NSColor::blackColor().setFill();
    NSBezierPath::fillRect(frame);

    let half = LOUPE_PIXELS / 2;
    let wanted = Area::spanning(
        (pixel.0 - half, pixel.1 - half),
        (pixel.0 + half, pixel.1 + half),
    );
    if let Some(shown) = wanted.intersection(shot.whole)
        && let Some(part) = shot.crop(shown)
    {
        let size = NSSize::new(shown.width as f64, shown.height as f64);
        let image = NSImage::initWithCGImage_size(NSImage::alloc(), &part, size);
        let target = NSRect::new(
            NSPoint::new(
                x + (shown.x - wanted.x) as f64 * LOUPE_CELL,
                y + (shown.y - wanted.y) as f64 * LOUPE_CELL,
            ),
            NSSize::new(
                shown.width as f64 * LOUPE_CELL,
                shown.height as f64 * LOUPE_CELL,
            ),
        );
        if let Some(context) = NSGraphicsContext::currentContext() {
            context.setImageInterpolation(NSImageInterpolation::None);
        }
        // SAFETY: no hints dictionary.
        unsafe {
            image.drawInRect_fromRect_operation_fraction_respectFlipped_hints(
                target,
                NSRect::ZERO,
                nsh_platform_macos::objc2_app_kit::NSCompositingOperation::Copy,
                1.0,
                true,
                None,
            );
        }
    }
    let center = NSRect::new(
        NSPoint::new(x + half as f64 * LOUPE_CELL, y + half as f64 * LOUPE_CELL),
        NSSize::new(LOUPE_CELL, LOUPE_CELL),
    );
    NSColor::whiteColor().setStroke();
    NSBezierPath::strokeRect(center);
    NSColor::colorWithWhite_alpha(1.0, 0.6).setStroke();
    NSBezierPath::strokeRect(inset(frame, 0.5));

    let color = shot.color(pixel).unwrap_or_default();
    label(
        &format!("{}, {}   {color}", pixel.0, pixel.1),
        NSPoint::new(x, y + side + 4.0),
    );
}
