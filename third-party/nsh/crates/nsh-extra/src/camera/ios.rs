//! The camera on iOS: `UIImagePickerController` with the camera as its
//! source, shown full screen (on an iPad too) over the surface that asked
//! (`nsh_platform_ios::presenting_controller`). One camera shows at a time,
//! its permission prompt included:
//! another photo asked meanwhile fails, and every photo is answered once,
//! also when the picker cannot be shown or other code dismisses it. Asked
//! while a sheet over the surface closes (or one opens), the camera shows
//! once that transition ends. The camera needs the user's
//! permission and the app's `NSCameraUsageDescription`: without the key
//! the system would end the app, so the photo fails instead (an embedding
//! app may lack it). The permission is asked once, before the camera
//! shows. The photo taken is prepared off the main thread as a picked image
//! (`nsh_platform_ios::prepare_image`): encoded again as a JPEG, upright,
//! scaled as the request says.

use std::{
    cell::{Cell, RefCell},
    ptr::NonNull,
    rc::Rc,
    sync::Mutex,
};

use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchTime, MainThreadBound};
use nsh_core::{picker::PickedFile, prelude::*};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, Bool, ProtocolObject},
};
use objc2_foundation::{NSArray, NSBundle, NSDictionary, NSObject, NSObjectProtocol, NSString};
use objc2_ui_kit::{
    UIImage, UIModalPresentationStyle, UIViewController, UIViewControllerTransitionCoordinator,
    UIViewControllerTransitionCoordinatorContext, UIWindow,
};
use tokio::sync::oneshot;

use super::{PhotoError, PhotoRequest};

// The camera's permission is AVFoundation's (`AVCaptureDevice`).
#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}

/// `UIImagePickerControllerSourceTypeCamera`.
const SOURCE_CAMERA: isize = 1;

/// `AVMediaTypeVideo`: the camera's media type.
const MEDIA_VIDEO: &str = "vide";

/// `AVAuthorizationStatus`.
const NOT_DETERMINED: isize = 0;
const AUTHORIZED: isize = 3;

/// What the camera answered.
enum Taken {
    Photo(SentImage),
    Cancelled,
    Failed(PhotoError),
}

type Answer = oneshot::Sender<Taken>;

/// A `UIImage` handed to another thread.
struct SentImage(Retained<UIImage>);

// SAFETY: a `UIImage` is immutable, and UIKit documents it safe to use from
// any thread.
unsafe impl Send for SentImage {}

pub(super) async fn available() -> bool {
    run_on_main_thread(|| usable().is_ok())
        .await
        .unwrap_or(false)
}

pub(super) async fn take_photo(request: PhotoRequest) -> Result<Option<PickedFile>, PhotoError> {
    let (answer, taken) = oneshot::channel();
    if let Err(error) = run_on_main_thread(move || start(answer)).await {
        return Err(PhotoError::failed(format!(
            "the camera cannot be shown: {error}"
        )));
    }
    let image = match taken.await {
        Ok(Taken::Photo(image)) => image,
        Ok(Taken::Cancelled) => return Ok(None),
        Ok(Taken::Failed(error)) => return Err(error),
        Err(_) => return Err(PhotoError::failed("the camera went away without a photo")),
    };
    blocking(move || prepare(image, request))
        .await
        .map_err(|error| PhotoError::failed(format!("cannot prepare the photo: {error}")))?
        .map(Some)
}

/// Whether this device has a camera UIKit shows: false in the simulator, on
/// Mac Catalyst and on devices without one. Main thread.
fn has_camera() -> bool {
    // UIKit shows a Mac's camera to a Catalyst app, but NSH packages none
    // and its development host is not entitled to the camera: none there.
    // The simulator has no real camera, yet UIKit reports one there (the
    // iOS 27 simulator), and the photo could not be taken: none there either.
    if cfg!(any(target_abi = "macabi", target_abi = "sim")) {
        return false;
    }
    let Some(class) = AnyClass::get(c"UIImagePickerController") else {
        return false;
    };
    // SAFETY: UIKit's documented class method.
    unsafe { msg_send![class, isSourceTypeAvailable: SOURCE_CAMERA] }
}

