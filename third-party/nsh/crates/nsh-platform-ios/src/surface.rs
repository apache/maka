use std::{
    cell::{Cell, RefCell},
    io,
    ptr::NonNull,
    sync::Arc,
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, MainThreadBound};
use nsh_core::{MountBatch, Points, Size};
use nsh_engine::{
    App, ColorScheme, Edges, Engine, EngineConfig, Environment, Idiom, Lifecycle, MainThreadTask,
    MountSink, Policy,
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyObject, ProtocolObject},
};
use objc2_core_foundation::{CGRect, CGSize};
use objc2_foundation::{
    NSCurrentLocaleDidChangeNotification, NSNotification, NSNotificationCenter, NSNumber, NSObject,
    NSObjectProtocol, NSOperationQueue, NSSystemTimeZoneDidChangeNotification, NSTimeZone, NSValue,
};
use objc2_ui_kit::{
    NSValueUIGeometryExtensions, UIApplication, UIApplicationDidBecomeActiveNotification,
    UIApplicationDidEnterBackgroundNotification, UIApplicationState,
    UIApplicationWillEnterForegroundNotification, UIApplicationWillResignActiveNotification,
    UIDevice, UIFont, UIFontTextStyleBody, UIKeyboardAnimationCurveUserInfoKey,
    UIKeyboardAnimationDurationUserInfoKey, UIKeyboardFrameEndUserInfoKey,
    UIKeyboardWillChangeFrameNotification, UIKeyboardWillHideNotification, UIResponder,
    UISceneActivationState, UISceneDidActivateNotification, UISceneDidEnterBackgroundNotification,
    UISceneWillDeactivateNotification, UISceneWillEnterForegroundNotification, UITraitCollection,
    UITraitEnvironment, UIUserInterfaceIdiom, UIUserInterfaceStyle, UIView, UIWindowScene,
};

use crate::{
    image::AssetBase,
    mount::{Mounter, SharedMounter},
    text::CoreTextEngine,
};

type ErrorHandler = Box<dyn Fn(&str)>;
type SharedErrorHandler = Arc<MainThreadBound<RefCell<Option<ErrorHandler>>>>;
type SharedHandler = Arc<MainThreadBound<RefCell<Option<Box<dyn Fn()>>>>>;
/// A test session's model of the app (`nsh test --target ios`): every
/// batch and error goes to it.
#[cfg(feature = "dev")]
type TestModel = Arc<std::sync::Mutex<Option<Arc<nsh_testing::agent::Model>>>>;

/// Forwards mount batches and errors from the engine thread to the main
/// thread.
struct MainThreadSink {
    mounter: SharedMounter,
    on_error: SharedErrorHandler,
    on_hot_failed: SharedHandler,
    #[cfg(feature = "dev")]
    test_model: TestModel,
}

impl MountSink for MainThreadSink {
    fn submit(&self, batch: MountBatch) {
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.test_model.lock().unwrap_or_else(|e| e.into_inner()) {
            model.apply(&batch);
        }
        let mounter = self.mounter.clone();
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("main queue runs on the main thread");
            if let Some(mounter) = mounter.get(mtm).borrow_mut().as_mut() {
                mounter.apply(batch);
            }
        });
    }

    fn request_frame(&self) {
        let mounter = self.mounter.clone();
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("main queue runs on the main thread");
            if let Some(mounter) = mounter.get(mtm).borrow().as_ref() {
                mounter.request_frame();
            }
        });
    }

    fn run_on_main_thread(&self, task: MainThreadTask) {
        // The main queue is serial: after the batches submitted before it.
        DispatchQueue::main().exec_async(move || task.run());
    }

    fn hot_update_failed(&self) {
        let handler = self.on_hot_failed.clone();
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("main queue runs on the main thread");
            if let Some(handler) = handler.get(mtm).borrow().as_ref() {
                handler();
            }
        });
    }

    fn report_error(&self, message: &str) {
        #[cfg(feature = "dev")]
        if let Some(model) = &*self.test_model.lock().unwrap_or_else(|e| e.into_inner()) {
            model.error(message);
        }
        let on_error = self.on_error.clone();
        let message = message.to_owned();
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("main queue runs on the main thread");
            if let Some(handler) = on_error.get(mtm).borrow().as_ref() {
                handler(&message);
            }
        });
    }
}

struct Running {
    // Field order: the engine (and its thread) stops before the mounter goes.
    engine: Engine,
    mounter: SharedMounter,
}

pub(crate) struct RootViewIvars {
    /// The app, waiting for the first non-empty layout.
    pending: RefCell<Option<App>>,
    running: RefCell<Option<Running>>,
    size: Cell<CGSize>,
    options: SurfaceOptions,
    on_error: SharedErrorHandler,
    /// A development update could not be applied in place.
    on_hot_failed: SharedHandler,
    /// Keyboard height over the view and its animation duration.
    keyboard: Cell<(f32, f32)>,
    /// Whether the app is in use where the surface shows, as the
    /// notifications of its window's scene said last (the application's
    /// while it has none: [`RootView::observe_lifecycle`]).
    lifecycle: Cell<Lifecycle>,
    /// Last environment sent to the engine.
    environment: Cell<Option<Environment>>,
    /// The embedding app's locale and text size over the system's
    /// ([`Surface::set_host_environment`]).
    host: Cell<nsh_engine::HostEnvironment>,
    /// The embedding app's theme overrides ([`Surface::set_host_tokens`]).
    host_tokens: RefCell<Option<nsh_engine::Tokens>>,
    /// Font files the embedding app registers ([`Surface::add_font`]).
    fonts: RefCell<Vec<Vec<u8>>>,
    /// Keyboard notification registrations.
    observers: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>>,
    /// Links that came before the engine started ([`Surface::url_scheme`]).
    url_schemes: RefCell<Vec<String>>,
    #[cfg(feature = "dev")]
    test_model: TestModel,
}

