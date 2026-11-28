package com.longbridge.nsh;

import android.annotation.TargetApi;
import android.graphics.Canvas;
import android.graphics.RecordingCanvas;
import android.graphics.RenderEffect;
import android.graphics.RenderNode;
import android.graphics.Shader;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;

/**
 * `backdrop-filter: blur()` (API 31+): before every frame what lies behind
 * the view is recorded into a render node (display lists only, nothing is
 * rasterized here): from the window's root down to the view, each
 * ancestor's background and the siblings drawn before the next ancestor.
 * The view, its children and everything above it stay out (recording the
 * whole window would make the node contain the view, which draws the
 * node). The node blurs, and the view's background draws it clipped to its
 * shape, under its own background and children, as CSS does.
 *
 * The node is recorded small and drawn stretched, filtered. Skia's GPU blur
 * scales its input down until the deviation is at most {@link #SIGMA} px
 * before it blurs, so a backdrop recorded at that size looks the same, and
 * its layer, which the whole backdrop is drawn into on every frame, has a
 * fraction of the pixels: a view of the screen's size blurred by 24 pt is
 * recorded at about a tenth of its width and height. A view nothing of which
 * is on screen records nothing.
 */
@TargetApi(31)
final class Backdrop implements ViewTreeObserver.OnPreDrawListener, View.OnAttachStateChangeListener {
    /** Recording a backdrop (nested backdrops do not record meanwhile). */
    private static boolean recording;

