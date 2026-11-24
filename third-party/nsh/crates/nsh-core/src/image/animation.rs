//! Animated GIF and WebP for the backends that decode with the `image`
//! crate (Windows, Linux, GPUI; ImageIO and the system decoders play the
//! others).
//!
//! [`decode`] reads every frame at the size the view shows it. An
//! animation whose frames fit [`MAX_CACHED_BYTES`] keeps them all decoded.
//! A larger one, such as a screen recording shown enlarged, keeps its
//! encoded bytes and streams: while it plays, a worker decodes its frames in
//! playing order, [`AHEAD`] ahead of the one showing, so it plays as sharp
//! as its view shows it rather than shrinking until every frame fits.
//! Streams share [`MAX_STREAMING_BYTES`] of working memory, at most
//! [`MAX_STREAMS`] at once: one that finds no room keeps its frame until
//! room frees. A stream asked for no frame for [`IDLE`] (its view is no
//! longer drawn) ends and frees its room; drawing starts it again. An
//! animation too large to stream at all decodes as small as its frames fit
//! the cache.
//!
//! A backend gives [`decode`] the function that turns a frame's RGBA pixels
//! into what it draws (its texture), which runs on the decoding thread, and
//! asks [`Animation::frame`] for the frame its timeline shows.

use std::{
    collections::VecDeque,
    io::Cursor,
    sync::{Arc, Condvar, Mutex, MutexGuard},
    time::Duration,
};

use image::{AnimationDecoder, ImageFormat, RgbaImage, metadata::LoopCount};

/// Frames of an animated image decoded at most (as iOS; longer ones stop
/// at the last of them).
pub const MAX_FRAMES: usize = 600;

/// The most bytes one animation keeps decoded: larger ones stream.
pub const MAX_CACHED_BYTES: usize = 48 << 20;

/// The working memory every stream shares (each one's estimated by
/// [`working_bytes`]).
pub const MAX_STREAMING_BYTES: usize = 128 << 20;

/// Streams decoding at once.
pub const MAX_STREAMS: usize = 4;

/// The longest side a frame decodes at.
const MAX_DIMENSION: u32 = 8192;

/// Frames a stream decodes ahead of the one showing.
const AHEAD: usize = 2;

/// A stream asked for no frame this long ends.
const IDLE: Duration = Duration::from_secs(2);

/// The container `bytes` start with, if it may hold an animation.
pub fn format(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"GIF8") {
        Some(ImageFormat::Gif)
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some(ImageFormat::WebP)
    } else {
        None
    }
}

/// A frame's delay in ms: as browsers and iOS, delays under 20ms (often
/// written as 0 by tools that meant "fast") show for 100ms.
pub fn frame_delay(delay: image::Delay) -> u32 {
    let (numer, denom) = delay.numer_denom_ms();
    match numer / denom.max(1) {
        ms if ms >= 20 => ms,
        _ => 100,
    }
}

/// `size` with its longest side at most `longest` (0: its own) and
/// [`MAX_DIMENSION`], never enlarged.
pub fn scaled(size: (u32, u32), longest: u32) -> (u32, u32) {
    let (w, h) = size;
    let side = w.max(h);
    let limit = match longest {
        0 => MAX_DIMENSION,
        l => l.min(MAX_DIMENSION),
    };
    if side <= limit {
        return size;
    }
    let f = limit as f64 / side as f64;
    (
        ((w as f64 * f).round() as u32).max(1),
        ((h as f64 * f).round() as u32).max(1),
    )
}

/// `rgba` at [`scaled`] size.
pub fn shrunk(rgba: RgbaImage, longest: u32) -> RgbaImage {
    let size = rgba.dimensions();
    match scaled(size, longest) {
        s if s == size => rgba,
        (w, h) => image::imageops::thumbnail(&rgba, w, h),
    }
}

/// The working memory a stream of an animation `natural` pixels large,
/// shown at `longest`, takes: the decoder's full-size canvases and the
/// frames it holds at the size shown. `None` when it exceeds
/// [`MAX_STREAMING_BYTES`]: such an animation never streams.
pub fn working_bytes(natural: (u32, u32), longest: u32) -> Option<usize> {
    let (w, h) = natural;
    let (tw, th) = scaled(natural, longest);
    let full = (w as usize).checked_mul(h as usize)?.checked_mul(12)?;
    let held = (tw as usize)
        .checked_mul(th as usize)?
        .checked_mul(4 * (AHEAD + 2))?;
    let bytes = full.checked_add(held)?;
    (bytes <= MAX_STREAMING_BYTES).then_some(bytes)
}

