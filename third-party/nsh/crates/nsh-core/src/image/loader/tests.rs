//! The loader's contract: one read per source, priorities, cancellation,
//! failures remembered, L3, and decodes at display size
//! shared by key.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};

use super::*;
use crate::{
    ResizeMode,
    geometry::{Points, size},
    image::{Budget, Frames, Images, Natural, Request, Target, Want},
};

/// A loader of the test's own (the process's is shared by every test).
fn own_loader() -> &'static Loader {
    Box::leak(Box::new(Loader::default()))
}

/// Assets that block until released, logging the order they are read in.
#[derive(Clone, Default)]
struct Gate {
    started: Arc<Mutex<Vec<String>>>,
    /// By URI: the release of a read started, or the result of one to come.
    gates: Arc<Mutex<HashMap<String, Opening>>>,
}

enum Opening {
    Started(mpsc::Sender<Result<Vec<u8>, String>>),
    Opened(mpsc::Receiver<Result<Vec<u8>, String>>),
}

impl Gate {
    fn context(&self) -> Context {
        let gate = self.clone();
        Context {
            read_asset: Some(ReadAsset::new(move |uri: &str| {
                let rx = {
                    let mut gates = gate.gates.lock().unwrap();
                    match gates.remove(uri) {
                        Some(Opening::Opened(rx)) => rx,
                        _ => {
                            let (tx, rx) = mpsc::channel();
                            gates.insert(uri.to_owned(), Opening::Started(tx));
                            rx
                        }
                    }
                };
                gate.started.lock().unwrap().push(uri.to_owned());
                rx.recv_timeout(Duration::from_secs(10))
                    .unwrap_or_else(|_| Err("never released".into()))
            })),
            ..Context::default()
        }
    }

    /// Lets the read of `uri` end with `result` (when it starts).
    fn open(&self, uri: &str, result: Result<Vec<u8>, String>) {
        let mut gates = self.gates.lock().unwrap();
        match gates.remove(uri) {
            Some(Opening::Started(tx)) => tx.send(result).unwrap(),
            _ => {
                let (tx, rx) = mpsc::channel();
                tx.send(result).unwrap();
                gates.insert(uri.to_owned(), Opening::Opened(rx));
            }
        }
    }

    fn started(&self) -> Vec<String> {
        self.started.lock().unwrap().clone()
    }

