//! A web view download that a granted host redirects to a host the app's
//! `webview` grant does not allow is cancelled before WebKit requests that
//! host: the Apple transport's `download:willPerformHTTPRedirection:...`
//! asks the grant, and the core hears an offer at the refused URL, then its
//! failure. A grant that allows the redirect target downloads it, which
//! shows the redirect is really followed here. Two local servers on
//! 127.0.0.1: the first redirects to the second, which counts requests.
use std::{
    cell::RefCell,
    io::{Read, Write},
    net::TcpListener,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use block2::RcBlock;
use nsh_core::{EventKind, EventPayload};
use nsh_platform_apple::web_download::{Allows, Emit, Transport};
use nsh_platform_macos::{
    objc2::{
        MainThreadMarker, msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject},
    },
    objc2_app_kit::NSApplication,
    objc2_foundation::{NSDate, NSRunLoop, NSString, NSURL, NSURLRequest},
};

#[link(name = "WebKit", kind = "framework")]
unsafe extern "C" {}

/// Serves one response to every connection on a thread of its own, and
/// counts the requests it read.
fn serve(response: impl Fn(u16) -> String + Send + 'static) -> (u16, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("a local port");
    let port = listener.local_addr().unwrap().port();
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            counted.fetch_add(1, Ordering::SeqCst);
            let _ = stream.write_all(response(port).as_bytes());
        }
    });
    (port, requests)
}

/// Runs the main run loop until `done` holds or `seconds` pass.
fn pump_until(seconds: f64, mut done: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + Duration::from_secs_f64(seconds);
    while Instant::now() < end {
        if done() {
            return true;
        }
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.01));
    }
    done()
}

/// What the transport reported: the kind and the payload, as text.
type Reports = Rc<RefCell<Vec<(EventKind, String)>>>;

/// Downloads `start` in a new web view through a transport that follows
/// the redirects `allows` grants; what it reported once the download
/// ended (or after 10 s).
fn download(mtm: MainThreadMarker, start: &str, allows: Allows) -> Vec<(EventKind, String)> {
    let reports: Reports = Rc::default();
    let heard = reports.clone();
    let emit: Emit = Rc::new(move |kind, payload: EventPayload| {
        heard.borrow_mut().push((kind, format!("{payload:?}")));
    });
    let transport = Transport::new(mtm, emit, allows);
    // SAFETY: WebKit's documented API on the main thread; the web view and
    // the transport live until the download ended.
    let web: Retained<AnyObject> =
        unsafe { msg_send![AnyClass::get(c"WKWebView").expect("WebKit"), new] };
    let request = NSURLRequest::requestWithURL(
        &NSURL::URLWithString(&NSString::from_str(start)).expect("a URL"),
    );
    let adopting = transport.clone();
    let adopt = RcBlock::new(move |download: *mut AnyObject| {
        // SAFETY: WebKit hands the new, live WKDownload.
        if let Some(download) = unsafe { download.as_ref() } {
            adopting.adopt(download);
        }
    });
    // SAFETY: as above; WebKit copies the block.
    let _: () = unsafe {
        msg_send![&web, startDownloadUsingRequest: &*request, completionHandler: &*adopt]
    };
    // A download the core would accept waits at its offer for a decision
    // no core makes here; a refused one ends right after its offer.
    let ended = pump_until(10.0, || {
        reports
            .borrow()
            .iter()
            .any(|(kind, _)| matches!(kind, EventKind::DownloadOffer | EventKind::DownloadEnd))
    });
    assert!(
        ended,
        "the download never came to an offer or an end: {:?}",
        reports.borrow()
    );
    // What follows the offer (a refused download's end).
    pump_until(0.5, || false);
    transport.cancel_all();
    pump_until(0.3, || false);
    drop(web);
    reports.take()
}

pub(super) fn run() {
    let mtm = MainThreadMarker::new().unwrap();
    NSApplication::sharedApplication(mtm).finishLaunching();
    let (secret_port, secret_requests) = serve(|_| {
        let body = "internal-only-data";
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\
             Content-Disposition: attachment; filename=\"secret.bin\"\r\n\
             Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    });
    let secret = format!("http://127.0.0.1:{secret_port}/secret");
    let target = secret.clone();
    let (start_port, start_requests) = serve(move |_| {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {target}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
    });
    let start = format!("http://localhost:{start_port}/report.bin");

    // Granted everywhere: the redirect is followed and the second server
    // asked, so the check below is not vacuous.
    let reported = download(mtm, &start, Rc::new(|_| true));
    assert!(
        start_requests.load(Ordering::SeqCst) >= 1,
        "the first server was asked"
    );
    assert_eq!(
        secret_requests.load(Ordering::SeqCst),
        1,
        "an allowed redirect is followed: {reported:?}"
    );
    assert!(
        reported
            .iter()
            .any(|(kind, payload)| *kind == EventKind::DownloadOffer && payload.contains(&secret)),
        "the offer is the response's URL, after the redirect: {reported:?}"
    );

    // Granted only the first host: the redirect is cancelled before the
    // second server is asked, and the core hears an offer at the refused
    // URL (which it refuses), then the download's end.
    let granted = format!("http://localhost:{start_port}/");
    let reported = download(mtm, &start, Rc::new(move |url| url.starts_with(&granted)));
    assert_eq!(
        secret_requests.load(Ordering::SeqCst),
        1,
        "a refused redirect never reaches the host it names: {reported:?}"
    );
    let offer = reported
        .iter()
        .position(|(kind, payload)| *kind == EventKind::DownloadOffer && payload.contains(&secret));
    let end = reported
        .iter()
        .position(|(kind, _)| *kind == EventKind::DownloadEnd);
    assert!(
        offer.is_some() && end.is_some() && offer < end,
        "the core hears the refused URL's offer, then the end: {reported:?}"
    );

    println!(
        "download_redirect: a download redirected to a host the grant does not allow is cancelled before it is requested"
    );
}
