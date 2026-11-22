package com.longbridge.nsh;

import android.annotation.TargetApi;
import android.graphics.Canvas;
import android.graphics.HardwareRenderer;
import android.graphics.PixelFormat;
import android.graphics.RecordingCanvas;
import android.graphics.RenderNode;
import android.hardware.HardwareBuffer;
import android.media.Image;
import android.media.ImageReader;
import android.view.View;

/**
 * Pictures of what views draw, for the shaders that read them (`sample_content`,
 * `sample_backdrop`, `sample_from`, `sample_to`; API 29+): a drawing is recorded
 * into a render node (display lists only), rendered once by a
 * {@link HardwareRenderer} into an {@link ImageReader} the CPU reads, and its
 * premultiplied RGBA rows go to libnsh while the image is held. One per view
 * and input, its reader kept while the size stays.
 */
@TargetApi(29)
final class Pictures {
    /** Draws the picture (in pixels, from its top-left). */
    interface Drawing {
        void draw(Canvas canvas);
    }

    /** Takes the rows (`stride` bytes apart; valid only during the call). */
    interface Sink {
        void take(java.nio.ByteBuffer pixels, int width, int height, int stride);
    }

    /** Whether pictures can be taken here. */
    static boolean supported() {
        return android.os.Build.VERSION.SDK_INT >= 29;
    }

    private final RenderNode node = new RenderNode("nsh-picture");
    private HardwareRenderer renderer;
    private ImageReader reader;
    private int width, height;

    /** `drawing` at `width` × `height` px, handed to `sink`; false where it could not be taken. */
    boolean take(int width, int height, Drawing drawing, Sink sink) {
        if (width <= 0 || height <= 0) return false;
        node.setPosition(0, 0, width, height);
        RecordingCanvas canvas = node.beginRecording(width, height);
        try {
            drawing.draw(canvas);
        } finally {
            node.endRecording();
        }
        try {
            if (reader == null || this.width != width || this.height != height) {
                release();
                reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2,
                        HardwareBuffer.USAGE_CPU_READ_OFTEN | HardwareBuffer.USAGE_GPU_COLOR_OUTPUT);
                renderer = new HardwareRenderer();
                renderer.setOpaque(false);
                renderer.setSurface(reader.getSurface());
                renderer.setContentRoot(node);
                this.width = width;
                this.height = height;
            }
            renderer.createRenderRequest().setWaitForPresent(true).syncAndDraw();
            Image image = reader.acquireLatestImage();
            if (image == null) return false;
            try {
                Image.Plane plane = image.getPlanes()[0];
                sink.take(plane.getBuffer(), width, height, plane.getRowStride());
            } finally {
                image.close();
            }
            return true;
        } catch (RuntimeException e) {
            android.util.Log.w("nsh", "shader: no picture: " + e.getMessage());
            release();
            return false;
        }
    }

    /** Frees the reader and the renderer (taking another makes them again). */
    void release() {
        if (renderer != null) renderer.destroy();
        if (reader != null) reader.close();
        renderer = null;
        reader = null;
    }

    /**
     * Draws what lies behind `view` (`Backdrop.behind`: the window's root down
     * to it), `view`'s top-left at the origin.
     */
    static void drawBehind(Canvas canvas, View view) {
        View root = view.getRootView();
        if (!(root instanceof android.view.ViewGroup) || root == view) return;
        java.util.ArrayList<View> chain = new java.util.ArrayList<>();
        for (View v = view; v != null; v = v.getParent() instanceof View ? (View) v.getParent() : null) {
            chain.add(0, v);
        }
        if (chain.get(0) != root) return;
        int[] at = new int[2], rootAt = new int[2];
        view.getLocationInWindow(at);
        root.getLocationInWindow(rootAt);
        int saved = canvas.save();
        canvas.translate(rootAt[0] - at[0], rootAt[1] - at[1]);
        Backdrop.behind(canvas, chain, 0);
        canvas.restoreToCount(saved);
    }

    /**
     * Draws `views` one over the other where they are, from `base`'s top-left
     * (a dialog's window and the app's view may sit apart on the screen).
     */
    static void drawViews(Canvas canvas, View base, View... views) {
        int[] origin = new int[2], at = new int[2];
        base.getLocationOnScreen(origin);
        for (View v : views) {
            if (v == null || v.getWidth() <= 0) continue;
            v.getLocationOnScreen(at);
            int saved = canvas.save();
            canvas.translate(at[0] - origin[0], at[1] - origin[1]);
            v.draw(canvas);
            canvas.restoreToCount(saved);
        }
    }
}