define_class!(
    /// The surface root view (node id 1). Starts the engine once it knows
    /// its real size, then reports size changes.
    #[unsafe(super(UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = RootViewIvars]
    pub(crate) struct RootView;

    impl RootView {
        #[unsafe(method(layoutSubviews))]
        fn layout_subviews(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), layoutSubviews] };
            let size = self.bounds().size;
            if size.width <= 0.0 || size.height <= 0.0 || size == self.ivars().size.get() {
                return;
            }
            self.ivars().size.set(size);
            let viewport = Size::new(Points(size.width as f32), Points(size.height as f32));
            if let Some(running) = self.ivars().running.borrow().as_ref() {
                running.engine.control().resize(viewport);
                self.publish_environment();
                return;
            }
            let pending = self.ivars().pending.borrow_mut().take();
            if let Some(app) = pending {
                self.start(app, viewport);
            }
        }

        /// VoiceOver's escape gesture (a two-finger scrub) from inside the
        /// surface, where no screen or modal took it: the app's going back
        /// (the top overlay's `onCancel` first), as Escape and the back
        /// button are elsewhere. A menu sheet's backdrop takes no focus,
        /// so this is how a VoiceOver user leaves it.
        #[unsafe(method(accessibilityPerformEscape))]
        fn accessibility_perform_escape(&self) -> bool {
            let shared = self
                .ivars()
                .running
                .borrow()
                .as_ref()
                .map(|r| r.mounter.clone());
            let taken = shared.is_some_and(|shared| {
                shared
                    .get(self.mtm())
                    .try_borrow()
                    .is_ok_and(|m| m.as_ref().is_some_and(Mounter::escape))
            });
            // SAFETY: calling the superclass implementation.
            taken || unsafe { msg_send![super(self), accessibilityPerformEscape] }
        }

        #[unsafe(method(didMoveToWindow))]
        fn did_move_to_window(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), didMoveToWindow] };
            // Another window may be another scene, in another state.
            self.ivars().lifecycle.set(self.scene_state());
            self.publish_environment();
            let Some(mounter) = self
                .ivars()
                .running
                .borrow()
                .as_ref()
                .map(|r| r.mounter.clone())
            else {
                return;
            };
            // On the next turn: a batch being applied may hold the mounter.
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                if let Some(m) = mounter.get(mtm).borrow_mut().as_mut() {
                    m.window_changed();
                }
            });
        }

        #[unsafe(method(safeAreaInsetsDidChange))]
        fn safe_area_insets_did_change(&self) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), safeAreaInsetsDidChange] };
            self.publish_environment();
        }

        #[unsafe(method(traitCollectionDidChange:))]
        fn trait_collection_did_change(&self, previous: Option<&UITraitCollection>) {
            // SAFETY: calling the superclass implementation.
            let _: () = unsafe { msg_send![super(self), traitCollectionDidChange: previous] };
            self.publish_environment();
            let Some(mounter) = self
                .ivars()
                .running
                .borrow()
                .as_ref()
                .map(|r| r.mounter.clone())
            else {
                return;
            };
            // On the next turn: a batch being applied may hold the mounter.
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                if let Some(m) = mounter.get(mtm).borrow_mut().as_mut() {
                    m.traits_changed();
                }
            });
        }

        /// Hardware keys no responder inside handled: the app's shortcuts
        /// (`nsh/keymap`) take those they bind.
        #[unsafe(method(pressesBegan:withEvent:))]
        fn presses_began(&self, presses: &AnyObject, event: Option<&AnyObject>) {
            let consumed = self
                .target()
                .is_some_and(|target| crate::keymap::root_began(&target, presses));
            if !consumed {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesBegan: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesEnded:withEvent:))]
        fn presses_ended(&self, presses: &AnyObject, event: Option<&AnyObject>) {
            let consumed = self
                .target()
                .is_some_and(|target| crate::keymap::ended(&target, presses));
            if !consumed {
                // SAFETY: calling the superclass implementation.
                let _: () = unsafe { msg_send![super(self), pressesEnded: presses, withEvent: event] };
            }
        }

        #[unsafe(method(pressesCancelled:withEvent:))]
        fn presses_cancelled(&self, presses: &AnyObject, event: Option<&AnyObject>) {
            let consumed = self
                .target()
                .is_some_and(|target| crate::keymap::ended(&target, presses));
            if !consumed {
                // SAFETY: calling the superclass implementation.
                let _: () =
                    unsafe { msg_send![super(self), pressesCancelled: presses, withEvent: event] };
            }
        }
    }
);

impl RootView {
    fn new(
        mtm: MainThreadMarker,
        frame: CGRect,
        app: App,
        options: SurfaceOptions,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(RootViewIvars {
            pending: RefCell::new(Some(app)),
            running: RefCell::new(None),
            size: Cell::new(CGSize::new(0.0, 0.0)),
            options,
            on_error: Arc::new(MainThreadBound::new(RefCell::new(None), mtm)),
            on_hot_failed: Arc::new(MainThreadBound::new(RefCell::new(None), mtm)),
            keyboard: Cell::new((0.0, 250.0)),
            lifecycle: Cell::new(lifecycle(mtm)),
            environment: Cell::new(None),
            host: Cell::default(),
            host_tokens: RefCell::new(None),
            fonts: RefCell::new(Vec::new()),
            observers: RefCell::new(Vec::new()),
            url_schemes: RefCell::new(Vec::new()),
            #[cfg(feature = "dev")]
            test_model: TestModel::default(),
        });
        // SAFETY: UIView's designated initializer.
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }

