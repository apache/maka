package com.longbridge.nsh;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.drawable.Animatable;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import java.io.FileInputStream;

/**
 * Two views request one GIF before it has loaded. Each must receive its own drawable: detaching one stops only that
 * one, and the other keeps invalidating.
 *
 * <p>Runs on a device of API 28 or 29 ({@code android.graphics.Movie} does not decode in the host JVM). The class is
 * not part of the runtime; the Android build compiles only {@code java/}.
 */
public final class MovieDrawableSharing {
    private MovieDrawableSharing() {}

    /** {@code args[0]} is the GIF file. */
    public static void main(String[] args) throws Exception {
        if (args.length != 1) fail("usage: MovieDrawableSharing <gif>");
        if (android.os.Build.VERSION.SDK_INT < 28 || android.os.Build.VERSION.SDK_INT >= 30) {
            fail("needs API 28 or 29, this device is " + android.os.Build.VERSION.SDK_INT);
        }
        byte[] gif = read(args[0]);
        Looper.prepareMainLooper();
        Images images = new Images(uri -> null);
        images.inline = uri -> gif;
        Images.Image[] got = new Images.Image[2];
        String[] errors = new String[2];
        int[] pending = {2};
        for (int i = 0; i < 2; i++) {
            int index = i;
            images.request("data:gif", 64, 0, new Images.Callback() {
                @Override
                public void done(Images.Image image, String error) {
                    got[index] = image;
                    errors[index] = error;
                    // app_process's main queue refuses to quit, so the check ends the process itself.
                    if (--pending[0] == 0) check(got, errors);
                }
            });
        }
        new Handler(Looper.getMainLooper()).postDelayed(() -> fail("timed out waiting for both views"), 5000);
        Looper.loop();
    }

    private static void check(Images.Image[] got, String[] errors) {
        if (got[0] == null || got[1] == null) fail("decode failed: " + errors[0] + " / " + errors[1]);
        if (!(got[0].content instanceof Images.MovieDrawable) || !(got[1].content instanceof Images.MovieDrawable)) {
            fail("expected a MovieDrawable on API " + android.os.Build.VERSION.SDK_INT);
        }
        if (got[0].content == got[1].content) fail("both views share one drawable");

        Drawable first = (Drawable) got[0].content;
        Drawable second = (Drawable) got[1].content;
        Invalidations firstHits = new Invalidations();
        Invalidations secondHits = new Invalidations();
        first.setCallback(firstHits);
        second.setCallback(secondHits);
        ((Animatable) first).start();
        ((Animatable) second).start();
        int width = Math.max(1, first.getIntrinsicWidth());
        int height = Math.max(1, first.getIntrinsicHeight());
        Canvas canvas = new Canvas(Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888));
        first.setBounds(0, 0, width, height);
        second.setBounds(0, 0, width, height);
        first.draw(canvas);
        second.draw(canvas);
        if (firstHits.count == 0 || secondHits.count == 0) fail("each view should invalidate as it plays");

        // Detach the first view, as ImageBox does when it leaves the window.
        ((Animatable) first).stop();
        int firstAtDetach = firstHits.count;
        int secondAtDetach = secondHits.count;
        if (!((Animatable) second).isRunning()) fail("detaching one view stopped the other");
        second.draw(canvas);
        if (secondHits.count <= secondAtDetach) fail("the remaining view stopped invalidating");
        if (firstHits.count != firstAtDetach) fail("the detached view still received invalidations");
        System.out.println("ok");
        System.exit(0);
    }

    private static byte[] read(String path) throws Exception {
        try (FileInputStream in = new FileInputStream(path)) {
            return Net.readAll(in);
        }
    }

    private static void fail(String message) {
        System.err.println(message);
        System.exit(1);
    }

    private static final class Invalidations implements Drawable.Callback {
        int count;

        @Override
        public void invalidateDrawable(Drawable who) {
            count++;
        }

        @Override
        public void scheduleDrawable(Drawable who, Runnable what, long when) {}

        @Override
        public void unscheduleDrawable(Drawable who, Runnable what) {}
    }
}
