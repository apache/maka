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
    private Dialog dialog;
    int animation; // 0 slide, 1 fade, 2 none
    /** `closeOnEscape`: the back button (Android's Escape) closes it here, then tells JS. */
    boolean closeOnEscape = true;
    /** The content reaches under the status bar (else it starts below). */
    private boolean translucent;
    private boolean closing;
    private Runnable pendingShow;

    ModalHost(Context context, Mounter mounter, int id) {
        this.mounter = mounter;
        this.id = id;
        root = new Box(context, mounter, id);
        mounter.observeFocus(root);
        container = new Container(context);
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

    void show() {
        if (dialog != null && !closing) {
            dialog.show();
            return;
        }
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
        matchSystemBars(window);
        container.setAlpha(animation == 1 ? 0 : 1);
        pendingShow = () -> {
            pendingShow = null;
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
        container.post(pendingShow);
    }

    /** Retire this root without leaving its window eligible for input. */
    void park() {
        if (pendingShow != null) container.removeCallbacks(pendingShow);
        pendingShow = null;
        container.animate().setListener(null);
        container.animate().cancel();
        closing = false;
        container.setAlpha(1);
        container.setTranslationY(0);
        if (dialog != null) dialog.hide();
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
            int mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
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
        closing = true;
        Dialog d = dialog;
        Runnable done = () -> {
            d.dismiss();
            if (dialog == d) dialog = null;
            closing = false;
            mounter.event(id, Native.DISMISS);
        };
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
        public void onWindowFocusChanged(boolean focused) {
            super.onWindowFocusChanged(focused);
            mounter.publishFocusPath();
        }

        @Override
        public boolean dispatchTouchEvent(android.view.MotionEvent e) {
            boolean tracking = touches.onTouch(e);
            return super.dispatchTouchEvent(e) || tracking;
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
            report();
            if (Build.VERSION.SDK_INT >= 30) {
                int ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
                if (ime != keyboard) {
                    keyboard = ime;
                    int[] at = new int[2];
                    getLocationOnScreen(at);
                    mounter.keyboard(ime > 0 ? at[1] + getHeight() - ime : Integer.MAX_VALUE);
                }
            }
            return super.onApplyWindowInsets(insets);
        }

        private void report() {
            WindowInsets insets = getRootWindowInsets();
            int top = 0, right = 0, bottom = 0, left = 0;
            if (insets != null) {
                if (Build.VERSION.SDK_INT >= 30) {
                    android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                    top = bars.top;
                    right = bars.right;
                    bottom = bars.bottom;
                    left = bars.left;
                } else {
                    top = insets.getSystemWindowInsetTop();
                    right = insets.getSystemWindowInsetRight();
                    bottom = insets.getSystemWindowInsetBottom();
                    left = insets.getSystemWindowInsetLeft();
                }
            }
            int below = statusBar();
            top = Math.max(0, top - below);
            int[] now = {getWidth(), getHeight() - below, top, right, bottom, left};
            if (now[0] == 0 || java.util.Arrays.equals(now, reported)) return;
            reported = now;
            float d = mounter.density;
            mounter.rootSize(id, now[0] / d, now[1] / d, top / d, right / d, bottom / d, left / d);
        }
    }
}