/// The camera's permission: `AVCaptureDevice`'s for video.
fn authorization() -> Option<isize> {
    let device = AnyClass::get(c"AVCaptureDevice")?;
    let video = NSString::from_str(MEDIA_VIDEO);
    // SAFETY: AVFoundation's documented class method.
    let status: isize = unsafe { msg_send![device, authorizationStatusForMediaType: &*video] };
    Some(status)
}

/// Whether the camera can be shown here: the device has one and the app's
/// Info.plist describes its use. `available()` and every photo ask the
/// same. Main thread.
fn usable() -> Result<(), PhotoError> {
    let described = NSBundle::mainBundle()
        .objectForInfoDictionaryKey(&NSString::from_str("NSCameraUsageDescription"))
        .is_some();
    if !described {
        return Err(PhotoError::unavailable(
            "the app's Info.plist has no NSCameraUsageDescription",
        ));
    }
    if !has_camera() {
        return Err(PhotoError::unavailable("this device has no camera"));
    }
    Ok(())
}

/// Shows the camera, after asking for the permission when the user was not
/// asked yet; answers at once when it cannot. Main thread.
fn start(answer: Answer) {
    let fail = |answer: Answer, error| drop(answer.send(Taken::Failed(error)));
    if let Err(error) = usable() {
        return fail(answer, error);
    }
    if ASKING.get() || showing() {
        return fail(
            answer,
            PhotoError::failed("the camera is already showing for another photo"),
        );
    }
    // The surface that asked, while its main-thread function runs: the
    // camera covers it even when it shows after the permission's prompt.
    let mtm = MainThreadMarker::new().expect("the camera starts on the main thread");
    let Some(top) = nsh_platform_ios::presenting_controller(mtm) else {
        return fail(
            answer,
            PhotoError::failed("there is no window to show the camera over"),
        );
    };
    match authorization() {
        Some(AUTHORIZED) => show(answer, &top),
        Some(NOT_DETERMINED) => ask(answer, top),
        Some(_) => fail(
            answer,
            PhotoError::denied("the user does not let the app use the camera"),
        ),
        None => fail(
            answer,
            PhotoError::unavailable("AVFoundation cannot be loaded"),
        ),
    }
}

/// Asks the user for the camera, then shows it or fails the photo.
fn ask(answer: Answer, top: Retained<UIViewController>) {
    let Some(device) = AnyClass::get(c"AVCaptureDevice") else {
        drop(answer.send(Taken::Failed(PhotoError::unavailable(
            "AVFoundation cannot be loaded",
        ))));
        return;
    };
    let mtm = MainThreadMarker::from(&*top);
    ASKING.set(true);
    let pending = Mutex::new(Some((answer, MainThreadBound::new(top, mtm))));
    let handler = RcBlock::new(move |granted: Bool| {
        let Some((answer, top)) = pending.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return;
        };
        // The answer comes on a queue of AVFoundation's.
        DispatchQueue::main().exec_async(move || {
            let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
            ASKING.set(false);
            let top = top.into_inner(mtm);
            if granted.as_bool() {
                show(answer, &top);
            } else {
                drop(answer.send(Taken::Failed(PhotoError::denied(
                    "the user does not let the app use the camera",
                ))));
            }
        });
    });
    let video = NSString::from_str(MEDIA_VIDEO);
    // SAFETY: AVFoundation's documented class method; the handler runs once.
    unsafe {
        let _: () =
            msg_send![device, requestAccessForMediaType: &*video, completionHandler: &*handler];
    }
}

thread_local! {
    /// The delegates of the cameras shown (a picker holds its delegate
    /// weakly).
    static SHOWN: RefCell<Vec<Retained<CameraDelegate>>> = const { RefCell::new(Vec::new()) };
    /// The permission's prompt is showing for a photo: another fails at once.
    static ASKING: Cell<bool> = const { Cell::new(false) };
}

pub(crate) struct CameraIvars {
    answer: RefCell<Option<Answer>>,
    /// The picker it answers for.
    picker: RefCell<Option<Retained<UIViewController>>>,
    /// The picker waits for a transition to end before it is presented.
    waiting: Cell<bool>,
}

