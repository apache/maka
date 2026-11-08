package com.longbridge.nsh;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Choreographer;
import android.view.KeyCharacterMap;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.PixelCopy;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
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
    /** The window that received the current finger's down. */
    private static View touchTarget;

    /** One finger's `action` (`MotionEvent.ACTION_*`) at `x`, `y` in the window. */
    static void touch(NshView host, int action, float x, float y) {
        onMain(() -> {
            long now = SystemClock.uptimeMillis();
            if (action == MotionEvent.ACTION_DOWN) {
                downTime = now;
                touchTarget = target(host);
            }
            View root = touchTarget != null ? touchTarget : target(host);
            MotionEvent e = MotionEvent.obtain(downTime, now, action, x, y, 0);
            e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
            root.dispatchTouchEvent(e);
            e.recycle();
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) touchTarget = null;
            return null;
        });
    }

    /**
     * A finger's drag along ({@code xs}, {@code ys}): down at the first
     * point, a move to each next one a frame ({@code frameMs}) apart, up at
     * the last; scheduled on the UI thread as the display paces real ones.
     * Each event carries the time it is due, as a touchscreen stamps its
     * samples: a busy UI thread takes them late and close together, and
     * the velocity the views compute (a scroll view's fling) still follows
     * the finger. Returns when it is done.
     */
    static void drag(NshView host, float[] xs, float[] ys, int frameMs) {
        java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        MAIN.post(() -> {
            long start = SystemClock.uptimeMillis();
            View window = target(host);
            int last = xs.length - 1;
            for (int i = 0; i <= last; i++) {
                final int at = i;
                final long due = start + (long) at * frameMs;
                MAIN.postAtTime(() -> {
                    int action = at == 0 ? MotionEvent.ACTION_DOWN
                            : at == last ? MotionEvent.ACTION_UP : MotionEvent.ACTION_MOVE;
                    MotionEvent e = MotionEvent.obtain(start, due, action, xs[at], ys[at], 0);
                    e.setSource(android.view.InputDevice.SOURCE_TOUCHSCREEN);
                    window.dispatchTouchEvent(e);
                    e.recycle();
                    if (at == last) done.countDown();
                }, due);
            }
        });
        try {
            done.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Where touches go: the system dialog shown over the app, else the
     * app's topmost `Dialog` (a window of its own), else the app's window.
     */
    private static View target(NshView host) {
        Dialog d = shownDialog;
        if (d != null && d.isShowing() && d.getWindow() != null) return d.getWindow().getDecorView();
        View modal = host.mounter().topModalWindow();
        return modal != null ? modal : host.getRootView();
    }

    /**
     * The focused view keys go to: in the topmost window (a field in a
     * `<modal>` has its focus in the dialog's window), else in the app's.
     */
    private static View focused(NshView host) {
        View focus = target(host).findFocus();
        return focus != null ? focus : host.getRootView().findFocus();
    }

    /** Types `text` into the focused field, key by key where keys type it. */
    static void type(NshView host, String text) {
        onMain(() -> {
            View focus = focused(host);
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
            View focus = focused(host);
            View to = focus != null ? focus : target(host);
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
            for (Window over : overWindows(host)) sig = sig * 31 + signature(over.getDecorView());
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

    /** The thread PixelCopy reports on: never the main thread, which may be the one waiting. */
    private static Handler copier;

    private static synchronized Handler copier() {
        if (copier == null) {
            HandlerThread t = new HandlerThread("nsh-pixel-copy");
            t.start();
            copier = new Handler(t.getLooper());
        }
        return copier;
    }

    /** A window over the app's: a `<modal>`'s dialog or the system alert. */
    private static final class Layer {
        Window window;
        /** Its decor view's rect in its own window. */
        Rect rect;
        /** Where it is from the app window's root view. */
        int x, y;
        /** The dim the compositor puts under it (`FLAG_DIM_BEHIND`), 0 for none. */
        float dim;
    }

    /** What a screenshot copies, gathered on the main thread. */
    private static final class Shot {
        View root;
        Window window;
        Rect rootRect;
        /** Bottom to top: the shown modals in their order, then the system alert. */
        final ArrayList<Layer> layers = new ArrayList<>();
    }

    /**
     * The windows over the app's, bottom to top: every `<modal>` shown (a
     * dialog window of its own: `Dialog`, sheets, ...), then the system alert.
     */
    private static ArrayList<Window> overWindows(NshView host) {
        ArrayList<Window> windows = new ArrayList<>(host.mounter().modalWindows());
        Dialog d = shownDialog;
        if (d != null && d.isShowing() && d.getWindow() != null) windows.add(d.getWindow());
        return windows;
    }

    /**
     * A picture of the window and the windows over it (the modals', the
     * system alert's), as a PNG: what the compositor shows, each window
     * copied from its surface with {@link PixelCopy}, so it holds what only
     * the GPU draws (texture views, `RenderEffect` filters, the backdrop's
     * blur, hardware layers). A window whose surface cannot be copied is
     * drawn into the bitmap instead.
     */
    static byte[] screenshot(NshView host) {
        CountDownLatch[] drawn = new CountDownLatch[1];
        Shot shot = onMain(() -> {
            View root = host.getRootView();
            if (root.getWidth() == 0 || root.getHeight() == 0) return null;
            Shot s = new Shot();
            s.root = root;
            Window w = windowOf(host.getContext());
            if (w != null && w.peekDecorView() == root) {
                s.window = w;
                int[] at = new int[2];
                root.getLocationInWindow(at);
                s.rootRect = new Rect(at[0], at[1], at[0] + root.getWidth(), at[1] + root.getHeight());
            }
            int[] rootAt = new int[2];
            root.getLocationOnScreen(rootAt);
            for (Window over : overWindows(host)) {
                View dv = over.getDecorView();
                if (dv.getWidth() == 0 || dv.getHeight() == 0) continue;
                Layer l = new Layer();
                l.window = over;
                l.rect = new Rect(0, 0, dv.getWidth(), dv.getHeight());
                int[] at = new int[2];
                dv.getLocationOnScreen(at);
                l.x = at[0] - rootAt[0];
                l.y = at[1] - rootAt[1];
                WindowManager.LayoutParams a = over.getAttributes();
                if ((a.flags & WindowManager.LayoutParams.FLAG_DIM_BEHIND) != 0) l.dim = a.dimAmount;
                s.layers.add(l);
            }
            // PixelCopy copies the last frame a window drew: each draws one with what is there now.
            drawn[0] = new CountDownLatch(1 + s.layers.size());
            root.invalidate();
            awaitFrame(root, drawn[0]);
            for (Layer l : s.layers) {
                View dv = l.window.getDecorView();
                dv.invalidate();
                awaitFrame(dv, drawn[0]);
            }
            return s;
        });
        if (shot == null) return null;
        try {
            drawn[0].await(1, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        Bitmap b = shot.window == null ? null : copy(shot.window, shot.rootRect);
        if (b == null) return drawViews(host, shot.root);
        Canvas c = new Canvas(b);
        for (Layer l : shot.layers) {
            // The dim under a window is the compositor's, a layer between it and the ones below.
            if (l.dim > 0) c.drawColor(Color.argb(Math.round(l.dim * 255), 0, 0, 0));
            Bitmap over = copy(l.window, l.rect);
            if (over != null) {
                c.drawBitmap(over, l.x, l.y, null);
                over.recycle();
            } else {
                onMain(() -> {
                    c.save();
                    c.translate(l.x, l.y);
                    l.window.getDecorView().draw(c);
                    c.restore();
                    return true;
                });
            }
        }
        return png(b);
    }

    /** Counts {@code drawn} down once the window of {@code root} has drawn its next frame (main thread). */
    private static void awaitFrame(View root, CountDownLatch drawn) {
        if (Build.VERSION.SDK_INT >= 29) {
            root.getViewTreeObserver().registerFrameCommitCallback(drawn::countDown);
        } else {
            // The frame after the next one: the next one draws, the one after is past it.
            Choreographer ch = Choreographer.getInstance();
            ch.postFrameCallback(t -> ch.postFrameCallback(t2 -> MAIN.post(drawn::countDown)));
        }
    }

    /** {@code rect} (window coordinates) of {@code window}'s surface; null when it cannot be copied. */
    private static Bitmap copy(Window window, Rect rect) {
        Bitmap b = Bitmap.createBitmap(rect.width(), rect.height(), Bitmap.Config.ARGB_8888);
        CountDownLatch done = new CountDownLatch(1);
        int[] result = {PixelCopy.ERROR_UNKNOWN};
        Boolean asked = onMain(() -> {
            PixelCopy.request(window, rect, b, r -> {
                result[0] = r;
                done.countDown();
            }, copier());
            return true;
        });
        boolean finished = false;
        if (asked != null) {
            try {
                finished = done.await(2, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        if (finished && result[0] == PixelCopy.SUCCESS) return b;
        android.util.Log.w("nsh", "test agent: PixelCopy failed (" + (finished ? result[0] : "timed out") + "), drawing the views instead");
        if (finished) b.recycle();
        return null;
    }

    /** The window's views and those of the windows over it drawn into a bitmap, as a PNG. */
    private static byte[] drawViews(NshView host, View root) {
        Bitmap b = onMain(() -> {
            if (root.getWidth() == 0 || root.getHeight() == 0) return null;
            Bitmap bitmap = Bitmap.createBitmap(root.getWidth(), root.getHeight(), Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(bitmap);
            root.draw(c);
            int[] rootAt = new int[2];
            root.getLocationOnScreen(rootAt);
            for (Window over : overWindows(host)) {
                View dv = over.getDecorView();
                WindowManager.LayoutParams a = over.getAttributes();
                if ((a.flags & WindowManager.LayoutParams.FLAG_DIM_BEHIND) != 0 && a.dimAmount > 0) {
                    c.drawColor(Color.argb(Math.round(a.dimAmount * 255), 0, 0, 0));
                }
                int[] at = new int[2];
                dv.getLocationOnScreen(at);
                c.save();
                c.translate(at[0] - rootAt[0], at[1] - rootAt[1]);
                dv.draw(c);
                c.restore();
            }
            return bitmap;
        });
        return b == null ? null : png(b);
    }

    private static byte[] png(Bitmap b) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        b.compress(Bitmap.CompressFormat.PNG, 100, out);
        b.recycle();
        return out.toByteArray();
    }

    /** The activity's window {@code context} belongs to; null outside one. */
    private static Window windowOf(Context context) {
        while (context instanceof ContextWrapper) {
            if (context instanceof Activity) return ((Activity) context).getWindow();
            context = ((ContextWrapper) context).getBaseContext();
        }
        return null;
    }
}
