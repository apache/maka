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

#[derive(Default)]
struct ScanGate {
    generation: u64,
    active: bool,
    paused: bool,
    delivered: bool,
}

impl ScanGate {
    fn set_active(&mut self, active: bool) -> bool {
        if self.active == active {
            return false;
        }
        self.active = active;
        self.generation += 1;
        self.delivered = false;
        true
    }

    fn set_paused(&mut self, paused: bool) {
        if self.paused && !paused {
            self.delivered = false;
        }
        self.paused = paused;
    }

    fn activation(&self) -> Option<u64> {
        self.active.then_some(self.generation)
    }

    fn listening(&self, generation: u64) -> bool {
        self.activation() == Some(generation) && !self.paused && !self.delivered
    }

    fn take_scan(&mut self, generation: u64, value: &str) -> bool {
        if value.is_empty() || !self.listening(generation) {
            return false;
        }
        self.delivered = true;
        true
    }
}

#[cfg(target_os = "ios")]
pub(crate) use ios::register;

#[cfg(target_os = "ios")]
mod ios {
    use super::ScanGate;
    use block2::RcBlock;
    use dispatch2::{DispatchQueue, DispatchRetained};
    use nsh_platform_ios::{ComponentContext, Components, NativeComponent};
    use objc2::{
        AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
        rc::{Retained, autoreleasepool},
        runtime::{Bool, ProtocolObject},
    };
    use objc2_av_foundation::{
        AVAuthorizationStatus, AVCaptureConnection, AVCaptureDevice, AVCaptureDeviceInput,
        AVCaptureMetadataOutput, AVCaptureMetadataOutputObjectsDelegate, AVCaptureSession,
        AVCaptureTorchMode, AVCaptureVideoPreviewLayer, AVLayerVideoGravityResizeAspectFill,
        AVMediaType, AVMediaTypeVideo, AVMetadataMachineReadableCodeObject, AVMetadataObject,
        AVMetadataObjectTypeQRCode,
    };
    use objc2_core_foundation::CGRect;
    use objc2_foundation::{NSArray, NSObject, NSObjectProtocol};
    use objc2_ui_kit::{UIResponder, UIView};
    use serde_json::{Value, json};
    use std::{
        cell::Cell,
        rc::Rc,
        sync::{Arc, Mutex, OnceLock, Weak},
    };

    pub(crate) fn register(components: &Components) {
        components.register(
            "MakaCodeScanner",
            Rc::new(|context| Box::new(Scanner::new(context))),
        );
    }

