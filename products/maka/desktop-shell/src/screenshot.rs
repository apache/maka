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
//! The picture stays on the native side: the stage draws it and the marks made on it, and copies,
//! saves or pins the selection. The UI opens one stage per display, shows the tools for the
//! selection it reports, and closes them all when one reports `done` or `cancel`.

mod annotate;
mod area;
mod elements;
mod output;
mod paint;
mod pin;
mod shapes;

use annotate::{Ink, Mark, Marks, Shape, Size, Tool};
use area::{Area, Edges, Pixel, Window, edges_near, snap, targets};
use block2::RcBlock;
use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_engine::{HostCall, JsonValue};
use nsh_platform_macos::{
    ComponentContext, Components, NativeComponent,
    objc2::{
        AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class,
        msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject},
        sel,
    },
    objc2_app_kit::{
        NSApplication, NSAutoresizingMaskOptions, NSBezierPath, NSBitmapImageRep, NSColor,
        NSColorSpace, NSCursor, NSEvent, NSEventModifierFlags, NSFocusRingType, NSFont,
        NSFontAttributeName, NSForegroundColorAttributeName, NSGraphicsContext, NSImage,
        NSImageInterpolation, NSImageScaling, NSImageView, NSModalResponse, NSModalResponseOK,
        NSOpenPanel, NSPasteboard, NSPasteboardTypeString, NSPopUpMenuWindowLevel, NSResponder,
        NSScreen, NSStringDrawing, NSTextField, NSTrackingArea, NSTrackingAreaOptions, NSView,
        NSWindingRule, NSWorkspace,
    },
    objc2_foundation::{
        NSArray, NSBundle, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSPoint,
        NSRect, NSSize, NSString, NSURL,
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
use paint::{Canvas, inset};
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
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
/// Points a box seen in the picture spans on each side; boxed letters (口, 回) are smaller.
const SMALLEST_SHAPE: f64 = 16.0;
/// Points within which a dragged corner sticks to a window or control edge.
const SNAP: f64 = 5.0;
/// Scrolled points that walk one target out or in; a wheel notch always does.
const SCROLL_STEP: f64 = 24.0;

/// Answers `screenshot.chooseFolder` with a folder from an open panel, or null when cancelled.
/// The panel floats above the launcher it is asked from, which floats above other windows.
pub(crate) fn choose_folder(call: HostCall) {
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
        let panel = NSOpenPanel::openPanel(mtm);
        panel.setCanChooseFiles(false);
        panel.setCanChooseDirectories(true);
        panel.setCanCreateDirectories(true);
        panel.setAllowsMultipleSelection(false);
        panel.setLevel(NSPopUpMenuWindowLevel);
        if let Some(current) = call.data()["current"].as_str() {
            panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(current))));
        }
        // The launcher never activates Maka, and the panel takes no keys until it does.
        NSApplication::sharedApplication(mtm).activate();
        let chosen = panel.clone();
        let call = Cell::new(Some(call));
        let handler = RcBlock::new(move |response: NSModalResponse| {
            let Some(call) = call.take() else { return };
            let path = (response == NSModalResponseOK)
                .then(|| chosen.URL())
                .flatten()
                .and_then(|url| url.path())
                .map(|path| path.to_string());
            call.resolve(path.map_or(JsonValue::Null, JsonValue::from));
        });
        panel.beginWithCompletionHandler(&handler);
    });
}

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
    windows: Vec<Window>,
    /// The display's top left in global points, from the primary display's top left.
    origin: CGPoint,
}

impl Shot {
    /// Draws in the stage's points.
    fn canvas(&self) -> Canvas<'_> {
        Canvas {
            picture: &self.image,
            whole: self.whole,
            origin: (0, 0),
            zoom: 1.0 / self.scale,
        }
    }

    fn rect(&self, area: Area) -> NSRect {
        self.canvas().rect(area)
    }

    /// The part of the picture under `rect`, in global points.
    fn area(&self, rect: CGRect) -> Option<Area> {
        pixels(rect, self.origin, self.scale)?.intersection(self.whole)
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
    Marking { anchor: Pixel },
}

