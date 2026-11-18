package com.longbridge.nsh;

import android.os.SystemClock;
import android.util.SparseArray;
import android.util.SparseBooleanArray;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewParent;

/**
 * The keyboard of one native window: the app's shortcuts, the focused
 * managed view's raw {@code onKeyDown} / {@code onKeyUp}, its mounted
 * {@code captureKeys} rules, and Tab / Shift+Tab focus traversal.
 *
 * <p>{@code NshView} is one window; a {@code ModalHost} dialog is another,
 * with its own focus and its own fallback root node. An {@code EditText} or
 * hosted native view keeps its own keys ({@link Mounter#keyNode} returns
 * `0`), and a {@code captureKeys} rule never reaches it. Decisions are made
 * synchronously on the UI thread from mounted state; a release uses the
 * focus, listeners and capture rules of the moment it arrives.
 *
 * <p>A system key ({@code KeyEvent.isSystem}: Back, Home, volume, media,
 * camera, call) is never captured, not even by {@code captureKeys: "all"}:
 * Android keeps its default. The raw {@code onKeyDown} / {@code onKeyUp}
 * observation is unaffected. A captured key is still observed, with its
 * {@code defaultPrevented} decision; observation and consumption are
 * separate.
 *
 * <p>Back's release may reach the window another way than a key-up down the
 * focus path ({@link BackRelease}): {@code NshView} hands it here
 * ({@link #backKey}, {@link #releaseBack}, {@link #cancelBack}) and it is
 * reported once, before the press goes back: as the listener's real key-up,
 * or, from the back callbacks, which bring none, as a key-up made from the
 * press's down.
 *
 * <p>Tab and Shift+Tab move between the managed stops and inputs in tree
 * order. At the first or last stop they yield to Android's own focus and
 * default handling instead of wrapping, so an app never traps Tab.
 *
 * <p>While no view of the app has the focus (the window's own root holds
 * it: at launch, and on the first key after a tap), an unmodified arrow key
 * that nothing in the app took and that Android has nowhere else to take
 * (no view outside the app in its direction, no scroll view around the app
 * scrolling that way) moves the focus to the first stop on screen
 * ({@link ArrowEntry}). From then on Android's own directional navigation
 * moves it. Enter and the D-pad centre keep Android's default.
 *
 * <p>An uncaptured Return or Space down reaches Android's native pressed
 * state. If a repeat or release becomes captured, the native state is
 * cancelled with a `FLAG_CANCELED` up, so no stale press and no click
 * remain.
 */
final class KeyDispatch {
    private final Mounter mounter;
    /** The window's view tree, whose focus is the keyboard's ({@code NshView}'s root or a modal's container). */
    private final View root;
    /** The node a key goes to when nothing in this window has a focus ({@code ROOT_ID} or a modal's id). */
    private final int fallback;
    /**
     * The keys whose press moved the managed focus (Tab, or an arrow into
     * the app), by code: their releases are consumed too. Another key
     * pressed meanwhile leaves them be.
     */
    private final SparseBooleanArray moved = new SparseBooleanArray();
    /** A down reached native handling: the view whose pressed state a captured repeat/up must cancel. */
    private final SparseArray<View> nativeDown = new SparseArray<>();
    /** A native press already cancelled while its key stayed held: its real up is cancelled too. */
    private final SparseArray<View> nativeCancelled = new SparseArray<>();
    /** Back's press, whose release may come another way than a key-up here. */
    private final BackRelease back = new BackRelease();
    /** A copy of Back's down (Android reuses the events it dispatches), for its release. */
    private KeyEvent backDown;

    KeyDispatch(Mounter mounter, View root, int fallback) {
        this.mounter = mounter;
        this.root = root;
        this.fallback = fallback;
    }

