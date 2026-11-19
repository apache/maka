package com.longbridge.nsh;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.annotation.SuppressLint;
import android.app.Dialog;
import android.content.Context;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;

/**
 * `<modal>`: content presented in its own dialog window over the app. The
 * core lays the content out at the size this window reports.
 */
final class ModalHost {
    final Mounter mounter;
    final int id;
    /** The modal's root view, placed by the core. */
    final Box root;
    private final Container container;
    /** This dialog window's shortcuts, raw keys, capture rules and Tab traversal. */
    private final KeyDispatch keys;
    private Dialog dialog;
    int animation; // 0 slide, 1 fade, 2 none
    /** `closeOnEscape`: the back button (Android's Escape) closes it here, then tells JS. */
    boolean closeOnEscape = true;
    /** The content reaches under the status bar (else it starts below). */
    private boolean translucent;
    private boolean closing;
    /**
     * Ends the presentation or dismissal through the shader that runs (or
     * waits for its layout to start) at once: the dialog settles where it
     * ends and its event goes out. Null while none does.
     */
    private Runnable ending;

    ModalHost(Context context, Mounter mounter, int id) {
        this.mounter = mounter;
        this.id = id;
        root = new Box(context, mounter, id);
        container = new Container(context);
        keys = new KeyDispatch(mounter, container, id);
        container.content.addView(root);
        mirror(mounter.rtl);
    }

    /** Lays the modal's widgets out right to left (or not). */
    void mirror(boolean rtl) {
        container.setLayoutDirection(rtl ? View.LAYOUT_DIRECTION_RTL : View.LAYOUT_DIRECTION_LTR);
    }

    void setStatusBarTranslucent(boolean on) {
        if (translucent == on) return;
        translucent = on;
        container.requestLayout();
    }

    /** A density change changes dp sizes even when the pixels stay put. */
    void densityChanged() {
        container.reported = null;
        // Report after the host has published its new environment, and
        // request layout even if Android keeps the dialog's pixel bounds.
        container.requestLayout();
        container.post(container::report);
    }

    TouchTracker touches() {
        return container.touches;
    }

    boolean shown() {
        return dialog != null && !closing;
    }

    /** The shown dialog's window (its decor view), or null. */
    View window() {
        Window window = dialogWindow();
        return window == null ? null : window.getDecorView();
    }

    /** The shown dialog's window, or null. */
    Window dialogWindow() {
        return shown() && dialog.isShowing() ? dialog.getWindow() : null;
    }

    /** Holds focus after an input blurs, so this window still receives hardware keys. */
    void focusRoot() {
        container.requestFocus();
    }

    /** Whether `v` is a dialog's root, which holds its window's focus while no node does ({@link #focusRoot}). */
    static boolean isRoot(View v) {
        return v instanceof Container;
    }

    void show() {
        if (dialog != null && !closing) return;
        // A dismissal through the shader still running ends first: its
        // window goes and `onDismiss` goes out before this one comes.
        finishChange();
        closing = false;
        Context context = mounter.context;
        dialog = new Dialog(context, android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        if (container.getParent() instanceof ViewGroup) ((ViewGroup) container.getParent()).removeView(container);
        dialog.setContentView(container);
        Window window = dialog.getWindow();
        if (window != null) {
            window.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
            window.setBackgroundDrawable(new ColorDrawable(0));
            window.setWindowAnimations(0);
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(0);
            window.setNavigationBarColor(0);
            // With three-button navigation the system lays a translucent scrim
            // over a transparent navigation bar (API 29+): a grey band across
            // the bottom of the app's popup, which reaches under the bar.
            if (Build.VERSION.SDK_INT >= 29) window.setNavigationBarContrastEnforced(false);
            if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(false);
            else window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        // No background of NSH's own: the app's popup (and backdrop) has its look.
        container.setBackgroundColor(0);
        dialog.setCancelable(false);
        dialog.setOnKeyListener((d, keyCode, event) -> {
            if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_UP) {
                backPressed();
                return true;
            }
            return keyCode == KeyEvent.KEYCODE_BACK;
        });
        if (Build.VERSION.SDK_INT >= 33) {
            dialog.getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                    android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::backPressed);
        }
        dialog.show();
        // The dialog's own root takes the fallback focus (its id is the modal's).
        if (!container.hasFocus()) container.requestFocus();
        container.post(() -> {
            if (closing || dialog == null) return;
            if (container.findFocus() == null) container.requestFocus();
        });
        matchSystemBars(window);
        Runnable animateIn = () -> {
            if (animation == 2) {
                mounter.event(id, Native.SHOW);
                return;
            }
            if (animation == 0) container.setTranslationY(container.getHeight());
            container.animate().alpha(1).translationY(0).setDuration(300)
                    .setInterpolator(new DecelerateInterpolator(1.5f))
                    .setListener(new AnimatorListenerAdapter() {
                        @Override
                        public void onAnimationEnd(Animator a) {
                            container.animate().setListener(null);
                            mounter.event(id, Native.SHOW);
                        }
                    }).start();
        };
        if (shaderIn(dialog, animateIn)) return;
        container.setAlpha(animation == 1 ? 0 : 1);
        container.post(animateIn);
    }