define_class!(
    /// The delegate of one camera: hands the photo taken over.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = CameraIvars]
    pub(crate) struct CameraDelegate;

    unsafe impl NSObjectProtocol for CameraDelegate {}

    impl CameraDelegate {
        #[unsafe(method(imagePickerController:didFinishPickingMediaWithInfo:))]
        fn did_finish(&self, picker: &UIViewController, info: &NSDictionary<NSString, AnyObject>) {
            picker.dismissViewControllerAnimated_completion(true, None);
            let key = NSString::from_str("UIImagePickerControllerOriginalImage");
            let taken = match info
                .objectForKey(&key)
                .and_then(|image| image.downcast::<UIImage>().ok())
            {
                Some(image) => Taken::Photo(SentImage(image)),
                None => Taken::Failed(PhotoError::failed("the camera gave no image")),
            };
            self.finish(taken);
        }

        #[unsafe(method(imagePickerControllerDidCancel:))]
        fn did_cancel(&self, picker: &UIViewController) {
            picker.dismissViewControllerAnimated_completion(true, None);
            self.finish(Taken::Cancelled);
        }
    }
);

impl CameraDelegate {
    /// Answers the photo once and lets the delegate and its picker go.
    fn finish(&self, taken: Taken) {
        if let Some(answer) = self.ivars().answer.borrow_mut().take() {
            drop(answer.send(taken));
        }
        self.ivars().picker.borrow_mut().take();
        let this: *const Self = self;
        SHOWN.with_borrow_mut(|shown| shown.retain(|d| !std::ptr::eq(&**d, this)));
    }

    /// Whether its picker is on screen, on its way there or waiting for a
    /// transition to end before it is presented.
    fn presented(&self) -> bool {
        if self.ivars().waiting.get() {
            return true;
        }
        self.ivars().picker.borrow().as_ref().is_some_and(|picker| {
            // SAFETY: UIKit's documented property, read on the main thread.
            let presenting: Option<Retained<UIViewController>> =
                unsafe { msg_send![&**picker, presentingViewController] };
            presenting.is_some()
        })
    }
}

/// Whether a camera is showing. One whose picker went away without telling
/// its delegate (other code dismissed it) is answered now. Main thread.
fn showing() -> bool {
    let shown = SHOWN.with_borrow(Clone::clone);
    for delegate in shown {
        if !delegate.presented() {
            delegate.finish(Taken::Failed(PhotoError::failed(
                "the camera was closed without a photo",
            )));
        }
    }
    SHOWN.with_borrow(|shown| !shown.is_empty())
}

/// Shows the camera full screen over `top`, the surface's controller.
fn show(answer: Answer, top: &UIViewController) {
    let mtm = MainThreadMarker::from(top);
    let Some(class) = AnyClass::get(c"UIImagePickerController") else {
        drop(answer.send(Taken::Failed(PhotoError::unavailable(
            "UIKit has no image picker",
        ))));
        return;
    };
    // SAFETY: UIKit's documented API, sent dynamically.
    let delegate = unsafe {
        let picker: Retained<AnyObject> = msg_send![class, new];
        let picker: Retained<UIViewController> = Retained::cast_unchecked(picker);
        let _: () = msg_send![&picker, setSourceType: SOURCE_CAMERA];
        let images = NSArray::from_retained_slice(&[NSString::from_str("public.image")]);
        let _: () = msg_send![&picker, setMediaTypes: &*images];
        let delegate = CameraDelegate::alloc(mtm).set_ivars(CameraIvars {
            answer: RefCell::new(Some(answer)),
            picker: RefCell::new(Some(picker.clone())),
            waiting: Cell::new(true),
        });
        let delegate: Retained<CameraDelegate> = msg_send![super(delegate), init];
        let _: () = msg_send![&picker, setDelegate: &*delegate];
        // Full screen everywhere: an iPad would show the camera in a form
        // sheet otherwise.
        picker.setModalPresentationStyle(UIModalPresentationStyle::FullScreen);
        delegate
    };
    SHOWN.with_borrow_mut(|shown| shown.push(delegate.clone()));
    let window = top.viewIfLoaded().and_then(|view| view.window());
    present_settled(delegate, window, 0);
}

/// The most waits the camera makes for transitions before it gives up: a
/// transition takes one, a look for one ending takes [`LOOK_MS`].
const MAX_WAITS: u32 = 120;

/// How long the camera waits before it looks again at a transition that
/// cannot tell when it ends, in milliseconds (a frame).
const LOOK_MS: u64 = 16;