    /// The running app's event target.
    fn target(&self) -> Option<Retained<crate::target::EventTarget>> {
        let running = self.ivars().running.borrow();
        let mounter = running
            .as_ref()?
            .mounter
            .get(self.mtm())
            .try_borrow()
            .ok()?;
        mounter.as_ref().map(|m| m.target().clone())
    }

    /// What JS sees through `windowSize()`, `safeArea()`, `keyboard()`...
    fn environment(&self) -> Environment {
        let size = self.bounds().size;
        let insets = self.safeAreaInsets();
        let (keyboard_height, keyboard_duration) = self.ivars().keyboard.get();
        // SAFETY: plain getters.
        let (style, body, scale) = unsafe {
            let traits = self.traitCollection();
            (
                traits.userInterfaceStyle(),
                UIFont::preferredFontForTextStyle(UIFontTextStyleBody).pointSize(),
                traits.displayScale(),
            )
        };
        let mut env = Environment {
            window: Size::new(Points(size.width as f32), Points(size.height as f32)),
            safe_area: Edges {
                top: Points(insets.top as f32),
                right: Points(insets.right as f32),
                bottom: Points(insets.bottom as f32),
                left: Points(insets.left as f32),
            },
            // UIKit draws no title bar an app could hide.
            title_bar: Edges::default(),
            keyboard_height: Points(keyboard_height),
            keyboard_duration,
            color_scheme: if style == UIUserInterfaceStyle::Dark {
                ColorScheme::Dark
            } else {
                ColorScheme::Light
            },
            // The body text style is 17pt at the default size.
            font_scale: (body / 17.0) as f32,
            rtl: preferred_language_rtl(),
            reduce_motion: objc2_ui_kit::UIAccessibilityIsReduceMotionEnabled(),
            pixel_ratio: scale as f32,
            screen_reader: objc2_ui_kit::UIAccessibilityIsVoiceOverRunning(),
            os: nsh_engine::Os::Ios,
            os_version: os_version(self.mtm()),
            idiom: match UIDevice::currentDevice(self.mtm()).userInterfaceIdiom() {
                UIUserInterfaceIdiom::Pad => Idiom::Pad,
                UIUserInterfaceIdiom::Mac => Idiom::Mac,
                UIUserInterfaceIdiom::TV => Idiom::Tv,
                _ => Idiom::Phone,
            },
            locale: current_locale(),
            locale_settings: locale_settings(),
            lifecycle: self.ivars().lifecycle.get(),
            // Only read for the web: iOS keys are always Apple's.
            apple_keyboard: true,
            // No host answers `nsh/host` here: an embedding app talks to its
            // apps through its own UI sets (`nsh/native`).
            host: false,
            // UIKit has no screen color sampler.
            screen_color: false,
            // The Speech framework fed by the microphone.
            speech: true,
            // The notification center.
            notifications: true,
            // AVAudioEngine and AVPlayer.
            audio: true,
            web_evaluate: true,
            // wgpu on Metal, in builds with it, until it finds no GPU.
            shaders: nsh_engine::shader::LINKED,
            // No file dialogs, file manager or trash (Catalyst included):
            // the default, so the core answers those requests.
            ..Environment::default()
        };
        // The embedding app's settings over the system's.
        self.ivars().host.get().apply(&mut env);
        env
    }

    /// Sends the environment to the engine if it changed.
    fn publish_environment(&self) {
        let running = self.ivars().running.borrow();
        let Some(running) = running.as_ref() else {
            return;
        };
        let env = self.environment();
        if self.ivars().environment.get() != Some(env) {
            self.ivars().environment.set(Some(env));
            running.engine.control().set_environment(env);
        }
    }