    /**
     * Whether the dialog comes and goes through its `transitionShader` (not
     * when the user asks for less motion: {@link NavTransition#wanted}).
     */
    private boolean throughShader() {
        return NavTransition.wanted(mounter, id);
    }

    /** Ends the change through the shader that runs (or waits to start) at once. */
    private void finishChange() {
        Runnable end = ending;
        ending = null;
        if (end != null) end.run();
    }

    /**
     * The dialog comes through its shader once laid out, from the app to the
     * app under it (`animateIn` where it cannot, or where no frame came back
     * by its end); false without one.
     */
    private boolean shaderIn(Dialog d, Runnable animateIn) {
        if (!throughShader()) return false;
        // Its first frame shows the dialog; until then the app shows alone.
        container.setAlpha(0);
        Runnable own = () -> {
            container.setAlpha(animation == 1 ? 0 : 1);
            container.post(animateIn);
        };
        Runnable presented = () -> {
            container.setAlpha(1);
            mounter.event(id, Native.SHOW);
        };
        android.view.ViewTreeObserver.OnPreDrawListener[] pending = new android.view.ViewTreeObserver.OnPreDrawListener[1];
        pending[0] = () -> {
            container.getViewTreeObserver().removeOnPreDrawListener(pending[0]);
            Window window = d.getWindow();
            if (ending == null || dialog != d || closing || window == null) return true;
            ending = null;
            NavTransition t = NavTransition.start(mounter, (ViewGroup) window.getDecorView(), id, id,
                    new View[] {mounter.host}, new View[] {mounter.host, container}, false, () -> {}, () -> {
                        ending = null;
                        presented.run();
                    }, () -> {
                        ending = null;
                        own.run();
                    });
            if (t == null) own.run();
            else ending = t::finish;
            return true;
        };
        // Dismissed before it started: it shows at once, then goes.
        ending = () -> {
            container.getViewTreeObserver().removeOnPreDrawListener(pending[0]);
            presented.run();
        };
        container.getViewTreeObserver().addOnPreDrawListener(pending[0]);
        return true;
    }

    /**
     * The status bar while the dialog is up: its window's, which the bar
     * follows over the activity's (`Command::StatusBar`; the topmost page's
     * or dialog's `statusBar`).
     */
    void statusBar(int style, boolean hidden, boolean night) {
        if (dialog != null && !closing) SystemUi.statusBar(dialog.getWindow(), style, hidden, night);
    }

