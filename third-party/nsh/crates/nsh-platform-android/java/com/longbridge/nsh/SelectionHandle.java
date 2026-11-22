package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.graphics.Canvas;
import android.view.View;

/**
 * A selection handle: the theme's drawable in a popup window over the app
 * (like TextView's, so it is not clipped and takes its own touches),
 * hanging from the line's bottom at one end of a selection. A selectable
 * text's own selection ({@link TextBox}) and a selectable view's
 * ({@link SelectableView}) both use it; its owner moves the selection.
 */
@SuppressLint("ViewConstructor")
final class SelectionHandle extends View {
    /** What a handle's drags do. */
    interface Owner {
        /** A finger went down on a handle. */
        void handleDown();

        /** The handle was dragged: it marks the window point ({@code x}, {@code y}). */
        void handleMoved(boolean start, float x, float y);

        /** The finger went up. */
        void handleUp();
    }

    final boolean start;
    private final View anchor;
    private final Owner owner;
    private final android.graphics.drawable.Drawable drawable;
    private final android.widget.PopupWindow popup;
    /** The hotspot's x in the drawable: where it points. */
    private final int hotspot;
    private float touchDx, touchDy;
    private int x, y;

    /** A handle shown over {@code anchor}'s window, tinted {@code color} (null: the theme's). */
    SelectionHandle(View anchor, boolean start, Integer color, Owner owner) {
        super(anchor.getContext());
        this.anchor = anchor;
        this.start = start;
        this.owner = owner;
        android.content.res.TypedArray a = getContext().obtainStyledAttributes(new int[] {
            start ? android.R.attr.textSelectHandleLeft : android.R.attr.textSelectHandleRight
        });
        android.graphics.drawable.Drawable d = a.getDrawable(0);
        a.recycle();
        if (d == null) d = new android.graphics.drawable.ColorDrawable(0xff3b82f6);
        drawable = d.mutate();
        int w = Math.max(1, drawable.getIntrinsicWidth()), h = Math.max(1, drawable.getIntrinsicHeight());
        drawable.setBounds(0, 0, w, h);
        hotspot = start ? w * 3 / 4 : w / 4;
        tint(color);
        popup = new android.widget.PopupWindow(this, w, h, false);
        popup.setClippingEnabled(false);
        popup.setSplitTouchEnabled(true);
        popup.setBackgroundDrawable(null);
        popup.setWindowLayoutType(android.view.WindowManager.LayoutParams.TYPE_APPLICATION_SUB_PANEL);
    }

    void tint(Integer color) {
        if (color != null) drawable.setTint(color);
        else drawable.setTintList(null);
        invalidate();
    }

    /** Points the handle at the window point ({@code px}, {@code py}). */
    void place(float px, float py) {
        int nx = Math.round(px) - hotspot, ny = Math.round(py);
        if (popup.isShowing()) {
            if (nx != x || ny != y) popup.update(nx, ny, -1, -1);
        } else {
            popup.showAtLocation(anchor, android.view.Gravity.NO_GRAVITY, nx, ny);
        }
        x = nx;
        y = ny;
    }

    void dismiss() {
        if (popup.isShowing()) popup.dismiss();
    }

    boolean contains(float rawX, float rawY) {
        if (!popup.isShowing()) return false;
        int[] at = new int[2];
        getLocationOnScreen(at);
        return rawX >= at[0] && rawX < at[0] + getWidth() && rawY >= at[1] && rawY < at[1] + getHeight();
    }

    /** Screen minus window coordinates of {@code view} (raw touch points are the screen's). */
    static int[] windowOffset(View view) {
        int[] screen = new int[2], window = new int[2];
        view.getLocationOnScreen(screen);
        view.getLocationInWindow(window);
        return new int[] {screen[0] - window[0], screen[1] - window[1]};
    }

    @Override
    protected void onDraw(Canvas canvas) {
        drawable.draw(canvas);
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override
    public boolean onTouchEvent(android.view.MotionEvent e) {
        switch (e.getActionMasked()) {
            case android.view.MotionEvent.ACTION_DOWN: {
                // The finger's distance from the point the handle marks
                // (window coordinates, as the popup's).
                int[] offset = windowOffset(anchor);
                touchDx = x + hotspot - (e.getRawX() - offset[0]);
                touchDy = y - (e.getRawY() - offset[1]);
                owner.handleDown();
                return true;
            }
            case android.view.MotionEvent.ACTION_MOVE: {
                int[] offset = windowOffset(anchor);
                owner.handleMoved(start, e.getRawX() - offset[0] + touchDx, e.getRawY() - offset[1] + touchDy);
                return true;
            }
            case android.view.MotionEvent.ACTION_UP:
            case android.view.MotionEvent.ACTION_CANCEL:
                owner.handleUp();
                return true;
            default:
                return true;
        }
    }
}