    /// The environment follows the system's time zone: the user changed
    /// it, or the device moved to another zone. Foundation caches the
    /// system's zone until it is reset.
    fn observe_time_zone(this: &Retained<Self>) {
        let center = NSNotificationCenter::defaultCenter();
        let weak = Weak::from_retained(this);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let Some(view) = weak.load() else { return };
            NSTimeZone::resetSystemTimeZone();
            view.publish_environment();
        });
        // SAFETY: as in `observe_keyboard`; the block only touches the view
        // on the main queue it is delivered on.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSSystemTimeZoneDidChangeNotification),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        };
        this.ivars().observers.borrow_mut().push(observer);
    }

    /// The environment follows the region's settings: the region format,
    /// 24-hour time, the first day of the week, the measurement system and
    /// the temperature unit, which iOS changes while apps run.
    fn observe_locale(this: &Retained<Self>) {
        let center = NSNotificationCenter::defaultCenter();
        let weak = Weak::from_retained(this);
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let Some(view) = weak.load() else { return };
            view.publish_environment();
        });
        // SAFETY: as in `observe_time_zone`.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSCurrentLocaleDidChangeNotification),
                None,
                Some(&NSOperationQueue::mainQueue()),
                &block,
            )
        };
        this.ivars().observers.borrow_mut().push(observer);
    }

    /// Tracks whether the app is in use where the surface shows
    /// (`lifecycle()`): the notifications of its window's scene, so that on
    /// an iPad with several windows, and on Catalyst, a surface follows its
    /// own window as the desktop backends do; the application's while the
    /// surface is in no window with a scene. An embedded surface follows
    /// the embedding app's window. The state is the notification's: during
    /// `willResignActive` / `willDeactivate`, the app and the scene still
    /// say active.
    fn observe_lifecycle(this: &Retained<Self>) {
        let center = NSNotificationCenter::defaultCenter();
        let weak = Weak::from_retained(this);
        let block = RcBlock::new(move |note: NonNull<NSNotification>| {
            let Some(view) = weak.load() else { return };
            // SAFETY: a valid notification for the duration of the call.
            let note = unsafe { note.as_ref() };
            let name = note.name();
            // SAFETY: immutable UIKit constants.
            let (of_scene, state) = unsafe {
                if *name == *UISceneDidActivateNotification {
                    (true, Lifecycle::Active)
                } else if *name == *UISceneDidEnterBackgroundNotification {
                    (true, Lifecycle::Background)
                } else if *name == *UISceneWillDeactivateNotification
                    || *name == *UISceneWillEnterForegroundNotification
                {
                    (true, Lifecycle::Inactive)
                } else if *name == *UIApplicationDidBecomeActiveNotification {
                    (false, Lifecycle::Active)
                } else if *name == *UIApplicationDidEnterBackgroundNotification {
                    (false, Lifecycle::Background)
                } else {
                    // Resigning active, or coming back to the foreground
                    // before it is active again.
                    (false, Lifecycle::Inactive)
                }
            };
            let scene = view.scene();
            let ours = match (&scene, note.object()) {
                (Some(scene), Some(object)) if of_scene => {
                    std::ptr::addr_eq(Retained::as_ptr(scene), Retained::as_ptr(&object))
                }
                // Another scene's, or the application's while the surface
                // follows a scene.
                (Some(_), _) => false,
                (None, _) => !of_scene,
            };
            if ours {
                view.ivars().lifecycle.set(state);
                view.publish_environment();
            }
        });
        // SAFETY: immutable UIKit constants.
        let names = unsafe {
            [
                UISceneDidActivateNotification,
                UISceneWillDeactivateNotification,
                UISceneDidEnterBackgroundNotification,
                UISceneWillEnterForegroundNotification,
                UIApplicationDidBecomeActiveNotification,
                UIApplicationWillResignActiveNotification,
                UIApplicationDidEnterBackgroundNotification,
                UIApplicationWillEnterForegroundNotification,
            ]
        };
        let mut observers = this.ivars().observers.borrow_mut();
        for name in names {
            // SAFETY: as in `observe_keyboard`; the block only touches the
            // view on the main queue it is delivered on.
            observers.push(unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    None,
                    Some(&NSOperationQueue::mainQueue()),
                    &block,
                )
            });
        }
    }

    /// The scene of the window the surface is in, if any.
    fn scene(&self) -> Option<Retained<UIWindowScene>> {
        self.window()?.windowScene()
    }

    /// The state of the surface's scene now, before its notifications say
    /// more (the application's without one). An unattached scene shows
    /// nothing, as one in the background.
    fn scene_state(&self) -> Lifecycle {
        let Some(scene) = self.scene() else {
            return lifecycle(self.mtm());
        };
        match scene.activationState() {
            UISceneActivationState::ForegroundActive => Lifecycle::Active,
            UISceneActivationState::ForegroundInactive => Lifecycle::Inactive,
            _ => Lifecycle::Background,
        }
    }

    /// Tracks the software keyboard: JS sees its height, and the mounter
    /// keeps the focused input clear of it.
    fn observe_keyboard(this: &Retained<Self>) {
        let center = NSNotificationCenter::defaultCenter();
        let weak = Weak::from_retained(this);
        let block = RcBlock::new(move |note: NonNull<NSNotification>| {
            let Some(view) = weak.load() else { return };
            // SAFETY: a valid notification for the duration of the call.
            view.keyboard_changed(unsafe { note.as_ref() });
        });
        // SAFETY: UIKit notification names; the block only touches the view
        // on the main queue it is delivered on.
        let names = unsafe {
            [
                UIKeyboardWillChangeFrameNotification,
                UIKeyboardWillHideNotification,
            ]
        };
        let mut observers = this.ivars().observers.borrow_mut();
        // Accessibility settings that classes (`motion-reduce:`) and JS read.
        let weak = Weak::from_retained(this);
        let settings = RcBlock::new(move |_: NonNull<NSNotification>| {
            if let Some(view) = weak.load() {
                view.publish_environment();
            }
        });
        // SAFETY: immutable UIKit constants.
        let settings_names = unsafe {
            [
                objc2_ui_kit::UIAccessibilityReduceMotionStatusDidChangeNotification,
                objc2_ui_kit::UIAccessibilityVoiceOverStatusDidChangeNotification,
            ]
        };
        for name in settings_names {
            // SAFETY: as below.
            observers.push(unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    None,
                    Some(&NSOperationQueue::mainQueue()),
                    &settings,
                )
            });
        }
        for name in names {
            // SAFETY: as above; the observer is removed when the view stops.
            observers.push(unsafe {
                center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    None,
                    Some(&NSOperationQueue::mainQueue()),
                    &block,
                )
            });
        }
    }

    fn keyboard_changed(&self, note: &NSNotification) {
        // The keyboard starts to move now, in the transaction posting this.
        let start = objc2_quartz_core::CACurrentMediaTime();
        let Some(info) = note.userInfo() else { return };
        // SAFETY: UIKit documents these user info keys and their value types
        // (NSValue of a CGRect in screen coordinates, NSNumber of seconds,
        // NSNumber of a UIViewAnimationCurve).
        let (frame, duration, curve) = unsafe {
            let frame = info
                .objectForKey(UIKeyboardFrameEndUserInfoKey)
                .and_then(|v| v.downcast::<NSValue>().ok())
                .map(|v| v.CGRectValue());
            let duration = info
                .objectForKey(UIKeyboardAnimationDurationUserInfoKey)
                .and_then(|v| v.downcast::<NSNumber>().ok())
                .map_or(0.25, |n| n.doubleValue());
            let curve = info
                .objectForKey(UIKeyboardAnimationCurveUserInfoKey)
                .and_then(|v| v.downcast::<NSNumber>().ok())
                .map_or(7, |n| n.integerValue());
            (frame, duration, curve)
        };
        let hiding = note.name().isEqualToString(
            // SAFETY: an immutable UIKit constant.
            unsafe { UIKeyboardWillHideNotification },
        );
        let height = match (frame, self.window().and_then(|w| w.windowScene())) {
            (Some(frame), Some(scene)) if !hiding => {
                let space = scene.screen().coordinateSpace();
                // SAFETY: `convertRect:fromCoordinateSpace:` of UICoordinateSpace.
                let frame: CGRect =
                    unsafe { msg_send![self, convertRect: frame, fromCoordinateSpace: &*space] };
                let bounds = self.bounds();
                let overlaps =
                    frame.origin.x < bounds.size.width && frame.origin.x + frame.size.width > 0.0;
                if overlaps {
                    (bounds.size.height - frame.origin.y).clamp(0.0, bounds.size.height)
                } else {
                    0.0
                }
            }
            _ => 0.0,
        };
        // UIKit gives seconds; the environment holds milliseconds.
        self.ivars()
            .keyboard
            .set((height as f32, (duration * 1000.0) as f32));
        self.publish_environment();
        let Some(mounter) = self
            .ivars()
            .running
            .borrow()
            .as_ref()
            .map(|r| r.mounter.clone())
        else {
            return;
        };
        let height = height as f32;
        let motion = crate::mount::KeyboardMotion {
            curve,
            duration,
            start,
        };
        // Focusing an input while a batch is applied can post this
        // synchronously: then run it on the next main-queue turn.
        let busy = match mounter.get(self.mtm()).try_borrow_mut() {
            Ok(mut m) => {
                if let Some(m) = m.as_mut() {
                    m.keyboard_changed(height, motion);
                }
                false
            }
            Err(_) => true,
        };
        let settled = mounter.clone();
        if busy {
            DispatchQueue::main().exec_async(move || {
                let mtm = MainThreadMarker::new().expect("main queue");
                if let Some(m) = mounter.get(mtm).borrow_mut().as_mut() {
                    m.keyboard_changed(height, motion);
                }
            });
        }
        // Once the engine handled the change, and the batch the app
        // answered with (if any) is applied (batches reach the main queue
        // first): what the app did not move clear of the keyboard moves.
        let control = self
            .ivars()
            .running
            .borrow()
            .as_ref()
            .map(|r| r.engine.control());
        if let Some(control) = control {
            control.flush(move |_| {
                DispatchQueue::main().exec_async(move || {
                    let mtm = MainThreadMarker::new().expect("main queue");
                    if let Some(m) = settled.get(mtm).borrow_mut().as_mut() {
                        m.keyboard_settled();
                    }
                });
            });
        }
    }

    fn start(&self, mut app: App, viewport: Size<Points>) {
        let mtm = self.mtm();
        let access = Arc::new(match &mut app {
            App::Js(bundle) => {
                if let Some(granted) = &self.ivars().options.granted {
                    bundle.policy.granted = Some(granted.clone());
                }
                bundle.policy.access()
            }
            // Native code reaches what the platform allows.
            App::Rust(_) => Policy::default().access(),
        });
        let mounter: SharedMounter = Arc::new(MainThreadBound::new(RefCell::new(None), mtm));
        #[allow(unused_mut)]
        let mut config = EngineConfig {
            app,
            viewport,
            trace: self.ivars().options.trace,
            content_culling: true,
            network: Some(crate::net::network()),
            websocket: None,
            refuse_connections: None,
            filesystem: None,
            assets: Some(Arc::new(crate::image::AssetReader(
                self.ivars().options.asset_base.clone(),
            ))),
            chunk_loader: None,
            environment: self.environment(),
            header_heights: header_heights(mtm),
            limits: self.ivars().options.limits,
            ui_sets: crate::ui_sets(),
            runtime: self.ivars().options.runtime.clone(),
            data_dir: self.ivars().options.data_dir.clone(),
            cache: system_cache(self.ivars().options.cache.clone()),
            storage: self.ivars().options.storage.as_ref().map(|dir| {
                nsh_engine::FileStorage::open(dir) as Arc<dyn nsh_engine::StorageBackend>
            }),
            clock: Default::default(),
            context: Default::default(),
            pinned: Default::default(),
            clipboard: None,
            host: self.ivars().options.host.clone(),
            picker: None,
            speech: None,
            audio: None,
            windows: None,
        };
        // A test session's app: the test's storage, network and trace.
        #[cfg(feature = "dev")]
        if let Some(model) = &*self
            .ivars()
            .test_model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
        {
            model.set_up_engine(&mut config);
        }
        let sink = MainThreadSink {
            mounter: mounter.clone(),
            on_error: self.ivars().on_error.clone(),
            on_hot_failed: self.ivars().on_hot_failed.clone(),
            #[cfg(feature = "dev")]
            test_model: self.ivars().test_model.clone(),
        };
        // The embedding app's theme overrides are in the first frame, and
        // the links that came before are the app's address when its code
        // first runs (`UrlScheme.url()`).
        let tokens = self.ivars().host_tokens.borrow().clone();
        let links = std::mem::take(&mut *self.ivars().url_schemes.borrow_mut());
        let fonts = self.ivars().fonts.borrow().clone();
        let engine = match Engine::start_with(config, CoreTextEngine::default, sink, |control| {
            if tokens.is_some() {
                control.set_tokens(tokens);
            }
            for font in fonts {
                control.register_font(font);
            }
            for url in links {
                send_url_scheme(control, url);
            }
        }) {
            Ok(engine) => engine,
            Err(err) => return log::error!("failed to start the engine: {err}"),
        };
        // The test moves its clock through the engine.
        #[cfg(feature = "dev")]
        if let Some(model) = &*self
            .ivars()
            .test_model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
        {
            model.engine_started(engine.control());
        }
        // Batches are queued on the main queue, so none can run before the
        // mounter is installed here.
        let root = Retained::into_super(self.retain());
        let asset_base = self.ivars().options.asset_base.clone();
        let mut installed = Mounter::new(
            mtm,
            root,
            engine.control(),
            mounter.clone(),
            asset_base,
            access,
            self.ivars().options.components.clone(),
        );
        installed.watch_scrolls(self.ivars().options.scroll_watchers.clone());
        // The app's downloaded images go through its disk cache.
        installed.set_image_cache(engine.image_cache());
        if self.ivars().options.fps || nsh_engine::perf::enabled_by_env() {
            installed.measure();
        }
        *mounter.get(mtm).borrow_mut() = Some(installed);
        *self.ivars().running.borrow_mut() = Some(Running { engine, mounter });
        self.ivars().environment.set(Some(self.environment()));
    }

    /// Stops the engine and removes all native views.
    fn stop(&self) {
        let running = self.ivars().running.borrow_mut().take();
        if let Some(Running { engine, mounter }) = running {
            drop(engine);
            // Queued batches become no-ops.
            mounter.get(self.mtm()).borrow_mut().take();
        }
        for view in self.subviews() {
            view.removeFromSuperview();
        }
    }
}