    fn capture_queue() -> &'static DispatchQueue {
        static QUEUE: OnceLock<DispatchRetained<DispatchQueue>> = OnceLock::new();
        QUEUE.get_or_init(|| DispatchQueue::new("com.maka.ios.code-scanner", None))
    }

    enum CameraError {
        Denied,
        Restricted,
        Unavailable,
        Failed(String),
    }

    impl CameraError {
        fn report(&self, context: &ComponentContext) {
            let (code, state, message) = match self {
                Self::Denied => ("denied", "denied", "Camera access was denied."),
                Self::Restricted => ("restricted", "restricted", "Camera access is restricted."),
                Self::Unavailable => (
                    "unavailable",
                    "unavailable",
                    "No QR-capable camera is available.",
                ),
                Self::Failed(message) => ("failed", "error", message.as_str()),
            };
            context.emit("status", json!({"state":state}));
            context.emit("error", json!({"code":code,"message":message}));
        }
    }

    #[derive(Default)]
    struct Controls {
        gate: ScanGate,
        torch: bool,
    }

    struct Worker {
        context: ComponentContext,
        controls: Mutex<Controls>,
        capture: Mutex<Option<Capture>>,
    }

    impl Worker {
        fn schedule(
            self: &Arc<Self>,
            work: impl FnOnce(&Arc<Self>, &mut Capture) + Send + 'static,
        ) {
            let worker = self.clone();
            capture_queue().exec_async(move || {
                autoreleasepool(|_| {
                    // Only the serial capture queue borrows this slot. Do not hold a lock
                    // while AVFoundation starts/stops, which may block.
                    let capture = worker.capture.lock().unwrap().take();
                    if let Some(mut capture) = capture {
                        work(&worker, &mut capture);
                        *worker.capture.lock().unwrap() = Some(capture);
                    }
                })
            });
        }

        fn set_active(self: &Arc<Self>, active: bool) {
            let mut controls = self.controls.lock().unwrap();
            if !controls.gate.set_active(active) {
                return;
            }
            if let Some(generation) = controls.gate.activation() {
                self.context.emit("status", json!({"state":"initializing"}));
                self.schedule(move |worker, capture| capture.start(worker, generation));
            } else {
                self.schedule(|_, capture| capture.stop());
            }
        }

        fn shutdown(self: &Arc<Self>) {
            self.controls.lock().unwrap().gate.set_active(false);
            let worker = self.clone();
            capture_queue().exec_async(move || {
                autoreleasepool(|_| {
                    let capture = worker.capture.lock().unwrap().take();
                    if let Some(mut capture) = capture {
                        capture.stop();
                    }
                })
            });
        }

        fn report(&self, generation: u64, result: Result<(), CameraError>) {
            let controls = self.controls.lock().unwrap();
            if controls.gate.activation() == Some(generation) {
                match result {
                    Ok(()) => self.context.emit("status", json!({"state":"ready"})),
                    Err(error) => error.report(&self.context),
                }
            }
        }
    }

    struct Capture {
        session: Retained<AVCaptureSession>,
        running: Option<Running>,
        permission: Option<PermissionRequest>,
    }

    struct PermissionRequest {
        // The most recent activation processed by the capture queue, not a
        // newer UI activation whose stop/start commands are still queued.
        activation: Option<u64>,
    }

    // SAFETY: After the preview layer is attached on main, all session/graph operations
    // are confined to the serial capture queue. UIKit only lays out the preview layer;
    // the main-queue delegate reads its arguments, never mutating the session.
    unsafe impl Send for Capture {}

    impl Capture {
        fn start(&mut self, worker: &Arc<Worker>, generation: u64) {
            if worker.controls.lock().unwrap().gate.activation() != Some(generation)
                || self.running.is_some()
            {
                return;
            }
            if let Some(permission) = &mut self.permission {
                permission.activation = Some(generation);
                return;
            }
            // SAFETY: Video is a documented media type for device lookup and authorization.
            let Some(media) = (unsafe { AVMediaTypeVideo }) else {
                worker.report(generation, Err(CameraError::Unavailable));
                return;
            };
            let Some(device) = (unsafe { AVCaptureDevice::defaultDeviceWithMediaType(media) })
            else {
                worker.report(generation, Err(CameraError::Unavailable));
                return;
            };
            // SAFETY: `media` is AVMediaTypeVideo.
            match unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) } {
                AVAuthorizationStatus::Authorized => {
                    let result = self.configure(worker, generation, device);
                    worker.report(generation, result);
                }
                AVAuthorizationStatus::Denied => {
                    worker.report(generation, Err(CameraError::Denied))
                }
                AVAuthorizationStatus::Restricted => {
                    worker.report(generation, Err(CameraError::Restricted))
                }
                AVAuthorizationStatus::NotDetermined => {
                    self.request_permission(worker, generation, media)
                }
                _ => worker.report(
                    generation,
                    Err(CameraError::Failed(
                        "Unknown camera authorization status.".into(),
                    )),
                ),
            }
        }

        fn request_permission(
            &mut self,
            worker: &Arc<Worker>,
            generation: u64,
            media: &AVMediaType,
        ) {
            self.permission = Some(PermissionRequest {
                activation: Some(generation),
            });
            let worker = Arc::downgrade(worker);
            let callback = RcBlock::new(move |granted: Bool| {
                if let Some(worker) = worker.upgrade() {
                    let granted = granted.as_bool();
                    worker.schedule(move |worker, capture| {
                        if let Some(generation) = capture
                            .permission
                            .take()
                            .and_then(|request| request.activation)
                        {
                            if granted {
                                capture.start(worker, generation);
                            } else {
                                // SAFETY: Permission was requested for the video media type.
                                let status = unsafe {
                                    AVMediaTypeVideo.map(|media| {
                                        AVCaptureDevice::authorizationStatusForMediaType(media)
                                    })
                                };
                                let error = if status == Some(AVAuthorizationStatus::Restricted) {
                                    CameraError::Restricted
                                } else {
                                    CameraError::Denied
                                };
                                worker.report(generation, Err(error));
                            }
                        }
                    });
                }
            });
            // SAFETY: `media` is AVMediaTypeVideo. The app declares a camera usage
            // description, and the copied block captures only a thread-safe Weak.
            unsafe {
                AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &callback)
            };
        }

        fn configure(
            &mut self,
            worker: &Arc<Worker>,
            generation: u64,
            device: Retained<AVCaptureDevice>,
        ) -> Result<(), CameraError> {
            let delegate = MetadataDelegate::alloc().set_ivars(DelegateIvars {
                worker: Arc::downgrade(worker),
                generation,
            });
            // SAFETY: NSObject's designated initializer, on the capture queue.
            let delegate: Retained<MetadataDelegate> = unsafe { msg_send![super(delegate), init] };
            // SAFETY: The session is stopped and exclusively configured on this queue.
            // Inputs/outputs are checked before adding and metadata types before setting.
            let (input, output) = unsafe {
                let input = AVCaptureDeviceInput::deviceInputWithDevice_error(&device).map_err(
                    |error| CameraError::Failed(error.localizedDescription().to_string()),
                )?;
                let output = AVCaptureMetadataOutput::new();
                if !self.session.canAddInput(&input) {
                    return Err(CameraError::Failed(
                        "Could not attach the camera input.".into(),
                    ));
                }
                self.session.addInput(&input);
                if !self.session.canAddOutput(&output) {
                    self.session.removeInput(&input);
                    return Err(CameraError::Failed(
                        "Could not attach the camera output.".into(),
                    ));
                }
                self.session.addOutput(&output);
                let qr = AVMetadataObjectTypeQRCode;
                if !output
                    .availableMetadataObjectTypes()
                    .iter()
                    .any(|kind| &*kind == qr)
                {
                    self.session.removeOutput(&output);
                    self.session.removeInput(&input);
                    return Err(CameraError::Unavailable);
                }
                output.setMetadataObjectTypes(Some(&NSArray::from_slice(&[qr])));
                output.setMetadataObjectsDelegate_queue(
                    Some(ProtocolObject::from_ref(&*delegate)),
                    Some(DispatchQueue::main()),
                );
                (input, output)
            };
            self.running = Some(Running {
                device,
                input,
                output,
                delegate,
            });
            if worker.controls.lock().unwrap().gate.activation() != Some(generation) {
                self.stop();
                return Ok(());
            }
            // SAFETY: Start is serialized with all capture configuration, off main.
            unsafe { self.session.startRunning() };
            // SAFETY: Read on the same queue that owns the session.
            if !unsafe { self.session.isRunning() } {
                self.stop();
                return Err(CameraError::Failed("Could not start the camera.".into()));
            }
            if worker.controls.lock().unwrap().gate.activation() != Some(generation) {
                self.stop();
                return Ok(());
            }
            self.update_torch(worker);
            Ok(())
        }

        fn update_torch(&self, worker: &Worker) {
            if let Some(running) = &self.running {
                let torch = {
                    let controls = worker.controls.lock().unwrap();
                    controls.gate.activation() == Some(running.delegate.ivars().generation)
                        && controls.torch
                };
                running.set_torch(torch);
            }
        }

        fn stop(&mut self) {
            if let Some(permission) = &mut self.permission {
                permission.activation = None;
            }
            if let Some(running) = self.running.take() {
                running.set_torch(false);
                // SAFETY: The graph is only touched on this queue. Clear the weak
                // delegate before stopping and releasing its retained owner.
                unsafe {
                    running.output.setMetadataObjectsDelegate_queue(None, None);
                    self.session.stopRunning();
                    self.session.removeOutput(&running.output);
                    self.session.removeInput(&running.input);
                }
            }
        }
    }

    struct Running {
        device: Retained<AVCaptureDevice>,
        input: Retained<AVCaptureDeviceInput>,
        output: Retained<AVCaptureMetadataOutput>,
        delegate: Retained<MetadataDelegate>,
    }

    impl Running {
        fn set_torch(&self, enabled: bool) {
            let mode = if enabled {
                AVCaptureTorchMode::On
            } else {
                AVCaptureTorchMode::Off
            };
            let device = &self.device;
            // SAFETY: Only this capture queue changes the device. Check support and
            // availability again under a successful configuration lock before setting.
            unsafe {
                if !device.hasTorch() || !device.isTorchAvailable() || device.torchMode() == mode {
                    return;
                }
                if let Err(error) = device.lockForConfiguration() {
                    log::warn!(
                        "Could not lock the camera torch: {}",
                        error.localizedDescription()
                    );
                    return;
                }
                if device.isTorchAvailable() && device.isTorchModeSupported(mode) {
                    device.setTorchMode(mode);
                }
                device.unlockForConfiguration();
            }
        }
    }

    struct DelegateIvars {
        worker: Weak<Worker>,
        generation: u64,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "MakaCodeScannerMetadataDelegate"]
        #[ivars = DelegateIvars]
        struct MetadataDelegate;

        // SAFETY: NSObject supplies its protocol methods.
        unsafe impl NSObjectProtocol for MetadataDelegate {}

        // SAFETY: Implements the documented delegate selector and signature. The
        // output schedules callbacks only on the main queue.
        unsafe impl AVCaptureMetadataOutputObjectsDelegate for MetadataDelegate {
            #[allow(non_snake_case)]
            #[unsafe(method(captureOutput:didOutputMetadataObjects:fromConnection:))]
            unsafe fn captureOutput_didOutputMetadataObjects_fromConnection(
                &self,
                _output: &AVCaptureMetadataOutput,
                objects: &NSArray<AVMetadataObject>,
                _connection: &AVCaptureConnection,
            ) {
                let ivars = self.ivars();
                let Some(worker) = ivars.worker.upgrade() else {
                    return;
                };
                let mut controls = worker.controls.lock().unwrap();
                if !controls.gate.listening(ivars.generation) {
                    return;
                }
                for object in objects {
                    let Ok(code) = object.downcast::<AVMetadataMachineReadableCodeObject>() else {
                        continue;
                    };
                    // SAFETY: The metadata object was checked to be machine-readable.
                    if let Some(value) = unsafe { code.stringValue() } {
                        let value = value.to_string();
                        if controls.gate.take_scan(ivars.generation, &value) {
                            worker
                                .context
                                .emit("scan", json!({"value":value,"format":"qr"}));
                            break;
                        }
                    }
                }
            }
        }
    );

    struct ViewIvars {
        preview: Retained<AVCaptureVideoPreviewLayer>,
        worker: Weak<Worker>,
        active: Cell<bool>,
    }

    define_class!(
        #[unsafe(super(UIView, UIResponder, NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "MakaCodeScannerView"]
        #[ivars = ViewIvars]
        struct ScannerView;

        impl ScannerView {
            #[unsafe(method(layoutSubviews))]
            fn layout_subviews(&self) {
                // SAFETY: Call UIView's implementation and lay out its sublayer on main.
                unsafe {
                    let _: () = msg_send![super(self), layoutSubviews];
                    self.ivars().preview.setFrame(self.bounds());
                }
            }

            #[unsafe(method(didMoveToWindow))]
            fn did_move_to_window(&self) {
                // SAFETY: This is UIView's superclass implementation.
                let _: () = unsafe { msg_send![super(self), didMoveToWindow] };
                self.update_active();
            }
        }
    );

    impl ScannerView {
        fn update_active(&self) {
            if let Some(worker) = self.ivars().worker.upgrade() {
                worker.set_active(self.ivars().active.get() && self.window().is_some());
            }
        }
    }

    struct Scanner {
        view: Retained<ScannerView>,
        worker: Arc<Worker>,
    }

    impl Scanner {
        fn new(context: ComponentContext) -> Self {
            let mtm = MainThreadMarker::new().expect("NSH creates components on the main thread");
            // SAFETY: Create and attach the preview on main, before handing the
            // unconfigured session over to the serial capture queue.
            let (session, preview) = unsafe {
                let session = AVCaptureSession::new();
                let preview = AVCaptureVideoPreviewLayer::initWithSession(
                    AVCaptureVideoPreviewLayer::alloc(),
                    &session,
                );
                if let Some(gravity) = AVLayerVideoGravityResizeAspectFill {
                    preview.setVideoGravity(gravity);
                }
                (session, preview)
            };
            let worker = Arc::new(Worker {
                context,
                controls: Mutex::default(),
                capture: Mutex::new(Some(Capture {
                    session,
                    running: None,
                    permission: None,
                })),
            });
            let view = ScannerView::alloc(mtm).set_ivars(ViewIvars {
                preview,
                worker: Arc::downgrade(&worker),
                active: Cell::new(false),
            });
            // SAFETY: UIView's designated initializer and main-thread layer attachment.
            let view: Retained<ScannerView> = unsafe {
                let view: Retained<ScannerView> =
                    msg_send![super(view), initWithFrame: CGRect::ZERO];
                view.layer().addSublayer(&view.ivars().preview);
                view
            };
            view.setClipsToBounds(true);
            Self { view, worker }
        }
    }

    impl NativeComponent for Scanner {
        fn view(&self) -> &UIView {
            &self.view
        }

        fn set_prop(&mut self, name: &str, value: Option<&Value>) {
            let enabled = value.and_then(Value::as_bool).unwrap_or(false);
            match name {
                "active" => {
                    self.view.ivars().active.set(enabled);
                    self.view.update_active();
                }
                "paused" => self
                    .worker
                    .controls
                    .lock()
                    .unwrap()
                    .gate
                    .set_paused(enabled),
                "torch" => {
                    self.worker.controls.lock().unwrap().torch = enabled;
                    self.worker
                        .schedule(|worker, capture| capture.update_torch(worker));
                }
                _ => {}
            }
        }
    }

    impl Drop for Scanner {
        fn drop(&mut self) {
            self.view.ivars().active.set(false);
            self.worker.shutdown();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ScanGate;

    #[test]
    fn accepts_one_nonempty_scan_until_resumed() {
        let mut gate = ScanGate::default();
        assert!(gate.set_active(true));
        let generation = gate.activation().unwrap();
        assert!(!gate.take_scan(generation, ""));
        assert!(gate.take_scan(generation, "pairing code"));
        gate.set_paused(false);
        assert!(!gate.take_scan(generation, "another code"));
        gate.set_paused(true);
        assert!(!gate.take_scan(generation, "another code"));
        gate.set_paused(false);
        assert!(gate.take_scan(generation, "pairing code"));
    }

    #[test]
    fn deactivation_immediately_fences_callbacks_even_after_reactivation() {
        let mut gate = ScanGate::default();
        gate.set_active(true);
        let old = gate.activation().unwrap();
        gate.set_active(false);
        assert!(!gate.take_scan(old, "old code"));
        gate.set_active(true);
        assert!(!gate.take_scan(old, "old code"));
        assert!(gate.take_scan(gate.activation().unwrap(), "new code"));
    }
}
