package com.longbridge.nsh;

import android.animation.ValueAnimator;
import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.inputmethod.InputMethodManager;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.OverScroller;
import android.widget.ProgressBar;
import android.widget.ScrollView;

/**
 * `<scroll>` and lists: a platform ScrollView (native fling and overscroll
 * effect) whose content box is sized by the core, plus pull to refresh,
 * paging and snapping, drag / momentum events and
 * `keyboardShouldPersistTaps`.
 */
@SuppressLint("ViewConstructor")
final class ScrollBox extends FrameLayout implements Node {
    final Mounter mounter;
    final int id;
    final Decor decor = new Decor();
    /** The events it listens to, kinds below 64 ({@link Mounter#wants} has all). */
    long events;
    boolean horizontal;
    int dismissMode; // 0 none, 1 on drag, 2 interactive
    private FrameLayout scroller;
    final Content content;
    private final ProgressBar spinner;
    private boolean refreshing;
    /** Content offset while pulling or refreshing (px). */
    private float pull;
    private boolean pulling;
    private float startY;
    private boolean touching;
    private final Runnable settled = this::settled;

    // `ScrollBehavior`; offsets and lengths in dp.
    private boolean paging, enabled = true, bounces = true, oneStep;
    /** A JS responder inside keeps the touches (`onResponderGrant` returned true). */
    boolean jsBlocked;
    /** The pan of a view inside activated (`panActivation`): it keeps the touches. */
    boolean gateBlocked;
    private float snapInterval, deceleration;
    private float[] snapOffsets = new float[0];
    private int snapAlignment; // 0 start, 1 center, 2 end
    private int keyboardTaps; // 0 never, 1 always, 2 handled
    /** `contentInset` (px) and the room kept for the keyboard below it. */
    private int insetTop, insetRight, insetBottom, insetLeft, keyboardPadding;

    // The current gesture.
    /** The user dragged the content. */
    private boolean dragging;
    /** The scroll view flung (or snapped) after the drag: gliding. */
    private boolean flung, momentum;
    /** This touch only dismisses the keyboard (`keyboardShouldPersistTaps`); -1: it does not. */
    private int tapMode = -1;
    private boolean swallowing;
    /**
     * Frames the platform scroll view drew. It draws again each frame while
     * its overscroll effect (Android 12's stretch) relaxes, which moves no
     * view: the test agent counts the frames as movement
     * ({@link TestAgent#animating}), since a touch caught then only stops
     * the stretch, and presses nothing.
     */
    int frames;

    /** The scrolled content, sized by the core (`ScrollContent`). */
    static final class Content extends Box {
        int contentWidth, contentHeight;