/// Height of a navigation bar (status bar excluded), normal and with a
/// large title, as UIKit lays them out on this device.
fn header_heights(mtm: MainThreadMarker) -> (Points, Points) {
    let bar = objc2_ui_kit::UINavigationBar::new(mtm);
    crate::navigation::keep_in_window(&bar);
    let normal = bar.sizeThatFits(CGSize::new(390.0, 0.0)).height as f32;
    let normal = if normal > 0.0 { normal } else { 44.0 };
    // Large titles add a 52pt row below the bar.
    (Points(normal), Points(normal + 52.0))
}

/// Options of a [`Surface`].
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct SurfaceOptions {
    /// Log per-commit timings.
    pub trace: bool,
    /// Where `asset:/` image URIs (bundled assets) are loaded from.
    pub asset_base: Option<AssetBase>,
    /// The VM limits of the apps it runs.
    pub limits: nsh_engine::Limits,
    /// The runtime for async tasks; `None` uses NSH's shared runtime.
    /// The embedding app owns it and must keep it running until the view
    /// stops. Dropping the view does not shut the runtime down.
    pub runtime: Option<tokio::runtime::Handle>,
    /// What the embedding app grants the apps it runs at most (`None`: what
    /// each app declares).
    pub granted: Option<nsh_engine::Capabilities>,
    /// Where the apps keep their data: each app in `<data_dir>/<app id>`
    /// ([`nsh_engine::EngineConfig::data_dir`]). Default: `nsh` in the
    /// app's Application Support; `None`: nothing is kept.
    pub data_dir: Option<std::path::PathBuf>,
    /// The directory the apps' storage (`nsh/storage`) is kept in
    /// (`storage.json` in it), overriding their own in
    /// [`SurfaceOptions::data_dir`]; `None`: theirs.
    pub storage: Option<std::path::PathBuf>,
    /// Where the apps keep their caches (the images they downloaded) and
    /// how much each keeps: by default `nsh` in the app's Caches
    /// ([`nsh_engine::CacheLocation::System`]), each app in
    /// `<dir>/<app id>`.
    pub cache: nsh_engine::CacheOptions,
    /// The native components the apps can use (`nsh/native`).
    pub components: crate::component::Components,
    /// The scroll views the embedding app watches by `nativeID`
    /// ([`crate::AppView::watch_scroll`]).
    pub scroll_watchers: crate::ScrollWatchers,
    /// The embedding app's channel with the apps (`nsh/host`): launch
    /// parameters, events and handlers of their calls and posts, one for
    /// every app the surface runs.
    pub host: nsh_engine::HostChannel,
    /// Logs the performance monitor's readings once a second (target
    /// `nsh::fps`): frame rate, frame and commit costs, CPU, memory.
    pub fps: bool,
}