/// Presents the delegate's picker over the top controller of `window`
/// (the surface's), once no transition runs there. UIKit postpones a
/// presentation over a controller whose presented one is being dismissed
/// (a sheet closing as the photo is asked for) until that dismissal ends,
/// telling nothing of it meanwhile, and refuses one over a controller
/// being presented. Waiting here first, a picker not presented by the next
/// turn is one UIKit refused.
fn present_settled(
    delegate: Retained<CameraDelegate>,
    window: Option<Retained<UIWindow>>,
    waits: u32,
) {
    if delegate.ivars().answer.borrow().is_none() {
        return;
    }
    let refused = |delegate: &CameraDelegate| {
        delegate.ivars().waiting.set(false);
        delegate.finish(Taken::Failed(PhotoError::failed(
            "the camera cannot be shown over the app's view",
        )));
    };
    // Found again after each wait: what closed meanwhile uncovered its
    // presenter, what was presented covers it.
    let Some(mut top) = window.as_ref().and_then(|w| w.rootViewController()) else {
        return refused(&delegate);
    };
    while let Some(next) = top.presentedViewController() {
        if next.isBeingDismissed() {
            break;
        }
        top = next;
    }
    let moving = match top.presentedViewController() {
        Some(leaving) => Some(leaving),
        None if top.isBeingPresented() => Some(top.clone()),
        None => None,
    };
    if let Some(moving) = moving {
        if waits >= MAX_WAITS {
            return refused(&delegate);
        }
        return after_transition(&moving, move || {
            present_settled(delegate, window, waits + 1);
        });
    }
    delegate.ivars().waiting.set(false);
    let Some(picker) = delegate.ivars().picker.borrow().clone() else {
        return;
    };
    top.presentViewController_animated_completion(&picker, true, None);
    // UIKit refuses a presentation silently: then nothing would answer the
    // photo.
    let mtm = MainThreadMarker::from(&*top);
    let delegate = MainThreadBound::new(delegate, mtm);
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
        let delegate = delegate.into_inner(mtm);
        if delegate.ivars().answer.borrow().is_some() && !delegate.presented() {
            refused(&delegate);
        }
    });
}

/// Runs `then` on the main queue once the transition `moving` is in ends,
/// or a frame later when it cannot tell.
fn after_transition(moving: &UIViewController, then: impl FnOnce() + 'static) {
    let mtm = MainThreadMarker::from(moving);
    let once = Rc::new(Cell::new(Some(then)));
    let done = {
        let once = once.clone();
        RcBlock::new(
            move |_: NonNull<ProtocolObject<dyn UIViewControllerTransitionCoordinatorContext>>| {
                // The main queue's next turn: the transition is over by
                // then, and what it postponed has begun.
                if let Some(then) = once.take() {
                    later(mtm, 0, then);
                }
            },
        )
    };
    // Refused when the transition is already ending: look again shortly.
    let waiting = moving.transitionCoordinator().is_some_and(|coordinator| {
        coordinator.animateAlongsideTransition_completion(None, Some(&done))
    });
    if !waiting && let Some(then) = once.take() {
        later(mtm, LOOK_MS, then);
    }
}

/// Runs `f` on the main queue after `ms` milliseconds, or on its next turn.
fn later(mtm: MainThreadMarker, ms: u64, f: impl FnOnce() + 'static) {
    let f = MainThreadBound::new(f, mtm);
    let run = move || {
        let mtm = MainThreadMarker::new().expect("the main queue runs on the main thread");
        (f.into_inner(mtm))();
    };
    if ms == 0 {
        return DispatchQueue::main().exec_async(run);
    }
    let when = DispatchTime::NOW.time((ms * 1_000_000) as i64);
    if let Err(error) = DispatchQueue::main().after(when, run) {
        log::warn!("the camera cannot wait for a transition: {error:?}");
    }
}

/// The photo `image` as `request` asks: a JPEG drawn upright (its
/// orientation applied), scaled down. Off the main thread.
fn prepare(image: SentImage, request: PhotoRequest) -> Result<PickedFile, PhotoError> {
    // The camera's pixels as a JPEG of the best quality, its orientation a
    // tag; ImageIO then draws it upright at the request's quality.
    let data = UIImage::jpeg_representation(&image.0, 1.0)
        .ok_or_else(|| PhotoError::failed("the photo cannot be encoded"))?;
    nsh_platform_ios::prepare_image(data.to_vec(), &super::photo_name(), &request.pick_request())
        .ok_or_else(|| PhotoError::failed("the photo cannot be encoded"))
}