/// What [`decode`] read.
pub struct Decoded<F> {
    /// The first frame (what shows before it plays).
    pub first: F,
    /// Its own size in pixels.
    pub natural: (u32, u32),
    /// Its frames, when it has more than one.
    pub animation: Option<Animation<F>>,
}

/// The frames of an animated image.
pub struct Animation<F> {
    /// Each frame's delay in ms ([`frame_delay`]).
    pub delays: Vec<u32>,
    /// Plays before it stops on its last frame; 0: forever.
    pub plays: u32,
    frames: Store<F>,
}

enum Store<F> {
    Cached(Vec<F>),
    Streamed(Stream<F>),
}

impl<F: Clone + Send + 'static> Animation<F> {
    /// Its frames.
    pub fn len(&self) -> usize {
        self.delays.len()
    }

    /// True when it has no frames (never: [`decode`] makes none such).
    pub fn is_empty(&self) -> bool {
        self.delays.is_empty()
    }

    /// The frame to show at `index`: a streamed animation's once decoded,
    /// until then the one showing (which also asks its worker for the
    /// frames ahead).
    pub fn frame(&self, index: usize) -> F {
        match &self.frames {
            Store::Cached(frames) => frames[index.min(frames.len() - 1)].clone(),
            Store::Streamed(stream) => stream.frame(index % self.delays.len()),
        }
    }

    /// The frames it keeps decoded: all of them, or none when they stream
    /// (each frame then lives while it is ahead or shown).
    pub fn cached(&self) -> &[F] {
        match &self.frames {
            Store::Cached(frames) => frames,
            Store::Streamed(_) => &[],
        }
    }

    /// True when its frames stream rather than stay decoded.
    pub fn streams(&self) -> bool {
        matches!(self.frames, Store::Streamed(_))
    }

    /// Frames it holds decoded at most (to count its memory).
    pub fn held_frames(&self) -> usize {
        match &self.frames {
            Store::Cached(frames) => frames.len(),
            Store::Streamed(_) => AHEAD + 2,
        }
    }

    /// Bytes it holds besides its decoded frames: a stream's encoded file
    /// and its decoder's working memory.
    pub fn other_bytes(&self) -> usize {
        match &self.frames {
            Store::Cached(_) => 0,
            Store::Streamed(stream) => stream.shared.source.bytes.len() + stream.shared.working,
        }
    }
}

/// Decodes the frames of a GIF or WebP `bytes` ([`format`]), their longest
/// side at most `longest` pixels (0: their own), each made what the backend
/// draws by `convert`. `None` when it is a still WebP. `stream`: an
/// animation over [`MAX_CACHED_BYTES`] may stream ([`Animation::frame`]);
/// without it, it decodes as small as its frames fit.
pub fn decode<F: Clone + Send + 'static>(
    bytes: &[u8],
    format: ImageFormat,
    longest: u32,
    stream: bool,
    convert: fn(RgbaImage) -> F,
) -> Result<Option<Decoded<F>>, String> {
    let Some((frames, plays)) = open(bytes, format)? else {
        return Ok(None);
    };
    let (mut kept, mut delays, mut total) = (Vec::new(), Vec::new(), 0usize);
    let mut natural = None;
    let mut over = false;
    for frame in frames.take(MAX_FRAMES) {
        let frame = match frame {
            Ok(frame) => frame,
            // A damaged frame ends the animation; what decoded plays.
            Err(e) if !delays.is_empty() => {
                log::debug!("image: animation cut short: {e}");
                break;
            }
            Err(e) => return Err(e.to_string()),
        };
        delays.push(frame_delay(frame.delay()));
        let buffer = frame.into_buffer();
        natural.get_or_insert(buffer.dimensions());
        let (w, h) = scaled(buffer.dimensions(), longest);
        total += w as usize * h as usize * 4;
        if total > MAX_CACHED_BYTES && !over {
            // Too large to keep: the rest are read for their delays.
            over = true;
            kept.truncate(1);
        }
        if !over || kept.is_empty() {
            kept.push(convert(shrunk(buffer, longest)));
        }
    }
    let natural = natural.ok_or("no frames")?;
    let first = kept[0].clone();
    if delays.len() < 2 {
        return Ok(Some(Decoded {
            first,
            natural,
            animation: None,
        }));
    }
    let frames = if !over {
        Store::Cached(kept)
    } else if let Some(working) = working_bytes(natural, longest).filter(|_| stream) {
        Store::Streamed(Stream::new(
            Source {
                bytes: Arc::from(bytes),
                format,
                longest,
                len: delays.len(),
                convert,
            },
            working,
            first.clone(),
        ))
    } else {
        // As small as the frames fit: their bytes go with the area.
        let side = scaled(natural, longest);
        let side = side.0.max(side.1) as f64;
        let fit = (side * (MAX_CACHED_BYTES as f64 / total as f64).sqrt()).floor() as u32;
        log::debug!("image: animation over {MAX_CACHED_BYTES} bytes: decoding at {fit}");
        return decode(bytes, format, fit.max(1), false, convert);
    };
    Ok(Some(Decoded {
        first,
        natural,
        animation: Some(Animation {
            delays,
            plays,
            frames,
        }),
    }))
}