    fn wait_started(&self, n: usize) {
        for _ in 0..1000 {
            if self.started().len() >= n {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("{} reads started, not {n}", self.started().len());
    }
}

fn asset(context: &Context, uri: &str) -> Location {
    context.resolve(uri).unwrap()
}

/// Waits for `rx`'s next value.
fn next<T>(rx: &mpsc::Receiver<T>) -> T {
    rx.recv_timeout(Duration::from_secs(10)).expect("no result")
}

#[test]
fn one_read_per_source_however_many_wait() {
    let loader = own_loader();
    let gate = Gate::default();
    let context = gate.context();
    let (tx, rx) = mpsc::channel();
    let tickets: Vec<Ticket> = (0..3)
        .map(|i| {
            let tx = tx.clone();
            loader.read(
                asset(&context, "asset:/a.png"),
                &context,
                Priority::Normal,
                None,
                Box::new(move |r| tx.send((i, r.map(|b| b.to_vec()))).unwrap()),
            )
        })
        .collect();
    gate.wait_started(1);
    gate.open("asset:/a.png", Ok(b"png".to_vec()));
    let mut got: Vec<_> = (0..3).map(|_| next(&rx)).collect();
    got.sort_by_key(|(i, _)| *i);
    assert_eq!(
        got,
        [
            (0, Ok(b"png".to_vec())),
            (1, Ok(b"png".to_vec())),
            (2, Ok(b"png".to_vec()))
        ]
    );
    assert_eq!(gate.started(), ["asset:/a.png"]);
    drop(tickets);
    // Kept in L3: read again from memory, here and now.
    let (tx, rx) = mpsc::channel();
    loader
        .read(
            asset(&context, "asset:/a.png"),
            &context,
            Priority::Normal,
            None,
            Box::new(move |r| tx.send(r.is_ok()).unwrap()),
        )
        .detach();
    assert_eq!(rx.try_recv(), Ok(true));
    assert_eq!(gate.started().len(), 1);
}

/// Fills every read thread with a read that waits for the gate.
fn occupy(loader: &'static Loader, gate: &Gate, context: &Context) -> Vec<Ticket> {
    let tickets = (0..DOWNLOADS)
        .map(|i| {
            loader.read(
                asset(context, &format!("asset:/busy{i}")),
                context,
                Priority::Visible,
                None,
                Box::new(|_| {}),
            )
        })
        .collect();
    gate.wait_started(DOWNLOADS);
    tickets
}

#[test]
fn reads_go_highest_priority_first() {
    let loader = own_loader();
    let gate = Gate::default();
    let context = gate.context();
    let _busy = occupy(loader, &gate, &context);
    let queue = |uri: &str, priority| {
        loader.read(
            asset(&context, uri),
            &context,
            priority,
            None,
            Box::new(|_| {}),
        )
    };
    let _prefetch = queue("asset:/prefetch", Priority::Prefetch);
    let _normal = queue("asset:/normal", Priority::Normal);
    let visible = queue("asset:/visible", Priority::Visible);
    let _later = queue("asset:/later", Priority::Normal);
    // A view scrolled away: its load waits behind the others.
    visible.set_priority(Priority::Prefetch);
    for (n, busy) in (0..4).map(|i| format!("asset:/busy{i}")).enumerate() {
        gate.open(&busy, Ok(Vec::new()));
        gate.wait_started(DOWNLOADS + n + 1);
    }
    assert_eq!(
        gate.started()[DOWNLOADS..],
        [
            "asset:/normal",
            "asset:/later",
            "asset:/prefetch",
            "asset:/visible"
        ]
    );
}

#[test]
fn a_read_nobody_waits_for_is_cancelled() {
    let loader = own_loader();
    let gate = Gate::default();
    let context = gate.context();
    let busy = occupy(loader, &gate, &context);
    let called = Arc::new(AtomicUsize::new(0));
    let ticket = {
        let called = called.clone();
        loader.read(
            asset(&context, "asset:/gone"),
            &context,
            Priority::Visible,
            None,
            Box::new(move |_| {
                called.fetch_add(1, Ordering::Relaxed);
            }),
        )
    };
    // Two wait; one gives up: the read stays for the other.
    let (tx, rx) = mpsc::channel();
    let kept = loader.read(
        asset(&context, "asset:/kept"),
        &context,
        Priority::Normal,
        None,
        Box::new(move |r| tx.send(r.is_ok()).unwrap()),
    );
    let gave_up = loader.read(
        asset(&context, "asset:/kept"),
        &context,
        Priority::Normal,
        None,
        Box::new(|_| panic!("gave up")),
    );
    drop(gave_up);
    drop(ticket);
    for i in 0..DOWNLOADS {
        gate.open(&format!("asset:/busy{i}"), Ok(Vec::new()));
    }
    gate.wait_started(DOWNLOADS + 1);
    gate.open("asset:/kept", Ok(b"x".to_vec()));
    assert!(next(&rx));
    drop((busy, kept));
    assert!(!gate.started().contains(&"asset:/gone".to_owned()));
    assert_eq!(called.load(Ordering::Relaxed), 0);
}

#[test]
fn failures_are_remembered_for_a_while() {
    let loader = own_loader();
    let gate = Gate::default();
    let context = gate.context();
    let (tx, rx) = mpsc::channel();
    let read = |tx: mpsc::Sender<Result<ImageData, String>>| {
        loader.read(
            asset(&context, "asset:/broken"),
            &context,
            Priority::Normal,
            None,
            Box::new(move |r| tx.send(r).unwrap()),
        )
    };
    let _first = read(tx.clone());
    gate.open("asset:/broken", Err("404".into()));
    assert_eq!(next(&rx).unwrap_err(), "404");
    // Answered from memory, not read again.
    read(tx).detach();
    assert_eq!(rx.try_recv().unwrap().unwrap_err(), "404");
    assert_eq!(gate.started().len(), 1);
}

#[test]
fn reads_keep_to_the_per_host_limit() {
    let mut reads = Reads::default();
    let job = |host: &str, seq| ReadJob {
        location: Location::Url(format!("https://{host}/{seq}")),
        context: Context::default(),
        host: host.into(),
        priority: Priority::Normal,
        seq,
        running: false,
        cancelled: Arc::default(),
        waiters: Vec::new(),
    };
    reads.jobs.insert("a5".into(), job("a.org", 5));
    reads.jobs.insert("b9".into(), job("b.org", 9));
    reads.hosts.insert("a.org".into(), PER_HOST);
    reads.running = PER_HOST;
    assert_eq!(next_read(&reads).as_deref(), Some("b9"));
    reads.running = DOWNLOADS;
    assert_eq!(next_read(&reads), None);
}

/// A transport answering every GET with `body`, logging what it was asked.
struct Canned {
    body: Vec<u8>,
    asked: Mutex<Vec<(String, bool)>>,
}

impl Transport for Canned {
    fn get(&self, get: Get<'_>) -> Result<crate::image::Fetched, String> {
        self.asked
            .lock()
            .unwrap()
            .push((get.url.to_owned(), get.cached));
        (get.progress)(self.body.len() as u64, self.body.len() as u64);
        Ok(crate::image::Fetched::new(
            200,
            Default::default(),
            self.body.clone(),
        ))
    }
}

#[test]
fn a_backend_transport_downloads_within_the_loaders_limits() {
    let loader = own_loader();
    let canned = Arc::new(Canned {
        body: b"png".to_vec(),
        asked: Mutex::default(),
    });
    let context = Context {
        transport: Some(canned.clone()),
        ..Context::default()
    };
    let (tx, rx) = mpsc::channel();
    let url = "https://a.org/a.png";
    let read = |tx: mpsc::Sender<Result<Vec<u8>, String>>| {
        loader.read(
            context.resolve(url).unwrap(),
            &context,
            Priority::Normal,
            None,
            Box::new(move |r| tx.send(r.map(|b| b.to_vec())).unwrap()),
        )
    };
    let _first = read(tx.clone());
    assert_eq!(next(&rx), Ok(b"png".to_vec()));
    // Kept in L3: not asked again.
    let _again = read(tx.clone());
    assert_eq!(next(&rx), Ok(b"png".to_vec()));
    assert_eq!(*canned.asked.lock().unwrap(), [(url.to_owned(), false)]);
    // A body over the limit is refused whatever the transport did.
    let huge = Context {
        transport: Some(Arc::new(Canned {
            body: vec![0; MAX_BYTES as usize + 1],
            asked: Mutex::default(),
        })),
        ..Context::default()
    };
    let _huge = loader.read(
        huge.resolve("https://a.org/huge.png").unwrap(),
        &huge,
        Priority::Normal,
        None,
        Box::new(move |r| tx.send(r.map(|b| b.to_vec())).unwrap()),
    );
    assert!(next(&rx).unwrap_err().contains("larger than"));
}

#[test]
fn redirects_never_go_from_https_to_http() {
    let access = Access::default();
    assert_eq!(
        redirect(&access, "https://a.org/x", "/y").as_deref(),
        Ok("https://a.org/y")
    );
    assert!(redirect(&access, "https://a.org/x", "http://a.org/y").is_err());
    assert!(redirect(&access, "http://a.org/x", "https://b.org/y").is_ok());
}

#[test]
fn encoded_bytes_are_kept_least_recently_used_out() {
    let mut l3 = Encoded::new(100);
    l3.insert("big", vec![0; 26].into());
    assert!(l3.get("big").is_none(), "over a quarter: not kept");
    l3.insert("a", vec![0; 25].into());
    l3.insert("b", vec![0; 25].into());
    l3.insert("c", vec![0; 25].into());
    l3.insert("d", vec![0; 25].into());
    assert!(l3.get("a").is_some());
    l3.insert("e", vec![0; 25].into());
    assert!(l3.get("b").is_none());
    assert!(l3.get("a").is_some() && l3.get("e").is_some());
}

#[test]
fn asset_directories_take_the_first_that_has_the_file() {
    let root = std::env::temp_dir().join(format!("nsh-asset-dirs-{}", std::process::id()));
    let (app, host) = (root.join("app"), root.join("host"));
    std::fs::create_dir_all(&app).unwrap();
    std::fs::create_dir_all(&host).unwrap();
    std::fs::write(host.join("a.png"), b"host").unwrap();
    std::fs::write(app.join("b.png"), b"app").unwrap();
    std::fs::write(host.join("b.png"), b"host").unwrap();
    let base = AssetBase::Directories(vec![app.clone(), host.clone()]);
    let file = |uri| match resolve(uri, Some(&base)) {
        Some(Location::File(path)) => path,
        _ => panic!("{uri}: not a file"),
    };
    assert_eq!(file("asset:/a.png"), host.join("a.png"));
    assert_eq!(
        file("asset:/b.png"),
        app.join("b.png"),
        "the app's own first"
    );
    // In none: the first's, which fails to read naming it.
    assert_eq!(file("asset:/c.png"), app.join("c.png"));
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn resolves_uris() {
    let dir = AssetBase::Directory("/app/assets".into());
    let http = AssetBase::Http("http://10.0.0.2:8080/assets/".into());
    let key = |uri, base| resolve(uri, base).map(|l: Location| l.key());
    assert_eq!(
        key("asset:/img/a.png", Some(&dir)).as_deref(),
        Some("file:///app/assets/img/a.png")
    );
    assert_eq!(
        key("asset:/a.png", Some(&http)).as_deref(),
        Some("http://10.0.0.2:8080/assets/a.png")
    );
    assert_eq!(key("asset:/a.png", None), None);
    assert_eq!(
        key("https://x.org/a.jpg", None).as_deref(),
        Some("https://x.org/a.jpg")
    );
    #[cfg(unix)]
    {
        assert_eq!(
            key("file:///home/a%20b.png", None).as_deref(),
            Some("file:///home/a b.png")
        );
        assert_eq!(
            key("/home/a.png", None).as_deref(),
            Some("file:///home/a.png")
        );
    }
    assert_eq!(key("relative.png", None), None);
    assert!(matches!(
        resolve("data:image/png;base64,AA==", None),
        Some(Location::Data(_))
    ));
    assert_eq!(density("asset:/logo@2x.png"), 2.0);
    assert_eq!(density("/a/b.png"), 1.0);
}

/// A PNG header of `w`×`h` (all `imagesize` reads).
fn png(w: u32, h: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bytes.extend(w.to_be_bytes());
    bytes.extend(h.to_be_bytes());
    bytes.extend([8, 6, 0, 0, 0, 0, 0, 0, 0]);
    bytes
}

/// Images whose "decode" records its target and costs 4 bytes a pixel.
fn images(budget: &Arc<Budget>, loader: &'static Loader) -> (Images<u32>, Arc<Mutex<Vec<Target>>>) {
    let decodes = Arc::new(Mutex::new(Vec::new()));
    let log = decodes.clone();
    let images = Images::new(budget, move |_: &ImageData, target: &Target| {
        log.lock().unwrap().push(*target);
        let natural = target.natural.ok_or("no size")?;
        let Natural::Pixels(w, h) = natural else {
            return Err("not a bitmap".into());
        };
        let scale = target.longest as f32 / w.max(h) as f32;
        let pixels = (w as f32 * scale) as usize * (h as f32 * scale) as usize;
        Ok((target.longest, natural, pixels * 4))
    })
    .on(loader);
    (images, decodes)
}

fn request(context: &Context, uri: &str, side: f32) -> Request {
    Request {
        location: asset(context, uri),
        context: context.clone(),
        declared: None,
        want: Want {
            size: size(Points(side), Points(side)),
            scale: 2.0,
            mode: ResizeMode::Cover,
        },
        frames: Frames::All,
        priority: Priority::Visible,
        progress: None,
    }
}

#[test]
fn images_decode_at_the_bucket_of_their_view_once_per_key() {
    let loader = own_loader();
    let gate = Gate::default();
    let context = gate.context();
    let budget = Budget::new(64 << 20);
    let (images, decodes) = images(&budget, loader);
    gate.open("asset:/photo.jpg", Ok(png(4000, 3000)));
    let (tx, rx) = mpsc::channel();
    let load = |side: f32| {
        let tx = tx.clone();
        images.load(
            request(&context, "asset:/photo.jpg", side),
            Box::new(move |r| tx.send(r.map(|(d, lease)| (d.value, lease))).unwrap()),
        )
    };
    // 100 points at 2× covering a 4:3 photo: 268 px → the 362 bucket.
    let first = load(100.0);
    let second = load(110.0);
    let (a, lease_a) = next(&rx).unwrap();
    let (b, lease_b) = next(&rx).unwrap();
    assert_eq!((a, b), (362, 362));
    assert_eq!(decodes.lock().unwrap().len(), 1, "one decode for the key");
    assert_eq!(budget.used(), 362 * 271 * 4);
    // Its size is known now: a hit is answered here and now.
    load(98.0).detach();
    assert_eq!(rx.try_recv().unwrap().unwrap().0, 362);
    // A bigger view asks for the next bucket; a huge one for the natural
    // size, never more.
    load(150.0).detach();
    assert_eq!(next(&rx).unwrap().0, 512);
    load(5000.0).detach();
    assert_eq!(next(&rx).unwrap().0, 4000);
    assert_eq!(gate.started().len(), 1, "the bytes were read once");
    drop((first, second, lease_a, lease_b));
}

#[test]
fn raw_uris_cannot_reuse_cached_images_from_attached_bytes() {
    let loader = own_loader();
    let context = Context::default();
    let budget = Budget::new(64 << 20);
    let (images, _) = images(&budget, loader);
    // MIME parameters can contain commas; these identifiers still name
    // attached bytes, not the payload of a data URI.
    for mime in ["image/png", "image/png,x"] {
        let source = ImageSource::default().with_bytes(mime, png(400, 300).into());
        let attached = Request {
            location: context.locate(&source).unwrap(),
            context: context.clone(),
            declared: None,
            want: Want::natural(1.0),
            frames: Frames::First,
            priority: Priority::Visible,
            progress: None,
        };
        let (tx, rx) = mpsc::channel();
        images
            .load(attached.clone(), Box::new(move |r| tx.send(r).unwrap()))
            .detach();
        let (decoded, lease) = next(&rx).unwrap();
        assert_eq!(decoded.value, 400);
        let raw = Request {
            location: context.resolve(&source.uri).unwrap(),
            ..attached
        };
        let (tx, rx) = mpsc::channel();
        images
            .load(raw, Box::new(move |r| tx.send(r).unwrap()))
            .detach();
        assert!(next(&rx).is_err(), "raw URIs must read their own payload");
        drop(lease);
    }
}

#[test]
fn a_decode_nobody_waits_for_is_cancelled() {
    let loader = own_loader();
    let gate = Gate::default();
    let context = gate.context();
    let budget = Budget::new(64 << 20);
    let (images, decodes) = images(&budget, loader);
    let ticket = images.load(
        request(&context, "asset:/never.png", 100.0),
        Box::new(|_| panic!("given up")),
    );
    gate.wait_started(1);
    drop(ticket);
    gate.open("asset:/never.png", Ok(png(10, 10)));
    // The read ends; nothing is decoded.
    std::thread::sleep(Duration::from_millis(100));
    assert!(decodes.lock().unwrap().is_empty());
    assert!(images.memory().is_empty());
}

#[test]
fn wanted_sizes_pick_buckets_by_natural_size() {
    let want = Want {
        size: size(Points(100.0), Points(100.0)),
        scale: 2.0,
        mode: ResizeMode::Contain,
    };
    assert_eq!(want.longest(Natural::Pixels(4000, 3000), 1.0, None), 256);
    assert_eq!(want.longest(Natural::Pixels(120, 90), 1.0, None), 120);
    // An SVG is drawn at its bucket, whatever its own size.
    let icon = Natural::Vector(size(Points(24.0), Points(24.0)));
    assert_eq!(want.longest(icon, 1.0, None), 256);
    assert_eq!(Want::natural(2.0).longest(icon, 1.0, None), 64);
    assert_eq!(
        Want::natural(2.0).longest(Natural::Pixels(4000, 3000), 1.0, None),
        4000
    );
}
