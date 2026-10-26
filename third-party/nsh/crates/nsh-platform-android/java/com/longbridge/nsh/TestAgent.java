package com.longbridge.nsh;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.Callable;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * The platform's part of `nsh test --target android` (the agent itself is
 * Rust, `agent.rs`): where a node's view is, and what a user's finger and
 * keyboard do there, as `MotionEvent`s and `KeyEvent`s dispatched to the
 * window's views, so they take the path real ones take (scroll views, text
 * fields, gesture detectors). The agent calls from a thread of its own;
 * each call does its work on the main thread and returns when it is done.
 * Coordinates are pixels from the window's top left.
 */
final class TestAgent {
    private TestAgent() {}

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** The dialog the app shows now, for answering it. */
    static Dialog shownDialog;

    /** `call` on the main thread, waited for (10 s at most); null on failure. */
    private static <T> T onMain(Callable<T> call) {
        FutureTask<T> task = new FutureTask<>(call);
        MAIN.post(task);
        try {
            return task.get(10, TimeUnit.SECONDS);
        } catch (Exception e) {
            android.util.Log.w("nsh", "test agent: " + e);
            return null;
        }
    }

    /** The view of node `id`'s bounds in the window: x, y, width, height; null when it does not show. */
    static float[] bounds(NshView host, int id) {
        return onMain(() -> {
            View v = host.mounter().views.get(id);
            if (v == null || !v.isShown()) return null;
            int[] at = new int[2];
            v.getLocationInWindow(at);
            return new float[] {at[0], at[1], v.getWidth(), v.getHeight()};
        });
    }

    /**
     * Where the characters {@code start}..{@code end} (UTF-16 units) of
     * text view {@code id} are on their first line, in the window: x, y,
     * width, height; null when it does not show.
     */
    static float[] textBounds(NshView host, int id, int start, int end) {
        return onMain(() -> {
            View v = host.mounter().views.get(id);
            if (!(v instanceof TextBox) || !v.isShown()) return null;
            TextBox text = (TextBox) v;
            android.text.Layout layout = text.layout();
            if (layout == null) return null;
            // The box of the characters on their first line: the first one (empty
            // for an empty range, or one past the text).
            float[] boxes = TextLayouts.rangeRects(layout, start, end, 1f);
            if (boxes.length < 4) return null;
            int[] at = new int[2];
            v.getLocationInWindow(at);
            return new float[] {
                at[0] + text.contentX() + boxes[0],
                at[1] + text.contentY() + boxes[1],
                boxes[2],
                boxes[3],
            };
        });
    }

    /** The window's content size: width, height. */
    static float[] viewport(NshView host) {
        return onMain(() -> {
            View root = host.getRootView();
            return new float[] {root.getWidth(), root.getHeight()};
        });
    }

    /** The time the finger went down, for the events of one gesture. */
    private static long downTime;

    /** One finger's `action` (`MotionEvent.ACTION_*`) at `x`, `y` in the window. */
    static void touch(NshView host, int action, float x, float y) {
        onMain(() -> {
            long now = SystemClock.uptimeMillis();
            if (action == MotionEvent.ACTION_DOWN) downTime = now;
            View root = target(host);
            MotionEvent e = MotionEvent.obtain(downTime, now, action, x, y, 0);
            e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
            root.dispatchTouchEvent(e);
            e.recycle();
            return null;
        });
    }