    boolean dispatchKeyEvent(KeyEvent e) {
        if (mounter.handle() == 0) return false;
        int action = e.getAction();
        if (action == KeyEvent.ACTION_DOWN) {
            if (e.getRepeatCount() == 0) {
                // A fresh press: any lost release state of this code is stale.
                nativeDown.remove(e.getKeyCode());
                nativeCancelled.remove(e.getKeyCode());
                moved.delete(e.getKeyCode());
                if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                    back.press(e.getDownTime());
                    backDown = new KeyEvent(e);
                }
            }
            if (keyEvent(e)) {
                // A repeat or a re-down consumed the key after native
                // handling saw its first down: clear that native press
                // without its click.
                cancelNative(e);
                return true;
            }
            View focus = focus();
            int code = e.getKeyCode();
            if (isTab(e) && mounter.moveFocus(root, focus, !e.isShiftPressed())) {
                moved.put(code, true);
                return true;
            }
            // An arrow with nothing of the app focused that Android has
            // nowhere else to take: its search from the window's root finds
            // nothing, so the focus goes to the first stop on screen,
            // whatever the direction.
            if (ArrowEntry.enters(code, e.hasNoModifiers(), focus == null || focus == root,
                    () -> elsewhere(ArrowEntry.direction(code)))
                    && mounter.enterFocus(root)) {
                moved.put(code, true);
                return true;
            }
            // Not a move (a held arrow's repeat moves the focus Android's
            // way), or a Tab the stops yielded at an end: its release
            // belongs to Android too, not to an earlier move of this press.
            moved.delete(code);
            nativeCancelled.remove(e.getKeyCode());
            if (focus != null && focus != root && mounter.keyNode(focus, fallback) > 1
                    && nativeDown.get(e.getKeyCode()) == null) {
                nativeDown.put(e.getKeyCode(), focus);
            }
            return false;
        }
        if (action == KeyEvent.ACTION_UP) {
            // Back's release may have been reported another way already:
            // with the back callback in effect, Android 15 QPR1 to 16 may
            // still send its key-up, marked cancelled, after `onBackInvoked`
            // or `onBackCancelled`, here or to the unhandled-key listener
            // when that took the down (`backKey`). It is not a second
            // release.
            if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                boolean report = back.up(e.getDownTime());
                if (!back.held()) backDown = null;
                if (!report) return false;
            }
            return release(e);
        }
        return false;
    }

    /** A key-up, real or Back's made from its down: reported and its native press settled. */
    private boolean release(KeyEvent e) {
        boolean consumed = keyEvent(e);
        View cancelled = nativeCancelled.get(e.getKeyCode());
        if (cancelled != null) {
            nativeCancelled.remove(e.getKeyCode());
            cancelNative(cancelled, e);
            return true;
        }
        boolean movedFocus = moved.get(e.getKeyCode());
        moved.delete(e.getKeyCode());
        boolean result = consumed || movedFocus;
        View nativeView = nativeDown.get(e.getKeyCode());
        if (nativeView != null) {
            nativeDown.remove(e.getKeyCode());
            if (result || nativeView != focus()) cancelNative(nativeView, e);
        }
        return result;
    }

    /**
     * A Back event the unhandled-key listener got instead of the views: once
     * it took the press's down, the window hands it the repeats and the
     * release directly. A repeat is reported as any key's, the release (or
     * its cancel) once, as the real key-up, with the modifiers held then.
     */
    void backKey(KeyEvent e) {
        if (e.getKeyCode() != KeyEvent.KEYCODE_BACK) return;
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            if (e.getRepeatCount() > 0 && back.held()) dispatchKeyEvent(e);
        } else if (e.getAction() == KeyEvent.ACTION_UP) {
            if (!back.take()) return;
            backDown = null;
            if (mounter.handle() != 0) release(e);
        }
    }

    /**
     * Back went up at {@code at} (uptime ms) and the press goes back
     * ({@code onBackInvoked}, which takes the place of the key-up): its
     * release is reported, once, before the app hears the press.
     */
    void releaseBack(long at) {
        endBack(at, false);
    }

    /** Back's press was cancelled ({@code onBackCancelled}): forgotten as a cancelled key-up, once. */
    void cancelBack() {
        endBack(SystemClock.uptimeMillis(), true);
    }

    /**
     * The callbacks bring no key-up: Back's release is made from its down
     * (its modifiers the down's), at {@code at}.
     */
    private void endBack(long at, boolean cancelled) {
        if (!back.take()) return;
        KeyEvent down = backDown;
        backDown = null;
        if (down == null || mounter.handle() == 0) return;
        int flags = down.getFlags() | (cancelled ? KeyEvent.FLAG_CANCELED : 0);
        release(new KeyEvent(down.getDownTime(), Math.max(at, down.getDownTime()), KeyEvent.ACTION_UP,
                KeyEvent.KEYCODE_BACK, 0, down.getMetaState(), down.getDeviceId(),
                down.getScanCode(), flags, down.getSource()));
    }

    boolean dispatchKeyShortcutEvent(KeyEvent e) {
        if (mounter.handle() == 0 || e.getAction() != KeyEvent.ACTION_DOWN) return false;
        View focus = focus();
        int node = mounter.keyNode(focus, fallback);
        return Native.keyShortcut(mounter.handle(), e.getKeyCode(), e.getUnicodeChar(0),
                e.getMetaState(), fallback, mounter.control(node), e.getRepeatCount() > 0,
                node == 0);
    }

    /** The window lost its focus or goes away: no held key has a release here. */
    void focusLost() {
        moved.clear();
        nativeDown.clear();
        nativeCancelled.clear();
        back.reset();
        backDown = null;
    }

    private View focus() {
        return root.findFocus();
    }

    /**
     * Whether Android takes an arrow in `direction` ({@code View.FOCUS_*})
     * elsewhere while the window's own root holds the focus: its focus
     * search from there ({@code ViewRootImpl}'s, through the parents'
     * {@code focusSearch}) finds a view outside the app, or a scroll view
     * around it scrolls that way (a host {@code ScrollView}'s
     * {@code arrowScroll}). Only an embedded {@code NshView} has either: a
     * standalone app's and a dialog's root fill their window.
     */
    private boolean elsewhere(int direction) {
        View holder = root.getRootView().findFocus();
        if (holder == null) return false;
        View next = holder.focusSearch(direction);
        if (next != null && next != holder && !inside(next, holder)) return true;
        for (ViewParent p = holder.getParent(); p instanceof View; p = p.getParent()) {
            if (scrolls((View) p, direction)) return true;
        }
        return false;
    }

    /** Whether `view` is inside `ancestor`. */
    private static boolean inside(View view, View ancestor) {
        for (ViewParent p = view.getParent(); p != null; p = p.getParent()) {
            if (p == ancestor) return true;
        }
        return false;
    }

    /** Whether `view` can scroll its content in `direction` ({@code View.FOCUS_*}). */
    private static boolean scrolls(View view, int direction) {
        switch (direction) {
            case View.FOCUS_UP: return view.canScrollVertically(-1);
            case View.FOCUS_DOWN: return view.canScrollVertically(1);
            case View.FOCUS_LEFT: return view.canScrollHorizontally(-1);
            case View.FOCUS_RIGHT: return view.canScrollHorizontally(1);
            default: return false;
        }
    }

    private boolean keyEvent(KeyEvent e) {
        View focus = focus();
        int node = mounter.keyNode(focus, fallback);
        // An input or hosted native view has the focus: it is in text, and
        // its keys stay its own.
        boolean editing = node == 0;
        int code = e.getKeyCode(), meta = e.getMetaState();
        int unicode = e.getUnicodeChar(0);
        int text = sourceText(e);
        int scan = e.getScanCode();
        if (e.getAction() == KeyEvent.ACTION_UP) {
            if (e.isCanceled()) return Native.keyCancel(mounter.handle(), code);
            // The release uses the current focus, listeners and capture
            // rules, not what its down happened to do.
            boolean raw = node > 0 && mounter.keyListens(node, fallback);
            boolean prevented = raw && mounter.keyCaptured(node, fallback, e);
            return Native.keyUp(mounter.handle(), code, unicode, text, meta, scan, node,
                    prevented, raw);
        }
        boolean raw = node > 0 && mounter.keyListens(node, fallback);
        boolean prevented = raw && mounter.keyCaptured(node, fallback, e);
        return Native.keyDown(mounter.handle(), code, unicode, text, meta, scan,
                e.getRepeatCount() > 0, editing, node, fallback, mounter.control(node),
                prevented, raw);
    }

    /** Plain Tab or Shift+Tab: the app's focus traversal, not Ctrl/Alt/Meta + Tab. */
    private static boolean isTab(KeyEvent e) {
        return e.getKeyCode() == KeyEvent.KEYCODE_TAB
                && !e.isCtrlPressed() && !e.isAltPressed() && !e.isMetaPressed();
    }

    /**
     * The printable character the source reports with its modifiers
     * (Shift, Caps Lock, AltGr or Alt): the raw `key` when there is one. A
     * Control combination reports a control character; its Shift/Caps level
     * is the printable source key.
     */
    private static int sourceText(KeyEvent e) {
        int meta = e.getMetaState();
        int text = e.getUnicodeChar(meta);
        if (text == 0 || Character.isISOControl(text)) {
            // Control/Command produce a control character; Alt and AltGr
            // stay, so a composed source character survives.
            text = e.getUnicodeChar(meta & ~(KeyEvent.META_CTRL_ON | KeyEvent.META_META_ON));
        }
        if (text == 0 || Character.isISOControl(text)) {
            text = e.getUnicodeChar(meta
                    & (KeyEvent.META_SHIFT_ON | KeyEvent.META_CAPS_LOCK_ON));
        }
        return text != 0 ? text : e.getUnicodeChar(0);
    }

    private void cancelNative(KeyEvent e) {
        View view = nativeDown.get(e.getKeyCode());
        if (view != null) {
            nativeDown.remove(e.getKeyCode());
            if (e.getAction() == KeyEvent.ACTION_DOWN) {
                nativeCancelled.put(e.getKeyCode(), view);
            }
            cancelNative(view, e);
        }
    }

    /** Clears a view's native pressed state with a canceled up: no click. */
    private static void cancelNative(View view, KeyEvent e) {
        if (view.getWindowToken() == null) return;
        KeyEvent up = new KeyEvent(e.getDownTime(), e.getEventTime(), KeyEvent.ACTION_UP,
                e.getKeyCode(), 0, e.getMetaState(), e.getDeviceId(), e.getScanCode(),
                e.getFlags() | KeyEvent.FLAG_CANCELED, e.getSource());
        view.dispatchKeyEvent(up);
    }
}