    private final View view;
    final RenderNode node = new RenderNode("nsh-backdrop");
    private float blurPx;
    /** The node's size, of the view's: its blur's deviation is at most {@link #SIGMA}. */
    private float scale = 1;
    /** The largest deviation Skia's GPU blur blurs by without scaling its input down (px). */
    private static final float SIGMA = 4;
    private final int[] at = new int[2], rootAt = new int[2];
    private final android.graphics.Rect visible = new android.graphics.Rect();
    private java.util.Set<WebBox> webViews = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());
    private java.util.Set<WebBox> sampledWebViews = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());

    Backdrop(View view) {
        this.view = view;
        node.setPivotX(0);
        node.setPivotY(0);
        view.addOnAttachStateChangeListener(this);
        if (view.isAttachedToWindow()) onViewAttachedToWindow(view);
    }

    void setBlur(float px) {
        if (px == blurPx) return;
        blurPx = px;
        // The deviation of a blur radius, as hwui converts it (`Blur::convertRadiusToSigma`).
        float sigma = 0.57735f * px + 0.5f;
        scale = px > 0 && sigma > SIGMA ? SIGMA / sigma : 1;
        float radius = scale < 1 ? (SIGMA - 0.5f) / 0.57735f : px;
        node.setRenderEffect(px > 0 ? RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP) : null);
        view.invalidate();
    }

    /** Stops recording (the view no longer blurs its backdrop). */
    void release() {
        view.removeOnAttachStateChangeListener(this);
        view.getViewTreeObserver().removeOnPreDrawListener(this);
        node.discardDisplayList();
        releaseWebViews();
    }

    @Override
    public void onViewAttachedToWindow(View v) {
        v.getViewTreeObserver().addOnPreDrawListener(this);
    }

    @Override
    public void onViewDetachedFromWindow(View v) {
        v.getViewTreeObserver().removeOnPreDrawListener(this);
        node.discardDisplayList();
        releaseWebViews();
    }

    @Override
    public boolean onPreDraw() {
        View root = view.getRootView();
        int w = view.getWidth(), h = view.getHeight();
        if (recording) return true;
        if (!(root instanceof ViewGroup) || root == view || w == 0 || h == 0) {
            releaseWebViews();
            return true;
        }
        // The chain from the root down to the view.
        java.util.ArrayList<View> chain = new java.util.ArrayList<>();
        for (View v = view; v != null; v = v.getParent() instanceof View ? (View) v.getParent() : null) {
            chain.add(0, v);
        }
        if (chain.get(0) != root) {
            releaseWebViews();
            return true;
        }
        // Off screen (a pager's other pages, a drawer slid out), the node would still be drawn into
        // its layer and blurred on every frame.
        if (!view.isShown() || !view.getGlobalVisibleRect(visible)) {
            node.discardDisplayList();
            releaseWebViews();
            return true;
        }
        view.getLocationInWindow(at);
        root.getLocationInWindow(rootAt);
        int sw = Math.max(1, (int) Math.ceil(w * scale)), sh = Math.max(1, (int) Math.ceil(h * scale));
        node.setPosition(0, 0, sw, sh);
        // Stretched by the node, not by the view's display list: an older backdrop's pre-draw can
        // record the view before this one records the node at another size (#2101).
        node.setScaleX((float) w / sw);
        node.setScaleY((float) h / sh);
        // An older backdrop's pre-draw can build this view's display list before this node has one
        // (#2101): the view drew nothing and stays clean, so redraw it once the node has content.
        boolean had = node.hasDisplayList();
        RecordingCanvas canvas = node.beginRecording(sw, sh);
        canvas.scale((float) sw / w, (float) sh / h);
        // The window, moved so the view's place is at the origin.
        canvas.translate(rootAt[0] - at[0], rootAt[1] - at[1]);
        recording = true;
        try {
            behind(canvas, chain, 0, this);
        } finally {
            recording = false;
            node.endRecording();
        }
        for (WebBox web : webViews) {
            if (!sampledWebViews.contains(web)) web.releaseCaptureLayer();
        }
        java.util.Set<WebBox> previous = webViews;
        webViews = sampledWebViews;
        sampledWebViews = previous;
        sampledWebViews.clear();
        if (!had) view.invalidate();
        return true;
    }

    /** A WebView's functor must draw once, at its own size, before a filtered layer samples it. */
    private void sampleWebViews(View source) {
        if (source.getVisibility() != View.VISIBLE) return;
        if (source instanceof WebBox) {
            WebBox web = (WebBox) source;
            if (sampledWebViews.add(web) && !webViews.contains(web)) web.retainCaptureLayer();
        } else if (source instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) source;
            for (int i = 0; i < group.getChildCount(); i++) sampleWebViews(group.getChildAt(i));
        }
    }

    private void releaseWebViews() {
        for (WebBox web : webViews) web.releaseCaptureLayer();
        webViews.clear();
    }

    /** Draws what `chain[depth]` (a group, in its own space) shows behind `chain[depth + 1]`. */
    static void behind(Canvas canvas, java.util.List<View> chain, int depth) {
        behind(canvas, chain, depth, null);
    }

    private static void behind(Canvas canvas, java.util.List<View> chain, int depth, Backdrop capture) {
        ViewGroup group = (ViewGroup) chain.get(depth);
        View next = chain.get(depth + 1);
        android.graphics.drawable.Drawable background = group.getBackground();
        if (background != null) background.draw(canvas);
        for (int i = 0; i < group.getChildCount(); i++) {
            View child = group.getChildAt(i);
            if (child.getVisibility() != View.VISIBLE && child != next) continue;
            int save = canvas.save();
            canvas.translate(child.getLeft() - group.getScrollX(), child.getTop() - group.getScrollY());
            if (!child.getMatrix().isIdentity()) canvas.concat(child.getMatrix());
            if (child.getAlpha() < 1) canvas.saveLayerAlpha(null, Math.round(child.getAlpha() * 255));
            if (child == next) {
                if (depth + 2 < chain.size()) behind(canvas, chain, depth + 1, capture);
                canvas.restoreToCount(save);
                return;
            }
            if (onlyBlurs(child)) {
                canvas.restoreToCount(save);
                continue;
            }
            if (capture != null) capture.sampleWebViews(child);
            child.draw(canvas);
            canvas.restoreToCount(save);
        }
    }

    /**
     * Whether `view` draws nothing but its own blurred backdrop (a layer of a
     * progressive blur). A backdrop behind it leaves it out: its backdrop node
     * holds everything behind it again, siblings like it included, so layers
     * stacked this way each drew the window again for every layer under them
     * (five layers of a progressive blur: 31 times, 37 ms of a Pixel 10 Pro's
     * RenderThread a frame in `prepareTree`). Later layers then blur what is
     * behind the stack rather than the blur of the layers under them, which
     * looks the same.
     */
    private static boolean onlyBlurs(View view) {
        if (view.getClass() != Box.class || !(view.getBackground() instanceof Decor)) return false;
        Box box = (Box) view;
        return ((Decor) view.getBackground()).onlyBackdrop() && box.getChildCount() == 0
                && !box.hasShader() && view.getForeground() == null;
    }

    /** Draws the blurred backdrop (the caller clips to the view's shape). */
    void draw(Canvas canvas) {
        if (canvas.isHardwareAccelerated() && node.hasDisplayList()) canvas.drawRenderNode(node);
    }
}