impl Default for SurfaceOptions {
    fn default() -> Self {
        Self {
            trace: false,
            asset_base: None,
            limits: nsh_engine::Limits::default(),
            runtime: None,
            granted: None,
            data_dir: data_dir(),
            storage: None,
            cache: nsh_engine::CacheOptions::default(),
            components: crate::component::Components::default(),
            scroll_watchers: crate::ScrollWatchers::default(),
            host: nsh_engine::HostChannel::default(),
            fps: false,
        }
    }
}

/// Where apps NSH runs on iOS keep their data: `nsh` in the (embedding or
/// standalone) app's Application Support, each app in a directory named by
/// its id.
fn data_dir() -> Option<std::path::PathBuf> {
    nsh_engine::data_dir().map(|dir| dir.join("nsh"))
}

/// `cache` with [`nsh_engine::CacheLocation::System`] made iOS's: `nsh` in
/// the (embedding or standalone) app's Caches, as its data is in its
/// Application Support.
fn system_cache(mut cache: nsh_engine::CacheOptions) -> nsh_engine::CacheOptions {
    if cache.location == nsh_engine::CacheLocation::System {
        cache.location = match std::env::var_os("HOME").filter(|home| !home.is_empty()) {
            Some(home) => nsh_engine::CacheLocation::Dir(
                std::path::PathBuf::from(home).join("Library/Caches/nsh"),
            ),
            None => nsh_engine::CacheLocation::Off,
        };
    }
    cache
}

