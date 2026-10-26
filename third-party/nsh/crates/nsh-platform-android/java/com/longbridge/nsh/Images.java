package com.longbridge.nsh;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * Loads images off the UI thread, decoded at (about) their display size,
 * cached in memory, with concurrent requests for the same image coalesced
 * (one download per URI, reporting progress) and downloads nobody waits
 * for cancelled. `Image.prefetch` / `getSize` keep the bytes they fetched
 * for the views that show them next. SVG images are drawn by the shared
 * rasterizer ({@link Native#svg}) at the requested size; their size is their
 * intrinsic size in points. A decode that runs out of memory fails like one
 * of bytes that are no image.
 */
final class Images {
    /** {@code image}: null on errors. */
    interface Callback {
        void done(Image image, String error);

        /** Bytes downloaded so far, of {@code total} (0: unknown). */
        default void progress(long loaded, long total) {}
    }

    /** The size of an image in pixels (an SVG's: in points), or an error. */
    interface InfoCallback {
        void done(int width, int height, String error);
    }

    /** A decoded image and the pixel size of its source (before downsampling; an SVG's: whole points). */
    static final class Image {
        /** A {@link Bitmap}, or an animated {@code Drawable} (started by the view). */
        final Object content;
        final int width, height;
        /** An SVG drawn into a bitmap: {@code width} and {@code height} are its size in points. */
        final boolean vector;
        /** Unrounded intrinsic SVG size in points, used for drawing. */
        final float intrinsicWidth, intrinsicHeight;

        Image(Object content, int width, int height) {
            this(content, width, height, false, 0, 0);
        }

        Image(Object content, int width, int height, boolean vector, float intrinsicWidth, float intrinsicHeight) {
            this.content = content;
            this.width = width;
            this.height = height;
            this.vector = vector;
            this.intrinsicWidth = intrinsicWidth;
            this.intrinsicHeight = intrinsicHeight;
        }
    }

    /** Reads `asset:/…` URIs (APK assets or the dev server). */
    interface AssetReader {
        byte[] read(String uri);
    }

    /** Checks a redirect against the app's capabilities: the URL to go on to, or null. */
    interface Redirects {
        String next(String base, String location);
    }

    /** Set by the mounter; until then no redirect is followed. */
    volatile Redirects redirects = (base, location) -> null;

    /** The bytes of an in-memory image ({@code data:} URIs, {@code blob:} URLs), or null. */
    interface Inline {
        byte[] bytes(String uri);
    }

    /** Set by the mounter; until then in-memory images fail. */
    volatile Inline inline = uri -> null;

    /** The running app's disk cache of downloaded images ({@link Native#imageCacheLookup}). */
    interface DiskCache {
        /** Fresh bytes ({@code byte[]}), a stale copy's conditional headers ({@code String[]}), or null. */
        Object lookup(String url);

        /** Ends a download (status 0: failed); the cached bytes to show, or null. */
        byte[] complete(String url, int status, String[] headers, byte[] body);
    }

    /** Set by the mounter; until then nothing is kept on disk. */
    volatile DiskCache disk = null;

    /** The response headers the disk cache reads (lower case). */
    private static final String[] CACHE_HEADERS = {
        "cache-control", "expires", "date", "age", "etag", "last-modified", "vary", "pragma"
    };

    private static final int MAX_REDIRECTS = 20;

    private static final ExecutorService POOL = Executors.newFixedThreadPool(4, r -> {
        Thread t = new Thread(r, "nsh-images");
        t.setDaemon(true);
        return t;
    });
    /** Bitmaps only. */
    private static final LruCache<String, Image> CACHE =
            new LruCache<String, Image>((int) Math.min(Runtime.getRuntime().maxMemory() / 8, 96L << 20)) {
                @Override
                protected int sizeOf(String key, Image image) {
                    return ((Bitmap) image.content).getAllocationByteCount();
                }
            };

    /** Encoded images kept for `Image.prefetch` / `getSize` until a view decodes them. */
    private static final LruCache<String, byte[]> DATA = new LruCache<String, byte[]>(32 << 20) {
        @Override
        protected int sizeOf(String uri, byte[] bytes) {
            return bytes.length;
        }
    };
    /** Progress reports at most this often (ms). */
    private static final long PROGRESS_INTERVAL = 100;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final AssetReader assets;
    /** Decodes waiting for their bytes, or decoding, by cache key. */
    private final HashMap<String, Inflight> inflight = new HashMap<>();
    /** Downloads (or reads), one per URI. */
    private final HashMap<String, Download> downloads = new HashMap<>();

    private static final class Inflight {
        final String uri;
        final int maxPx, blurPx;
        final List<Callback> waiters = new ArrayList<>();

        Inflight(String uri, int maxPx, int blurPx) {
            this.uri = uri;
            this.maxPx = maxPx;
            this.blurPx = blurPx;
        }
    }

    private static final class Download {
        final List<String> keys = new ArrayList<>();
        final List<InfoCallback> infos = new ArrayList<>();
        Future<?> task;
    }

    Images(AssetReader assets) {
        this.assets = assets;
    }

    static String key(String uri, int maxPx, int blurPx) {
        return blurPx > 0 ? maxPx + "@" + blurPx + "@" + uri : maxPx + "@" + uri;
    }

    /**
     * Requests `uri` decoded to at most `maxPx` on its longer side, blurred
     * by `blurPx`: a cached bitmap at once, or null and a callback later.
     * Animated images are not cached (each view plays its own).
     */
    Image request(String uri, int maxPx, int blurPx, Callback callback) {
        String key = key(uri, maxPx, blurPx);
        Image cached = CACHE.get(key);
        if (cached != null) return cached;
        Inflight existing = inflight.get(key);
        if (existing != null) {
            existing.waiters.add(callback);
            return null;
        }
        Inflight request = new Inflight(uri, maxPx, blurPx);
        request.waiters.add(callback);
        inflight.put(key, request);
        fetch(uri, key, null);
        return null;
    }

    /** `Image.getSize` / `prefetch`: the size of `uri` in pixels (an SVG's: in points), keeping its bytes. */
    void info(String uri, InfoCallback callback) {
        fetch(uri, null, callback);
    }

    /** Gets the bytes of `uri` to decode `key` or answer `info`. */
    private void fetch(String uri, String key, InfoCallback info) {
        byte[] data = DATA.get(uri);
        if (data != null) {
            serve(uri, data, key, info);
            return;
        }
        Download download = downloads.get(uri);
        if (download == null) {
            download = new Download();
            downloads.put(uri, download);
            Download started = download;
            download.task = POOL.submit(() -> {
                byte[] bytes = null;
                String error = null;
                try {
                    bytes = read(uri, started);
                } catch (Exception e) {
                    error = String.valueOf(e);
                }
                byte[] result = bytes;
                String message = error;
                main.post(() -> bytesReady(uri, started, result, message));
            });
        }
        if (key != null) download.keys.add(key);
        if (info != null) download.infos.add(info);
    }

    private void bytesReady(String uri, Download download, byte[] bytes, String error) {
        if (downloads.get(uri) != download) return;
        downloads.remove(uri);
        if (bytes != null && !download.infos.isEmpty()) DATA.put(uri, bytes);
        for (String key : download.keys) {
            if (bytes != null) serve(uri, bytes, key, null);
            else finish(key, null, error);
        }
        for (InfoCallback info : download.infos) {
            if (bytes != null) serve(uri, bytes, null, info);
            else info.done(0, 0, error);
        }
    }

    /** Decodes `bytes` for `key` (off the UI thread), or reads their size for `info`. */
    private void serve(String uri, byte[] bytes, String key, InfoCallback info) {
        if (info != null) {
            if (maybeSvg(bytes)) {
                // An SVG's size takes parsing it: measured on the image threads.
                POOL.submit(() -> {
                    int[] size = new int[4];
                    boolean svg;
                    try {
                        svg = Native.svg(bytes, -1, 0, size, new float[2]) != null;
                    } catch (Throwable e) {
                        String error = String.valueOf(e);
                        main.post(() -> info.done(0, 0, error));
                        return;
                    }
                    main.post(() -> {
                        if (svg) info.done(size[2], size[3], null);
                        else infoOfBitmap(uri, bytes, info);
                    });
                });
                return;
            }
            infoOfBitmap(uri, bytes, info);
            return;
        }
        Inflight request = inflight.get(key);
        if (request == null) return;
        int maxPx = request.maxPx, blurPx = request.blurPx;
        POOL.submit(() -> {
            Image image = null;
            String error = null;
            try {
                image = maybeSvg(bytes) ? decodeSvg(bytes, maxPx, blurPx) : null;
                if (image == null && animated(bytes)) image = decodeAnimated(bytes, maxPx);
                if (image == null) image = decode(bytes, maxPx, blurPx);
                if (image == null) error = "cannot decode " + uri;
            } catch (Exception | OutOfMemoryError e) {
                error = String.valueOf(e);
            }
            Image result = image;
            String message = error;
            main.post(() -> finish(key, result, message));
        });
    }

    /** Answers {@code info} with the pixel size in a bitmap's header. */
    private static void infoOfBitmap(String uri, byte[] bytes, InfoCallback info) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        if (bounds.outWidth > 0 && bounds.outHeight > 0) info.done(bounds.outWidth, bounds.outHeight, null);
        else info.done(0, 0, "cannot read the size of " + uri);
    }

    /** Download progress for the views waiting for `download`'s decodes. */
    private void progress(Download download, long loaded, long total) {
        for (String key : download.keys) {
            Inflight request = inflight.get(key);
            if (request == null) continue;
            for (Callback c : request.waiters) c.progress(loaded, total);
        }
    }

    /**
     * Text starting with {@code <} (after a byte order mark and white space), or gzip: maybe an SVG, which
     * {@link Native#svg} decides. Bitmap formats start otherwise.
     */
    private static boolean maybeSvg(byte[] b) {
        if (b.length > 1 && (b[0] & 0xff) == 0x1f && (b[1] & 0xff) == 0x8b) return true;
        int i = b.length >= 3 && (b[0] & 0xff) == 0xef && (b[1] & 0xff) == 0xbb && (b[2] & 0xff) == 0xbf ? 3 : 0;
        while (i < b.length && (b[i] == ' ' || b[i] == '\t' || b[i] == '\r' || b[i] == '\n')) i++;
        return i < b.length && b[i] == '<';
    }

    /**
     * An SVG drawn for a view {@code maxPx} long, its shorter side that long (0: its intrinsic size at the display's
     * density); null if it is none.
     */
    private static Image decodeSvg(byte[] bytes, int maxPx, int blurPx) {
        int[] size = new int[4];
        float density = android.content.res.Resources.getSystem().getDisplayMetrics().density;
        float[] intrinsic = new float[2];
        byte[] pixels = Native.svg(bytes, maxPx, density, size, intrinsic);
        if (pixels == null) return null;
        Bitmap bitmap = Bitmap.createBitmap(size[0], size[1], Bitmap.Config.ARGB_8888);
        bitmap.copyPixelsFromBuffer(java.nio.ByteBuffer.wrap(pixels));
        if (blurPx > 0) bitmap = Blur.blurred(bitmap, blurPx);
        return new Image(bitmap, size[2], size[3], true, intrinsic[0], intrinsic[1]);
    }

    /** GIF, animated WebP (VP8X with the animation flag) or APNG (acTL). */
    private static boolean animated(byte[] b) {
        if (b.length > 6 && b[0] == 'G' && b[1] == 'I' && b[2] == 'F') return true;
        if (b.length > 21 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F'
                && b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P'
                && b[12] == 'V' && b[13] == 'P' && b[14] == '8' && b[15] == 'X') {
            return (b[20] & 0x02) != 0;
        }
        if (b.length > 8 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') {
            // acTL comes before the first IDAT.
            for (int i = 8; i + 8 < b.length; ) {
                int length = ((b[i] & 0xff) << 24) | ((b[i + 1] & 0xff) << 16) | ((b[i + 2] & 0xff) << 8) | (b[i + 3] & 0xff);
                String type = new String(b, i + 4, 4, java.nio.charset.StandardCharsets.US_ASCII);
                if (type.equals("acTL")) return true;
                if (type.equals("IDAT") || length < 0) return false;
                i += 12 + length;
            }
        }
        return false;
    }

    /** An animated drawable (API 28+), downsampled like bitmaps. */
    private static Image decodeAnimated(byte[] bytes, int maxPx) throws java.io.IOException {
        if (android.os.Build.VERSION.SDK_INT < 28) return null;
        android.graphics.ImageDecoder.Source source =
                android.graphics.ImageDecoder.createSource(java.nio.ByteBuffer.wrap(bytes));
        int[] size = new int[2];
        android.graphics.drawable.Drawable d = android.graphics.ImageDecoder.decodeDrawable(source, (decoder, info, src) -> {
            size[0] = info.getSize().getWidth();
            size[1] = info.getSize().getHeight();
            int longest = Math.max(size[0], size[1]);
            int sample = 1;
            while (maxPx > 0 && longest / (sample * 2) >= maxPx) sample *= 2;
            decoder.setTargetSampleSize(sample);
        });
        return d instanceof android.graphics.drawable.AnimatedImageDrawable ? new Image(d, size[0], size[1]) : null;
    }

    /** `callback` no longer wants `uri`; cancels the load if nobody does. */
    void cancel(String uri, int maxPx, int blurPx, Callback callback) {
        String key = key(uri, maxPx, blurPx);
        Inflight request = inflight.get(key);
        if (request == null) return;
        request.waiters.remove(callback);
        if (!request.waiters.isEmpty()) return;
        inflight.remove(key);
        Download download = downloads.get(uri);
        if (download == null) return;
        download.keys.remove(key);
        if (download.keys.isEmpty() && download.infos.isEmpty()) {
            download.task.cancel(true);
            downloads.remove(uri);
        }
    }

    private void finish(String key, Image image, String error) {
        Inflight request = inflight.remove(key);
        if (image != null && image.content instanceof Bitmap) CACHE.put(key, image);
        if (request == null) return;
        // Shown now: the encoded bytes are not needed any more.
        if (image != null) DATA.remove(request.uri);
        for (int i = 0; i < request.waiters.size(); i++) {
            Image shared = image;
            // Each view plays its own animation.
            if (i > 0 && image != null && image.content instanceof android.graphics.drawable.Drawable) {
                android.graphics.drawable.Drawable.ConstantState state =
                        ((android.graphics.drawable.Drawable) image.content).getConstantState();
                if (state != null) shared = new Image(state.newDrawable(), image.width, image.height);
            }
            request.waiters.get(i).done(shared, error);
        }
    }

    /** Reads `uri` (off the UI thread), reporting download progress. */
    private byte[] read(String uri, Download download) throws Exception {
        // Their bytes are in the engine, which hands them over by URI.
        if (uri.startsWith("data:") || uri.startsWith("blob:")) {
            byte[] bytes = inline.bytes(uri);
            if (bytes == null) {
                throw new java.io.IOException(uri.startsWith("blob:")
                        ? "no blob for " + uri + " (revoked?)"
                        : "malformed data: URI");
            }
            return bytes;
        }
        if (uri.startsWith("asset:/")) {
            byte[] bytes = assets.read(uri);
            if (bytes == null) throw new java.io.FileNotFoundException(uri);
            return bytes;
        }
        if (uri.startsWith("http://") || uri.startsWith("https://")) {
            // Through the disk cache: a fresh copy is all it takes, a stale
            // one is revalidated (its conditions sent).
            DiskCache disk = this.disk;
            Object cached = disk != null ? disk.lookup(uri) : null;
            if (cached instanceof byte[]) return (byte[]) cached;
            String[] conditions = cached instanceof String[] ? (String[]) cached : null;
            HttpURLConnection c = null;
            String url = uri;
            try {
                // Redirects are followed here, one hop at a time: a hop the app is
                // not granted is never requested.
                for (int hops = 0; ; hops++) {
                    c = (HttpURLConnection) new URL(url).openConnection();
                    c.setInstanceFollowRedirects(false);
                    c.setConnectTimeout(30_000);
                    c.setReadTimeout(60_000);
                    if (conditions != null) {
                        for (int i = 0; i + 1 < conditions.length; i += 2) c.setRequestProperty(conditions[i], conditions[i + 1]);
                    }
                    int code;
                    try {
                        code = c.getResponseCode();
                    } catch (java.io.IOException e) {
                        // Offline: a stale copy may serve.
                        byte[] stale = disk != null ? disk.complete(uri, 0, null, null) : null;
                        if (stale != null) return stale;
                        throw e;
                    }
                    if (code != 301 && code != 302 && code != 303 && code != 307 && code != 308) break;
                    String location = c.getHeaderField("Location");
                    c.disconnect();
                    if (location == null || hops >= MAX_REDIRECTS) throw new java.io.IOException("redirect from " + url);
                    String next = redirects.next(url, location);
                    if (next == null) throw new java.io.IOException("redirect to " + location + " is not granted");
                    url = next;
                }
                int status = c.getResponseCode();
                if (status == 304 || status >= 400) {
                    byte[] served = disk != null ? disk.complete(uri, status, cacheHeaders(c), null) : null;
                    if (served != null) return served;
                    throw new java.io.IOException("HTTP " + status);
                }
                long total = Math.max(0, c.getContentLengthLong());
                InputStream in = c.getInputStream();
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(total > 0 ? (int) Math.min(total, 1 << 26) : 1 << 16);
                byte[] buffer = new byte[1 << 15];
                long last = 0;
                for (int n; (n = in.read(buffer)) > 0; ) {
                    out.write(buffer, 0, n);
                    long now = android.os.SystemClock.uptimeMillis();
                    long loaded = out.size();
                    if (now - last >= PROGRESS_INTERVAL || loaded == total) {
                        last = now;
                        main.post(() -> progress(download, loaded, total));
                    }
                }
                byte[] bytes = out.toByteArray();
                if (disk != null) disk.complete(uri, status, cacheHeaders(c), bytes);
                return bytes;
            } finally {
                if (c != null) c.disconnect();
            }
        }
        String path = uri.startsWith("file://") ? uri.substring(7) : uri;
        try (InputStream in = new FileInputStream(path)) {
            return Net.readAll(in);
        }
    }

    /** The headers of {@code c}'s response the disk cache reads, as names and values. */
    private static String[] cacheHeaders(HttpURLConnection c) {
        List<String> pairs = new ArrayList<>();
        for (java.util.Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
            if (e.getKey() == null) continue;
            String name = e.getKey().toLowerCase(java.util.Locale.ROOT);
            for (String wanted : CACHE_HEADERS) {
                if (!wanted.equals(name)) continue;
                for (String value : e.getValue()) {
                    pairs.add(name);
                    pairs.add(value);
                }
            }
        }
        return pairs.toArray(new String[0]);
    }

    private static Image decode(byte[] bytes, int maxPx, int blurPx) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        BitmapFactory.Options options = new BitmapFactory.Options();
        int longest = Math.max(bounds.outWidth, bounds.outHeight);
        int sample = 1;
        // Power-of-two downsampling while the result stays at least maxPx.
        while (maxPx > 0 && longest / (sample * 2) >= maxPx) sample *= 2;
        options.inSampleSize = sample;
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (bitmap == null) return null;
        if (blurPx > 0) bitmap = Blur.blurred(bitmap, blurPx);
        return new Image(bitmap, bounds.outWidth, bounds.outHeight);
    }
}
