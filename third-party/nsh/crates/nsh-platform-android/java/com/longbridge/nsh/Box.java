package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Path;
import android.graphics.Rect;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.HorizontalScrollView;
import android.widget.ScrollView;

/**
 * A container positioning its children at the frames the core computed
 * (no Android layout pass decides anything). Hosts `<view>`, list cells and
 * the root. Children may draw outside (shadows): clipping is explicit.
 *
 * Touch handling follows React Native: `onPressIn` when a finger lands
 * (after a short delay inside scroll views, which may take the touch for a
 * scroll), `onPressOut` when it lifts or leaves, `onLongPress`, `onPress`;
 * drags drive `pan` values; two fingers drive `pinch` / `rotation`.
 */
@SuppressLint("ViewConstructor")
class Box extends ViewGroup implements Node {
    final Mounter mounter;
    final int id;
    /** The events it listens to, kinds below 64 ({@link Mounter#wants} has all). */
    long events;
    final Decor decor = new Decor();
    boolean clip;
    /** 0 auto, 1 none, 2 box-none, 3 box-only. */
    int pointerEvents;
    /** Opacity factor while pressed, or NaN. */
    /** Pan axis lock: 0 free, 1 horizontal, 2 vertical. */
    int panAxis;
    boolean pinchable, rotatable;
    /**
     * The area descendants cover outside the bounds (px, own coordinates;
     * `MountItem::Overflow`), or null: touches there go to the children.
     */
    android.graphics.RectF overflow;
    /** The child taking the current gesture where ViewGroup would not deliver it (outside its bounds). */
    private View overflowTarget;
    /** Children go here while the box both clips and casts a shadow. */
    private Box content;
    private final Path clipPath = new Path();

    Box(Context context, Mounter mounter, int id) {
        super(context);
        this.mounter = mounter;
        this.id = id;
        setClipChildren(false);
        setClipToPadding(false);
        setBackground(decor);
        setWillNotDraw(false);
    }

    @Override
    public int nodeId() {
        return id;
    }

    /** Where children are added. */
    ViewGroup container() {
        return content != null ? content : this;
    }

    /** Frame of a child, in px, relative to its parent. Margin layout params,
     * so frame layouts (screens, modals) can host core-placed views. */
    static final class Frame extends ViewGroup.MarginLayoutParams {
        int left, top, right, bottom;

        Frame() {
            super(0, 0);
        }
    }

    static Frame frame(View v) {
        ViewGroup.LayoutParams p = v.getLayoutParams();
        if (p instanceof Frame) return (Frame) p;
        Frame f = new Frame();
        v.setLayoutParams(f);
        return f;
    }