    /**
     * A finger's drag along ({@code xs}, {@code ys}): down at the first
     * point, a move to each next one a frame ({@code frameMs}) apart, up at
     * the last; scheduled on the UI thread as the display paces real ones.
     * Returns when it is done.
     */
    static void drag(NshView host, float[] xs, float[] ys, int frameMs) {
        java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        MAIN.post(() -> {
            long start = SystemClock.uptimeMillis();
            int last = xs.length - 1;
            for (int i = 0; i <= last; i++) {
                final int at = i;
                MAIN.postAtTime(() -> {
                    int action = at == 0 ? MotionEvent.ACTION_DOWN
                            : at == last ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
                    long now = SystemClock.uptimeMillis();
                    MotionEvent e = MotionEvent.obtain(start, now, action, xs[at], ys[at], 0);
                    e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
                    target(host).dispatchTouchEvent(e);
                    e.recycle();
                    if (at == last) done.countDown();
                }, start + (long) at * frameMs);
            }
        });
        try {
            done.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    /** Where touches go: the dialog shown over the app, else the app's window. */
    private static View target(NshView host) {
        Dialog d = shownDialog;
        if (d != null && d.isShowing() && d.getWindow() != null) return d.getWindow().getDecorView();
        return host.getRootView();
    }

    /** Types `text` into the focused field, key by key where keys type it. */
    static void type(NshView host, String text) {
        onMain(() -> {
            View focus = host.getRootView().findFocus();
            if (focus == null) return null;
            KeyEvent[] keys = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray());
            if (keys != null) {
                for (KeyEvent k : keys) focus.dispatchKeyEvent(k);
            } else if (focus instanceof EditText) {
                // No key types it (an input method's text): committed as
                // the input method commits it.
                android.view.inputmethod.InputConnection ic =
                        focus.onCreateInputConnection(new android.view.inputmethod.EditorInfo());
                if (ic != null) ic.commitText(text, 1);
            }
            return null;
        });
    }

    /** Presses the key `code` (`KeyEvent.KEYCODE_*`) with `meta` (`KeyEvent.META_*`). */
    static void key(NshView host, int code, int meta) {
        onMain(() -> {
            View focus = host.getRootView().findFocus();
            View to = focus != null ? focus : host.getRootView();
            long now = SystemClock.uptimeMillis();
            KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta);
            // With Ctrl, a shortcut first, as the window's input stage
            // (ViewRootImpl) offers it: Ctrl+A selects all in a text field.
            if ((meta & KeyEvent.META_CTRL_ON) == 0 || !to.dispatchKeyShortcutEvent(down)) {
                to.dispatchKeyEvent(down);
            }
            to.dispatchKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0, meta));
            return null;
        });
    }

    /**
     * Presses the key `code` (`KeyEvent.KEYCODE_*`) with `meta` (`KeyEvent.META_*`) on a hardware
     * keyboard: the window's view hierarchy gets it from its root, as the window's input stage
     * (ViewRootImpl) hands it over after the input method: with Control as a shortcut first.
     */
    static void pressKeys(NshView host, int code, int meta) {
        onMain(() -> {
            View window = target(host);
            long now = SystemClock.uptimeMillis();
            KeyEvent down = new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta,
                    KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, android.view.InputDevice.SOURCE_KEYBOARD);
            if ((meta & KeyEvent.META_CTRL_ON) == 0 || !window.dispatchKeyShortcutEvent(down)) {
                window.dispatchKeyEvent(down);
            }
            window.dispatchKeyEvent(KeyEvent.changeAction(down, KeyEvent.ACTION_UP));
            return null;
        });
    }

    /** The text input `id` holds; null when it is no input. */
    static String inputText(NshView host, int id) {
        return onMain(() -> {
            View v = host.mounter().views.get(id);
            return v instanceof InputBox ? ((InputBox) v).edit.getText().toString() : null;
        });
    }

    /** The system's back: what the back button or gesture does. */
    @SuppressWarnings("deprecation")
    static boolean back(NshView host) {
        Boolean done = onMain(() -> {
            Dialog d = shownDialog;
            if (d != null && d.isShowing()) {
                d.onBackPressed();
                return true;
            }
            Activity a = SystemUi.activity(host.getContext());
            if (a == null) return false;
            a.onBackPressed();
            return true;
        });
        return done != null && done;
    }

    /**
     * Where to tap to answer the dialog shown: the middle of its button
     * titled `button` (window pixels of the dialog's window), or null
     * when it has none.
     */
    static float[] dialogPoint(String button) {
        return onMain(() -> {
            Dialog d = shownDialog;
            if (d == null || !d.isShowing() || d.getWindow() == null) return null;
            View found = find(d.getWindow().getDecorView(), button);
            if (found == null) return null;
            int[] at = new int[2];
            found.getLocationInWindow(at);
            return new float[] {at[0] + found.getWidth() / 2f, at[1] + found.getHeight() / 2f};
        });
    }

    private static View find(View v, String text) {
        if (v instanceof TextView && v.isShown() && text.contentEquals(((TextView) v).getText())) {
            // A list item's text, or a button's.
            return v;
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                View f = find(g.getChildAt(i), text);
                if (f != null) return f;
            }
        }
        return null;
    }

    /** What moved last time {@link #animating} looked. */
    private static long lastSignature;

    /**
     * Whether something moves: a view's place, offset, scroll position or
     * opacity changed since the last look (a screen sliding in, a dialog
     * fading, a list gliding after a fling), whatever animates it, or a
     * scroll view drew (its overscroll stretch relaxing).
     */
    static boolean animating(NshView host) {
        Boolean moving = onMain(() -> {
            long sig = signature(host.getRootView());
            Dialog d = shownDialog;
            if (d != null && d.isShowing() && d.getWindow() != null) {
                sig = sig * 31 + signature(d.getWindow().getDecorView());
            }
            boolean changed = sig != lastSignature;
            lastSignature = sig;
            return changed;
        });
        return moving != null && moving;
    }

    private static long signature(View v) {
        if (v.getVisibility() != View.VISIBLE) return 0;
        long h = v.getLeft();
        h = h * 31 + v.getTop();
        h = h * 31 + Float.floatToIntBits(v.getTranslationX());
        h = h * 31 + Float.floatToIntBits(v.getTranslationY());
        h = h * 31 + Float.floatToIntBits(v.getAlpha());
        h = h * 31 + Float.floatToIntBits(v.getScaleX());
        h = h * 31 + v.getScrollX();
        h = h * 31 + v.getScrollY();
        if (v instanceof ScrollBox) h = h * 31 + ((ScrollBox) v).frames;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) h = h * 31 + signature(g.getChildAt(i));
        }
        return h;
    }

    /** A picture of the window (and the dialog over it), as a PNG. */
    static byte[] screenshot(NshView host) {
        return onMain(() -> {
            View root = host.getRootView();
            if (root.getWidth() == 0 || root.getHeight() == 0) return null;
            Bitmap b = Bitmap.createBitmap(root.getWidth(), root.getHeight(), Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(b);
            root.draw(c);
            Dialog d = shownDialog;
            if (d != null && d.isShowing() && d.getWindow() != null) {
                View dv = d.getWindow().getDecorView();
                int[] at = new int[2];
                dv.getLocationOnScreen(at);
                int[] rootAt = new int[2];
                root.getLocationOnScreen(rootAt);
                c.translate(at[0] - rootAt[0], at[1] - rootAt[1]);
                dv.draw(c);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            b.compress(Bitmap.CompressFormat.PNG, 100, out);
            b.recycle();
            return out.toByteArray();
        });
    }
}
