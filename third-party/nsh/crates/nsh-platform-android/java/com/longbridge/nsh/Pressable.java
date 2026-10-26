package com.longbridge.nsh;

import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewParent;
import android.widget.HorizontalScrollView;
import android.widget.ScrollView;

/**
 * Press handling for leaf views (text, images): `onPressIn`, `onPressOut`,
 * `onLongPress` and `onPress` with React Native semantics (see `Box`).
 * Feedback only (`TouchTracker`), it shows the pressed style and ripple of
 * any node view that handles no press, and reports no event.
 */
final class Pressable {
    private final View view;
    private final Mounter mounter;
    private final int id;
    private final boolean feedbackOnly;
    /** The node presses go to: the view, or the pressable text span the touch is on. */
    private int node;
    /** Its listeners, for spans (which have no view). */
    private long nodeEvents;
    private boolean span;
    private float downX, downY;
    /** The touch, for the press events' payload. */
    private final Mounter.PressAt at = new Mounter.PressAt();
    private boolean tracking, pressedIn, longPressed;
    private final Runnable pressIn = this::pressIn;
    private final Runnable longPress = this::longPress;

    Pressable(View view, Mounter mounter, int id) {
        this(view, mounter, id, false);
    }

    /** A passive style/ripple observer, fed by the root's touch tracker. */
    Pressable(View view, Mounter mounter, int id, boolean feedbackOnly) {
        this.feedbackOnly = feedbackOnly;
        this.view = view;
        this.mounter = mounter;
        this.id = id;
    }

    /** The view itself takes presses. */
    boolean ownWanted() {
        return mounter.handlesPress(id);
    }

    private boolean wants(int kind) {
        if (feedbackOnly) return false;
        return span ? (nodeEvents & (1L << kind)) != 0 : mounter.wants(id, kind);
    }

    private void event(int kind) {
        if (wants(kind)) mounter.press(node, kind, view, at);
    }

    boolean onTouchEvent(MotionEvent e) {
        if (e.getActionMasked() == MotionEvent.ACTION_DOWN) {
            int link = !feedbackOnly && view instanceof TextBox ? ((TextBox) view).linkAt(e.getX(), e.getY()) : -1;
            span = link >= 0;
            if (span) {
                node = ((TextBox) view).linkNode(link);
                nodeEvents = ((TextBox) view).linkEvents(link);
            } else {
                if (!feedbackOnly && !ownWanted()) return false;
                node = id;
            }
        }
        if (!feedbackOnly) at.track(e);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = e.getX();
                downY = e.getY();
                tracking = true;
                pressedIn = false;
                longPressed = false;
                if (insideScrollView()) view.postDelayed(pressIn, ViewConfiguration.getTapTimeout());
                else pressIn();
                if (wants(Native.LONG_PRESS)) view.postDelayed(longPress, span ? ViewConfiguration.getLongPressTimeout() : mounter.longPressDelay(id));
                return true;
            case MotionEvent.ACTION_MOVE: {
                float slop = ViewConfiguration.get(view.getContext()).getScaledTouchSlop();
                float margin = 20 * mounter.density;
                boolean inside = e.getX() >= -margin && e.getY() >= -margin
                        && e.getX() <= view.getWidth() + margin && e.getY() <= view.getHeight() + margin;
                if (tracking && (!inside || (!pressedIn && Math.hypot(e.getX() - downX, e.getY() - downY) > slop * 4))) {
                    tracking = false;
                    pressOut();
                }
                return true;
            }
            case MotionEvent.ACTION_UP:
                if (tracking) {
                    if (!pressedIn) pressIn();
                    boolean press = !longPressed;
                    pressOut();
                    if (press) event(Native.PRESS);
                }
                tracking = false;
                return true;
            case MotionEvent.ACTION_CANCEL:
                tracking = false;
                pressOut();
                return true;
        }
        return true;
    }

    /** An accessibility click (TalkBack's double tap). */
    void click() {
        if (mounter.wants(id, Native.PRESS)) mounter.event(id, Native.PRESS);
    }

    private void pressIn() {
        if (pressedIn || !tracking) return;
        pressedIn = true;
        event(Native.PRESS_IN);
        if (!span) mounter.pressFeedback(view, id, true, downX, downY);
    }

    private void pressOut() {
        view.removeCallbacks(pressIn);
        view.removeCallbacks(longPress);
        if (!pressedIn) return;
        pressedIn = false;
        event(Native.PRESS_OUT);
        if (!span) mounter.pressFeedback(view, id, false, downX, downY);
    }

    private void longPress() {
        if (!tracking) return;
        if (!pressedIn) pressIn();
        longPressed = true;
        event(Native.LONG_PRESS);
    }

    private boolean insideScrollView() {
        for (ViewParent p = view.getParent(); p != null; p = p.getParent()) {
            if (p instanceof ScrollView || p instanceof HorizontalScrollView) return true;
        }
        return false;
    }
}
