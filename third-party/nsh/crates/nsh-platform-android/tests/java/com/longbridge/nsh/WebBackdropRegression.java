package com.longbridge.nsh;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.Gravity;
import android.view.View;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.TextView;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** A real WebView must keep painting when a sibling samples its backdrop, including after updates. */
public final class WebBackdropRegression extends Instrumentation {
    private HostActivity host;

    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        int status = Activity.RESULT_OK;
        try {
            Intent intent = new Intent(getTargetContext(), HostActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            host = (HostActivity) startActivitySync(intent);
            await(() -> host.web.getHeight() > 0 && host.web.getContentHeight() > 1000);
            assertLayer(View.LAYER_TYPE_NONE);
            assertPainted();
            require(contrast() > 15, "solid control must show the stripes through its fill");

            // Start a fresh page under the blur, as a real app does. Enabling blur only after
            // the full page has rasterized can leave old tiles in the cache and hide the failure.
            onMain(host::finish);
            waitForIdleSync();
            intent.putExtra("blur", true);
            host = (HostActivity) startActivitySync(intent);
            await(() -> host.web.getHeight() > 0 && host.web.getContentHeight() > 1000);
            assertPainted();
            assertLayer(View.LAYER_TYPE_HARDWARE);
            for (int count = 0; count <= 2; count++) {
                int value = count;
                onMain(() -> { host.counter.setText("Counter " + value); host.first.invalidate(); });
                assertPainted();
            }
            require(contrast() < 8, "the overlay must still blur its backdrop");

            // Two backdrops share the page's layer. Releasing one must not disable the other.
            onMain(() -> host.second.decor.setBackdrop(host.second, 20 * host.density));
            afterFrame();
            onMain(() -> host.first.decor.setBackdrop(host.first, 0));
            assertLayer(View.LAYER_TYPE_HARDWARE);
            assertPainted();
            onMain(() -> host.second.setVisibility(View.GONE));
            assertLayer(View.LAYER_TYPE_NONE);
            onMain(() -> host.second.setVisibility(View.VISIBLE));
            assertLayer(View.LAYER_TYPE_HARDWARE);

            // A page moved in front of the backdrop is no longer sampled.
            onMain(() -> { host.root.removeView(host.page); host.root.addView(host.page, 2); });
            assertLayer(View.LAYER_TYPE_NONE);
            onMain(() -> { host.root.removeView(host.page); host.root.addView(host.page, 0); });
            assertLayer(View.LAYER_TYPE_HARDWARE);
            onMain(() -> host.root.removeView(host.second));
            assertLayer(View.LAYER_TYPE_NONE);
            onMain(() -> host.root.addView(host.second));
            assertLayer(View.LAYER_TYPE_HARDWARE);
            assertPainted();

            // The layer belongs to the WebBox, so a replacement renderer inherits the active capture.
            AtomicBoolean terminated = new AtomicBoolean();
            onMain(() -> {
                var process = host.web.getWebViewRenderProcess();
                if (process != null) terminated.set(process.terminate());
            });
            if (terminated.get()) {
                await(() -> host.box.getChildCount() == 0);
                onMain(() -> { host.box.command(4, null); host.web = (WebView) host.box.getChildAt(0); });
                await(() -> host.web.getContentHeight() > 1000);
                assertLayer(View.LAYER_TYPE_HARDWARE);
                assertPainted();
                result.putString("renderer", "Replacement renderer painted under the active backdrop");
            } else {
                result.putString("renderer", "No separate WebView renderer to terminate on this device");
            }
            onMain(() -> host.second.decor.setBackdrop(host.second, 0));
            assertLayer(View.LAYER_TYPE_NONE);
            assertPainted();
            result.putString("stream", "WebBackdropRegression: PASS (pixels, blur, shared layer lifetime)\n");
        } catch (Throwable error) {
            result.putString("stream", "WebBackdropRegression: FAIL " + android.util.Log.getStackTraceString(error));
            status = Activity.RESULT_CANCELED;
        } finally {
            if (host != null) onMain(host::finish);
        }
        finish(status, result);
    }

    private void assertLayer(int type) throws Exception {
        await(() -> host.web.getLayerType() == type);
        afterFrame();
    }