        Content(Context context, Mounter mounter, int id) {
            super(context, mounter, id);
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            int w = Math.max(contentWidth, MeasureSpec.getSize(widthSpec));
            int h = Math.max(contentHeight, MeasureSpec.getSize(heightSpec));
            super.onMeasure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY));
        }
    }

    ScrollBox(Context context, Mounter mounter, int id) {
        super(context);
        this.mounter = mounter;
        this.id = id;
        setBackground(decor);
        content = new Content(context, mounter, id);
        spinner = new ProgressBar(context);
        spinner.setIndeterminate(true);
        spinner.setVisibility(GONE);
        int size = Math.round(28 * mounter.density);
        addView(spinner, new LayoutParams(size, size, android.view.Gravity.CENTER_HORIZONTAL | android.view.Gravity.TOP));
        content.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> payOwed());
        build();
    }

    @Override
    public int nodeId() {
        return id;
    }

    private void build() {
        if (scroller != null) {
            scroller.removeView(content);
            removeView(scroller);
            if (scroller instanceof ZScroll) {
                content.setScaleX(1);
                content.setScaleY(1);
                content.setTranslationX(0);
                content.setTranslationY(0);
                mounter.zoom(id, 1);
            }
        }
        scroller = zooms ? new ZScroll(getContext()) : horizontal ? new HScroll(getContext()) : new VScroll(getContext());
        scroller.setOverScrollMode(bounces ? OVER_SCROLL_IF_CONTENT_SCROLLS : OVER_SCROLL_NEVER);
        scroller.setPadding(insetLeft, insetTop, insetRight, insetBottom + keyboardPadding);
        scroller.setClipToPadding(false);
        // A scroll view inside another one scrolls first, then hands the
        // rest to its parent (else the parent takes every drag along its axis).
        scroller.setNestedScrollingEnabled(true);
        scroller.setVerticalScrollBarEnabled(!horizontal);
        scroller.setHorizontalScrollBarEnabled(horizontal);
        scroller.addView(content, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        // The view or its content changed size: scroll what was clamped.
        scroller.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> payOwed());
        scroller.setOnScrollChangeListener((v, x, y, ox, oy) -> {
            if (stickyCells.length > 0) pinSticky();
            if (touching && !dragging && !swallowing) {
                dragging = true;
                // The scroll view takes the touches from JS responders.
                mounter.cancelTouches();
                // Caught while gliding: the glide ended.
                if (momentum) emit(Native.MOMENTUM_END);
                momentum = false;
                emit(Native.SCROLL_DRAG_START);
            } else if (swallowing) {
                dragging = true;
            }
            float d = mounter.density;
            mounter.scroll(id, x / d, y / d, applied);
            removeCallbacks(settled);
            postDelayed(settled, 120);
        });
        addView(scroller, 0, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    }

    void configure(boolean horizontal, boolean indicator, int dismissMode) {
        if (horizontal != this.horizontal) {
            this.horizontal = horizontal;
            build();
        }
        scroller.setVerticalScrollBarEnabled(indicator && !horizontal);
        scroller.setHorizontalScrollBarEnabled(indicator && horizontal);
        this.dismissMode = dismissMode;
    }

    void setContentSize(int width, int height) {
        content.contentWidth = width;
        content.contentHeight = height;
        if (scroller instanceof ZScroll) {
            // Exactly the core's size: the zoom scales it.
            ((ZScroll) scroller).placeContent();
            return;
        }
        // Sized right away: scrolling in the same batch (anchoring, a
        // jump to an item) is clamped to the content's current size.
        int w = Math.max(width, scroller.getWidth()), h = Math.max(height, scroller.getHeight());
        content.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY));
        content.layout(0, 0, w, h);
        content.requestLayout();
    }

    /** Sticky cells: node ids and their travel (px), from `StickyCells`. */
    private int[] stickyCells = new int[0];
    private float[] stickyStart = new float[0], stickyEnd = new float[0];

    void setSticky(int[] cells, float[] start, float[] end) {
        for (int old : stickyCells) {
            boolean kept = false;
            for (int c : cells) kept |= c == old;
            View v = mounter.view(old);
            if (!kept && v != null) {
                if (horizontal) v.setTranslationX(0); else v.setTranslationY(0);
            }
            if (!kept && mounter.stickyHosts.get(old) == this) mounter.stickyHosts.remove(old);
            mounter.forgetStickyOffset(old);
        }
        // A cell may be in a list in this scroll view's viewport: its
        // animated offset finds this scroll view. Its offset is forgotten:
        // the outputs after the batch bring back the ones still animated,
        // so a cell whose offset became a number no longer adds the old one.
        for (int c : cells) {
            mounter.stickyHosts.put(c, this);
            mounter.forgetStickyOffset(c);
        }
        stickyCells = cells;
        stickyStart = start;
        stickyEnd = end;
        frontSticky();
        pinSticky();
    }

    /** Keeps sticky cells above the others (also after new cells arrive). */
    void frontSticky() {
        for (int c : stickyCells) {
            View v = mounter.view(c);
            if (v != null && v.getParent() == content && content.indexOfChild(v) != content.getChildCount() - 1) {
                v.bringToFront();
            }
        }
    }

    boolean hasSticky() {
        return stickyCells.length > 0;
    }

    /** Moves the sticky cells with the scroll offset (and their animated offsets). */
    void pinSticky() {
        float offset = horizontal ? scroller.getScrollX() : scroller.getScrollY();
        for (int i = 0; i < stickyCells.length; i++) {
            View v = mounter.view(stickyCells[i]);
            if (v == null) continue;
            float extra = mounter.stickyOffset(stickyCells[i]);
            float t = Math.max(0, Math.min(offset + extra - stickyStart[i], stickyEnd[i] - stickyStart[i]));
            if (horizontal) v.setTranslationX(t); else v.setTranslationY(t);
        }
    }

    /** Room below the content (keyboard avoidance), under `contentInset`. */
    void setContentPaddingBottom(int px) {
        keyboardPadding = px;
        scroller.setPadding(insetLeft, insetTop, insetRight, insetBottom + keyboardPadding);
    }

    /** `ScrollBehavior` (lengths in dp). */
    void setBehavior(boolean paging, float snapInterval, float[] snapOffsets, int snapAlignment, float deceleration,
            boolean enabled, boolean bounces, float top, float right, float bottom, float left, int keyboardTaps,
            boolean oneStep) {
        this.paging = paging;
        this.snapInterval = snapInterval;
        this.snapOffsets = snapOffsets;
        this.snapAlignment = snapAlignment;
        this.deceleration = deceleration;
        this.enabled = enabled;
        this.bounces = bounces;
        this.keyboardTaps = keyboardTaps;
        this.oneStep = oneStep;
        float d = mounter.density;
        insetTop = Math.round(top * d);
        insetRight = Math.round(right * d);
        insetBottom = Math.round(bottom * d);
        insetLeft = Math.round(left * d);
        scroller.setOverScrollMode(bounces ? OVER_SCROLL_IF_CONTENT_SCROLLS : OVER_SCROLL_NEVER);
        scroller.setPadding(insetLeft, insetTop, insetRight, insetBottom + keyboardPadding);
    }

    // --- Paging and snapping ---------------------------------------------

    private boolean snaps() {
        return paging || snapInterval > 0 || snapOffsets.length > 0;
    }

    /** The scroll view's own fling (px/s): snaps instead when snapping. */
    private boolean fling(int velocity) {
        flung = true;
        if (!snaps()) return false;
        snap(velocity);
        return true;
    }

    /** Glides to the snap point for a release at {@code velocity} (px/s). */
    private void snap(int velocity) {
        if (scroller instanceof ZScroll) return;
        float d = mounter.density;
        boolean h = horizontal;
        float offset = (h ? scroller.getScrollX() : scroller.getScrollY()) / d;
        float viewport = (h ? scroller.getWidth() : scroller.getHeight()) / d;
        float length = (h ? content.getWidth() + scroller.getPaddingLeft() + scroller.getPaddingRight()
                : content.getHeight() + scroller.getPaddingTop() + scroller.getPaddingBottom()) / d;
        float v = velocity / d / 1000f;
        // Where UIKit's deceleration would glide (velocity kept per ms).
        float rate = deceleration > 0 ? deceleration : (snapInterval > 0 || snapOffsets.length > 0) ? 0.99f : 0.998f;
        float projected = offset + v * rate / (1 - rate);
        float target = snapTarget(offset, projected, v, viewport, length);
        int px = Math.round(target * d);
        if (scroller instanceof ScrollView) ((ScrollView) scroller).smoothScrollTo(0, px);
        else ((HorizontalScrollView) scroller).smoothScrollTo(px, 0);
    }

    /** `ScrollBehavior::snap_target` (nsh-core), in dp. */
    private float snapTarget(float offset, float projected, float velocity, float viewport, float content) {
        float max = Math.max(0, content - viewport);
        float[] points;
        if (snapInterval > 0) {
            float shift = snapAlignment == 1 ? (viewport - snapInterval) / 2 : snapAlignment == 2 ? viewport - snapInterval : 0;
            int n = (int) Math.max(0, Math.ceil((max + shift) / snapInterval));
            points = new float[n + 1];
            for (int i = 0; i <= n; i++) points[i] = Math.max(0, Math.min(max, i * snapInterval - shift));
        } else if (snapOffsets.length > 0) {
            points = new float[snapOffsets.length];
            for (int i = 0; i < points.length; i++) points[i] = Math.max(0, Math.min(max, snapOffsets[i]));
        } else {
            float page = Math.max(1, viewport);
            int n = (int) Math.ceil(max / page);
            points = new float[n + 1];
            for (int i = 0; i <= n; i++) points[i] = Math.min(max, i * page);
        }
        final float slow = 0.3f; // dp per ms: slower releases settle at the nearest point
        boolean step = oneStep || (paging && snapInterval <= 0 && snapOffsets.length == 0);
        float from = step ? offset : projected;
        Float target = null;
        if (velocity > slow) {
            for (float p : points) {
                if (step ? p > from + 0.5f : p >= from - 0.5f) { target = p; break; }
            }
        } else if (velocity < -slow) {
            for (int i = points.length - 1; i >= 0; i--) {
                float p = points[i];
                if (step ? p < from - 0.5f : p <= from + 0.5f) { target = p; break; }
            }
        } else {
            for (float p : points) {
                if (target == null || Math.abs(p - from) < Math.abs(target - from)) target = p;
            }
        }
        return target != null ? target : velocity > 0 ? max : 0;
    }

    /** The platform scroll views, with `scrollable` and snapping. */
    private final class VScroll extends ScrollView {
        VScroll(Context context) {
            super(context);
        }

        @Override
        public boolean onInterceptTouchEvent(MotionEvent e) {
            return enabled && !jsBlocked && !gateBlocked && super.onInterceptTouchEvent(e);
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouchEvent(MotionEvent e) {
            if (!enabled || jsBlocked || gateBlocked) return false;
            boolean up = beforeTouch(e);
            boolean handled = super.onTouchEvent(e);
            if (up) released();
            return handled;
        }

        @Override
        public void fling(int velocity) {
            if (!ScrollBox.this.fling(velocity)) super.fling(velocity);
        }

        @Override
        public void draw(Canvas canvas) {
            super.draw(canvas);
            frames++;
        }
    }

    private final class HScroll extends HorizontalScrollView {
        HScroll(Context context) {
            super(context);
        }

        @Override
        public boolean onInterceptTouchEvent(MotionEvent e) {
            return enabled && !jsBlocked && !gateBlocked && super.onInterceptTouchEvent(e);
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouchEvent(MotionEvent e) {
            if (!enabled || jsBlocked || gateBlocked) return false;
            boolean up = beforeTouch(e);
            boolean handled = super.onTouchEvent(e);
            if (up) released();
            return handled;
        }

        @Override
        public void fling(int velocity) {
            if (!ScrollBox.this.fling(velocity)) super.fling(velocity);
        }

        @Override
        public void draw(Canvas canvas) {
            super.draw(canvas);
            frames++;
        }
    }

    /** Before the scroll view sees {@code e}: whether it ends the touch. */
    private boolean beforeTouch(MotionEvent e) {
        int action = e.getActionMasked();
        boolean up = action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL;
        if (up) flung = false;
        return up;
    }

    /** The finger lifted off the scroll view (after its fling, if any). */
    private void released() {
        if (!dragging) return;
        if (!flung && snaps()) {
            snap(0);
            flung = true;
        }
        emit(Native.SCROLL_DRAG_END);
        if (flung) {
            momentum = true;
            emit(Native.MOMENTUM_START);
        }
    }

    private void emit(int kind) {
        if (!mounter.wants(id, kind)) return;
        float d = mounter.density;
        mounter.event(id, kind, null, 0, scroller.getScrollX() / d, scroller.getScrollY() / d);
    }

    /**
     * Scrolls a descendant into the area above the bottom padding (the
     * keyboard). `requestRectangleOnScreen` cannot: ScrollView ignores its
     * padding when it decides whether a rectangle is visible.
     */
    /**
     * Scrolls {@code v} (and {@code margin} px around it) into view, over
     * {@code motion}: an animator from 0 to 1 the caller starts. False when
     * there is nothing to scroll (the animator is left alone).
     */
    boolean reveal(View v, int margin, ValueAnimator motion) {
        Rect r = new Rect(0, -margin, v.getWidth(), v.getHeight() + margin);
        scroller.offsetDescendantRectToMyCoords(v, r);
        int top = scroller.getScrollY();
        int bottom = top + scroller.getHeight() - scroller.getPaddingBottom();
        int dy = r.bottom > bottom ? Math.min(r.bottom - bottom, r.top - top) : Math.min(0, r.top - top);
        if (dy == 0) return false;
        if (!(scroller instanceof ScrollView)) {
            scroller.scrollBy(0, dy);
            return false;
        }
        int x = scroller.getScrollX();
        motion.addUpdateListener(a -> scroller.scrollTo(x, top + Math.round(dy * (float) a.getAnimatedValue())));
        return true;
    }

    /** Scrolls the core asked for that were applied (reported with offsets). */
    private int applied;

    /**
     * The part of the last {@code scrollByPx} that the scroll view clamped
     * (px): the view or its content is about to change size (e.g. while a
     * layout animation resizes it) and catches up when it does.
     */
    private int owedX, owedY;

    void scrollByPx(int dx, int dy) {
        applied++;
        int x = scroller.getScrollX() + dx + owedX, y = scroller.getScrollY() + dy + owedY;
        scroller.scrollTo(x, y);
        owedX = x - scroller.getScrollX();
        owedY = y - scroller.getScrollY();
    }

    /** Pays what clamping kept back, as far as the current size allows. */
    private void payOwed() {
        if (owedX == 0 && owedY == 0) return;
        int x = scroller.getScrollX() + owedX, y = scroller.getScrollY() + owedY;
        scroller.scrollTo(x, y);
        owedX = x - scroller.getScrollX();
        owedY = y - scroller.getScrollY();
    }

    void scrollToPx(int x, int y, boolean animated) {
        applied++;
        if (scroller instanceof ZScroll) {
            ((ZScroll) scroller).scrollToPx(x, y, animated);
        } else if (scroller instanceof ScrollView) {
            if (animated) ((ScrollView) scroller).smoothScrollTo(x, y);
            else scroller.scrollTo(x, y);
        } else {
            if (animated) ((HorizontalScrollView) scroller).smoothScrollTo(x, y);
            else scroller.scrollTo(x, y);
        }
    }

    /** A retirement must cancel this view's deferred input completion. */
    void cancelPendingScroll() {
        removeCallbacks(settled);
    }

    /** Scrolling came to rest (no API for it: no change for a moment). */
    private void settled() {
        if (touching) {
            postDelayed(settled, 120);
            return;
        }
        if (momentum) {
            momentum = false;
            emit(Native.MOMENTUM_END);
        }
        mounter.scrollEnded(id);
        float d = mounter.density;
        mounter.event(id, Native.SCROLL_END, null, 0, scroller.getScrollX() / d, scroller.getScrollY() / d);
    }

    // --- Zoom ------------------------------------------------------------

    /** `ScrollBehavior` zoom settings. */
    private boolean zooms, bouncesZoom = true, pinch = true, centerContent;
    private float minZoom = 1, maxZoom = 1;

    /** Pull to refresh: whether the spinner shows, where (dp) a pull refreshes and the room kept while refreshing. */
    private boolean refreshIndicator = true;
    private float refreshThreshold = 64, refreshInset = 56;

    /** `refreshIndicator`: the app draws its own, {@code height} dp tall, in place of the spinner. */
    void setRefresh(boolean own, float height) {
        float inset = own ? height : 56;
        boolean changed = refreshIndicator == own || inset != refreshInset;
        refreshIndicator = !own;
        refreshThreshold = own ? height : 64;
        refreshInset = inset;
        if (!changed) return;
        if (own) {
            spinner.setVisibility(GONE);
        } else if (refreshing) {
            spinner.setVisibility(VISIBLE);
            spinner.setAlpha(1);
        }
        // A refresh in progress keeps the room of the indicator now showing.
        if (refreshing && !pulling) animatePull(inset * mounter.density, null);
    }

    void setZoom(boolean zooms, float min, float max, boolean bouncesZoom, boolean pinch, boolean center) {
        minZoom = min;
        maxZoom = max;
        this.bouncesZoom = bouncesZoom;
        this.pinch = pinch;
        centerContent = center;
        if (zooms != this.zooms) {
            this.zooms = zooms;
            build();
        } else if (scroller instanceof ZScroll) {
            ZScroll z = (ZScroll) scroller;
            z.setScale(Math.max(minZoom, Math.min(maxZoom, z.scale)), z.getWidth() / 2f, z.getHeight() / 2f);
        }
    }

    /** `zoomTo` (content point in dp). */
    void zoomTo(float scale, boolean hasCenter, float x, float y, boolean animated) {
        if (!(scroller instanceof ZScroll)) return;
        float d = mounter.density;
        ((ZScroll) scroller).zoomTo(scale, hasCenter, x * d, y * d, animated);
    }

    /**
     * A zoomable scroll view (UIScrollView's zooming, which Android lacks):
     * the content is scaled around its top left corner and scrolled both
     * ways by this view's own scroll offset. Pinches zoom around their focal
     * point, drags (any number of fingers) pan and fling, and both bounce
     * past the limits when allowed.
     */
    private final class ZScroll extends FrameLayout {
        float scale = 1;
        /** The pinch's scale without the rubber band beyond the limits. */
        private float rawScale = 1;
        private final ScaleGestureDetector detector;
        private final OverScroller glide;
        private VelocityTracker velocity;
        private final int slop, minFling, maxFling;
        private float downX, downY, lastX, lastY;
        private boolean panning;
        private android.animation.ValueAnimator zoomAnimation;

        ZScroll(Context context) {
            super(context);
            ViewConfiguration c = ViewConfiguration.get(context);
            slop = c.getScaledTouchSlop();
            minFling = c.getScaledMinimumFlingVelocity();
            maxFling = c.getScaledMaximumFlingVelocity();
            glide = new OverScroller(context);
            detector = new ScaleGestureDetector(context, new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                @Override
                public boolean onScaleBegin(ScaleGestureDetector d) {
                    if (!pinch) return false;
                    stop();
                    rawScale = scale;
                    startPan();
                    return true;
                }

                @Override
                public boolean onScale(ScaleGestureDetector d) {
                    rawScale *= d.getScaleFactor();
                    setScale(rubber(rawScale), d.getFocusX(), d.getFocusY());
                    return true;
                }
            });
            detector.setQuickScaleEnabled(false);
        }

        /** Beyond the limits a pinch meets growing resistance (or none goes there). */
        private float rubber(float s) {
            if (s > maxZoom) return bouncesZoom ? maxZoom * (float) Math.pow(s / maxZoom, 0.35) : maxZoom;
            if (s < minZoom) return bouncesZoom ? minZoom * (float) Math.pow(s / minZoom, 0.35) : minZoom;
            return s;
        }

        private float contentWidth() {
            return content.contentWidth * scale;
        }

        private float contentHeight() {
            return content.contentHeight * scale;
        }

        /** `centerContent`: where content narrower than the viewport starts. */
        private float offsetX(float s) {
            float free = getWidth() - getPaddingLeft() - getPaddingRight() - content.contentWidth * s;
            return centerContent ? Math.max(0, free / 2) : 0;
        }

        private float offsetY(float s) {
            float free = getHeight() - getPaddingTop() - getPaddingBottom() - content.contentHeight * s;
            return centerContent ? Math.max(0, free / 2) : 0;
        }

        private int maxX() {
            return (int) Math.max(0, getPaddingLeft() + contentWidth() + getPaddingRight() - getWidth());
        }

        private int maxY() {
            return (int) Math.max(0, getPaddingTop() + contentHeight() + getPaddingBottom() - getHeight());
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec));
            measureContent();
        }

        private void measureContent() {
            content.measure(MeasureSpec.makeMeasureSpec(content.contentWidth, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(content.contentHeight, MeasureSpec.EXACTLY));
        }

        @Override
        protected void onLayout(boolean changed, int l, int t, int r, int b) {
            layoutContent();
        }

        private void layoutContent() {
            int x = getPaddingLeft(), y = getPaddingTop();
            content.layout(x, y, x + content.contentWidth, y + content.contentHeight);
            apply();
        }

        /** The core's content size changed. */
        void placeContent() {
            measureContent();
            layoutContent();
            scrollTo(clamp(getScrollX(), maxX()), clamp(getScrollY(), maxY()));
        }

        private void apply() {
            // Around the top left (a Box resets its pivot when resized).
            content.setPivotX(0);
            content.setPivotY(0);
            content.setScaleX(scale);
            content.setScaleY(scale);
            content.setTranslationX(offsetX(scale));
            content.setTranslationY(offsetY(scale));
        }

        /** Zooms to {@code s} keeping the content under ({@code fx}, {@code fy}) (view px) in place. */
        void setScale(float s, float fx, float fy) {
            float px = (getScrollX() + fx - getPaddingLeft() - offsetX(scale)) / scale;
            float py = (getScrollY() + fy - getPaddingTop() - offsetY(scale)) / scale;
            place(s, px, py, fx, fy);
        }

        /** Zooms to {@code s} with content point ({@code px}, {@code py}) (unzoomed px) at ({@code fx}, {@code fy}). */
        private void place(float s, float px, float py, float fx, float fy) {
            boolean changed = s != scale;
            scale = s;
            apply();
            int x = Math.round(px * s + getPaddingLeft() + offsetX(s) - fx);
            int y = Math.round(py * s + getPaddingTop() + offsetY(s) - fy);
            int sx = getScrollX(), sy = getScrollY();
            scrollTo(clamp(x, maxX()), clamp(y, maxY()));
            if (changed) {
                mounter.zoom(id, s);
                // The new scale goes out with an offset report.
                if (sx == getScrollX() && sy == getScrollY()) {
                    float d = mounter.density;
                    mounter.scroll(id, getScrollX() / d, getScrollY() / d, applied);
                }
            }
        }

        private int clamp(int v, int max) {
            return Math.max(0, Math.min(max, v));
        }

        void zoomTo(float target, boolean hasCenter, float x, float y, boolean animated) {
            stop();
            float to = Math.max(minZoom, Math.min(maxZoom, target));
            float w = getWidth() / 2f, h = getHeight() / 2f;
            float fromX = (getScrollX() + w - getPaddingLeft() - offsetX(scale)) / scale;
            float fromY = (getScrollY() + h - getPaddingTop() - offsetY(scale)) / scale;
            float toX = hasCenter ? x : fromX, toY = hasCenter ? y : fromY;
            if (!animated) {
                place(to, toX, toY, w, h);
                return;
            }
            float from = scale;
            zoomAnimation = android.animation.ValueAnimator.ofFloat(0, 1);
            zoomAnimation.setDuration(300);
            zoomAnimation.setInterpolator(new android.view.animation.DecelerateInterpolator(1.5f));
            zoomAnimation.addUpdateListener(a -> {
                float t = (float) a.getAnimatedValue();
                place(from + (to - from) * t, fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, w, h);
            });
            zoomAnimation.start();
        }

        void scrollToPx(int x, int y, boolean animated) {
            stop();
            int tx = clamp(x, maxX()), ty = clamp(y, maxY());
            if (animated) {
                glide.startScroll(getScrollX(), getScrollY(), tx - getScrollX(), ty - getScrollY(), 300);
                postInvalidateOnAnimation();
            } else {
                scrollTo(tx, ty);
            }
        }

        private void stop() {
            if (!glide.isFinished()) glide.forceFinished(true);
            if (zoomAnimation != null) {
                zoomAnimation.cancel();
                zoomAnimation = null;
            }
        }

        /** The focal point of the fingers down (without one lifting now). */
        private float focus(MotionEvent e, boolean x) {
            int skip = e.getActionMasked() == MotionEvent.ACTION_POINTER_UP ? e.getActionIndex() : -1;
            float sum = 0;
            int n = 0;
            for (int i = 0; i < e.getPointerCount(); i++) {
                if (i == skip) continue;
                sum += x ? e.getX(i) : e.getY(i);
                n++;
            }
            return n > 0 ? sum / n : 0;
        }

        private void startPan() {
            panning = true;
            getParent().requestDisallowInterceptTouchEvent(true);
        }

        /** Follows the fingers; true once this view took the gesture. */
        private boolean track(MotionEvent e) {
            if (velocity == null) velocity = VelocityTracker.obtain();
            velocity.addMovement(e);
            detector.onTouchEvent(e);
            float fx = focus(e, true), fy = focus(e, false);
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    // A touch catches a glide.
                    boolean gliding = !glide.isFinished();
                    stop();
                    panning = gliding;
                    downX = lastX = fx;
                    downY = lastY = fy;
                    break;
                case MotionEvent.ACTION_POINTER_DOWN:
                case MotionEvent.ACTION_POINTER_UP:
                    lastX = fx;
                    lastY = fy;
                    if (pinch && e.getPointerCount() > 1) startPan();
                    break;
                case MotionEvent.ACTION_MOVE: {
                    if (!panning) {
                        float dx = fx - downX, dy = fy - downY;
                        boolean along = (Math.abs(dx) > slop && (maxX() > 0 || bounces))
                                || (Math.abs(dy) > slop && (maxY() > 0 || bounces));
                        if (along && (maxX() > 0 || maxY() > 0 || scale != 1)) {
                            startPan();
                            lastX = fx;
                            lastY = fy;
                        }
                    }
                    if (panning) {
                        panBy(lastX - fx, lastY - fy);
                        lastX = fx;
                        lastY = fy;
                    }
                    break;
                }
                default:
                    break;
            }
            return panning;
        }

        /** Scrolls by a finger's move, resisting past the edges (or stopping there). */
        private void panBy(float dx, float dy) {
            int x = getScrollX(), y = getScrollY();
            scrollTo(x + Math.round(resist(x, dx, maxX())), y + Math.round(resist(y, dy, maxY())));
        }

        private float resist(int at, float d, int max) {
            float next = at + d;
            if (next >= 0 && next <= max) return d;
            if (!bounces) return Math.max(0, Math.min(max, next)) - at;
            return d / 2;
        }

        /** The fingers lifted: settle the zoom, then bounce back or glide. */
        private void release() {
            panning = false;
            float vx = 0, vy = 0;
            if (velocity != null) {
                velocity.computeCurrentVelocity(1000, maxFling);
                vx = velocity.getXVelocity();
                vy = velocity.getYVelocity();
                velocity.recycle();
                velocity = null;
            }
            if (scale > maxZoom || scale < minZoom) {
                zoomBack();
                return;
            }
            int x = getScrollX(), y = getScrollY(), mx = maxX(), my = maxY();
            if (x < 0 || y < 0 || x > mx || y > my) {
                glide.springBack(x, y, 0, mx, 0, my);
                postInvalidateOnAnimation();
            } else if (Math.hypot(vx, vy) > minFling) {
                int over = bounces ? Math.round(48 * mounter.density) : 0;
                glide.fling(x, y, Math.round(-vx), Math.round(-vy), 0, mx, 0, my, over, over);
                flung = true;
                postInvalidateOnAnimation();
            }
        }

        /** A pinch ended beyond the limits: back to the nearest one. */
        private void zoomBack() {
            float to = Math.max(minZoom, Math.min(maxZoom, scale));
            float from = scale, fx = lastX, fy = lastY;
            float px = (getScrollX() + fx - getPaddingLeft() - offsetX(scale)) / scale;
            float py = (getScrollY() + fy - getPaddingTop() - offsetY(scale)) / scale;
            zoomAnimation = android.animation.ValueAnimator.ofFloat(0, 1);
            zoomAnimation.setDuration(250);
            zoomAnimation.setInterpolator(new android.view.animation.DecelerateInterpolator());
            zoomAnimation.addUpdateListener(a -> {
                float t = (float) a.getAnimatedValue();
                place(from + (to - from) * t, px, py, fx, fy);
            });
            zoomAnimation.start();
        }

        @Override
        public void computeScroll() {
            if (glide.computeScrollOffset()) {
                scrollTo(glide.getCurrX(), glide.getCurrY());
                postInvalidateOnAnimation();
            }
        }

        @Override
        public boolean onInterceptTouchEvent(MotionEvent e) {
            if (!enabled || jsBlocked || gateBlocked) return false;
            return track(e);
        }

        @SuppressLint("ClickableViewAccessibility")
        @Override
        public boolean onTouchEvent(MotionEvent e) {
            if (!enabled || jsBlocked || gateBlocked) return false;
            boolean up = beforeTouch(e);
            int action = e.getActionMasked();
            // A down that reaches here was seen by the interception already.
            if (action != MotionEvent.ACTION_DOWN) track(e);
            if (up) {
                if (action == MotionEvent.ACTION_UP) release();
                else {
                    panning = false;
                    if (scale > maxZoom || scale < minZoom) zoomBack();
                }
                released();
            }
            return true;
        }
    }

    // --- Pull to refresh -------------------------------------------------

    private boolean canPull() {
        return !horizontal && !zooms && (events & (1L << Native.REFRESH)) != 0 && scroller.getScrollY() == 0;
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        int action = e.getActionMasked();
        touching = action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_CANCEL;
        if (action == MotionEvent.ACTION_DOWN) {
            // The user scrolls now: what was owed no longer applies.
            owedX = owedY = 0;
            dragging = false;
            tapMode = tapMode(e);
            // "never": the tap reaches nothing but the scroll view.
            swallowing = tapMode == 0;
        }
        if (action == MotionEvent.ACTION_MOVE && dismissMode != 0) {
            float slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
            if (Math.abs(e.getY() - startY) > slop) hideKeyboard();
        }
        if (action == MotionEvent.ACTION_DOWN) startY = e.getY();
        boolean handled;
        if (swallowing) {
            MotionEvent local = MotionEvent.obtain(e);
            local.offsetLocation(-scroller.getLeft() - scroller.getTranslationX(), -scroller.getTop() - scroller.getTranslationY());
            scroller.onTouchEvent(local);
            local.recycle();
            handled = true;
        } else {
            handled = super.dispatchTouchEvent(e);
        }
        if (action == MotionEvent.ACTION_UP && tapMode >= 0 && !dragging
                && (tapMode == 0 || !handlesTap(this, e.getX(), e.getY()))) {
            hideKeyboard();
        }
        if (!touching) {
            swallowing = false;
            tapMode = -1;
        }
        return handled;
    }

    /**
     * How a touch treats the keyboard ({@code keyboardShouldPersistTaps}):
     * -1 when no input is focused or the touch is on an input, else the
     * mode of the outermost scroll view that does not let taps through.
     */
    private int tapMode(MotionEvent e) {
        if (mounter.focusedInput() == null || inputAt(this, e.getX(), e.getY())) return -1;
        for (ViewParent p = getParent(); p != null; p = p.getParent()) {
            if (p instanceof ScrollBox && ((ScrollBox) p).keyboardTaps != 1) return -1;
        }
        return keyboardTaps == 1 ? -1 : keyboardTaps;
    }

    /**
     * Whether an input is under ({@code x}, {@code y}) of {@code group}: in
     * any child there, topmost first, as a touch a child does not take goes
     * on to the one below (a decoration over a field does not hide it).
     */
    private static boolean inputAt(ViewGroup group, float x, float y) {
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (c.getVisibility() != VISIBLE) continue;
            float lx = localX(group, c, x), ly = localY(group, c, y);
            if (lx < 0 || ly < 0 || lx >= c.getWidth() || ly >= c.getHeight()) continue;
            if (c instanceof InputBox) return true;
            if (c instanceof ViewGroup && inputAt((ViewGroup) c, lx, ly)) return true;
        }
        return false;
    }

    /** Whether something under ({@code x}, {@code y}) of {@code group} handles taps. */
    private static boolean handlesTap(ViewGroup group, float x, float y) {
        View v = childAt(group, x, y);
        if (v == null) return false;
        if (v.isClickable() || v.isLongClickable() || v instanceof InputBox || v instanceof android.widget.SeekBar) return true;
        return v instanceof ViewGroup && handlesTap((ViewGroup) v, localX(group, v, x), localY(group, v, y));
    }

    /** The topmost visible child of {@code group} under ({@code x}, {@code y}). */
    private static View childAt(ViewGroup group, float x, float y) {
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (c.getVisibility() != VISIBLE) continue;
            float lx = localX(group, c, x), ly = localY(group, c, y);
            if (lx >= 0 && ly >= 0 && lx < c.getWidth() && ly < c.getHeight()) return c;
        }
        return null;
    }

    private static float localX(ViewGroup group, View child, float x) {
        return x + group.getScrollX() - child.getLeft() - child.getTranslationX();
    }

    private static float localY(ViewGroup group, View child, float y) {
        return y + group.getScrollY() - child.getTop() - child.getTranslationY();
    }

    private void hideKeyboard() {
        View focused = findFocus();
        if (focused == null) return;
        InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
        imm.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        mounter.host.requestFocus();
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent e) {
        if (refreshing || !canPull()) return false;
        if (e.getActionMasked() == MotionEvent.ACTION_MOVE) {
            float dy = e.getY() - startY;
            float slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
            if (dy > slop) {
                pulling = true;
                startY = e.getY();
                return true;
            }
        }
        return false;
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (!pulling) return false;
        float d = mounter.density;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_MOVE:
                // Resistance like a rubber band.
                setPull(Math.max(0, (e.getY() - startY) * 0.5f));
                if (refreshIndicator) {
                    spinner.setVisibility(VISIBLE);
                    spinner.setAlpha(Math.min(1, pull / (refreshThreshold * d)));
                }
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                pulling = false;
                if (pull >= refreshThreshold * d) {
                    setRefreshing(true);
                    mounter.event(id, Native.REFRESH);
                } else {
                    animatePull(0, () -> spinner.setVisibility(GONE));
                }
                return true;
        }
        return true;
    }

    void setRefreshing(boolean on) {
        if (on == refreshing) return;
        refreshing = on;
        float d = mounter.density;
        if (on) {
            if (refreshIndicator) {
                spinner.setVisibility(VISIBLE);
                spinner.setAlpha(1);
            }
            animatePull(refreshInset * d, null);
        } else {
            animatePull(0, () -> spinner.setVisibility(GONE));
        }
    }

    private void setPull(float px) {
        if (px == pull) return;
        pull = px;
        scroller.setTranslationY(px);
        spinner.setTranslationY(Math.max(0, px / 2 - spinner.getHeight() / 2f));
        // The pull is a translation, not a scroll: the offset stays 0.
        mounter.pull(id, px / mounter.density);
    }

    private void animatePull(float to, Runnable end) {
        android.animation.ValueAnimator a = android.animation.ValueAnimator.ofFloat(pull, to);
        a.setDuration(250);
        a.addUpdateListener(v -> setPull((float) v.getAnimatedValue()));
        if (end != null) {
            a.addListener(new android.animation.AnimatorListenerAdapter() {
                @Override
                public void onAnimationEnd(android.animation.Animator animation) {
                    end.run();
                }
            });
        }
        a.start();
    }
}
