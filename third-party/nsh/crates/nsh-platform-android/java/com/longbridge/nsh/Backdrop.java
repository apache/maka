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
 */
@TargetApi(31)
final class Backdrop implements ViewTreeObserver.OnPreDrawListener, View.OnAttachStateChangeListener {
    /** Recording a backdrop (nested backdrops do not record meanwhile). */
    private static boolean recording;

    private final View view;
    final RenderNode node = new RenderNode("nsh-backdrop");
    private float blurPx;
    private final int[] at = new int[2], rootAt = new int[2];

    Backdrop(View view) {
        this.view = view;
        view.addOnAttachStateChangeListener(this);
        if (view.isAttachedToWindow()) onViewAttachedToWindow(view);
    }

    void setBlur(float px) {
        if (px == blurPx) return;
        blurPx = px;
        node.setRenderEffect(px > 0 ? RenderEffect.createBlurEffect(px, px, Shader.TileMode.CLAMP) : null);
        view.invalidate();
    }

    /** Stops recording (the view no longer blurs its backdrop). */
    void release() {
        view.removeOnAttachStateChangeListener(this);
        view.getViewTreeObserver().removeOnPreDrawListener(this);
        node.discardDisplayList();
    }

    @Override
    public void onViewAttachedToWindow(View v) {
        v.getViewTreeObserver().addOnPreDrawListener(this);
    }

    @Override
    public void onViewDetachedFromWindow(View v) {
        v.getViewTreeObserver().removeOnPreDrawListener(this);
        node.discardDisplayList();
    }

    @Override
    public boolean onPreDraw() {
        View root = view.getRootView();
        int w = view.getWidth(), h = view.getHeight();
        if (!(root instanceof ViewGroup) || root == view || w == 0 || h == 0 || recording) return true;
        // The chain from the root down to the view.
        java.util.ArrayList<View> chain = new java.util.ArrayList<>();
        for (View v = view; v != null; v = v.getParent() instanceof View ? (View) v.getParent() : null) {
            chain.add(0, v);
        }
        if (chain.get(0) != root) return true;
        view.getLocationInWindow(at);
        root.getLocationInWindow(rootAt);
        node.setPosition(0, 0, w, h);
        RecordingCanvas canvas = node.beginRecording(w, h);
        // The window, moved so the view's place is at the origin.
        canvas.translate(rootAt[0] - at[0], rootAt[1] - at[1]);
        recording = true;
        try {
            behind(canvas, chain, 0);
        } finally {
            recording = false;
            node.endRecording();
        }
        return true;
    }

    /** Draws what `chain[depth]` (a group, in its own space) shows behind `chain[depth + 1]`. */
    static void behind(Canvas canvas, java.util.List<View> chain, int depth) {
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
                if (depth + 2 < chain.size()) behind(canvas, chain, depth + 1);
                canvas.restoreToCount(save);
                return;
            }
            child.draw(canvas);
            canvas.restoreToCount(save);
        }
    }

    /** Draws the blurred backdrop (the caller clips to the view's shape). */
    void draw(Canvas canvas) {
        if (canvas.isHardwareAccelerated() && node.hasDisplayList()) canvas.drawRenderNode(node);
    }
}