/// The frames of `bytes` and its plays (0: forever); `None` for a still
/// WebP.
fn open(bytes: &[u8], format: ImageFormat) -> Result<Option<(image::Frames<'_>, u32)>, String> {
    let cursor = Cursor::new(bytes);
    let error = |e: image::ImageError| e.to_string();
    let (frames, loops) = match format {
        ImageFormat::Gif => {
            let decoder = image::codecs::gif::GifDecoder::new(cursor).map_err(error)?;
            let loops = decoder.loop_count();
            (decoder.into_frames(), loops)
        }
        ImageFormat::WebP => {
            let decoder = image::codecs::webp::WebPDecoder::new(cursor).map_err(error)?;
            if !decoder.has_animation() {
                return Ok(None);
            }
            let loops = decoder.loop_count();
            (decoder.into_frames(), loops)
        }
        _ => return Err("not an animation format".into()),
    };
    let plays = match loops {
        LoopCount::Infinite => 0,
        // GIF counts repetitions after the first play (as browsers read
        // it), WebP plays.
        LoopCount::Finite(n) if format == ImageFormat::Gif => n.get().saturating_add(1),
        LoopCount::Finite(n) => n.get(),
    };
    Ok(Some((frames, plays)))
}

/// What a stream decodes.
struct Source<F> {
    bytes: Arc<[u8]>,
    format: ImageFormat,
    longest: u32,
    /// Its frames (what [`decode`] read).
    len: usize,
    convert: fn(RgbaImage) -> F,
}

/// The frames of a stream ahead of the one showing, decoded by a worker
/// while it plays.
struct Stream<F> {
    shared: Arc<Shared<F>>,
}

struct Shared<F> {
    source: Source<F>,
    /// Its share of [`MAX_STREAMING_BYTES`] while its worker runs.
    working: usize,
    state: Mutex<State<F>>,
    /// Wakes the worker: a frame was asked for, or the stream dropped.
    wake: Condvar,
}

struct State<F> {
    /// The frame showing (asked for last).
    wanted: usize,
    /// Decoded frames from `wanted` on, in playing order.
    ready: VecDeque<(usize, F)>,
    /// The frame handed out last, shown until the next one is decoded.
    shown: (usize, F),
    /// A worker runs, holding its share of the working memory.
    running: bool,
    /// A frame was asked for since the worker last waited.
    asked: bool,
    /// Decoding failed: it keeps the frame it shows.
    failed: bool,
    /// The animation is gone: its worker ends.
    dropped: bool,
}

/// How many frames `to` comes after `from`, in playing order.
fn ahead(from: usize, to: usize, len: usize) -> usize {
    (to + len - from) % len
}

impl<F> State<F> {
    /// The frame the worker decodes next.
    fn next(&self, len: usize) -> usize {
        match self.ready.back() {
            Some(&(last, _)) => (last + 1) % len,
            None if self.shown.0 == self.wanted => (self.wanted + 1) % len,
            None => self.wanted,
        }
    }
}

impl<F: Clone + Send + 'static> Stream<F> {
    fn new(source: Source<F>, working: usize, first: F) -> Stream<F> {
        Stream {
            shared: Arc::new(Shared {
                source,
                working,
                state: Mutex::new(State {
                    wanted: 0,
                    ready: VecDeque::new(),
                    shown: (0, first),
                    running: false,
                    asked: false,
                    failed: false,
                    dropped: false,
                }),
                wake: Condvar::new(),
            }),
        }
    }

    fn frame(&self, index: usize) -> F {
        let shared = &self.shared;
        let len = shared.source.len;
        let mut s = shared.lock();
        s.wanted = index;
        s.asked = true;
        // Frames the timeline passed (it skips frames when behind) go; the
        // one asked for shows once decoded.
        while let Some(&(at, _)) = s.ready.front() {
            if at == index {
                s.shown = s.ready.pop_front().expect("front");
                break;
            }
            if ahead(index, at, len) <= AHEAD {
                break;
            }
            s.ready.pop_front();
        }
        if !s.running && !s.failed && reserve(shared.working) {
            s.running = true;
            let worker = shared.clone();
            let spawned = std::thread::Builder::new()
                .name("nsh-animation".into())
                .spawn(move || run(Running(worker)));
            if spawned.is_err() {
                s.running = false;
                release(shared.working);
            }
        }
        shared.wake.notify_one();
        s.shown.1.clone()
    }
}