/// Text being typed onto the picture.
struct Editing {
    field: Retained<NSTextField>,
    at: Pixel,
    ink: Ink,
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
    /// How many targets out from the smallest under the pointer, walked by scrolling.
    depth: Cell<usize>,
    smallest: Cell<Option<Area>>,
    scrolled: Cell<f64>,
    selection: Cell<Option<Area>>,
    /// The selection the UI last heard of.
    announced: Cell<Option<Area>>,
    gesture: Cell<Gesture>,
    tool: Cell<Option<Tool>>,
    color: Cell<[u8; 3]>,
    size: Cell<Size>,
    marks: RefCell<Marks>,
    draft: RefCell<Option<Mark>>,
    editing: RefCell<Option<Editing>>,
    /// Where Save puts the picture; macOS's screenshot folder when unset.
    folder: RefCell<Option<PathBuf>>,
    /// Whether boxes seen in the picture are targets, besides windows and their controls.
    picture_boxes: Cell<bool>,
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
                self.focus();
            }
            self.hover(event);
            let typing = self.ivars().tool.get() == Some(Tool::Text)
                && self.ivars().selection.get().is_some_and(|area| area.contains(self.ivars().pointer.get()));
            if typing { NSCursor::IBeamCursor() } else { NSCursor::crosshairCursor() }.set();
        }
        #[unsafe(method(scrollWheel:))]
        fn scroll_wheel(&self, event: &NSEvent) { self.scroll(event); }
        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) { self.press(event); }
        #[unsafe(method(mouseDragged:))]
        fn mouse_dragged(&self, event: &NSEvent) { self.drag(event); }
        #[unsafe(method(mouseUp:))]
        fn mouse_up(&self, _event: &NSEvent) { self.release(); }
        #[unsafe(method(rightMouseDown:))]
        fn right_mouse_down(&self, _event: &NSEvent) {
            // One step back at a time: first the selection and its marks, then the stage.
            self.commit_text();
            let state = self.ivars();
            if state.selection.take().is_some() {
                state.gesture.set(Gesture::Idle);
                state.marks.borrow_mut().clear();
                state.draft.take();
                self.announce();
                self.setNeedsDisplay(true);
            } else {
                self.emit("cancel");
            }
        }
        #[unsafe(method(keyDown:))]
        fn key_down(&self, event: &NSEvent) { self.key(event); }
        #[unsafe(method(commitText:))]
        fn commit_text_action(&self, _sender: Option<&AnyObject>) { self.commit_text(); }
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
            depth: Cell::new(0),
            smallest: Cell::new(None),
            scrolled: Cell::new(0.0),
            selection: Cell::new(None),
            announced: Cell::new(None),
            gesture: Cell::new(Gesture::Idle),
            tool: Cell::new(None),
            color: Cell::new([0xFF, 0x3B, 0x30]),
            size: Cell::new(Size::Medium),
            marks: RefCell::new(Marks::default()),
            draft: RefCell::new(None),
            editing: RefCell::new(None),
            folder: RefCell::new(None),
            picture_boxes: Cell::new(true),
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

    /// Takes the keys back from the toolbar, unless text is being typed.
    fn focus(&self) {
        if self.ivars().editing.borrow().is_none()
            && let Some(window) = self.window()
        {
            window.makeFirstResponder(Some(self));
        }
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
        let sources = windows_on();
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
                let sources = sources.clone();
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
                        windows: Vec::new(),
                        origin,
                    });
                    deliver(stage.clone(), shot.map(|shot| (shot, sources.clone())));
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

    fn freeze(&self, mut shot: Shot, sources: Vec<elements::Source>) {
        if !matches!(*self.ivars().phase.borrow(), Phase::Capturing) {
            return;
        }
        let whole = shot.whole;
        let smallest = (SMALLEST_WINDOW * shot.scale) as i64;
        let (windows, sources): (Vec<Window>, Vec<elements::Source>) = sources
            .into_iter()
            .filter_map(|source| {
                let area = shot.area(source.bounds)?;
                (area.width >= smallest && area.height >= smallest).then(|| {
                    let window = Window {
                        area,
                        elements: Vec::new(),
                    };
                    (window, source)
                })
            })
            .unzip();
        shot.windows = windows;
        let picture = shot.image.clone();
        let smallest_shape = (SMALLEST_SHAPE * shot.scale) as i64;
        let size = NSSize::new(
            whole.width as f64 / shot.scale,
            whole.height as f64 / shot.scale,
        );
        let image = NSImage::initWithCGImage_size(NSImage::alloc(), &shot.image, size);
        self.ivars().picture.setImage(Some(&image));
        *self.ivars().phase.borrow_mut() = Phase::Frozen(shot);
        self.setNeedsDisplay(true);
        let trusted = elements::trusted();
        self.ivars()
            .context
            .emit("ready", serde_json::json!({ "elements": trusted }));
        if trusted {
            self.in_background(
                move || elements::scan(&sources),
                |stage, found| stage.found(found),
            );
        }
        if self.ivars().picture_boxes.get() {
            self.in_background(
                move || shapes::find(&picture, smallest_shape),
                |stage, found| stage.shapes(found),
            );
        }
    }

    /// Runs `work` off the main thread and hands its result to `then` on it.
    fn in_background<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
        then: impl FnOnce(&Self, T) + Send + 'static,
    ) {
        let stage = MainThreadBound::new(self.retain(), self.mtm());
        std::thread::spawn(move || {
            let result = work();
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
                then(stage.get(mtm), result);
            });
        });
    }

    /// The controls in each frozen window, in global points.
    fn found(&self, found: Vec<Vec<CGRect>>) {
        let mut phase = self.ivars().phase.borrow_mut();
        let Phase::Frozen(shot) = &mut *phase else {
            return;
        };
        let (origin, scale, whole) = (shot.origin, shot.scale, shot.whole);
        for (window, rects) in shot.windows.iter_mut().zip(found) {
            let bounds = window.area;
            let areas = rects
                .into_iter()
                .filter_map(|rect| pixels(rect, origin, scale)?.intersection(whole))
                .filter_map(|area| area.intersection(bounds));
            window.add(areas);
        }
        drop(phase);
        self.setNeedsDisplay(true);
    }

    /// Boxes seen in the picture, each given to the front-most window it lies in.
    fn shapes(&self, found: Vec<Area>) {
        let mut phase = self.ivars().phase.borrow_mut();
        let Phase::Frozen(shot) = &mut *phase else {
            return;
        };
        let mut given = vec![Vec::new(); shot.windows.len()];
        for area in found {
            let inside = |window: &Window| window.area.intersection(area) == Some(area);
            if let Some(index) = shot.windows.iter().position(inside) {
                given[index].push(area);
            }
        }
        for (window, areas) in shot.windows.iter_mut().zip(given) {
            window.add(areas);
        }
        drop(phase);
        self.setNeedsDisplay(true);
    }

    fn pixel(&self, event: &NSEvent) -> Option<Pixel> {
        let point = self.convertPoint_fromView(event.locationInWindow(), None);
        match &*self.ivars().phase.borrow() {
            Phase::Frozen(shot) => Some(shot.pixel(point)),
            _ => None,
        }
    }

    fn hover(&self, event: &NSEvent) {
        let Some(pixel) = self.pixel(event) else {
            return;
        };
        let state = self.ivars();
        state.pointer.set(pixel);
        // Moving onto another control starts the walk out from it again.
        let smallest = self.targets().first().copied();
        if state.smallest.replace(smallest) != smallest {
            state.depth.set(0);
        }
        self.setNeedsDisplay(true);
    }

    fn scroll(&self, event: &NSEvent) {
        let state = self.ivars();
        if state.selection.get().is_some() {
            return;
        }
        let step = if event.hasPreciseScrollingDeltas() {
            SCROLL_STEP
        } else {
            f64::MIN_POSITIVE
        };
        let scrolled = state.scrolled.get() + event.scrollingDeltaY();
        if scrolled.abs() < step {
            return state.scrolled.set(scrolled);
        }
        state.scrolled.set(0.0);
        let deepest = self.targets().len().saturating_sub(1);
        let depth = state.depth.get();
        state.depth.set(if scrolled > 0.0 {
            (depth + 1).min(deepest)
        } else {
            depth.saturating_sub(1)
        });
        self.setNeedsDisplay(true);
    }

    fn snapped(&self, pixel: Pixel, event: &NSEvent) -> Pixel {
        if event.modifierFlags().contains(NSEventModifierFlags::Option) {
            return pixel;
        }
        let slop = self.points_to_pixels(SNAP);
        match &*self.ivars().phase.borrow() {
            Phase::Frozen(shot) => snap(pixel, &edges_near(&shot.windows, pixel, shot.whole), slop),
            _ => pixel,
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
        self.commit_text();
        let Some(pixel) = self.pixel(event) else {
            return;
        };
        let state = self.ivars();
        state.pointer.set(pixel);
        let slop = self.points_to_pixels(BORDER_SLOP);
        if let Some(selection) = state.selection.get() {
            let tool = state.tool.get();
            if tool.is_none() && event.clickCount() >= 2 && selection.contains(pixel) {
                return self.copy();
            }
            let edges = selection.edges_at(pixel, slop);
            if edges.any() {
                state.gesture.set(Gesture::Resizing {
                    edges,
                    start: selection,
                });
                return self.announce();
            }
            if let Some(tool) = tool {
                if selection.contains(pixel) {
                    self.mark(tool, pixel);
                }
                return;
            }
            if selection.contains(pixel) {
                state.gesture.set(Gesture::Moving {
                    grab: pixel,
                    start: selection,
                });
                return self.announce();
            }
        } else if event.clickCount() >= 2 {
            return self.copy();
        }
        state.gesture.set(Gesture::Drawing {
            anchor: self.snapped(pixel, event),
            moved: false,
        });
    }

    fn ink(&self) -> Option<Ink> {
        let state = self.ivars();
        match &*state.phase.borrow() {
            Phase::Frozen(shot) => Some(Ink {
                color: state.color.get(),
                size: state.size.get(),
                scale: shot.scale,
            }),
            _ => None,
        }
    }

    fn mark(&self, tool: Tool, at: Pixel) {
        let Some(ink) = self.ink() else { return };
        let state = self.ivars();
        match tool {
            Tool::Text => self.edit_text(at, ink),
            Tool::Number => {
                let mut marks = state.marks.borrow_mut();
                let number = marks.next_number();
                marks.add(Mark {
                    shape: Shape::Number { at, number },
                    ink,
                });
            }
            _ => {
                *state.draft.borrow_mut() = Mark::dragged(tool, at, ink);
                state.gesture.set(Gesture::Marking { anchor: at });
            }
        }
        self.setNeedsDisplay(true);
    }

    fn edit_text(&self, at: Pixel, ink: Ink) {
        let state = self.ivars();
        let (Some(selection), Some(window)) = (state.selection.get(), self.window()) else {
            return;
        };
        let (corner, right) = match &*state.phase.borrow() {
            Phase::Frozen(shot) => {
                let selection = shot.rect(selection);
                let corner = shot.rect(Area::spanning(at, at)).origin;
                (corner, selection.origin.x + selection.size.width)
            }
            _ => return,
        };
        let field = NSTextField::new(self.mtm());
        field.setBezeled(false);
        field.setBordered(false);
        field.setDrawsBackground(false);
        field.setFocusRingType(NSFocusRingType::None);
        style_field(&field, ink);
        if let Some(cell) = field.cell() {
            // Clicking away or choosing another tool keeps the text, as Return does.
            cell.setSendsActionOnEndEditing(true);
            cell.setScrollable(true);
        }
        // SAFETY: the stage answers `commitText:` and outlives the field it holds.
        unsafe {
            field.setTarget(Some(self));
            field.setAction(Some(sel!(commitText:)));
        }
        let height = (ink.size.font() * 1.5).ceil();
        // The field draws its text two points in from its left edge.
        field.setFrame(NSRect::new(
            NSPoint::new(corner.x - 2.0, corner.y),
            NSSize::new((right - corner.x).max(120.0), height),
        ));
        self.addSubview(&field);
        window.makeFirstResponder(Some(&field));
        *state.editing.borrow_mut() = Some(Editing { field, at, ink });
    }

    fn commit_text(&self) {
        let Some(editing) = self.ivars().editing.take() else {
            return;
        };
        let mark = Mark {
            shape: Shape::Text {
                at: editing.at,
                text: editing.field.stringValue().to_string(),
            },
            ink: editing.ink,
        };
        if mark.drawn() {
            self.ivars().marks.borrow_mut().add(mark);
        }
        // The field may be ending its editing in this very call.
        let field = MainThreadBound::new(editing.field, self.mtm());
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
            field.get(mtm).removeFromSuperview();
        });
        self.focus();
        self.setNeedsDisplay(true);
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
                    let corner = self.snapped(pixel, event);
                    state.selection.set(Some(Area::spanning(anchor, corner)));
                    state.gesture.set(Gesture::Drawing {
                        anchor,
                        moved: true,
                    });
                    self.announce();
                }
            }
            Gesture::Moving { grab, start } => state.selection.set(Some(
                start.moved((pixel.0 - grab.0, pixel.1 - grab.1), whole),
            )),
            Gesture::Resizing { edges, start } => {
                let corner = self.snapped(pixel, event);
                state.selection.set(Some(start.resized(edges, corner)))
            }
            Gesture::Marking { anchor } => {
                if let Some(draft) = &mut *state.draft.borrow_mut() {
                    draft.extend(anchor, pixel);
                }
            }
        }
        self.setNeedsDisplay(true);
    }

    fn release(&self) {
        let state = self.ivars();
        match state.gesture.get() {
            Gesture::Drawing { moved: false, .. } => state.selection.set(self.hovered()),
            Gesture::Marking { .. } => {
                if let Some(mark) = state.draft.take().filter(Mark::drawn) {
                    state.marks.borrow_mut().add(mark);
                }
            }
            _ => {}
        }
        state.gesture.set(Gesture::Idle);
        self.announce();
        self.setNeedsDisplay(true);
    }

    /// Tells the UI where the selection is, to show the tools by it, or that there is none.
    fn announce(&self) {
        let state = self.ivars();
        let shown = match state.gesture.get() {
            Gesture::Idle | Gesture::Marking { .. } => state.selection.get(),
            _ => None,
        };
        if state.announced.replace(shown) == shown {
            return;
        }
        let rect = match (&*state.phase.borrow(), shown) {
            (Phase::Frozen(shot), Some(area)) => {
                let rect = shot.rect(area);
                serde_json::json!({
                    "x": rect.origin.x,
                    "y": rect.origin.y,
                    "width": rect.size.width,
                    "height": rect.size.height,
                })
            }
            _ => JsonValue::Null,
        };
        state.context.emit("selection", rect);
    }

    fn choose(&self, tool: Option<Tool>) {
        self.commit_text();
        self.ivars().tool.set(tool);
    }

    fn set_ink(&self, color: Option<[u8; 3]>, size: Option<Size>) {
        let state = self.ivars();
        if let Some(color) = color {
            state.color.set(color);
        }
        if let Some(size) = size {
            state.size.set(size);
        }
        if let Some(editing) = &mut *state.editing.borrow_mut() {
            editing.ink.color = state.color.get();
            editing.ink.size = state.size.get();
            style_field(&editing.field, editing.ink);
        }
    }

    fn undo(&self, redo: bool) {
        self.commit_text();
        let mut marks = self.ivars().marks.borrow_mut();
        if redo {
            marks.redo()
        } else {
            marks.undo()
        }
        drop(marks);
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
        let flags = event.modifierFlags();
        if flags.contains(NSEventModifierFlags::Command) {
            let typed = event
                .charactersIgnoringModifiers()
                .map(|typed| typed.to_string().to_lowercase());
            match typed.as_deref() {
                Some("z") => self.undo(flags.contains(NSEventModifierFlags::Shift)),
                Some("c") => self.copy(),
                Some("s") => self.save(),
                Some("t") => self.pin(),
                _ => {}
            }
            return;
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
        self.announce();
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

    /// What a click takes, from the smallest control under the pointer out to the whole display.
    fn targets(&self) -> Vec<Area> {
        match &*self.ivars().phase.borrow() {
            Phase::Frozen(shot) => targets(&shot.windows, self.ivars().pointer.get(), shot.whole),
            _ => Vec::new(),
        }
    }

    fn hovered(&self) -> Option<Area> {
        let targets = self.targets();
        let depth = self
            .ivars()
            .depth
            .get()
            .min(targets.len().saturating_sub(1));
        targets.get(depth).copied()
    }

    fn points_to_pixels(&self, points: f64) -> i64 {
        match &*self.ivars().phase.borrow() {
            Phase::Frozen(shot) => (points * shot.scale).round() as i64,
            _ => points as i64,
        }
    }

    /// The selection, or what a click would take, with the marks on it.
    fn finished(&self) -> Option<(CFRetained<CGImage>, NSRect)> {
        self.commit_text();
        let area = self.ivars().selection.get().or_else(|| self.hovered())?;
        let Phase::Frozen(shot) = &*self.ivars().phase.borrow() else {
            return None;
        };
        let marks = self.ivars().marks.borrow();
        let picture = paint::render(&shot.image, shot.whole, area, marks.made());
        let Some(picture) = picture else {
            drop(marks);
            self.fail("cannot draw the screenshot".into(), false);
            return None;
        };
        Some((picture, shot.rect(area)))
    }

    fn copy(&self) {
        let Some((picture, _)) = self.finished() else {
            return;
        };
        match output::copy(&picture) {
            Ok(()) => self.emit("done"),
            Err(message) => self.fail(message, false),
        }
    }

    fn save(&self) {
        let Some((picture, _)) = self.finished() else {
            return;
        };
        match output::save(&picture, self.ivars().folder.borrow().as_deref()) {
            Ok(_) => self.emit("done"),
            Err(message) => self.fail(message, false),
        }
    }

    fn pin(&self) {
        let Some(window) = self.window() else { return };
        let Some((picture, rect)) = self.finished() else {
            return;
        };
        let on_screen = window.convertRectToScreen(self.convertRect_toView(rect, None));
        pin::pin(
            self.mtm(),
            picture,
            on_screen,
            self.ivars().folder.borrow().clone(),
        );
        self.emit("done");
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
            self.emit("done");
        }
    }

    fn draw(&self) {
        let phase = self.ivars().phase.borrow();
        let Phase::Frozen(shot) = &*phase else { return };
        let state = self.ivars();
        let bounds = self.bounds();
        let selection = state.selection.get();
        let Some(focus) = selection.or_else(|| {
            let targets = targets(&shot.windows, state.pointer.get(), shot.whole);
            targets
                .get(state.depth.get().min(targets.len() - 1))
                .copied()
        }) else {
            return;
        };
        let focus_rect = shot.rect(focus);

        let shade = NSBezierPath::bezierPathWithRect(bounds);
        shade.appendBezierPathWithRect(focus_rect);
        shade.setWindingRule(NSWindingRule::EvenOdd);
        NSColor::colorWithWhite_alpha(0.0, 0.45).setFill();
        shade.fill();

        if selection.is_some() {
            NSGraphicsContext::saveGraphicsState_class();
            NSBezierPath::clipRect(focus_rect);
            let canvas = shot.canvas();
            for mark in state.marks.borrow().made() {
                canvas.paint(mark);
            }
            if let Some(draft) = &*state.draft.borrow() {
                canvas.paint(draft);
            }
            NSGraphicsContext::restoreGraphicsState_class();
        }

        let accent = NSColor::colorWithSRGBRed_green_blue_alpha(0.16, 0.56, 1.0, 1.0);
        accent.setStroke();
        let border = NSBezierPath::bezierPathWithRect(inset(focus_rect, 0.5));
        border.setLineWidth(1.0);
        border.stroke();

        let gesture = state.gesture.get();
        if selection.is_some() && matches!(gesture, Gesture::Idle | Gesture::Moving { .. }) {
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

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        let state = self.stage.ivars();
        match name {
            "folder" => {
                *state.folder.borrow_mut() = value.and_then(JsonValue::as_str).map(PathBuf::from)
            }
            "pictureBoxes" => state
                .picture_boxes
                .set(value.and_then(JsonValue::as_bool).unwrap_or(true)),
            _ => {}
        }
    }

    fn command(&mut self, name: &str, args: &JsonValue) {
        let stage = &self.stage;
        let text = |key: &str| args.get(key).and_then(JsonValue::as_str);
        match name {
            // A build macOS has not seen is missing from the privacy list until it is dragged in.
            "revealApplication" => {
                let application = NSBundle::mainBundle().bundleURL();
                NSWorkspace::sharedWorkspace()
                    .activateFileViewerSelectingURLs(&NSArray::from_retained_slice(&[application]));
                // The stage floats above Finder.
                return stage.emit("cancel");
            }
            "requestAccessibility" => {
                elements::request();
                // The stage floats above the prompt.
                return stage.emit("cancel");
            }
            "tool" => stage.choose(text("tool").and_then(Tool::named)),
            "ink" => stage.set_ink(
                text("color").and_then(annotate::color),
                text("size").and_then(Size::named),
            ),
            "undo" => stage.undo(false),
            "redo" => stage.undo(true),
            "copy" => return stage.copy(),
            "save" => return stage.save(),
            "pin" => return stage.pin(),
            _ => {}
        }
        stage.focus();
    }
}

fn deliver(
    stage: Arc<MainThreadBound<Retained<Stage>>>,
    shot: Result<(Shot, Vec<elements::Source>), String>,
) {
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
        let stage = stage.get(mtm);
        match shot {
            Ok((shot, sources)) => stage.freeze(shot, sources),
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

/// The on-screen windows of the normal level, front to back.
fn windows_on() -> Vec<elements::Source> {
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
            Some(elements::Source {
                pid: number(&info, "kCGWindowOwnerPID")? as i32,
                bounds: CGRect::new(
                    CGPoint::new(number(&bounds, "X")?, number(&bounds, "Y")?),
                    CGSize::new(number(&bounds, "Width")?, number(&bounds, "Height")?),
                ),
            })
        })
        .collect()
}

/// `rect`, in global points, in pixels of the display at `origin`.
fn pixels(rect: CGRect, origin: CGPoint, scale: f64) -> Option<Area> {
    let pixel = |value: f64, start: f64| ((value - start) * scale).round() as i64;
    let left = pixel(rect.origin.x, origin.x);
    let top = pixel(rect.origin.y, origin.y);
    let right = pixel(rect.origin.x + rect.size.width, origin.x) - 1;
    let bottom = pixel(rect.origin.y + rect.size.height, origin.y) - 1;
    (right >= left && bottom >= top).then(|| Area::spanning((left, top), (right, bottom)))
}

fn style_field(field: &NSTextField, ink: Ink) {
    let [r, g, b] = ink.color;
    field.setFont(Some(&NSFont::systemFontOfSize(ink.size.font())));
    field.setTextColor(Some(&NSColor::colorWithSRGBRed_green_blue_alpha(
        r as f64 / 255.0,
        g as f64 / 255.0,
        b as f64 / 255.0,
        1.0,
    )));
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
