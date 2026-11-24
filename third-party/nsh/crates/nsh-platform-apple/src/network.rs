//! How the device reaches the network (`network()`), for the macOS and iOS
//! backends: the system's path monitor (Network.framework's
//! `nw_path_monitor`) on the main queue and, on iOS, whether the user lets
//! the app use cellular data (CoreTelephony's `CTCellularData`).
//!
//! One monitor per process, started by the first surface that reads
//! [`network`]: the route is the device's, whichever surface shows. Each
//! change posts [`CHANGED`] on the default notification center from the
//! main thread; the backends observe it and report their surfaces'
//! environments again.

use std::{
    cell::Cell,
    ffi::{c_int, c_void},
    ptr,
};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use nsh_core::platform::{Network, NetworkKind};
use objc2::MainThreadMarker;
use objc2_foundation::{NSNotificationCenter, NSString};

/// The notification posted on the default center, on the main thread,
/// when [`network`] changed.
pub const CHANGED: &str = "NSHNetworkDidChangeNotification";

/// [`CHANGED`] as the notification center names it.
pub fn changed_name() -> objc2::rc::Retained<NSString> {
    NSString::from_str(CHANGED)
}

/// `nw_path_monitor_t`, `nw_path_t`: Network.framework's objects.
type NwObject = *mut c_void;

// `nw_path_status_t`.
const STATUS_INVALID: c_int = 0;
const STATUS_UNSATISFIED: c_int = 2;
// `nw_interface_type_t`.
const INTERFACE_WIFI: c_int = 1;
const INTERFACE_CELLULAR: c_int = 2;
const INTERFACE_WIRED: c_int = 3;

#[link(name = "Network", kind = "framework")]
unsafe extern "C" {
    fn nw_path_monitor_create() -> NwObject;
    fn nw_path_monitor_set_queue(monitor: NwObject, queue: *mut c_void);
    fn nw_path_monitor_set_update_handler(
        monitor: NwObject,
        handler: &block2::Block<dyn Fn(NwObject)>,
    );
    fn nw_path_monitor_start(monitor: NwObject);
    fn nw_path_get_status(path: NwObject) -> c_int;
    fn nw_path_uses_interface_type(path: NwObject, interface_type: c_int) -> bool;
    fn nw_path_is_expensive(path: NwObject) -> bool;
    fn nw_path_is_constrained(path: NwObject) -> bool;
}

thread_local! {
    /// What the monitors reported last (main thread).
    static NETWORK: Cell<Network> = Cell::new(Network::default());
    /// The monitors run.
    static STARTED: Cell<bool> = const { Cell::new(false) };
}

/// How the device reaches the network now, as the monitors reported it last
/// ([`NetworkKind::Unknown`] until the path monitor's first answer, which
/// follows on the main queue). Starts the monitors on the first call.
pub fn network(mtm: MainThreadMarker) -> Network {
    start(mtm);
    NETWORK.with(Cell::get)
}

/// Starts the path monitor and, on iOS, the cellular data permission's,
/// once per process; they live as long as it does.
fn start(_mtm: MainThreadMarker) {
    if STARTED.with(|s| s.replace(true)) {
        return;
    }
    // SAFETY: a monitor this function owns for the process's life (never
    // released); its handler is copied by the monitor and runs on the main
    // queue, the thread whose state it writes. A path is valid for the
    // duration of the call.
    unsafe {
        let monitor = nw_path_monitor_create();
        if monitor.is_null() {
            log::warn!("nsh: the system's network path monitor did not start");
            return;
        }
        let main = ptr::from_ref(DispatchQueue::main()).cast_mut().cast();
        nw_path_monitor_set_queue(monitor, main);
        let handler = RcBlock::new(|path: NwObject| {
            if !path.is_null() {
                update(|network| route(path, network));
            }
        });
        nw_path_monitor_set_update_handler(monitor, &handler);
        nw_path_monitor_start(monitor);
    }
    #[cfg(target_os = "ios")]
    cellular::start();
}

/// The route `path` takes, written into `network`.
///
/// # Safety
///
/// `path` is a live `nw_path_t`.
unsafe fn route(path: NwObject, network: &mut Network) {
    // SAFETY: guaranteed by the caller, for each call.
    unsafe {
        let status = nw_path_get_status(path);
        network.kind = kind(status, |t| nw_path_uses_interface_type(path, t));
        network.expensive = nw_path_is_expensive(path);
        network.constrained = nw_path_is_constrained(path);
    }
}