    /** Check the actual window pixels: DOM, dimensions and native style all stay valid in the failure. */
    private void assertPainted() throws Exception {
        long deadline = SystemClock.uptimeMillis() + 5000;
        int hits, samples;
        do {
            afterFrame();
            int[] at = new int[2];
            onMain(() -> host.web.getLocationOnScreen(at));
            Bitmap image = getUiAutomation().takeScreenshot();
            require(image != null, "OS screenshot unavailable");
            try {
                int width = host.web.getWidth(), height = host.web.getHeight();
                hits = 0; samples = 0;
                for (int y = height * 3 / 4; y < height * 7 / 8; y += 4) {
                    for (int x = width * 3 / 4; x < width * 7 / 8; x += 4) {
                        int pixel = image.getPixel(at[0] + x, at[1] + y);
                        if (Math.abs(Color.red(pixel) - 199) < 5 && Math.abs(Color.green(pixel) - 230) < 5
                                && Math.abs(Color.blue(pixel) - 250) < 5) hits++;
                        samples++;
                    }
                }
                if (hits > samples * 0.9) return;
            } finally { image.recycle(); }
        } while (SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("lower WebView content is not painted: " + hits + "/" + samples);
    }

    /** Stripe contrast inside the overlay; blurring keeps its fill but removes the sharp stripes. */
    private double contrast() {
        int[] at = new int[2];
        onMain(() -> host.first.getLocationOnScreen(at));
        Bitmap image = getUiAutomation().takeScreenshot();
        require(image != null, "OS screenshot unavailable");
        try {
            double sum = 0, squares = 0;
            int count = 0;
            int y = at[1] + host.first.getHeight() / 2;
            for (int x = host.first.getWidth() / 8; x < host.first.getWidth() / 3; x++) {
                int red = Color.red(image.getPixel(at[0] + x, y));
                sum += red; squares += red * red; count++;
            }
            return Math.sqrt(squares / count - Math.pow(sum / count, 2));
        } finally { image.recycle(); }
    }

    private void afterFrame() throws Exception {
        CountDownLatch frame = new CountDownLatch(1);
        onMain(() -> host.root.postOnAnimation(() -> host.root.postOnAnimation(frame::countDown)));
        require(frame.await(5, TimeUnit.SECONDS), "window did not produce a frame");
        waitForIdleSync();
    }

    private void await(BooleanSupplier condition) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 10000;
        AtomicBoolean done = new AtomicBoolean();
        do {
            onMain(() -> done.set(condition.getAsBoolean()));
            if (done.get()) return;
            Thread.sleep(20);
        } while (SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("native condition timed out");
    }

    private void onMain(Runnable action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        runOnMainSync(() -> { try { action.run(); } catch (Throwable error) { failure.set(error); } });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    /** A nested WebBox, two native siblings, and constant HTML taller than the viewport. */
    public static final class HostActivity extends Activity {
        NshView owner;
        WebBox box;
        WebView web;
        FrameLayout root, page;
        Box first, second;
        TextView counter;
        float density;

        @Override public void onCreate(Bundle state) {
            super.onCreate(state);
            density = getResources().getDisplayMetrics().density;
            owner = new NshView(this);
            root = new FrameLayout(this);
            page = new FrameLayout(this);
            root.addView(page, new FrameLayout.LayoutParams(-1, -1));
            box = (WebBox) WebBox.make(this, owner.mounter(), 4);
            web = (WebView) box.getChildAt(0);
            page.addView(box, new FrameLayout.LayoutParams(-1, -1));
            String html = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>"
                    + "<style>body{margin:0;background:white;font:24px/1.6 sans-serif}"
                    + "header{height:100px;background:repeating-linear-gradient(90deg,#142e44 0 12px,white 12px 24px)}"
                    + "section{box-sizing:border-box;height:180px;padding:24px;background:#c7e6fa}</style><header></header>";
            for (int i = 0; i < 20; i++) html += "<section>Persistent WebView paragraph " + i + ".</section>";
            box.configure(new Object[]{2, html, "https://blur.test/"}, null, null, null, true, true, false);
            first = overlay(6, 36);
            second = overlay(8, 120);
            if (getIntent().getBooleanExtra("blur", false)) first.decor.setBackdrop(first, 20 * density);
            counter = new TextView(this);
            counter.setTextSize(16);
            counter.setGravity(Gravity.CENTER);
            first.addView(counter);
            first.addOnLayoutChangeListener((v,l,t,r,b,ol,ot,or_,ob) -> {
                Box.Frame frame = Box.frame(counter);
                frame.right = r - l; frame.bottom = b - t;
                Box.place(counter);
            });
            setContentView(root);
        }

        private Box overlay(int id, int top) {
            Box overlay = new Box(this, owner.mounter(), id);
            overlay.decor.fill = Color.argb(199, 245, 245, 250);
            FrameLayout.LayoutParams frame = new FrameLayout.LayoutParams(-1, Math.round(48 * density));
            frame.leftMargin = frame.rightMargin = Math.round(24 * density);
            frame.topMargin = Math.round(top * density);
            root.addView(overlay, frame);
            return overlay;
        }

        @Override protected void onDestroy() {
            if (first != null) first.decor.setBackdrop(first, 0);
            if (second != null) second.decor.setBackdrop(second, 0);
            if (box != null) box.destroy();
            if (owner != null) owner.destroy();
            super.onDestroy();
        }
    }
}
