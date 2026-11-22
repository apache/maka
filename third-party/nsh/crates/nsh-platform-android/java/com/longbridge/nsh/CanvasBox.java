package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Build;
import java.util.HashMap;

/**
 * `<canvas>`: replays a drawing (`encode.rs` `canvas`) in {@link #onDraw} with its {@link CanvasPainter}.
 */
@SuppressLint("ViewConstructor")
final class CanvasBox extends Box {
    private final CanvasPainter painter = new CanvasPainter();
    /** Images it draws, by URI, once loaded. */
    final HashMap<String, Images.Image> images = painter.images;

    CanvasBox(Context context, Mounter mounter, int id) {
        super(context, mounter, id);
        setWillNotDraw(false);
    }

    /**
     * Android 8 draws no shadow layers of shapes on a hardware canvas, so there a drawing that sets a shadow is
     * replayed in software into this bitmap, then drawn as a bitmap.
     */
    private Bitmap software;

    /** Sets the drawing; returns the URIs of the images it draws. */
    java.util.List<String> setDrawing(int[] code, Object[] objects) {
        java.util.List<String> uris = painter.setDrawing(code, objects);
        images.keySet().retainAll(uris);
        invalidate();
        return uris;
    }

    void setSlot(int slot, float value) {
        if (painter.setSlot(slot, value)) invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (painter.isEmpty()) return;
        int w = getWidth(), h = getHeight();
        float density = mounter.density;
        if (painter.hasShadow && Build.VERSION.SDK_INT < 28 && canvas.isHardwareAccelerated()) {
            if (w <= 0 || h <= 0) return;
            if (software == null || software.getWidth() != w || software.getHeight() != h) {
                software = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            } else {
                software.eraseColor(0);
            }
            painter.paint(new Canvas(software), w, h, density);
            canvas.drawBitmap(software, 0, 0, null);
            return;
        }
        painter.paint(canvas, w, h, density);
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        software = null;
    }
}