/// One running nsh app hosted in a `UIView`.
///
/// Add [`Surface::view`] to any view hierarchy; the app starts once the view
/// has a non-empty size and lays out to its bounds. Dropping the surface
/// stops its engine.
pub struct Surface {
    view: Retained<RootView>,
}

impl Surface {
    /// Creates a surface running `app` (a [`nsh_engine::Bundle`] or a Rust
    /// app's [`nsh_engine::Root`]). `frame` is the initial view frame.
    pub fn new(
        mtm: MainThreadMarker,
        app: impl Into<App>,
        frame: CGRect,
        options: SurfaceOptions,
    ) -> io::Result<Surface> {
        // Font and text-layout caches are process-wide: warm them while UIKit
        // finishes setting up the window.
        std::thread::Builder::new()
            .name("nsh-prewarm".into())
            .spawn(crate::text::prewarm)?;
        let view = RootView::new(mtm, frame, app.into(), options);
        RootView::observe_keyboard(&view);
        RootView::observe_lifecycle(&view);
        RootView::observe_time_zone(&view);
        RootView::observe_locale(&view);
        Ok(Surface { view })
    }

    /// The root view to add to a hierarchy.
    pub fn view(&self) -> &UIView {
        &self.view
    }

    /// Receives fatal app errors (bundle failed to load, uncaught JS
    /// exceptions) on the main thread. Errors are logged either way.
    pub fn set_error_handler(&self, handler: impl Fn(&str) + 'static) {
        *self.view.ivars().on_error.get(self.view.mtm()).borrow_mut() = Some(Box::new(handler));
    }

    /// Keeps the model `nsh test --target ios` steps see of the app
    /// ([`nsh_testing::agent::Model`]): every batch and error goes to it
    /// from now on.
    #[cfg(feature = "dev")]
    pub(crate) fn set_test_model(&self, model: Option<Arc<nsh_testing::agent::Model>>) {
        *self
            .view
            .ivars()
            .test_model
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = model;
    }

    /// `f` with the running app's mounter (`None` before the app starts).
    #[cfg(feature = "dev")]
    pub(crate) fn with_mounter<R>(&self, f: impl FnOnce(&Mounter) -> R) -> Option<R> {
        let running = self.view.ivars().running.borrow();
        let shared = running.as_ref()?.mounter.clone();
        drop(running);
        let mounter = shared.get(self.view.mtm()).borrow();
        mounter.as_ref().map(f)
    }

    /// Applies a development update to the running app in place. Returns
    /// false when no app runs yet. If the update cannot be applied, the
    /// handler set with [`Surface::set_hot_failed_handler`] runs.
    #[cfg(feature = "dev")]
    pub(crate) fn hot_update(&self, update: nsh_engine::HotUpdate) -> bool {
        match self.view.ivars().running.borrow().as_ref() {
            Some(running) => {
                running.engine.control().hot_update(update);
                true
            }
            None => false,
        }
    }

    /// Runs `handler` on the main thread when a development update could
    /// not be applied in place.
    #[cfg(feature = "dev")]
    pub(crate) fn set_hot_failed_handler(&self, handler: impl Fn() + 'static) {
        *self
            .view
            .ivars()
            .on_hot_failed
            .get(self.view.mtm())
            .borrow_mut() = Some(Box::new(handler));
    }

    /// The embedding app's locale and text size, standing in for the
    /// system's: sent to the running app at once, and to every app started
    /// later.
    pub fn set_host_environment(&self, host: nsh_engine::HostEnvironment) {
        self.view.ivars().host.set(host);
        self.view.publish_environment();
    }

    /// The embedding app's theme overrides (`nsh_base::theme_overrides`),
    /// which win over the app's tokens of the same names (`None`: the
    /// app's own again): sent to the running app at once, and to every app
    /// started later before its first frame.
    pub fn set_host_tokens(&self, tokens: Option<nsh_engine::Tokens>) {
        *self.view.ivars().host_tokens.borrow_mut() = tokens.clone();
        if let Some(running) = &*self.view.ivars().running.borrow() {
            running.engine.control().set_tokens(tokens);
        }
    }

    /// Replaces the fonts registered before the app starts. The engine reads
    /// them when it starts.
    pub fn set_host_fonts(&self, fonts: Vec<Vec<u8>>) {
        *self.view.ivars().fonts.borrow_mut() = fonts;
    }

    /// Registers one more font file for the running app and every app
    /// started later.
    pub fn add_font(&self, data: Vec<u8>) {
        self.view.ivars().fonts.borrow_mut().push(data.clone());
        if let Some(running) = &*self.view.ivars().running.borrow() {
            running.engine.control().register_font(data);
        }
    }

    /// Hands `url`, a link the system opened the app with, to the app's
    /// engine, whose core keeps it until the app listens (`UrlScheme`);
    /// kept until the engine starts, which applies it before the app's code
    /// first runs.
    pub(crate) fn url_scheme(&self, url: String) {
        match &*self.view.ivars().running.borrow() {
            Some(running) => send_url_scheme(&running.engine.control(), url),
            None => self.view.ivars().url_schemes.borrow_mut().push(url),
        }
    }

    /// Replaces the running app with `app` (state is reset).
    pub fn reload(&self, app: impl Into<App>) {
        let app = app.into();
        self.view.stop();
        let size = self.view.ivars().size.get();
        if size.width > 0.0 && size.height > 0.0 {
            self.view.start(
                app,
                Size::new(Points(size.width as f32), Points(size.height as f32)),
            );
        } else {
            *self.view.ivars().pending.borrow_mut() = Some(app);
        }
    }
}

/// Reports `url` as a link the system opened the app with.
fn send_url_scheme(control: &nsh_engine::EngineControl, url: String) {
    control.dispatch_event(
        nsh_core::ROOT_ID,
        nsh_core::EventKind::UrlScheme,
        nsh_core::EventPayload::Map(vec![(
            nsh_core::url_scheme::URL,
            nsh_core::PayloadValue::Str(url),
        )]),
    );
}

