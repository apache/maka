package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.view.View;
import android.view.ViewGroup;

/**
 * A page or a dialog coming or going through its `transitionShader`
 * (`NAV_SHADER`; API 29+): pictures of its lower side (`sample_from`) and
 * of its upper side (`sample_to`) go to libnsh once, which runs the shader
 * under the id of the stack or the dialog; this view, over them, shows its
 * frames until it ends. libnsh sends the frames that come back while its
 * clock runs and, once it ends, one that replaces nothing: until the first
 * frame, what it covers shows as it is, and a change no frame came back for
 * by then takes its own motion instead of cutting to its end. A change that
 * starts while one runs ends that one first ({@link #finish}).
 */
@SuppressLint("ViewConstructor")
final class NavTransition extends View implements NshView.ShaderFrames {
    private final Mounter mounter;
    private final int key;
    private final Runnable covered, done, own;
    private Bitmap bitmap;
    private boolean covering, ended;
    private final Rect bounds = new Rect();
    private final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG);

    private NavTransition(Mounter mounter, int key, Runnable covered, Runnable done, Runnable own) {
        super(mounter.context);
        this.mounter = mounter;
        this.key = key;
        this.covered = covered;
        this.done = done;
        this.own = own;
    }

    /**
     * Whether page or dialog `page` comes and goes through its shader here:
     * it has one, pictures can be taken (API 29+), and the user does not ask
     * for less motion ("Remove animations": the page then takes its own
     * animation, which the system's animator scale makes at once).
     */
    static boolean wanted(Mounter mounter, int page) {
        return mounter.navShaders.get(page) && Pictures.supported()
                && android.animation.ValueAnimator.areAnimatorsEnabled();
    }

    /**
     * Starts `page`'s transition over `parent` (the stack or the dialog's
     * window, node `id`): its lower side (`sample_from`: the page under it,
     * the window without the dialog) and its upper side (`sample_to`), each
     * views drawn one over the other where they are; `nsh.progress` goes
     * from 0 to 1 as the page or the dialog comes, from 1 to 0 as it goes
     * (`reverse`). `covered` runs once its first frame shows (what it covers
     * may hide), `done` when it ends, `own` instead when it ended before a
     * frame came back (the change then moves with its own animation). A
     * transition still running over `parent` ends first, before the
     * pictures are taken. Null where it does not run (no shader, Android 9,
     * less motion, no picture, no GPU): the caller animates as it would.
     */
    static NavTransition start(Mounter mounter, ViewGroup parent, int id, int page, View[] lower, View[] upper,
                               boolean reverse, Runnable covered, Runnable done, Runnable own) {
        // Its own id space: the stack's or the dialog's node may be deleted
        // while the transition plays.
        int key = id | Integer.MIN_VALUE;
        // Its pictures must not hold the frames of the one before.
        NshView.ShaderFrames old = mounter.host.navFrames.get(key);
        if (old instanceof NavTransition) ((NavTransition) old).finish();
        long handle = mounter.handle();
        int w = parent.getWidth(), h = parent.getHeight();
        if (!wanted(mounter, page) || handle == 0 || w <= 0 || h <= 0) return null;
        Pictures a = new Pictures(), b = new Pictures();
        boolean[] runs = new boolean[1];
        a.take(w, h, c -> Pictures.drawViews(c, parent, lower), (fromPixels, fw, fh, fromStride) ->
                b.take(w, h, c -> Pictures.drawViews(c, parent, upper), (toPixels, tw, th, toStride) ->
                        runs[0] = Native.navTransition(handle, key, page, w, h, fromPixels, fromStride, toPixels,
                                toStride, reverse)));
        a.release();
        b.release();
        if (!runs[0]) return null;
        NavTransition t = new NavTransition(mounter, key, covered, done, own);
        parent.addView(t, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        t.bringToFront();
        mounter.host.navFrames.put(key, t);
        mounter.host.requestFrames();
        return t;
    }

    /**
     * Ends it at once (a change starts while it runs): its frames go, libnsh
     * renders no more of them, and `done` runs, so its views settle where it
     * ends and its events go out. Nothing once it ended.
     */
    void finish() {
        if (ended) return;
        end(true);
        done.run();
    }

    /**
     * Stops showing it, without `done`: the app it belonged to stopped
     * (libnsh forgot its run), so its views and events are gone with it.
     */
    void cancel() {
        if (!ended) end(false);
    }

    /** Its frames go; `stop`: libnsh stops its run too (not while it sends one of its frames). */
    private void end(boolean stop) {
        ended = true;
        if (mounter.host.navFrames.get(key) == this) mounter.host.navFrames.remove(key);
        if (getParent() instanceof ViewGroup) ((ViewGroup) getParent()).removeView(this);
        long handle = mounter.handle();
        if (stop && handle != 0) Native.navTransitionEnd(handle, key);
    }

    /**
     * A frame while it runs (`replaces`), or its end. libnsh sends nothing
     * until the first frame comes back, so waiting for it never ends the
     * transition; one that ends with no frame shown moves with its own
     * animation.
     */
    @Override
    public void shaderFrame(java.nio.ByteBuffer pixels, int width, int height, boolean replaces, float overflow) {
        if (ended) return;
        if (!replaces) {
            // libnsh dropped the run as it sent this: called during its
            // frame, which must not call back in.
            end(false);
            (covering ? done : own).run();
            return;
        }
        if (pixels == null || width <= 0 || height <= 0) return;
        if (bitmap == null || bitmap.getWidth() != width || bitmap.getHeight() != height) {
            bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        }
        bitmap.copyPixelsFromBuffer(pixels);
        if (!covering) {
            covering = true;
            covered.run();
        }
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        if (bitmap == null) return;
        bounds.set(0, 0, getWidth(), getHeight());
        canvas.drawBitmap(bitmap, null, bounds, paint);
    }
}
