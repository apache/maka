package com.longbridge.nsh;

import android.graphics.Bitmap;

/**
 * `blurRadius`: a stack blur (a fast approximation of a Gaussian) of
 * decoded bitmaps, on the image threads; the same algorithm as the Apple
 * side (`blur.rs`).
 */
final class Blur {
    private Blur() {}

    /** {@code bitmap} blurred by {@code radius} pixels (a new, mutable bitmap). */
    static Bitmap blurred(Bitmap bitmap, int radius) {
        radius = Math.min(254, radius);
        int w = bitmap.getWidth(), h = bitmap.getHeight();
        if (radius < 1 || w == 0 || h == 0) return bitmap;
        Bitmap out = bitmap.copy(Bitmap.Config.ARGB_8888, true);
        int[] px = new int[w * h];
        out.getPixels(px, 0, w, 0, 0, w, h);
        int[] stack = new int[(2 * radius + 1) * 4];
        for (int y = 0; y < h; y++) line(px, y * w, 1, w, radius, stack);
        for (int x = 0; x < w; x++) line(px, x, w, h, radius, stack);
        out.setPixels(px, 0, w, 0, 0, w, h);
        return out;
    }

    private static int channel(int argb, int c) {
        return (argb >>> (24 - c * 8)) & 0xff;
    }

    /** One pass over {@code count} pixels from {@code start}, {@code step} apart (in place). */
    private static void line(int[] px, int start, int step, int count, int radius, int[] stack) {
        int div = 2 * radius + 1, last = count - 1;
        long[] sum = new long[4], in = new long[4], out = new long[4];
        for (int i = 0; i <= radius; i++) {
            int p = px[start];
            for (int c = 0; c < 4; c++) {
                int v = channel(p, c);
                stack[i * 4 + c] = v;
                sum[c] += (long) v * (i + 1);
                out[c] += v;
            }
        }
        for (int i = 1; i <= radius; i++) {
            int p = px[start + Math.min(i, last) * step];
            for (int c = 0; c < 4; c++) {
                int v = channel(p, c);
                stack[(i + radius) * 4 + c] = v;
                sum[c] += (long) v * (radius + 1 - i);
                in[c] += v;
            }
        }
        long weight = (long) (radius + 1) * (radius + 1);
        int sp = radius;
        for (int x = 0; x < count; x++) {
            int value = 0;
            for (int c = 0; c < 4; c++) {
                value |= (int) (sum[c] / weight) << (24 - c * 8);
                sum[c] -= out[c];
            }
            px[start + x * step] = value;
            int slot = (sp + div - radius) % div;
            int incoming = px[start + Math.min(x + radius + 1, last) * step];
            for (int c = 0; c < 4; c++) {
                int v = channel(incoming, c);
                out[c] -= stack[slot * 4 + c];
                stack[slot * 4 + c] = v;
                in[c] += v;
                sum[c] += in[c];
            }
            sp = (sp + 1) % div;
            for (int c = 0; c < 4; c++) {
                out[c] += stack[sp * 4 + c];
                in[c] -= stack[sp * 4 + c];
            }
        }
    }
}