impl<F> Drop for Stream<F> {
    fn drop(&mut self) {
        self.shared.lock().dropped = true;
        self.shared.wake.notify_one();
    }
}

impl<F> Shared<F> {
    fn lock(&self) -> MutexGuard<'_, State<F>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// A stream's worker while it runs: ending (a panic too) frees its share.
struct Running<F>(Arc<Shared<F>>);

impl<F> Drop for Running<F> {
    fn drop(&mut self) {
        self.0.lock().running = false;
        release(self.0.working);
    }
}

/// Decodes the frames ahead of the one showing until the stream drops or
/// idles for [`IDLE`].
fn run<F: Clone + Send + 'static>(running: Running<F>) {
    let shared = &running.0;
    let source = &shared.source;
    // The decoder and the index of the frame it reads next.
    let mut decoder: Option<(image::Frames<'static>, usize)> = None;
    loop {
        let next = {
            let mut s = shared.lock();
            loop {
                if s.dropped {
                    return;
                }
                let next = s.next(source.len);
                if ahead(s.wanted, next, source.len) <= AHEAD
                    && s.ready.len() <= AHEAD
                    && s.ready.iter().all(|&(at, _)| at != next)
                    && s.shown.0 != next
                {
                    break next;
                }
                s.asked = false;
                let (guard, wait) = shared
                    .wake
                    .wait_timeout(s, IDLE)
                    .unwrap_or_else(|e| e.into_inner());
                s = guard;
                if wait.timed_out() && !s.asked {
                    return;
                }
            }
        };
        let frame = match read(&mut decoder, source, next) {
            Ok(frame) => frame,
            Err(e) => {
                log::debug!("image: animation stream ended: {e}");
                shared.lock().failed = true;
                return;
            }
        };
        let mut s = shared.lock();
        // Kept unless the timeline moved past it meanwhile.
        if s.next(source.len) == next && ahead(s.wanted, next, source.len) <= AHEAD {
            s.ready.push_back((next, frame));
        }
    }
}

/// Frame `index` of `source`, read on from where `decoder` is (from the
/// start when it is past it: GIF frames build on the ones before).
fn read<F>(
    decoder: &mut Option<(image::Frames<'static>, usize)>,
    source: &Source<F>,
    index: usize,
) -> Result<F, String> {
    if decoder.as_ref().is_none_or(|&(_, at)| at > index) {
        let bytes = OwnedBytes(source.bytes.clone());
        let frames = match source.format {
            ImageFormat::Gif => image::codecs::gif::GifDecoder::new(Cursor::new(bytes))
                .map_err(|e| e.to_string())?
                .into_frames(),
            _ => image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
                .map_err(|e| e.to_string())?
                .into_frames(),
        };
        *decoder = Some((frames, 0));
    }
    let (frames, at) = decoder.as_mut().expect("opened");
    loop {
        let frame = frames
            .next()
            .ok_or("the animation ended early")?
            .map_err(|e| e.to_string())?;
        *at += 1;
        if *at > index {
            return Ok((source.convert)(shrunk(
                frame.into_buffer(),
                source.longest,
            )));
        }
    }
}

/// The encoded bytes a stream's decoder reads, shared with the stream.
struct OwnedBytes(Arc<[u8]>);

impl AsRef<[u8]> for OwnedBytes {
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}

/// Working memory the running streams take, and how many run.
static USAGE: Mutex<(usize, usize)> = Mutex::new((0, 0));

/// Takes `bytes` of [`MAX_STREAMING_BYTES`] for a worker, if there is room.
fn reserve(bytes: usize) -> bool {
    let mut usage = USAGE.lock().unwrap_or_else(|e| e.into_inner());
    if usage.1 >= MAX_STREAMS || usage.0 + bytes > MAX_STREAMING_BYTES {
        return false;
    }
    usage.0 += bytes;
    usage.1 += 1;
    true
}

fn release(bytes: usize) {
    let mut usage = USAGE.lock().unwrap_or_else(|e| e.into_inner());
    usage.0 -= bytes;
    usage.1 -= 1;
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    /// A GIF of `count` frames `side` pixels square, frame `i` red `i`.
    fn gif(side: u32, count: u8) -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            for i in 0..count {
                let pixels = RgbaImage::from_pixel(side, side, image::Rgba([i, 0, 0, 255]));
                encoder
                    .encode_frame(image::Frame::from_parts(
                        pixels,
                        0,
                        0,
                        image::Delay::from_numer_denom_ms(100, 1),
                    ))
                    .unwrap();
            }
        }
        bytes
    }