    /** Places `v` at its frame right away (no layout pass). */
    static void place(View v) {
        Frame f = frame(v);
        int w = f.right - f.left, h = f.bottom - f.top;
        f.width = w;
        f.height = h;
        v.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY));
        v.layout(f.left, f.top, f.right, f.bottom);
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec));
        for (int i = 0; i < getChildCount(); i++) {
            View child = getChildAt(i);
            if (child == content) {
                child.measure(widthSpec, heightSpec);
                continue;
            }
            Frame f = frame(child);
            child.measure(MeasureSpec.makeMeasureSpec(f.right - f.left, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(f.bottom - f.top, MeasureSpec.EXACTLY));
        }
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
        for (int i = 0; i < getChildCount(); i++) {
            View child = getChildAt(i);
            if (child == content) {
                child.layout(0, 0, r - l, b - t);
                continue;
            }
            Frame f = frame(child);
            child.layout(f.left, f.top, f.right, f.bottom);
        }
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        invalidateOutline();
        decor.applyPivot(this);
        if (content != null) content.layout(0, 0, w, h);
    }

    /** Applies clipping after a style change. */
    void updateClip() {
        // Not `hasShadow()`: the background may arrive (or animate in) later.
        boolean split = clip && (decor.shadowColor >>> 24) != 0;
        if (split && content == null) {
            // Clipping this view would clip its shadow: children move into a
            // content box that clips instead.
            content = new Box(getContext(), mounter, id);
            content.setBackground(null);
            content.setClickable(false);
            while (getChildCount() > 0) {
                View child = getChildAt(0);
                removeViewAt(0);
                content.addView(child);
            }
            addView(content);
            content.layout(0, 0, getWidth(), getHeight());
        } else if (!split && content != null) {
            Box old = content;
            content = null;
            removeView(old);
            while (old.getChildCount() > 0) {
                View child = old.getChildAt(0);
                old.removeViewAt(0);
                addView(child);
            }
        }
        if (content != null) {
            System.arraycopy(decor.radii, 0, content.decor.radii, 0, 4);
            content.decor.continuous = decor.continuous;
            content.clip = true;
            content.decor.clip(content, true);
            decor.clip(this, false);
        } else {
            decor.clip(this, clip);
        }
        invalidate();
    }

    @Override
    protected void dispatchDraw(Canvas canvas) {
        if (decor.needsPathClip(clip) && content == null) {
            canvas.save();
            canvas.clipPath(decor.shape(new Rect(0, 0, getWidth(), getHeight()), 0, clipPath));
            super.dispatchDraw(canvas);
            canvas.restore();
        } else {
            super.dispatchDraw(canvas);
        }
    }

    // --- Touch routing: pointerEvents and hitSlop -----------------------------

    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        if (pointerEvents == 1) return false;
        int action = e.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            overflowTarget = null;
            // ViewGroup only delivers a touch to a child that contains it: a
            // touch on a descendant placed outside its parent (a dropdown
            // under its field) goes to the child whose area holds it, and
            // a touch outside this box (delivered so by its parent) only
            // to its children, never to the box itself.
            float x = e.getX(), y = e.getY();
            boolean outside = x < 0 || y < 0 || x >= getWidth() || y >= getHeight();
            if (outside || hasOverflowingChild()) {
                View target = pointerEvents == 3 ? null : overflowChild(x, y, outside);
                if (target != null && dispatchTo(target, e)) {
                    overflowTarget = target;
                    return true;
                }
                if (outside) return false;
            }
        } else if (overflowTarget != null) {
            boolean handled = dispatchTo(overflowTarget, e);
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) overflowTarget = null;
            return handled;
        }
        if (action == MotionEvent.ACTION_DOWN && mounter.hasHitSlop()) {
            View target = slopTarget(e.getX(), e.getY());
            if (target != null) {
                // A touch in a child's hit slop: move it inside the child, so
                // the regular dispatch delivers it (and the rest of the
                // gesture) there.
                MotionEvent inside = MotionEvent.obtain(e);
                float x = clamp(e.getX(), target.getLeft() + 1, target.getRight() - 1);
                float y = clamp(e.getY(), target.getTop() + 1, target.getBottom() - 1);
                inside.offsetLocation(x - e.getX(), y - e.getY());
                boolean handled = super.dispatchTouchEvent(inside);
                inside.recycle();
                return handled;
            }
        }
        return super.dispatchTouchEvent(e);
    }

    private boolean hasOverflowingChild() {
        ViewGroup group = container();
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (c instanceof Box && ((Box) c).overflow != null) return true;
        }
        return false;
    }

    /** ({@code x}, {@code y}) of this box in child {@code c}. */
    private float[] inChild(View c, float x, float y) {
        ViewGroup group = container();
        float[] pt = {x, y};
        if (group != this) {
            pt[0] -= group.getLeft();
            pt[1] -= group.getTop();
        }
        pt[0] += group.getScrollX() - c.getLeft();
        pt[1] += group.getScrollY() - c.getTop();
        android.graphics.Matrix m = c.getMatrix();
        if (!m.isIdentity()) {
            android.graphics.Matrix inverse = new android.graphics.Matrix();
            if (m.invert(inverse)) inverse.mapPoints(pt);
        }
        return pt;
    }

    /**
     * The topmost child to deliver a touch at ({@code x}, {@code y}) to
     * that ViewGroup would not: one whose overflow area holds it, or (with
     * {@code inBounds}) one that contains it. Null when a child above
     * contains the point (the regular dispatch delivers it).
     */
    private View overflowChild(float x, float y, boolean inBounds) {
        ViewGroup group = container();
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (c.getVisibility() != VISIBLE) continue;
            float[] pt = inChild(c, x, y);
            if (pt[0] >= 0 && pt[1] >= 0 && pt[0] < c.getWidth() && pt[1] < c.getHeight()) {
                return inBounds ? c : null;
            }
            if (c instanceof Box) {
                Box b = (Box) c;
                if (b.overflow != null && b.pointerEvents != 1 && b.pointerEvents != 3 && !b.clip
                        && b.overflow.contains(pt[0], pt[1])) return c;
            }
        }
        return null;
    }

    /** Delivers {@code e} (of this box) to child {@code c}, in its coordinates. */
    private boolean dispatchTo(View c, MotionEvent e) {
        ViewGroup group = container();
        MotionEvent local = MotionEvent.obtain(e);
        float dx = group.getScrollX() - c.getLeft(), dy = group.getScrollY() - c.getTop();
        if (group != this) {
            dx -= group.getLeft();
            dy -= group.getTop();
        }
        local.offsetLocation(dx, dy);
        android.graphics.Matrix m = c.getMatrix();
        if (!m.isIdentity()) {
            android.graphics.Matrix inverse = new android.graphics.Matrix();
            if (m.invert(inverse)) local.transform(inverse);
        }
        boolean handled = c.dispatchTouchEvent(local);
        local.recycle();
        return handled;
    }

    private static float clamp(float v, float min, float max) {
        return Math.max(min, Math.min(max, v));
    }

    /** The child whose hit slop (but no child's bounds) contains the point. */
    private View slopTarget(float x, float y) {
        ViewGroup group = container();
        float ox = group == this ? 0 : group.getLeft(), oy = group == this ? 0 : group.getTop();
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (c.getVisibility() == VISIBLE && contains(c, x - ox, y - oy, null)) return null;
        }
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (!(c instanceof Node) || c.getVisibility() != VISIBLE) continue;
            float[] slop = mounter.hitSlop(((Node) c).nodeId());
            if (slop != null && contains(c, x - ox, y - oy, slop)) return c;
        }
        return null;
    }

    private static boolean contains(View c, float x, float y, float[] slop) {
        float t = 0, r = 0, b = 0, l = 0;
        if (slop != null) {
            t = slop[0];
            r = slop[1];
            b = slop[2];
            l = slop[3];
        }
        float left = c.getLeft() + c.getTranslationX(), top = c.getTop() + c.getTranslationY();
        return x >= left - l && x < left + c.getWidth() + r && y >= top - t && y < top + c.getHeight() + b;
    }

    // --- Gestures ----------------------------------------------------------

    private float downRawX, downRawY;
    /** Where the press went down (for the ripple). */
    private float pressX, pressY;
    /** The touch, for the press events' payload. */
    private final Mounter.PressAt at = new Mounter.PressAt();
    private boolean panning, tracking, pressedIn, longPressed;
    private VelocityTracker velocity;
    private final Runnable longPress = this::onLongPress;
    private final Runnable pressIn = this::onPressIn;
    /** Two-finger gesture: start span / angle, last values for velocity. */
    private boolean transforming;
    private float startSpan, startAngle, lastScale, lastAngle;
    private long lastTime;
    private float scaleVelocity, angleVelocity;

    private boolean wants(int kind) {
        return (events & (1L << kind)) != 0;
    }

    private boolean pressable() {
        return mounter.handlesPress(id);
    }

    private boolean pannable() {
        return wants(Native.PAN_START) || wants(Native.PAN_END) || mounter.hasPan(id);
    }

    private boolean twoFinger() {
        return pinchable || rotatable || wants(Native.PINCH_START) || wants(Native.PINCH_END)
                || wants(Native.ROTATION_START) || wants(Native.ROTATION_END);
    }

    private void onLongPress() {
        if (tracking && !panning) {
            if (!pressedIn) onPressIn();
            longPressed = true;
            mounter.press(id, Native.LONG_PRESS, this, at);
        }
    }

    private void onPressIn() {
        if (pressedIn || !tracking) return;
        pressedIn = true;
        if (wants(Native.PRESS_IN)) mounter.press(id, Native.PRESS_IN, this, at);
        mounter.pressFeedback(this, id, true, pressX, pressY);
    }

    private void pressOut() {
        removeCallbacks(pressIn);
        removeCallbacks(longPress);
        if (!pressedIn) return;
        pressedIn = false;
        if (wants(Native.PRESS_OUT)) mounter.press(id, Native.PRESS_OUT, this, at);
        mounter.pressFeedback(this, id, false, pressX, pressY);
    }

    /** Whether a scroll view may still take this touch for a scroll. */
    private boolean insideScrollView() {
        for (ViewParent p = getParent(); p != null; p = p.getParent()) {
            if (p instanceof ScrollView || p instanceof HorizontalScrollView) return true;
        }
        return false;
    }

    private void track(MotionEvent e) {
        if (velocity == null) return;
        MotionEvent screen = MotionEvent.obtain(e);
        screen.setLocation(e.getRawX(), e.getRawY());
        velocity.addMovement(screen);
        screen.recycle();
    }

    /** Whether a movement of (dx, dy) starts this view's pan. */
    private boolean panStarts(float dx, float dy, float slop) {
        if (Math.hypot(dx, dy) <= slop) return false;
        if (panAxis == 1) return Math.abs(dx) > Math.abs(dy);
        if (panAxis == 2) return Math.abs(dy) > Math.abs(dx);
        return true;
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent e) {
        if (pointerEvents == 3) return true;
        int action = e.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            downRawX = e.getRawX();
            downRawY = e.getRawY();
        }
        if (action == MotionEvent.ACTION_POINTER_DOWN && twoFinger() && e.getPointerCount() == 2) {
            // A second finger: take over from the child for pinch / rotation.
            tracking = false;
            return true;
        }
        // Take over a drag that starts on a child (e.g. the card's label).
        if (pannable() && action == MotionEvent.ACTION_MOVE && !panning) {
            float slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
            float dx = e.getRawX() - downRawX, dy = e.getRawY() - downRawY;
            if (panStarts(dx, dy, slop)) {
                // The DOWN went to the child: the pan starts with this move
                // (which onTouchEvent never sees), so a quick flick still
                // pans and ends.
                tracking = false;
                if (velocity != null) velocity.recycle();
                velocity = VelocityTracker.obtain();
                track(e);
                panning = true;
                getParent().requestDisallowInterceptTouchEvent(true);
                float density = mounter.density;
                mounter.pan(id, 0, dx / density, dy / density, 0, 0);
                return true;
            }
        }
        return false;
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (pointerEvents == 2) return false;
        boolean pressable = pressable(), pannable = pannable(), twoFinger = twoFinger();
        if (!pressable && !pannable && !twoFinger) return false;
        float density = mounter.density;
        if (pressable) at.track(e);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downRawX = e.getRawX();
                downRawY = e.getRawY();
                tracking = true;
                pressedIn = false;
                longPressed = false;
                panning = false;
                transforming = false;
                if (velocity != null) velocity.recycle();
                velocity = VelocityTracker.obtain();
                track(e);
                pressX = e.getX();
                pressY = e.getY();
                if (pressable) {
                    if (insideScrollView()) postDelayed(pressIn, ViewConfiguration.getTapTimeout());
                    else onPressIn();
                    if (wants(Native.LONG_PRESS)) postDelayed(longPress, mounter.longPressDelay(id));
                }
                return true;
            case MotionEvent.ACTION_POINTER_DOWN:
                if (twoFinger && e.getPointerCount() == 2) {
                    tracking = false;
                    pressOut();
                    startTransform(e);
                }
                return true;
            case MotionEvent.ACTION_MOVE: {
                track(e);
                if (transforming && e.getPointerCount() >= 2) {
                    moveTransform(e, 1);
                    return true;
                }
                float dx = e.getRawX() - downRawX, dy = e.getRawY() - downRawY;
                float slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
                if (!panning && pannable && panStarts(dx, dy, slop)) {
                    panning = true;
                    tracking = false;
                    pressOut();
                    getParent().requestDisallowInterceptTouchEvent(true);
                    mounter.pan(id, 0, dx / density, dy / density, 0, 0);
                } else if (panning) {
                    mounter.pan(id, 1, dx / density, dy / density, 0, 0);
                } else if (tracking && !inside(e)) {
                    tracking = false;
                    pressOut();
                }
                return true;
            }
            case MotionEvent.ACTION_POINTER_UP:
                if (transforming && e.getPointerCount() == 2) endTransform(2);
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                boolean up = e.getActionMasked() == MotionEvent.ACTION_UP;
                if (transforming) endTransform(up ? 2 : 3);
                if (panning) {
                    track(e);
                    velocity.computeCurrentVelocity(1000);
                    float dx = e.getRawX() - downRawX, dy = e.getRawY() - downRawY;
                    // Velocity in the parent's space, like the translation.
                    mounter.pan(id, up ? 2 : 3, dx / density, dy / density,
                            velocity.getXVelocity() / density, velocity.getYVelocity() / density);
                } else if (up && tracking) {
                    if (!pressedIn) onPressIn();
                    boolean press = !longPressed && wants(Native.PRESS);
                    pressOut();
                    if (press) mounter.press(id, Native.PRESS, this, at);
                }
                pressOut();
                panning = false;
                tracking = false;
                if (velocity != null) {
                    velocity.recycle();
                    velocity = null;
                }
                return true;
            }
        }
        return true;
    }

    /** Whether the finger is still over the view (with a margin). */
    private boolean inside(MotionEvent e) {
        float margin = 20 * mounter.density;
        return e.getX() >= -margin && e.getY() >= -margin
                && e.getX() <= getWidth() + margin && e.getY() <= getHeight() + margin;
    }

    private static float span(MotionEvent e) {
        return (float) Math.hypot(e.getX(1) - e.getX(0), e.getY(1) - e.getY(0));
    }

    private static float angle(MotionEvent e) {
        return (float) Math.toDegrees(Math.atan2(e.getY(1) - e.getY(0), e.getX(1) - e.getX(0)));
    }

    private void startTransform(MotionEvent e) {
        transforming = true;
        startSpan = Math.max(1, span(e));
        startAngle = angle(e);
        lastScale = 1;
        lastAngle = 0;
        lastTime = e.getEventTime();
        scaleVelocity = angleVelocity = 0;
        getParent().requestDisallowInterceptTouchEvent(true);
        if (pinchable || wants(Native.PINCH_START)) mounter.transformGesture(id, false, 0, 1, 0);
        if (rotatable || wants(Native.ROTATION_START)) mounter.transformGesture(id, true, 0, 0, 0);
    }

    private void moveTransform(MotionEvent e, int state) {
        float scale = span(e) / startSpan;
        float angle = angle(e) - startAngle;
        if (angle > 180) angle -= 360;
        if (angle < -180) angle += 360;
        float dt = Math.max(1, e.getEventTime() - lastTime) / 1000f;
        scaleVelocity = (scale - lastScale) / dt;
        angleVelocity = (angle - lastAngle) / dt;
        lastScale = scale;
        lastAngle = angle;
        lastTime = e.getEventTime();
        if (pinchable || wants(Native.PINCH_END)) mounter.transformGesture(id, false, state, scale, scaleVelocity);
        if (rotatable || wants(Native.ROTATION_END)) mounter.transformGesture(id, true, state, angle, angleVelocity);
    }

    private void endTransform(int state) {
        if (!transforming) return;
        transforming = false;
        if (pinchable || wants(Native.PINCH_END)) mounter.transformGesture(id, false, state, lastScale, scaleVelocity);
        if (rotatable || wants(Native.ROTATION_END)) mounter.transformGesture(id, true, state, lastAngle, angleVelocity);
    }

    /** TalkBack's double tap (and `performClick`) presses the view. */
    @Override
    public boolean performClick() {
        super.performClick();
        if (wants(Native.PRESS)) mounter.event(id, Native.PRESS);
        return true;
    }
}