/// The kind of link of a path of `status` that uses the interface types
/// `uses` says. A satisfiable path (one a connection may bring up, as a
/// VPN on demand) is online: a request would bring it up.
fn kind(status: c_int, uses: impl Fn(c_int) -> bool) -> NetworkKind {
    match status {
        STATUS_INVALID => NetworkKind::Unknown,
        STATUS_UNSATISFIED => NetworkKind::None,
        _ if uses(INTERFACE_WIFI) => NetworkKind::Wifi,
        _ if uses(INTERFACE_CELLULAR) => NetworkKind::Cellular,
        _ if uses(INTERFACE_WIRED) => NetworkKind::Wired,
        _ => NetworkKind::Other,
    }
}

/// Changes the network as `change` says (main thread) and, when it changed,
/// posts [`CHANGED`].
fn update(change: impl FnOnce(&mut Network)) {
    let mut network = NETWORK.with(Cell::get);
    let before = network;
    change(&mut network);
    if network == before {
        return;
    }
    NETWORK.with(|n| n.set(network));
    let center = NSNotificationCenter::defaultCenter();
    // SAFETY: a notification of NSH's own name, without an object.
    unsafe { center.postNotificationName_object(&changed_name(), None) };
}

/// Whether the user lets the app use cellular data: `CTCellularData`.
#[cfg(target_os = "ios")]
mod cellular {
    use std::cell::RefCell;

    use block2::RcBlock;
    use dispatch2::DispatchQueue;
    use nsh_core::platform::CellularData;
    use objc2::{
        msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject},
    };

    #[link(name = "CoreTelephony", kind = "framework")]
    unsafe extern "C" {}

    // `CTCellularDataRestrictedState`.
    const RESTRICTED: usize = 1;
    const NOT_RESTRICTED: usize = 2;

    thread_local! {
        /// The object whose notifier reports the changes: it reports only
        /// while it lives (main thread, for the process's life).
        static DATA: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
    }

    fn state(raw: usize) -> CellularData {
        match raw {
            RESTRICTED => CellularData::Restricted,
            NOT_RESTRICTED => CellularData::NotRestricted,
            _ => CellularData::Unknown,
        }
    }

    pub(super) fn start() {
        let Some(class) = AnyClass::get(c"CTCellularData") else {
            return;
        };
        // SAFETY: `CTCellularData`'s initializer, its state's getter and
        // its notifier's setter (which copies the block). The notifier runs
        // on a queue of CoreTelephony's: it hands the state to the main
        // queue, the thread whose state it writes.
        unsafe {
            let data: Retained<AnyObject> = msg_send![class, new];
            let notifier = RcBlock::new(|raw: usize| {
                DispatchQueue::main().exec_async(move || {
                    super::update(|network| network.cellular_data = state(raw));
                });
            });
            let _: () = msg_send![&data, setCellularDataRestrictionDidUpdateNotifier: &*notifier];
            let raw: usize = msg_send![&data, restrictedState];
            super::update(|network| network.cellular_data = state(raw));
            DATA.with(|d| *d.borrow_mut() = Some(data));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_s_status_and_interfaces_name_its_kind() {
        let uses = |types: &'static [c_int]| move |t| types.contains(&t);
        assert_eq!(kind(STATUS_INVALID, uses(&[])), NetworkKind::Unknown);
        assert_eq!(
            kind(STATUS_UNSATISFIED, uses(&[INTERFACE_WIFI])),
            NetworkKind::None
        );
        // Satisfied (1) or satisfiable (3): the link it uses.
        assert_eq!(kind(1, uses(&[INTERFACE_WIFI])), NetworkKind::Wifi);
        assert_eq!(kind(3, uses(&[INTERFACE_CELLULAR])), NetworkKind::Cellular);
        assert_eq!(kind(1, uses(&[INTERFACE_WIRED])), NetworkKind::Wired);
        // A VPN over Wi-Fi uses both: the link beneath names it.
        assert_eq!(kind(1, uses(&[0, INTERFACE_WIFI])), NetworkKind::Wifi);
        assert_eq!(kind(1, uses(&[0])), NetworkKind::Other);
    }
}