    /** The dialog's bar icons as the activity's. */
    @SuppressWarnings("deprecation")
    private void matchSystemBars(Window window) {
        android.app.Activity activity = SystemUi.activity(mounter.context);
        if (window == null || activity == null) return;
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController from = activity.getWindow().getInsetsController();
            android.view.WindowInsetsController to = window.getInsetsController();
            if (from == null || to == null) return;
            int mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            to.setSystemBarsAppearance(from.getSystemBarsAppearance() & mask, mask);
        } else {
            int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            View decor = window.getDecorView();
            int own = activity.getWindow().getDecorView().getSystemUiVisibility() & mask;
            decor.setSystemUiVisibility(decor.getSystemUiVisibility() & ~mask | own);
        }
    }

    /**
     * The back button, Android's Escape. Answered from `closeOnEscape`, not
     * by asking JS: close here (reported as `RequestClose` with reason
     * `cancel`, then `Dismiss` when gone), or only report it (`open`
     * decides).
     */
    void backPressed() {
        if (closing) return;
        mounter.requestClose(id, "cancel");
        if (closeOnEscape) {
            dismiss();
            mounter.modalClosed(this);
        }
    }

    void dismiss() {
        if (dialog == null || closing) return;
        // A presentation through the shader still running ends first: the
        // dialog shows and `onShow` goes out before it goes.
        finishChange();
        closing = true;
        keys.focusLost();
        if (mounter.handle() != 0) Native.keyReset(mounter.handle());
        // Its keyboard hides with it, not once the dialog's window is gone.
        mounter.hideKeyboardIn(container);
        Dialog d = dialog;
        Runnable done = () -> {
            d.dismiss();
            if (dialog == d) dialog = null;
            closing = false;
            mounter.event(id, Native.DISMISS);
        };
        Window window = d.getWindow();
        NavTransition t = throughShader() && window != null
                ? NavTransition.start(mounter, (ViewGroup) window.getDecorView(), id, id,
                        new View[] {mounter.host}, new View[] {mounter.host, container}, true,
                        () -> container.setAlpha(0), () -> {
                            ending = null;
                            done.run();
                        }, () -> {
                            ending = null;
                            animateOut(done);
                        })
                : null;
        if (t != null) {
            ending = t::finish;
            return;
        }
        animateOut(done);
    }

    /** The dialog goes with its own animation, then `done`. */
    private void animateOut(Runnable done) {
        if (animation == 2) {
            done.run();
            return;
        }
        container.animate()
                .alpha(animation == 1 ? 0 : 1)
                .translationY(animation == 0 ? container.getHeight() : 0)
                .setDuration(250)
                .setListener(new AnimatorListenerAdapter() {
                    @Override
                    public void onAnimationEnd(Animator a) {
                        container.animate().setListener(null);
                        done.run();
                    }
                }).start();
    }

    /** Reports the window's size and insets: the content is laid out at them. */
    @SuppressLint("ViewConstructor")
    private final class Container extends ViewGroup {
        private int[] reported = {0, 0, 0, 0, 0, 0};

        private final TouchTracker touches;

        Container(Context context) {
            super(context);
            setFocusable(true);
            setFocusableInTouchMode(true);
            setDescendantFocusability(FOCUS_BEFORE_DESCENDANTS);
            if (Build.VERSION.SDK_INT >= 26) setDefaultFocusHighlightEnabled(false);
            touches = new TouchTracker(mounter, this);
            mounter.touchTrackers.add(touches);
            // The core places the root (`Box.place`) inside it.
            content = new ViewGroup(context) {
                @Override
                protected void onMeasure(int widthSpec, int heightSpec) {
                    setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec));
                    Box.Frame f = Box.frame(root);
                    root.measure(MeasureSpec.makeMeasureSpec(f.right - f.left, MeasureSpec.EXACTLY),
                            MeasureSpec.makeMeasureSpec(f.bottom - f.top, MeasureSpec.EXACTLY));
                }

                @Override
                protected void onLayout(boolean changed, int l, int t, int r, int b) {
                    Box.Frame f = Box.frame(root);
                    root.layout(f.left, f.top, f.right, f.bottom);
                }
            };
            addView(content);
        }

        @Override
        public boolean dispatchTouchEvent(android.view.MotionEvent e) {
            android.view.MotionEvent t = mounter.keyboardTap(e);
            boolean tracking = touches.onTouch(t);
            boolean handled = super.dispatchTouchEvent(t) || tracking;
            if (t != e) t.recycle();
            return handled;
        }

        @Override
        public boolean dispatchKeyEvent(KeyEvent e) {
            return keys.dispatchKeyEvent(e) || super.dispatchKeyEvent(e);
        }

        @Override
        public boolean dispatchKeyShortcutEvent(KeyEvent e) {
            return keys.dispatchKeyShortcutEvent(e) || super.dispatchKeyShortcutEvent(e);
        }

        @Override
        public void onWindowFocusChanged(boolean hasWindowFocus) {
            super.onWindowFocusChanged(hasWindowFocus);
            if (!hasWindowFocus) {
                keys.focusLost();
                if (mounter.handle() != 0) Native.keyReset(mounter.handle());
            } else if (findFocus() == null) {
                requestFocus();
            }
        }

        /**
         * A tap clears a focus not focusable in touch mode and leaves the
         * dialog's window without one; the first key after it leaves touch
         * mode, and this takes the focus back before `ViewRootImpl` would
         * pick a default one and consume the key ({@code NshView}'s
         * listener, for its window), so an arrow reaches {@link KeyDispatch}.
         */
        private final ViewTreeObserver.OnTouchModeChangeListener keyboardFocus = inTouchMode -> {
            if (!inTouchMode && hasWindowFocus() && getRootView().findFocus() == null) requestFocus();
        };

        @Override
        protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            getViewTreeObserver().addOnTouchModeChangeListener(keyboardFocus);
        }

        @Override
        protected void onDetachedFromWindow() {
            getViewTreeObserver().removeOnTouchModeChangeListener(keyboardFocus);
            super.onDetachedFromWindow();
        }

        /** Holds the root where the content starts (below the status bar unless translucent). */
        final ViewGroup content;

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            int w = MeasureSpec.getSize(widthSpec), h = MeasureSpec.getSize(heightSpec);
            setMeasuredDimension(w, h);
            content.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(Math.max(0, h - statusBar()), MeasureSpec.EXACTLY));
        }

        /** The status bar's height when the content starts below it. */
        private int statusBar() {
            if (translucent) return 0;
            WindowInsets insets = getRootWindowInsets();
            if (insets == null) return 0;
            return Build.VERSION.SDK_INT >= 30 ? insets.getInsets(WindowInsets.Type.statusBars()).top
                    : insets.getSystemWindowInsetTop();
        }

        @Override
        protected void onLayout(boolean changed, int l, int t, int r, int b) {
            content.layout(0, statusBar(), r - l, b - t);
            report();
        }

        private int keyboard;

        @Override
        public WindowInsets onApplyWindowInsets(WindowInsets insets) {
            int ime = keyboardHeight(insets);
            if (ime != keyboard) {
                keyboard = ime;
                int[] at = new int[2];
                getLocationOnScreen(at);
                mounter.keyboard(ime > 0 ? at[1] + getHeight() - ime : Integer.MAX_VALUE);
                // Shrink / grow the modal's layout area above the IME (see report).
                requestLayout();
            }
            report();
            return super.onApplyWindowInsets(insets);
        }

        /**
         * How far the software keyboard reaches into this dialog. Below
         * Android 11 it shares the bottom system inset with the navigation
         * bar (same split as {@link NshView}).
         */
        private int keyboardHeight(WindowInsets insets) {
            if (insets == null) return 0;
            if (Build.VERSION.SDK_INT >= 30) {
                return insets.getInsets(WindowInsets.Type.ime()).bottom;
            }
            int bottom = insets.getSystemWindowInsetBottom();
            int navigation = navigationBarHeight();
            return bottom > navigation ? bottom : 0;
        }

        private int navigationBarHeight() {
            int res = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
            return res == 0 ? 0 : getResources().getDimensionPixelSize(res);
        }

        private void report() {
            WindowInsets insets = getRootWindowInsets();
            int top = 0, right = 0, bottom = 0, left = 0;
            int ime = 0;
            if (insets != null) {
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    top = bars.top;
                    right = bars.right;
                    bottom = bars.bottom;
                    left = bars.left;
                    ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
                } else {
                    top = insets.getSystemWindowInsetTop();
                    right = insets.getSystemWindowInsetRight();
                    bottom = insets.getSystemWindowInsetBottom();
                    left = insets.getSystemWindowInsetLeft();
                    // Bottom inset taller than the nav bar is the keyboard: keep
                    // only the bar as a safe-area inset and shrink the height.
                    int navigation = navigationBarHeight();
                    if (bottom > navigation) {
                        ime = bottom;
                        bottom = navigation;
                    }
                }
            }
            int below = statusBar();
            top = Math.max(0, top - below);
            // Lay the dialog out above the IME so centered cards stay visible
            // (the activity's keyboard-inset env often stays 0 while a dialog
            // holds the soft keyboard).
            int[] now = {getWidth(), Math.max(0, getHeight() - below - ime), top, right, bottom, left};
            if (now[0] == 0 || java.util.Arrays.equals(now, reported)) return;
            reported = now;
            float d = mounter.density;
            mounter.rootSize(id, now[0] / d, now[1] / d, top / d, right / d, bottom / d, left / d);
        }
    }
}