impl Drop for Surface {
    fn drop(&mut self) {
        self.view.stop();
        let center = NSNotificationCenter::defaultCenter();
        for observer in self.view.ivars().observers.borrow_mut().drain(..) {
            // SAFETY: an observer token returned by this center.
            unsafe { center.removeObserver(observer.as_ref()) };
        }
    }
}

/// Whether the user's first language is written right to left (as React
/// Native decides; the app's own localizations do not matter).
fn preferred_language_rtl() -> bool {
    use objc2_foundation::{NSLocale, NSLocaleLanguageDirection};
    NSLocale::preferredLanguages()
        .firstObject()
        .is_some_and(|language| {
            NSLocale::characterDirectionForLanguage(&language)
                == NSLocaleLanguageDirection::RightToLeft
        })
}

/// The user's preferred languages, most preferred first:
/// `NSLocale.preferredLanguages`, Settings' list (the app's own language
/// first when the user chose one for it). iOS restarts apps when the user
/// changes the list, so it is read as the environment is published.
fn preferred_languages() -> nsh_engine::Languages {
    let tags: Vec<String> = objc2_foundation::NSLocale::preferredLanguages()
        .iter()
        .map(|tag| tag.to_string())
        .collect();
    nsh_engine::Languages::parse(tags.iter().map(String::as_str))
        .unwrap_or_else(|| nsh_engine::Languages::one(current_locale()))
}

/// The user's locale settings (`localeSettings()`): the preferred
/// languages, the time zone, and Settings' time format (the hours of
/// `NSDateFormatter`'s format for the `j` template, which 24-hour time
/// changes), `NSCalendar`'s first weekday, `NSLocale`'s measurement system
/// and the `AppleTemperatureUnit` default, over the region's.
fn locale_settings() -> nsh_engine::LocaleSettings {
    use nsh_engine::{HourCycle, MeasurementSystem, TemperatureUnit, Weekday};
    use objc2_foundation::{
        NSCalendar, NSDateFormatter, NSLocale, NSLocaleMeasurementSystem, NSString, NSUserDefaults,
        ns_string,
    };
    let locale = NSLocale::currentLocale();
    let mut preferences = nsh_engine::LocaleSettings::parse(&locale.localeIdentifier().to_string());
    preferences.languages = preferred_languages();
    preferences.time_zone = time_zone();
    // The hours of the user's time format, which 24-hour time changes.
    let hours =
        NSDateFormatter::dateFormatFromTemplate_options_locale(ns_string!("j"), 0, Some(&locale));
    if let Some(cycle) = hours.and_then(|format| HourCycle::of_pattern(&format.to_string())) {
        preferences.hour_cycle = cycle;
    }
    // From 1 for Sunday to 7 for Saturday.
    let first = match NSCalendar::currentCalendar().firstWeekday() {
        1 => Some(Weekday::Sunday),
        n => u8::try_from(n)
            .ok()
            .and_then(|n| Weekday::from_number(n.wrapping_sub(1))),
    };
    if let Some(day) = first {
        preferences.first_day_of_week = day;
    }
    // SAFETY: a key Foundation defines.
    let system = locale.objectForKey(unsafe { NSLocaleMeasurementSystem });
    match system
        .and_then(|s| s.downcast::<NSString>().ok())
        .map(|s| s.to_string())
        .as_deref()
    {
        Some("Metric") => preferences.measurement_system = MeasurementSystem::Metric,
        Some("U.S.") => preferences.measurement_system = MeasurementSystem::Us,
        Some("U.K.") => preferences.measurement_system = MeasurementSystem::Uk,
        _ => {}
    }
    // Set once the user picks one.
    let unit =
        NSUserDefaults::standardUserDefaults().stringForKey(ns_string!("AppleTemperatureUnit"));
    match unit.map(|u| u.to_string()).as_deref() {
        Some("Celsius") => preferences.temperature_unit = TemperatureUnit::Celsius,
        Some("Fahrenheit") => preferences.temperature_unit = TemperatureUnit::Fahrenheit,
        _ => {}
    }
    preferences
}

/// The user's region format (`NSLocale.currentLocale`: language and
/// region, as Settings sets them), `Intl`'s default.
fn current_locale() -> nsh_engine::Locale {
    let identifier = objc2_foundation::NSLocale::currentLocale()
        .localeIdentifier()
        .to_string();
    nsh_engine::Locale::parse(&identifier).unwrap_or_default()
}

/// The system's time zone: its IANA name.
fn time_zone() -> nsh_engine::TimeZone {
    nsh_engine::TimeZone::parse(&NSTimeZone::systemTimeZone().name().to_string())
        .unwrap_or_default()
}

/// The app's state as UIApplication reports it now, before its
/// notifications say more.
fn lifecycle(mtm: MainThreadMarker) -> Lifecycle {
    match UIApplication::sharedApplication(mtm).applicationState() {
        UIApplicationState::Active => Lifecycle::Active,
        UIApplicationState::Background => Lifecycle::Background,
        _ => Lifecycle::Inactive,
    }
}

/// The iOS version (`UIDevice.systemVersion`, the iOS version Catalyst
/// apps run as), read once.
fn os_version(mtm: MainThreadMarker) -> (u16, u16) {
    static VERSION: std::sync::OnceLock<(u16, u16)> = std::sync::OnceLock::new();
    *VERSION.get_or_init(|| {
        let version = UIDevice::currentDevice(mtm).systemVersion().to_string();
        let mut parts = version.split('.').map(|p| p.parse().unwrap_or(0));
        (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
    })
}
