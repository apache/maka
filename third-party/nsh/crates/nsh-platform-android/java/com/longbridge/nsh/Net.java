package com.longbridge.nsh;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * `fetch` on HttpURLConnection (crates/nsh-platform-android/src/net.rs): one pooled thread per request reports the
 * response head, then the body in chunks as they arrive (waiting while paused: the back pressure); a streamed request
 * body is written with chunked transfer encoding, each chunk asked for when the last one is written.
 */
final class Net {
    private Net() {}

    private static final int CHUNK = 64 * 1024;
    /** The end of a streamed body (also sent on cancellation). */
    private static final byte[] END = new byte[0];

    private static final ExecutorService POOL = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "nsh-net");
        t.setDaemon(true);
        return t;
    });
    private static final ConcurrentHashMap<Long, Call> ACTIVE = new ConcurrentHashMap<>();

    static native void nativeHead(long key, int status, String url, boolean redirected, String[] headers);
    static native void nativeData(long key, byte[] data);
    static native void nativeEnd(long key);
    static native void nativeFail(long key, String message);
    static native void nativeBodyWanted(long key);

    /** A request in flight. */
    private static final class Call {
        final long key;
        final LinkedBlockingQueue<byte[]> body = new LinkedBlockingQueue<>();
        volatile HttpURLConnection connection;
        volatile boolean cancelled;
        private boolean paused;

        Call(long key) {
            this.key = key;
        }

        synchronized void setPaused(boolean p) {
            paused = p;
            notifyAll();
        }

        synchronized void awaitResumed() throws InterruptedException {
            while (paused && !cancelled) wait();
        }

        synchronized void cancel() {
            cancelled = true;
            notifyAll();
            body.offer(END);
            HttpURLConnection c = connection;
            if (c != null) c.disconnect();
        }
    }

    static void fetch(long key, String method, String url, String[] headers, byte[] body, boolean streamed,
                      boolean follow) {
        Call call = new Call(key);
        ACTIVE.put(key, call);
        POOL.execute(() -> run(call, method, url, headers, body, streamed, follow));
    }

    static void send(long key, byte[] chunk) {
        Call call = ACTIVE.get(key);
        if (call != null) call.body.offer(chunk);
    }

    static void finish(long key) {
        Call call = ACTIVE.get(key);
        if (call != null) call.body.offer(END);
    }

    static void pause(long key, boolean paused) {
        Call call = ACTIVE.get(key);
        if (call != null) call.setPaused(paused);
    }

    static void cancel(long key) {
        Call call = ACTIVE.remove(key);
        if (call != null) call.cancel();
    }

    private static void run(Call call, String method, String url, String[] headers, byte[] body, boolean streamed,
                            boolean follow) {
        long key = call.key;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            call.connection = c;
            if (call.cancelled) return;
            c.setInstanceFollowRedirects(follow);
            c.setRequestMethod(method);
            c.setConnectTimeout(30_000);
            c.setReadTimeout(60_000);
            for (int i = 0; i + 1 < headers.length; i += 2) c.addRequestProperty(headers[i], headers[i + 1]);
            if (streamed) {
                c.setDoOutput(true);
                c.setChunkedStreamingMode(0);
                try (OutputStream out = c.getOutputStream()) {
                    while (true) {
                        nativeBodyWanted(key);
                        byte[] chunk = call.body.take();
                        if (chunk == END || call.cancelled) break;
                        out.write(chunk);
                        out.flush();
                    }
                }
            } else if (body != null) {
                c.setDoOutput(true);
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream out = c.getOutputStream()) {
                    out.write(body);
                }
            }
            if (call.cancelled) return;
            int status = c.getResponseCode();
            List<String> flat = new ArrayList<>();
            for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                if (e.getKey() == null) continue; // the status line
                for (String v : e.getValue()) {
                    flat.add(e.getKey());
                    flat.add(v);
                }
            }
            String finalUrl = c.getURL().toString();
            nativeHead(key, status, finalUrl, !finalUrl.equals(url), flat.toArray(new String[0]));
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            if (in != null) {
                try (InputStream input = in) {
                    byte[] buf = new byte[CHUNK];
                    while (true) {
                        call.awaitResumed();
                        if (call.cancelled) return;
                        int n = input.read(buf);
                        if (n < 0) break;
                        if (n > 0) nativeData(key, Arrays.copyOf(buf, n));
                    }
                }
            }
            if (!call.cancelled) nativeEnd(key);
        } catch (Exception e) {
            if (!call.cancelled) nativeFail(key, String.valueOf(e.getMessage() != null ? e.getMessage() : e));
        } finally {
            ACTIVE.remove(key);
            if (c != null) c.disconnect();
        }
    }

    static byte[] readAll(InputStream in) throws java.io.IOException {
        try (InputStream input = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = input.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }
}
