package com.longbridge.nsh;

import android.app.Activity;
import android.app.Dialog;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Native instrumentation: an embedded surface must not scroll its touch-only host into view. */
public final class EmbeddedFocusRegression extends Instrumentation {
    /** Starts the native regression on the instrumentation thread. */
    @Override public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        start();
    }

    /** Exercises real window focus and keyboard input without bypassing ViewRootImpl. */
    @Override public void onStart() {
        Bundle result = new Bundle();
        int status = Activity.RESULT_OK;
        HostActivity activity = null;
        try {
            setInTouchMode(true);
            Intent intent = new Intent(getTargetContext(), HostActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = (HostActivity) startActivitySync(intent);
            HostActivity host = activity;
            await(() -> host.surface.hasWindowFocus() && host.surface.getHeight() > 0);
            onMain(() -> {
                require(host.surface.isInTouchMode(), "expected touch mode");
                require(!host.surface.hasFocus(), "touch-mode attachment took focus");
                host.scroll.scrollTo(0, host.surface.getTop() - host.scroll.getHeight() / 2);
            });
            waitForIdleSync();
            final int[] before = new int[2];
            onMain(() -> {
                before[0] = host.scroll.getScrollY();
                before[1] = host.scroll.surfaceFocusRequests;
                int top = host.surface.getTop() - before[0];
                require(top > 0 && top < host.scroll.getHeight()
                    && top + host.surface.getHeight() > host.scroll.getHeight(), "surface must be partly visible");
            });
            cycleDialog(host);
            onMain(() -> {
                require(!host.surface.hasFocus(), "return from a dialog took touch-mode focus");
                require(host.scroll.getScrollY() == before[0], "dialog dismissal scrolled the host");
                require(host.scroll.surfaceFocusRequests == before[1], "surface requested child focus without a key");
            });
            sendKeyDownUpSync(KeyEvent.KEYCODE_TAB);
            await(() -> host.surface.keyDowns == 1);
            onMain(() -> require(!host.surface.isInTouchMode(), "hardware key did not leave touch mode"));
            onMain(() -> {
                host.input.setFocusableInTouchMode(true);
                require(host.input.requestFocus(), "native input could not take focus");
            });
            waitForIdleSync();
            onMain(() -> before[0] = host.scroll.getScrollY());
            cycleDialog(host);
            onMain(() -> {
                require(host.input.hasFocus(), "surface stole the native input's focus");
                require(host.scroll.getScrollY() == before[0], "return from a dialog moved the native input");
            });
            sendKeyDownUpSync(KeyEvent.KEYCODE_A);
            await(() -> host.input.getText().toString().equals("a"));
            onMain(() -> require(host.surface.keyDowns == 1, "surface intercepted the native input's key"));
            result.putString("stream", "EmbeddedFocusRegression: PASS (touch-mode scroll, first hardware key, native-input ownership)\n");
        } catch (Throwable error) {
            result.putString("stream", "EmbeddedFocusRegression: FAIL " + android.util.Log.getStackTraceString(error));
            status = Activity.RESULT_CANCELED;
        } finally {
            if (activity != null) {
                HostActivity host = activity;
                onMain(host::finish);
            }
        }
        finish(status, result);
    }

    private void cycleDialog(HostActivity host) throws Exception {
        onMain(() -> {
            host.dialog = new Dialog(host);
            TextView label = new TextView(host);
            label.setText("Host dialog");
            host.dialog.setContentView(label);
            host.dialog.show();
        });
        await(() -> !host.surface.hasWindowFocus());
        onMain(() -> host.dialog.dismiss());
        await(() -> host.surface.hasWindowFocus());
        waitForIdleSync();
    }

    private void onMain(Runnable action) {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        runOnMainSync(() -> {
            try { action.run(); }
            catch (Throwable error) { failure.set(error); }
        });
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private void await(BooleanSupplier condition) throws Exception {
        long deadline = android.os.SystemClock.uptimeMillis() + 5000;
        AtomicBoolean done = new AtomicBoolean();
        do {
            onMain(() -> done.set(condition.getAsBoolean()));
            if (done.get()) return;
            Thread.sleep(20);
        } while (android.os.SystemClock.uptimeMillis() < deadline);
        throw new AssertionError("native condition timed out");
    }

    private static void require(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }

    /** An actual host activity with native scrolling around the embedded surface. */
    public static final class HostActivity extends Activity {
        ProbeSurface surface;
        HostScroll scroll;
        EditText input;
        Dialog dialog;

        /** Places the surface partly outside the host's initial viewport. */
        @Override public void onCreate(Bundle state) {
            super.onCreate(state);
            scroll = new HostScroll(this);
            LinearLayout column = new LinearLayout(this);
            column.setOrientation(LinearLayout.VERTICAL);
            input = new EditText(this);
            input.setFocusable(false);
            column.addView(input, new LinearLayout.LayoutParams(-1, 64));
            View spacer = new View(this);
            int page = getResources().getDisplayMetrics().heightPixels;
            column.addView(spacer, new LinearLayout.LayoutParams(-1, page * 2));
            surface = new ProbeSurface(this);
            scroll.surface = surface;
            column.addView(surface, new LinearLayout.LayoutParams(-1, page));
            column.addView(new View(this), new LinearLayout.LayoutParams(-1, page * 2));
            scroll.addView(column);
            setContentView(scroll);
        }

        /** Releases the embedded native surface with its owner. */
        @Override protected void onDestroy() {
            if (dialog != null) dialog.dismiss();
            if (surface != null) surface.destroy();
            super.onDestroy();
        }
    }

    private static final class ProbeSurface extends NshView {
        int keyDowns;
        ProbeSurface(Activity activity) { super(activity); }
        @Override public boolean dispatchKeyEvent(KeyEvent event) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) keyDowns++;
            return super.dispatchKeyEvent(event);
        }
    }

    private static final class HostScroll extends ScrollView {
        NshView surface;
        int surfaceFocusRequests;
        HostScroll(Activity activity) { super(activity); }
        @Override public void requestChildFocus(View child, View focused) {
            if (focused == surface) surfaceFocusRequests++;
            super.requestChildFocus(child, focused);
        }
    }
}