    fn rgba(image: RgbaImage) -> Arc<RgbaImage> {
        Arc::new(image)
    }

    /// The frame `index` shows once its stream decoded it.
    fn frame_when_ready(animation: &Animation<Arc<RgbaImage>>, index: usize) -> Arc<RgbaImage> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let frame = animation.frame(index);
            if frame.get_pixel(0, 0)[0] == index as u8 {
                return frame;
            }
            assert!(Instant::now() < deadline, "frame {index} never decoded");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn times_frames() {
        assert_eq!(frame_delay(image::Delay::from_numer_denom_ms(70, 1)), 70);
        assert_eq!(frame_delay(image::Delay::from_numer_denom_ms(0, 1)), 100);
        assert_eq!(frame_delay(image::Delay::from_numer_denom_ms(10, 1)), 100);
        assert_eq!(frame_delay(image::Delay::from_numer_denom_ms(41, 2)), 20);
    }

    #[test]
    fn sniffs_animated_formats() {
        assert_eq!(format(b"GIF89a..."), Some(ImageFormat::Gif));
        assert_eq!(format(b"RIFF\0\0\0\0WEBPVP8X"), Some(ImageFormat::WebP));
        assert_eq!(format(b"\x89PNG\r\n"), None);
        assert_eq!(format(b"RIFF"), None);
    }

    #[test]
    fn small_animations_keep_their_frames() {
        let decoded = decode(&gif(16, 3), ImageFormat::Gif, 0, true, rgba)
            .unwrap()
            .unwrap();
        let animation = decoded.animation.unwrap();
        assert!(!animation.streams());
        assert_eq!((animation.len(), animation.held_frames()), (3, 3));
        assert_eq!(animation.delays, [100, 100, 100]);
        assert_eq!(animation.frame(2).get_pixel(0, 0)[0], 2);
    }

    #[test]
    fn large_animations_stream_at_the_size_shown() {
        // 14 frames of 1024² take 56 MiB: over the cache, they stream at
        // full size rather than at half.
        let decoded = decode(&gif(1024, 14), ImageFormat::Gif, 1024, true, rgba)
            .unwrap()
            .unwrap();
        assert_eq!(decoded.first.dimensions(), (1024, 1024));
        let animation = decoded.animation.unwrap();
        assert!(animation.streams());
        assert_eq!(animation.len(), 14);
        for index in (0..14).chain(0..2) {
            let frame = frame_when_ready(&animation, index);
            assert_eq!(frame.dimensions(), (1024, 1024));
        }
    }

    #[test]
    fn without_streaming_large_animations_decode_as_small_as_they_fit() {
        let decoded = decode(&gif(1024, 14), ImageFormat::Gif, 1024, false, rgba)
            .unwrap()
            .unwrap();
        let animation = decoded.animation.unwrap();
        assert!(!animation.streams());
        assert_eq!(animation.len(), 14);
        let side = animation.frame(0).width();
        assert!(side < 1024 && 14 * side as usize * side as usize * 4 <= MAX_CACHED_BYTES);
    }

    #[test]
    fn streamed_frames_match_decoded_ones() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/gallery/bounce.gif");
        let bytes = std::fs::read(path).unwrap();
        let cached = decode(&bytes, ImageFormat::Gif, 32, true, rgba)
            .unwrap()
            .unwrap()
            .animation
            .unwrap();
        let stream = Stream::new(
            Source {
                bytes: Arc::from(&bytes[..]),
                format: ImageFormat::Gif,
                longest: 32,
                len: cached.len(),
                convert: rgba,
            },
            0,
            cached.frame(0),
        );
        let mut decoder = None;
        // In order, after a loop, and from a frame before the decoder's.
        for index in (0..cached.len()).chain([0, 2, 1]) {
            let frame = read(&mut decoder, &stream.shared.source, index).unwrap();
            assert_eq!(*frame, *cached.frame(index), "frame {index}");
        }
    }

    #[test]
    fn streams_share_their_working_memory() {
        let mut taken = 0;
        while reserve(1) {
            taken += 1;
        }
        assert!(taken <= MAX_STREAMS);
        for _ in 0..taken {
            release(1);
        }
        assert!(working_bytes((1600, 920), 1200).is_some());
        assert!(working_bytes((8192, 8192), 8192).is_none());
    }
}
