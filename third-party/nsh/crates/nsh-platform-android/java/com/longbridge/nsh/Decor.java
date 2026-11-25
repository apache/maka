package com.longbridge.nsh;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.DashPathEffect;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.view.View;
import android.view.ViewOutlineProvider;

/**
 * Background, border, rounded corners and drop shadow of a view, drawn as
 * its background drawable. Units are px.
 */
final class Decor extends Drawable {
    int fill;
    /** Top left, top right, bottom right, bottom left. */
    final float[] radii = new float[4];
    /** `borderCurve: "continuous"`. */
    boolean continuous;
    /** Top, right, bottom, left (px). */
    final float[] borderWidths = new float[4];
    /** Top, right, bottom, left. */
    final int[] borderColors = new int[4];
    /** 0 solid, 1 dashed, 2 dotted. */
    int borderStyle;
    /**
     * `clipPath` (CSS's `inset()`), or null: each edge's offset (px) top,
     * right, bottom, left, then each edge's fraction of the width or height
     * in the same order, then the radii (px) from the top left. As the
     * core's `ClipInset`.
     */
    float[] clipPath;

    private final Path clipShape = new Path();
    private final RectF clipRect = new RectF();
    private final float[] clipRadii = new float[8];

    /** The decoration of a view NSH styles, or null. */
    static Decor of(View v) {
        if (v instanceof StackBox.ScreenBox) return ((StackBox.ScreenBox) v).root.decor;
        if (v instanceof StackBox) return ((StackBox) v).decor;
        if (v instanceof Box) return ((Box) v).decor;
        if (v instanceof TextBox) return ((TextBox) v).decor;
        if (v instanceof ImageBox) return ((ImageBox) v).decor;
        if (v instanceof ScrollBox) return ((ScrollBox) v).decor;
        if (v instanceof InputBox) return ((InputBox) v).decor;
        return null;
    }

    /**
     * The clip path's rectangle in a box of {@code w} x {@code h} into
     * {@link #clipRect} and its radii into {@link #clipRadii}, as the core's
     * `ClipInset::resolve`: opposite edges that would pass each other meet
     * in proportion, radii that do not fit are scaled down together.
     */
    private void resolveClip(float w, float h) {
        float[] c = clipPath;
        w = Math.max(0, w);
        h = Math.max(0, h);
        float top = c[0] + c[4] * h, right = c[1] + c[5] * w, bottom = c[2] + c[6] * h, left = c[3] + c[7] * w;
        float v = top + bottom;
        if (v > h && v > 0) {
            top *= h / v;
            bottom *= h / v;
        }
        float hz = left + right;
        if (hz > w && hz > 0) {
            left *= w / hz;
            right *= w / hz;
        }
        float rw = Math.max(0, w - left - right), rh = Math.max(0, h - top - bottom);
        clipRect.set(left, top, left + rw, top + rh);
        float tl = Math.max(0, c[8]), tr = Math.max(0, c[9]), br = Math.max(0, c[10]), bl = Math.max(0, c[11]);
        float f = 1;
        if (tl + tr > rw) f = Math.min(f, rw / (tl + tr));
        if (bl + br > rw) f = Math.min(f, rw / (bl + br));
        if (tl + bl > rh) f = Math.min(f, rh / (tl + bl));
        if (tr + br > rh) f = Math.min(f, rh / (tr + br));
        f = Math.max(0, f);
        float[] r = {tl * f, tr * f, br * f, bl * f};
        for (int i = 0; i < 4; i++) {
            clipRadii[i * 2] = r[i];
            clipRadii[i * 2 + 1] = r[i];
        }
    }

    /** The clip path's outline in a box of {@code w} x {@code h}. */
    Path clipShape(float w, float h) {
        resolveClip(w, h);
        clipShape.reset();
        clipShape.addRoundRect(clipRect, clipRadii, Path.Direction.CW);
        return clipShape;
    }

    /**
     * Whether ({@code x}, {@code y}) of {@code v} is outside its clip path:
     * neither it nor its children take a touch there.
     */
    boolean clipsOut(View v, float x, float y) {
        if (clipPath == null) return false;
        resolveClip(v.getWidth(), v.getHeight());
        RectF b = clipRect;
        if (!(x >= b.left && y >= b.top && x < b.right && y < b.bottom)) return true;
        // In a corner's square, outside its circle.
        float[] r = clipRadii;
        return outsideCorner(x, y, b.left + r[0], b.top + r[0], r[0], x < b.left + r[0] && y < b.top + r[0])
                || outsideCorner(x, y, b.right - r[2], b.top + r[2], r[2], x > b.right - r[2] && y < b.top + r[2])
                || outsideCorner(x, y, b.right - r[4], b.bottom - r[4], r[4], x > b.right - r[4] && y > b.bottom - r[4])
                || outsideCorner(x, y, b.left + r[6], b.bottom - r[6], r[6], x < b.left + r[6] && y > b.bottom - r[6]);
    }

    private static boolean outsideCorner(float x, float y, float cx, float cy, float r, boolean inSquare) {
        if (r <= 0 || !inSquare) return false;
        float dx = x - cx, dy = y - cy;
        return dx * dx + dy * dy > r * r;
    }

    /**
     * Runs {@code draw} (a view's whole `draw`: its background, shadows,
     * content and children) clipped to the view's clip path, if any.
     */
    void drawClipped(Canvas canvas, View v, Runnable draw) {
        if (clipPath == null) {
            draw.run();
            return;
        }
        int save = canvas.save();
        canvas.clipPath(clipShape(v.getWidth(), v.getHeight()));
        draw.run();
        canvas.restoreToCount(save);
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();
    private final Path inner = new Path();
    private final Path side = new Path();
    private final RectF rect = new RectF();
    private final float[] corners = new float[8];

    /** True if an outer box shadow draws outside the box. */
    boolean hasOuterShadows() {
        for (int n = 0; n < boxShadowColors.length; n++) {
            if (boxShadows[n * 5 + 4] == 0 && Color.alpha(boxShadowColors[n]) > 0) return true;
        }
        return false;
    }

    /** One circular radius: the outline is a plain round rect. */
    boolean uniformRadius() {
        return !continuous && radii[0] == radii[1] && radii[1] == radii[2] && radii[2] == radii[3];
    }

    boolean rounded() {
        return radii[0] > 0 || radii[1] > 0 || radii[2] > 0 || radii[3] > 0;
    }

    /** The rounded outline of `bounds`, inset by `inset`. */
    Path shape(Rect bounds, float inset, Path out) {
        rect.set(bounds.left + inset, bounds.top + inset, bounds.right - inset, bounds.bottom - inset);
        for (int i = 0; i < 4; i++) {
            float r = Math.max(0, fit(bounds)[i] - inset);
            corners[i * 2] = r;
            corners[i * 2 + 1] = r;
        }
        out.reset();
        roundedRect(out, rect, corners, continuous);
        return out;
    }

    /** Corner smoothing of continuous corners (`nsh_core::shape::SMOOTHING`). */
    private static final double SMOOTHING = 0.6;

    /**
     * Adds `rect` with `corners` (horizontal and vertical radius per corner,
     * clockwise from the top left, fitted), clockwise: a port of
     * `nsh_core::shape::rounded_rect`, so both platforms draw the same
     * corners.
     */
    static void roundedRect(Path out, RectF rect, float[] corners, boolean continuous) {
        if (!continuous) {
            out.addRoundRect(rect, corners, Path.Direction.CW);
            return;
        }
        double x0 = rect.left, y0 = rect.top, x1 = rect.right, y1 = rect.bottom;
        double w = x1 - x0, h = y1 - y0;
        double tlx = corners[0], tly = corners[1], trx = corners[2], tryy = corners[3];
        double brx = corners[4], bry = corners[5], blx = corners[6], bly = corners[7];
        // Per corner: its point, the directions it is entered / left along,
        // its radius along each and how far it may reach along each.
        double[][] specs = {
            {x1, y0, 1, 0, 0, 1, trx, tryy, share(w, trx, tlx), share(h, tryy, bry)},
            {x1, y1, 0, 1, -1, 0, bry, brx, share(h, bry, tryy), share(w, brx, blx)},
            {x0, y1, -1, 0, 0, -1, blx, bly, share(w, blx, brx), share(h, bly, tly)},
            {x0, y0, 0, -1, 1, 0, tly, tlx, share(h, tly, bly), share(w, tlx, trx)},
        };
        double[] pt = new double[2];
        for (int i = 0; i < 4; i++) {
            double[] s = specs[i];
            double r = Math.max(s[6], s[7]);
            if (r <= 0) {
                if (i == 0) out.moveTo((float) s[0], (float) s[1]);
                else out.lineTo((float) s[0], (float) s[1]);
                continue;
            }
            double su = s[6] / r, sv = s[7] / r;
            double budget = Math.max(r, Math.min(s[8] / su, s[9] / sv));
            double smoothing = Math.max(0, Math.min(SMOOTHING, budget / r - 1));
            double p = Math.min((1 + smoothing) * r, budget);
            double arc = Math.PI / 2 * (1 - smoothing);
            double arcLen = Math.sin(arc / 2) * r * Math.sqrt(2);
            double alpha = (Math.PI / 2 - arc) / 2;
            double p3p4 = r * Math.tan(alpha / 2);
            double beta = Math.PI / 4 * smoothing;
            double c = p3p4 * Math.cos(beta), d = c * Math.tan(beta);
            double b = Math.max(0, (p - arcLen - c - d) / 3), a = 2 * b;
            map(s, su, sv, -p, 0, pt);
            if (i == 0) out.moveTo((float) pt[0], (float) pt[1]);
            else out.lineTo((float) pt[0], (float) pt[1]);
            boolean transitions = a + b + c > 1e-9 * r;
            if (transitions) cubic(out, s, su, sv, -p + a, 0, -p + a + b, 0, -p + a + b + c, d);
            double start = -Math.PI / 4 - arc / 2, end = -Math.PI / 4 + arc / 2;
            double k = 4.0 / 3.0 * Math.tan(arc / 4) * r;
            double p0x = -r + r * Math.cos(start), p0y = r + r * Math.sin(start);
            double p3x = -r + r * Math.cos(end), p3y = r + r * Math.sin(end);
            cubic(out, s, su, sv,
                    p0x - k * Math.sin(start), p0y + k * Math.cos(start),
                    p3x + k * Math.sin(end), p3y - k * Math.cos(end),
                    p3x, p3y);
            if (transitions) cubic(out, s, su, sv, 0, p - a - b, 0, p - a, 0, p);
        }
        out.close();
    }

    private static double share(double len, double r, double other) {
        return r + other > 0 ? len * r / (r + other) : 0;
    }

    /** Corner frame (along u, along v from the corner) to the plane. */
    private static void map(double[] s, double su, double sv, double a, double b, double[] out) {
        out[0] = s[0] + s[2] * a * su + s[4] * b * sv;
        out[1] = s[1] + s[3] * a * su + s[5] * b * sv;
    }

    private static void cubic(Path out, double[] s, double su, double sv,
            double a1, double b1, double a2, double b2, double a3, double b3) {
        double[] p = new double[2];
        map(s, su, sv, a1, b1, p);
        float x1 = (float) p[0], y1 = (float) p[1];
        map(s, su, sv, a2, b2, p);
        float x2 = (float) p[0], y2 = (float) p[1];
        map(s, su, sv, a3, b3, p);
        out.cubicTo(x1, y1, x2, y2, (float) p[0], (float) p[1]);
    }

    private final float[] fitted = new float[4];

    /** Radii scaled down so adjacent corners do not overlap (CSS). */
    private float[] fit(Rect b) {
        float w = b.width(), h = b.height();
        float f = 1;
        f = Math.min(f, ratio(w, radii[0], radii[1]));
        f = Math.min(f, ratio(w, radii[3], radii[2]));
        f = Math.min(f, ratio(h, radii[0], radii[3]));
        f = Math.min(f, ratio(h, radii[1], radii[2]));
        for (int i = 0; i < 4; i++) fitted[i] = radii[i] * f;
        return fitted;
    }

    private static float ratio(float side, float a, float b) {
        return a + b > side ? side / (a + b) : 1;
    }

    // Box shadows (px): dx, dy, blur, spread, inset (1) per layer, top
    // layer first (CSS order), and their colors.
    float[] boxShadows = new float[0];
    int[] boxShadowColors = new int[0];
    // Gradients, top layer first.
    Gradient[] gradients = new Gradient[0];
    /** `maskImage`, top layer first. */
    Gradient[] masks = new Gradient[0];
    private Paint maskPaint;
    // `outline*` (px): width (0: none), color, style (0 solid, 1 dashed, 2
    // dotted), offset.
    float outlineWidth, outlineOffset;
    int outlineColor, outlineStyle;

    /** A gradient background (`encode.rs` `effects`). */
    static final class Gradient {
        /** 0 linear (angle), 1 to a corner, 2 radial, 3 conic. */
        int kind;
        float angle;
        boolean right, bottom, circle;
        /** Radial: 0 closest side, 1 closest corner, 2 farthest side, 3 farthest corner. */
        int size;
        float x = 0.5f, y = 0.5f;
        int[] colors;
        /** Fractions of the gradient line, placed by {@link #resolve} when {@link #units} is set. */
        float[] positions;
        /** Stops as written when some are in points (else null): 0 spread, 1 fraction, 2 pixels. */
        int[] units;
        float[] values;
        /** Repeats past the last stop (`repeating-*-gradient`). */
        boolean repeating;
        /** The stops {@link #place} made for the shader: colors, and positions within 0..1. */
        int[] drawnColors;
        float[] drawnPositions;
        /** What {@link #drawnColors} and {@link #drawnPositions} were placed for. */
        private float placedLine = Float.NaN, placedReach = Float.NaN;

        /** Most stops {@link #place} repeats a gradient's into, as the core's `MAX_UNROLLED_STOPS`. */
        private static final int MAX_UNROLLED_STOPS = 16384;

        /**
         * Places the stops along a gradient line {@code line} px long ({@link #resolve}) for a
         * shader that repeats nothing and draws them over {@code 0..reach} of the line (1: the
         * whole line of a linear or conic gradient; a radial gradient's rings go on past its ending
         * shape, to the box's farthest corner), as the core's `Gradient::unrolled_stops` does: the
         * positions as fractions of {@code reach}, a repeating gradient's stops repeated over all
         * of it with period last − first, both ways (CSS Images 3), and cut at both ends with the
         * colors there. Sets {@link #drawnColors} and {@link #drawnPositions}.
         */
        void place(float line, float reach) {
            if (drawnColors != null && line == placedLine && reach == placedReach) return;
            placedLine = line;
            placedReach = reach;
            resolve(line);
            reach = Math.max(reach, 1e-6f);
            int n = positions.length;
            float period = n > 0 ? positions[n - 1] - positions[0] : 0;
            double start = 0, end = 0;
            if (period > 1e-4f) {
                start = Math.floor(-positions[n - 1] / period);
                end = Math.ceil((reach - positions[0]) / period);
            }
            drawnColors = colors;
            if (!repeating || period <= 1e-4f || (end - start + 1) * n > MAX_UNROLLED_STOPS) {
                drawnPositions = positions;
                if (reach != 1) {
                    drawnPositions = new float[n];
                    for (int k = 0; k < n; k++) drawnPositions[k] = positions[k] / reach;
                }
                return;
            }
            // The copies that reach into the line, from the one ending before it to the one
            // starting after it.
            int copies = (int) (end - start + 1), m = copies * n;
            int[] tiledColors = new int[m];
            float[] tiled = new float[m];
            float max = Float.NEGATIVE_INFINITY;
            for (int c = 0; c < copies; c++) {
                float shift = (float) (start + c) * period;
                for (int k = 0; k < n; k++) {
                    // A copy's first stop may round to a hair before the last one's.
                    max = Math.max(max, positions[k] + shift);
                    tiled[c * n + k] = max;
                    tiledColors[c * n + k] = colors[k];
                }
            }
            int inside = 0;
            for (float p : tiled) if (p > 0 && p < reach) inside++;
            drawnColors = new int[inside + 2];
            drawnPositions = new float[inside + 2];
            drawnColors[0] = colorAt(tiledColors, tiled, 0);
            int j = 1;
            for (int i = 0; i < m; i++) {
                if (tiled[i] <= 0 || tiled[i] >= reach) continue;
                drawnColors[j] = tiledColors[i];
                drawnPositions[j++] = tiled[i] / reach;
            }
            drawnColors[j] = colorAt(tiledColors, tiled, reach);
            drawnPositions[j] = 1;
        }

        /**
         * The color at {@code t} of ascending stops: between the stops around it (at a hard edge,
         * two stops at one position, the later one's).
         */
        private static int colorAt(int[] colors, float[] positions, float t) {
            int i = positions.length - 1;
            while (i >= 0 && positions[i] > t) i--;
            if (i < 0) return colors[0];
            if (i + 1 < positions.length && positions[i + 1] > positions[i]) {
                return mix(colors[i], colors[i + 1], (t - positions[i]) / (positions[i + 1] - positions[i]));
            }
            return colors[i];
        }

        /** {@code a} mixed with {@code b} by {@code t} (0: a) with premultiplied alpha, as CSS mixes. */
        private static int mix(int a, int b, float t) {
            float alphaA = a >>> 24, alphaB = b >>> 24;
            float alpha = alphaA + (alphaB - alphaA) * t;
            int out = Math.round(Math.max(0, Math.min(255, alpha))) << 24;
            if (alpha <= 0) return out;
            for (int shift = 0; shift <= 16; shift += 8) {
                float x = ((a >>> shift) & 0xff) * alphaA, y = ((b >>> shift) & 0xff) * alphaB;
                out |= Math.round(Math.max(0, Math.min(255, (x + (y - x) * t) / alpha))) << shift;
            }
            return out;
        }

        /**
         * Places the stops along a gradient line {@code line} px long, as `Gradient::resolve_stops`
         * does: lengths as fractions of the line, missing positions spread evenly, each at least the
         * one before it.
         */
        void resolve(float line) {
            if (units == null) return;
            int n = positions.length;
            if (n == 0) return;
            for (int k = 0; k < n; k++) {
                switch (units[k]) {
                    case 0: positions[k] = Float.NaN; break;
                    case 1: positions[k] = values[k]; break;
                    default: positions[k] = line > 0 ? values[k] / line : values[k] > 0 ? 1 : 0;
                }
            }
            if (Float.isNaN(positions[0])) positions[0] = 0;
            if (Float.isNaN(positions[n - 1])) positions[n - 1] = 1;
            // From 0, as the core's Gradient::resolve_stops: negative stops resolve to 0.
            float max = 0;
            for (int k = 0; k < n; k++) {
                if (Float.isNaN(positions[k])) continue;
                max = Math.max(max, positions[k]);
                positions[k] = max;
            }
            int i = 1;
            while (i < n) {
                if (!Float.isNaN(positions[i])) {
                    i++;
                    continue;
                }
                int start = i - 1, end = i;
                while (Float.isNaN(positions[end])) end++;
                float a = positions[start], b = positions[end];
                for (int k = i; k < end; k++) positions[k] = a + (b - a) * (k - start) / (end - start);
                i = end;
            }
        }
    }

    /** `backdrop-filter: blur()` (API 31+), drawn under the background. */
    Backdrop backdrop;

    /** Blurs what is behind `view` by `px` (0: no longer). */
    void setBackdrop(android.view.View view, float px) {
        if (android.os.Build.VERSION.SDK_INT < 31) return;
        if (px <= 0) {
            if (backdrop != null) {
                backdrop.release();
                backdrop = null;
                invalidateSelf();
            }
            return;
        }
        if (backdrop == null) backdrop = new Backdrop(view);
        backdrop.setBlur(px);
    }

    /** Distance shadow casters are moved away to draw only their shadows. */
    private static final float AWAY = 1 << 14;
    private final Path shadowPath = new Path();

    /**
     * A decoration draws the same whether its view is shown, so a change of
     * visibility does not invalidate it. `Drawable.setVisible` would: a stack
     * screen hidden under the next one, and shown again by a pop, tells every
     * view in it, and each one would record its display list again.
     */
    @Override
    public boolean setVisible(boolean visible, boolean restart) {
        Callback callback = getCallback();
        setCallback(null);
        boolean changed = super.setVisible(visible, restart);
        setCallback(callback);
        return changed;
    }

    @Override
    public void draw(Canvas canvas) {
        Rect b = getBounds();
        drawOuterShadows(canvas, b);
        if (backdrop != null) {
            canvas.save();
            canvas.clipPath(shape(b, 0, path));
            backdrop.draw(canvas);
            canvas.restore();
        }
        if (Color.alpha(fill) > 0) {
            paint.setStyle(Paint.Style.FILL);
            paint.setColor(fill);
            canvas.drawPath(shape(b, 0, path), paint);
        }
        drawGradients(canvas, b);
        drawInsetShadows(canvas, b);
        if (!bordersAbove) drawBorders(canvas);
        drawOutline(canvas, b);
    }

    /** CSS blur (twice the deviation) as a Skia shadow radius. */
    private static float shadowRadius(float blur) {
        // Skia: sigma = radius / sqrt(3) + 0.5.
        return Math.max(0.01f, (blur / 2 - 0.5f) * 1.7320508f);
    }

    /**
     * Android 8 draws no shadow layers of shapes on a hardware canvas (only
     * of text): there box shadows are drawn by the same code on a software
     * canvas, into a bitmap ({@link #drawShadowSlices}).
     */
    private static boolean softwareShadows(Canvas canvas) {
        return Build.VERSION.SDK_INT < 28 && canvas.isHardwareAccelerated();
    }

    /**
     * Later versions draw a shape's shadow layer on a hardware canvas, but
     * blur its mask again whenever the box moves by a fraction of a pixel
     * (Skia caches it by subpixel position), and clip it by the box's path:
     * while boxes as large as the screen slid, their shadows, a 1 px inset
     * rim included, took most of each frame. Each layer is drawn once into
     * small bitmaps instead ({@link #drawCachedShadow}).
     */
    private static boolean cachedShadows(Canvas canvas) {
        return canvas.isHardwareAccelerated();
    }

    /** Shadow bitmaps, shared by boxes that look the same. */
    private static final android.util.LruCache<String, Bitmap> SHADOWS =
            new android.util.LruCache<String, Bitmap>(8 << 20) {
                @Override
                protected int sizeOf(String key, Bitmap value) {
                    return value.getByteCount();
                }
            };

    /**
     * The outer or inset shadows of `b`, drawn in software into a bitmap of
     * the smallest box that has the same corners, then stretched to `b` in
     * nine slices: a 2 px band between the corners, where the shadow is the
     * same all along, takes the rest of each side. So the bitmap does not
     * depend on the box's size, and equal boxes (a list's cards) share one.
     * An axis too short to have such a band is drawn at its size.
     */
    private void drawShadowSlices(Canvas canvas, Rect b, boolean inset) {
        float reach = 0;
        for (int n = 0; n < boxShadowColors.length; n++) {
            int i = n * 5;
            if ((boxShadows[i + 4] != 0) != inset || Color.alpha(boxShadowColors[n]) == 0) continue;
            reach = Math.max(reach, Math.abs(boxShadows[i]) + Math.abs(boxShadows[i + 1])
                    + Math.abs(boxShadows[i + 3]) + boxShadows[i + 2] * 2 + 4);
        }
        int m = (int) Math.ceil(reach);
        float[] r = fit(b).clone();
        // Continuous corners keep their full smoothing over 1.6 radii.
        float k = continuous ? 1.6f : 1f;
        int left = (int) Math.ceil((Math.max(r[0], r[3]) + m) * k + borderWidths[3]);
        int right = (int) Math.ceil((Math.max(r[1], r[2]) + m) * k + borderWidths[1]);
        int top = (int) Math.ceil((Math.max(r[0], r[1]) + m) * k + borderWidths[0]);
        int bottom = (int) Math.ceil((Math.max(r[3], r[2]) + m) * k + borderWidths[2]);
        int w = b.width(), h = b.height();
        boolean wide = w > left + right + 2, tall = h > top + bottom + 2;
        int sw = wide ? left + right + 2 : w, sh = tall ? top + bottom + 2 : h;
        if (sw <= 0 || sh <= 0) return;

        StringBuilder key = new StringBuilder(inset ? "i" : "o");
        key.append(sw).append(',').append(sh).append(',').append(continuous);
        for (float v : r) key.append(',').append(v);
        if (inset) for (float v : borderWidths) key.append(',').append(v);
        for (float v : boxShadows) key.append(',').append(v);
        for (int c : boxShadowColors) key.append(',').append(c);
        String id = key.toString();
        Bitmap bitmap = SHADOWS.get(id);
        if (bitmap == null) {
            bitmap = Bitmap.createBitmap(sw + 2 * m, sh + 2 * m, Bitmap.Config.ARGB_8888);
            Canvas software = new Canvas(bitmap);
            software.translate(m, m);
            Rect small = new Rect(0, 0, sw, sh);
            if (inset) drawInsetShadows(software, small);
            else drawOuterShadows(software, small);
            SHADOWS.put(id, bitmap);
        }

        int[] xs = wide
                ? new int[] {0, m + left, m + left + 2, sw + 2 * m}
                : new int[] {0, sw + 2 * m};
        int[] dxs = wide
                ? new int[] {b.left - m, b.left + left, b.right - right, b.right + m}
                : new int[] {b.left - m, b.right + m};
        int[] ys = tall
                ? new int[] {0, m + top, m + top + 2, sh + 2 * m}
                : new int[] {0, sh + 2 * m};
        int[] dys = tall
                ? new int[] {b.top - m, b.top + top, b.bottom - bottom, b.bottom + m}
                : new int[] {b.top - m, b.bottom + m};
        Rect src = new Rect(), dst = new Rect();
        for (int y = 0; y + 1 < ys.length; y++) {
            for (int x = 0; x + 1 < xs.length; x++) {
                src.set(xs[x], ys[y], xs[x + 1], ys[y + 1]);
                dst.set(dxs[x], dys[y], dxs[x + 1], dys[y + 1]);
                // No filtering: the band is the same along it, corners 1:1.
                canvas.drawBitmap(bitmap, src, dst, null);
            }
        }
    }

    /** Outer box shadows: only outside the box, as CSS draws them. */
    private void drawOuterShadows(Canvas canvas, Rect b) {
        if (!hasOuterShadows()) return;
        if (softwareShadows(canvas)) {
            drawShadowSlices(canvas, b, false);
            return;
        }
        // Bottom layer first.
        for (int n = boxShadowColors.length - 1; n >= 0; n--) {
            if (boxShadows[n * 5 + 4] != 0 || Color.alpha(boxShadowColors[n]) == 0) continue;
            if (cachedShadows(canvas) && drawCachedShadow(canvas, b, n)) continue;
            canvas.save();
            if (android.os.Build.VERSION.SDK_INT >= 26) canvas.clipOutPath(shape(b, 0, path));
            castShadow(canvas, b, n);
            canvas.restore();
        }
    }

    /** Inset box shadows: inside the padding box, above the background. */
    private void drawInsetShadows(Canvas canvas, Rect b) {
        boolean any = false;
        for (int n = 0; n < boxShadowColors.length; n++) any |= boxShadows[n * 5 + 4] != 0 && Color.alpha(boxShadowColors[n]) > 0;
        if (!any) return;
        if (softwareShadows(canvas)) {
            drawShadowSlices(canvas, b, true);
            return;
        }
        for (int n = boxShadowColors.length - 1; n >= 0; n--) {
            if (boxShadows[n * 5 + 4] == 0 || Color.alpha(boxShadowColors[n]) == 0) continue;
            if (cachedShadows(canvas) && drawCachedShadow(canvas, b, n)) continue;
            canvas.save();
            canvas.clipPath(shape(padding(b), 0, path));
            castShadow(canvas, b, n);
            canvas.restore();
        }
    }

    /** The padding box of `b`: inside its borders. */
    private Rect padding(Rect b) {
        float t = borderWidths[0], r = borderWidths[1], bo = borderWidths[2], l = borderWidths[3];
        return new Rect(Math.round(b.left + l), Math.round(b.top + t), Math.round(b.right - r), Math.round(b.bottom - bo));
    }

    /**
     * Draws layer `n` of the box shadows of `b` as a shadow layer, unclipped:
     * the caller clips an outer one to outside the box, an inset one to its
     * padding box.
     */
    private void castShadow(Canvas canvas, Rect b, int n) {
        int i = n * 5;
        float dx = boxShadows[i], dy = boxShadows[i + 1], blur = boxShadows[i + 2], spread = boxShadows[i + 3];
        shadowPath.reset();
        paint.setStyle(Paint.Style.FILL);
        paint.setColor(0xff000000);
        if (boxShadows[i + 4] == 0) {
            // The caster sits far away; only its shadow lands here.
            grown(b, spread, shadowPath);
            paint.setShadowLayer(shadowRadius(blur), dx + AWAY, dy, boxShadowColors[n]);
        } else {
            // A frame around the shifted, shrunk inner shape casts the shadow
            // inwards.
            Rect pad = padding(b);
            float reach = Math.abs(dx) + Math.abs(dy) + Math.abs(spread) + blur * 2 + 4;
            shadowPath.setFillType(Path.FillType.EVEN_ODD);
            shadowPath.addRect(pad.left - reach, pad.top - reach, pad.right + reach, pad.bottom + reach, Path.Direction.CW);
            Path hole = new Path();
            grown(pad, -spread, hole);
            hole.offset(dx, dy);
            shadowPath.addPath(hole);
            paint.setShadowLayer(shadowRadius(blur), AWAY, 0, boxShadowColors[n]);
        }
        shadowPath.offset(-AWAY, 0);
        canvas.drawPath(shadowPath, paint);
        paint.clearShadowLayer();
    }

    /**
     * Layer `n` of the box shadows of `b`, as {@link #castShadow} draws it
     * and clipped as its caller would, from bitmaps drawn once and shared by
     * equal boxes: no shadow is blurred and no path is clipped as the box is
     * drawn, which is what made a shadow layer on a hardware canvas slow.
     * False, drawing nothing, when the bitmaps would take more than a quarter
     * of the cache (a spread far larger than the box): the caller draws the
     * layer as before.
     *
     * The shadow, unclipped, is stretched in nine slices as in
     * {@link #drawShadowSlices}, so its bitmap does not depend on the box's
     * size. A blurred layer changes slowly: that bitmap has a pixel for every
     * `u` px, a quarter of the blur (half the deviation), and is drawn
     * filtered; a 28 pt shadow at 3x takes about 50 by 50 pixels, cheap to
     * blur again when the box's corners change. The slices are cut along the
     * edge the clip follows (the box for an outer shadow, the padding box for
     * an inset one) and where its corners' curves end: pieces on the shown
     * side come from the slices, pieces on the hidden side are not drawn,
     * and the squares of the curves come from a second bitmap, clipped and
     * at full size. A layer whose bitmap is at full size anyway (`u` = 1, a
     * blur under 8 px) is drawn into it clipped, and its slices are drawn
     * whole: fewer pieces, as every backdrop recorded behind a box draws
     * them again. The middle slice is not drawn: it lies inside the box,
     * hidden for an outer shadow, and for an inset one more than twice the
     * blur from where it casts (`reach`), where it holds nothing.
     */
    private boolean drawCachedShadow(Canvas canvas, Rect b, int n) {
        int i = n * 5;
        boolean inset = boxShadows[i + 4] != 0;
        float blur = boxShadows[i + 2];
        float reach = Math.abs(boxShadows[i]) + Math.abs(boxShadows[i + 1]) + Math.abs(boxShadows[i + 3]) + blur * 2 + 4;
        int u = Math.max(1, (int) (blur / 4));
        // A layer drawn at full size is drawn clipped: its slices then need no cutting.
        boolean clipped = u == 1;
        int m = units(reach, u);
        float[] r = fit(b).clone();
        // Continuous corners keep their full smoothing over 1.6 radii.
        float k = continuous ? 1.6f : 1f;
        int left = units((Math.max(r[0], r[3]) + m) * k + borderWidths[3], u);
        int right = units((Math.max(r[1], r[2]) + m) * k + borderWidths[1], u);
        int top = units((Math.max(r[0], r[1]) + m) * k + borderWidths[0], u);
        int bottom = units((Math.max(r[3], r[2]) + m) * k + borderWidths[2], u);
        int w = b.width(), h = b.height();
        boolean wide = w > left + right + 2 * u, tall = h > top + bottom + 2 * u;
        // An axis too short to have a band is drawn at its size, the bitmap
        // rounded up to whole pixels past its far end (hidden, or past the
        // shadow's reach).
        int sw = wide ? left + right + 2 * u : w, sh = tall ? top + bottom + 2 * u : h;
        if (sw <= 0 || sh <= 0) return false;
        Rect small = new Rect(0, 0, sw, sh);
        // The edge the clip follows, and how far its corners' curves reach along each side: within
        // that side's slice, so a corner's square shows that corner alone.
        Rect e = inset ? padding(b) : b, es = inset ? padding(small) : small;
        float[] er = fit(e);
        int cl = curve(Math.max(er[0], er[3]), k), cr = curve(Math.max(er[1], er[2]), k);
        int ct = curve(Math.max(er[0], er[1]), k), cb = curve(Math.max(er[3], er[2]), k);
        boolean squares = !clipped && cl + cr > 0 && ct + cb > 0;
        int bw = units(sw + 2 * m, u) / u, bh = units(sh + 2 * m, u) / u;
        // A shadow far larger than its box (a spread of the screen's size) is drawn as before.
        long bytes = 4L * bw * bh + (squares ? 4L * (cl + cr) * (ct + cb) : 0);
        if (bytes > SHADOWS.maxSize() / 4) return false;

        StringBuilder key = new StringBuilder("l");
        key.append(sw).append(',').append(sh).append(',').append(continuous);
        for (float v : radii) key.append(',').append(v);
        for (float v : borderWidths) key.append(',').append(v);
        for (int j = i; j < i + 5; j++) key.append(',').append(boxShadows[j]);
        key.append(',').append(boxShadowColors[n]);
        String id = key.toString();
        Bitmap slices = SHADOWS.get(id);
        if (slices == null) {
            slices = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888);
            Canvas software = new Canvas(slices);
            software.scale(1f / u, 1f / u);
            software.translate(m, m);
            if (clipped && inset) software.clipPath(shape(es, 0, path));
            else if (clipped) software.clipOutPath(shape(es, 0, path));
            castShadow(software, small, n);
            SHADOWS.put(id, slices);
        }
        // The four corners' squares side by side, as the box's caller draws them.
        Bitmap curves = squares ? SHADOWS.get(id + "c") : null;
        if (squares && curves == null) {
            curves = Bitmap.createBitmap(cl + cr, ct + cb, Bitmap.Config.ARGB_8888);
            Canvas software = new Canvas(curves);
            for (int q = 0; q < 4; q++) {
                int x = q % 2 == 0 ? 0 : cl, y = q / 2 == 0 ? 0 : ct;
                software.save();
                software.clipRect(x, y, q % 2 == 0 ? cl : cl + cr, q / 2 == 0 ? ct : ct + cb);
                software.translate(x - (q % 2 == 0 ? es.left : es.right - cr), y - (q / 2 == 0 ? es.top : es.bottom - cb));
                if (inset) software.clipPath(shape(es, 0, path));
                else software.clipOutPath(shape(es, 0, path));
                castShadow(software, small, n);
                software.restore();
            }
            SHADOWS.put(id + "c", curves);
        }

        // The slices along each axis: where they start on the canvas and in the bitmap.
        int[] dxs = wide
                ? new int[] {b.left - m, b.left + left, b.right - right, b.right + m}
                : new int[] {b.left - m, b.left - m + slices.getWidth() * u};
        int[] xs = wide
                ? new int[] {0, (m + left) / u, (m + left) / u + 2, slices.getWidth()}
                : new int[] {0, slices.getWidth()};
        int[] dys = tall
                ? new int[] {b.top - m, b.top + top, b.bottom - bottom, b.bottom + m}
                : new int[] {b.top - m, b.top - m + slices.getHeight() * u};
        int[] ys = tall
                ? new int[] {0, (m + top) / u, (m + top) / u + 2, slices.getHeight()}
                : new int[] {0, slices.getHeight()};
        int[] cx = clipped ? dxs : cuts(dxs, e.left, e.right, cl, cr);
        int[] cy = clipped ? dys : cuts(dys, e.top, e.bottom, ct, cb);

        if (shadowPaint == null) {
            shadowPaint = new Paint();
            shadowPaint.setFilterBitmap(true);
        }
        android.graphics.BitmapShader sliced = new android.graphics.BitmapShader(slices,
                android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP);
        android.graphics.BitmapShader curved = curves == null ? null : new android.graphics.BitmapShader(curves,
                android.graphics.Shader.TileMode.CLAMP, android.graphics.Shader.TileMode.CLAMP);
        android.graphics.Matrix matrix = new android.graphics.Matrix();
        for (int y = 0; y + 1 < cy.length; y++) {
            float my = (cy[y] + cy[y + 1]) / 2f;
            boolean outY = my < e.top || my > e.bottom, nearY = my < e.top + ct || my > e.bottom - cb;
            int sy = slice(dys, my), qy = my < e.top + ct ? 0 : 1;
            // Pieces of a row drawn from the same slice or square are drawn as one.
            int from = 0, kind = 0, at = -1;
            for (int x = 0; x < cx.length; x++) {
                // 0: not drawn, 1: from the slices, 2: from the corners' squares.
                int nextKind = 0, nextAt = -1;
                if (x + 1 < cx.length) {
                    float mx = (cx[x] + cx[x + 1]) / 2f;
                    boolean out = outY || mx < e.left || mx > e.right;
                    boolean curve = squares && !out && nearY && (mx < e.left + cl || mx > e.right - cr);
                    boolean middle = wide && tall && slice(dxs, mx) == 1 && sy == 1;
                    nextKind = clipped ? (middle ? 0 : 1) : curve ? 2 : out != inset && !middle ? 1 : 0;
                    nextAt = curve ? (mx < e.left + cl ? 0 : 1) : slice(dxs, mx);
                }
                if (nextKind == kind && nextAt == at) continue;
                if (kind == 1) {
                    float scaleX = (float) (dxs[at + 1] - dxs[at]) / (xs[at + 1] - xs[at]);
                    float scaleY = (float) (dys[sy + 1] - dys[sy]) / (ys[sy + 1] - ys[sy]);
                    matrix.setScale(scaleX, scaleY);
                    matrix.postTranslate(dxs[at] - xs[at] * scaleX, dys[sy] - ys[sy] * scaleY);
                    drawPiece(canvas, sliced, matrix, cx[from], cy[y], cx[x], cy[y + 1]);
                } else if (kind == 2) {
                    matrix.setTranslate(at == 0 ? e.left : e.right - cr - cl, qy == 0 ? e.top : e.bottom - cb - ct);
                    drawPiece(canvas, curved, matrix, cx[from], cy[y], cx[x], cy[y + 1]);
                }
                from = x;
                kind = nextKind;
                at = nextAt;
            }
        }
        shadowPaint.setShader(null);
        return true;
    }

    /** How far a corner's curve of radius `r` reaches along its sides (px), with a pixel for its edge. */
    private static int curve(float r, float k) {
        return r > 0 ? (int) Math.ceil(r * k) + 1 : 0;
    }

    /** Draws the pieces of shadows' bitmaps. */
    private Paint shadowPaint;

    /** Draws a rectangle of `shader`, placed by `matrix`. */
    private void drawPiece(Canvas canvas, android.graphics.BitmapShader shader, android.graphics.Matrix matrix,
            int l, int t, int r, int b) {
        shader.setLocalMatrix(matrix);
        shadowPaint.setShader(shader);
        canvas.drawRect(l, t, r, b, shadowPaint);
    }

    /**
     * The bounds of `slices`, cut where the clip's edges (`from`, `to`) and
     * the ends of its corners' curves (`a` and `z` inside them) cross them,
     * in order.
     */
    private static int[] cuts(int[] slices, int from, int to, int a, int z) {
        int first = slices[0], last = slices[slices.length - 1];
        java.util.TreeSet<Integer> at = new java.util.TreeSet<>();
        for (int v : slices) at.add(v);
        for (int v : new int[] {from, from + a, to - z, to}) at.add(Math.max(first, Math.min(last, v)));
        int[] out = new int[at.size()];
        int j = 0;
        for (int v : at) out[j++] = v;
        return out;
    }

    /** The slice of `slices` (their starts and the last end) that `v` is in. */
    private static int slice(int[] slices, float v) {
        int s = 0;
        while (s + 2 < slices.length && v >= slices[s + 1]) s++;
        return s;
    }

    /** `v` rounded up to a whole number of `u`. */
    private static int units(float v, int u) {
        return (int) Math.ceil(v / u) * u;
    }

    /** The box's rounded shape grown by `d` px (corners grow with it). */
    private void grown(Rect b, float d, Path out) {
        float[] fitted = fit(b);
        rect.set(b.left - d, b.top - d, b.right + d, b.bottom + d);
        for (int i = 0; i < 4; i++) {
            float r = fitted[i] > 0 ? Math.max(0, fitted[i] + d) : 0;
            corners[i * 2] = r;
            corners[i * 2 + 1] = r;
        }
        roundedRect(out, rect, corners, continuous);
    }

    private final android.graphics.Matrix gradientMatrix = new android.graphics.Matrix();

    private void drawGradients(Canvas canvas, Rect b) {
        if (gradients.length == 0) return;
        paint.setStyle(Paint.Style.FILL);
        Path box = shape(b, 0, path);
        for (int i = gradients.length - 1; i >= 0; i--) {
            paint.setShader(shader(gradients[i], b));
            paint.setColor(0xff000000);
            canvas.drawPath(box, paint);
            paint.setShader(null);
        }
    }

    /** What `g` paints over the box `b`. */
    private android.graphics.Shader shader(Gradient g, Rect b) {
        float w = Math.max(1, b.width()), h = Math.max(1, b.height());
        android.graphics.Shader shader;
        switch (g.kind) {
            case 2: {
                float cx = b.left + g.x * w, cy = b.top + g.y * h;
                float ax = g.x * w, ay = g.y * h;
                float dx, dy;
                switch (g.size) {
                    case 0: dx = Math.min(ax, w - ax); dy = Math.min(ay, h - ay); break;
                    case 2: dx = Math.max(ax, w - ax); dy = Math.max(ay, h - ay); break;
                    case 1: dx = Math.min(ax, w - ax) * 1.4142135f; dy = Math.min(ay, h - ay) * 1.4142135f; break;
                    default: dx = Math.max(ax, w - ax) * 1.4142135f; dy = Math.max(ay, h - ay) * 1.4142135f;
                }
                if (g.circle) {
                    float r = g.size == 0 ? Math.min(dx, dy) : g.size == 2 ? Math.max(dx, dy)
                            : (float) Math.hypot(dx / 1.4142135f, dy / 1.4142135f);
                    dx = dy = r;
                }
                // The farthest corner, in radii of the ending shape: a repeating gradient's
                // rings go on to it.
                float reach = g.repeating && dx > 0 && dy > 0
                        ? Math.max(1, (float) Math.hypot(Math.max(ax, w - ax) / dx, Math.max(ay, h - ay) / dy))
                        : 1;
                // Lengths are along the ray to the right.
                g.place(dx, reach);
                shader = new android.graphics.RadialGradient(cx, cy, Math.max(0.5f, dx) * reach, g.drawnColors,
                        g.drawnPositions, android.graphics.Shader.TileMode.CLAMP);
                // An ellipse: the circle scaled vertically.
                gradientMatrix.setScale(1, dy / Math.max(0.5f, dx), cx, cy);
                shader.setLocalMatrix(gradientMatrix);
                break;
            }
            case 3: {
                float cx = b.left + g.x * w, cy = b.top + g.y * h;
                g.place(0, 1);
                shader = new android.graphics.SweepGradient(cx, cy, g.drawnColors, g.drawnPositions);
                // Sweeps start right; CSS starts up.
                gradientMatrix.setRotate(g.angle - 90, cx, cy);
                shader.setLocalMatrix(gradientMatrix);
                break;
            }
            default: {
                float angle = g.angle;
                if (g.kind == 1) {
                    float a = (float) Math.toDegrees(Math.atan2(h, w));
                    angle = g.right ? (g.bottom ? 90 + a : 90 - a) : (g.bottom ? 270 - a : 270 + a);
                }
                double rad = Math.toRadians(angle);
                float sin = (float) Math.sin(rad), cos = (float) Math.cos(rad);
                float len = Math.abs(w * sin) + Math.abs(h * cos);
                float cx = b.left + w / 2, cy = b.top + h / 2;
                float dx = sin * len / 2, dy = -cos * len / 2;
                g.place(len, 1);
                shader = new android.graphics.LinearGradient(cx - dx, cy - dy, cx + dx, cy + dy, g.drawnColors,
                        g.drawnPositions, android.graphics.Shader.TileMode.CLAMP);
            }
        }
        return shader;
    }

    /**
     * Keeps what `canvas` holds of the layer {@link #drawMasked} opened where
     * `maskImage`'s topmost gradient is opaque (as iOS and macOS, which
     * draw that one).
     */
    private void drawMask(Canvas canvas, Rect b) {
        if (maskPaint == null) {
            maskPaint = new Paint();
            maskPaint.setXfermode(new android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.DST_IN));
        }
        maskPaint.setShader(shader(masks[0], b));
        canvas.drawRect(b, maskPaint);
        maskPaint.setShader(null);
    }

    /**
     * Draws the view through `draw` under `maskImage`, in a layer of its own
     * so the mask covers all of it, its backdrop included.
     */
    void drawMasked(Canvas canvas, android.view.View view, Runnable draw) {
        if (masks.length == 0) {
            draw.run();
            return;
        }
        Rect b = new Rect(0, 0, view.getWidth(), view.getHeight());
        int save = canvas.saveLayer(0, 0, b.right, b.bottom, null);
        draw.run();
        drawMask(canvas, b);
        canvas.restoreToCount(save);
    }

    private void drawOutline(Canvas canvas, Rect b) {
        if (outlineWidth <= 0 || Color.alpha(outlineColor) == 0) return;
        float w = outlineWidth;
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(w);
        paint.setColor(outlineColor);
        if (outlineStyle == 1) {
            paint.setPathEffect(new DashPathEffect(new float[] {w * 3, w * 3}, 0));
        } else if (outlineStyle == 2) {
            paint.setPathEffect(new DashPathEffect(new float[] {0, w * 2}, 0));
            paint.setStrokeCap(Paint.Cap.ROUND);
        }
        shadowPath.reset();
        grown(b, outlineOffset + w / 2, shadowPath);
        canvas.drawPath(shadowPath, paint);
        paint.setPathEffect(null);
        paint.setStrokeCap(Paint.Cap.BUTT);
    }

    /** The view draws the borders itself, above its content (images, like
     * Core Animation's layer border). */
    boolean bordersAbove;

    void drawBorders(Canvas canvas) {
        if (!hasBorder()) return;
        Rect b = getBounds();
        if (uniformBorder()) {
            float w = borderWidths[0];
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(w);
            paint.setColor(borderColors[0]);
            if (borderStyle == 1) {
                paint.setPathEffect(new DashPathEffect(new float[] {w * 3, w * 3}, 0));
                paint.setStrokeCap(Paint.Cap.BUTT);
            } else if (borderStyle == 2) {
                // Zero-length dashes with round caps draw dots.
                paint.setPathEffect(new DashPathEffect(new float[] {0, w * 2}, 0));
                paint.setStrokeCap(Paint.Cap.ROUND);
            }
            canvas.drawPath(shape(b, w / 2, path), paint);
            paint.setPathEffect(null);
            paint.setStrokeCap(Paint.Cap.BUTT);
            return;
        }
        // Sides differ: fill the ring between the outer and inner edges, one
        // side's trapezoid at a time.
        ring(b);
        paint.setStyle(Paint.Style.FILL);
        float w = b.width(), h = b.height();
        float t = borderWidths[0], r = borderWidths[1], bo = borderWidths[2], l = borderWidths[3];
        float[][] sides = {
            {0, 0, w, 0, w - r, t, l, t},
            {w, 0, w, h, w - r, h - bo, w - r, t},
            {w, h, 0, h, l, h - bo, w - r, h - bo},
            {0, h, 0, 0, l, t, l, h - bo},
        };
        for (int i = 0; i < 4; i++) {
            if (borderWidths[i] <= 0 || Color.alpha(borderColors[i]) == 0) continue;
            float[] p = sides[i];
            side.reset();
            side.moveTo(b.left + p[0], b.top + p[1]);
            for (int k = 2; k < 8; k += 2) side.lineTo(b.left + p[k], b.top + p[k + 1]);
            side.close();
            canvas.save();
            canvas.clipPath(side);
            paint.setColor(borderColors[i]);
            canvas.drawPath(path, paint);
            canvas.restore();
        }
    }

    boolean hasBorder() {
        for (int i = 0; i < 4; i++) {
            if (borderWidths[i] > 0 && Color.alpha(borderColors[i]) > 0) return true;
        }
        return false;
    }

    boolean uniformBorder() {
        for (int i = 1; i < 4; i++) {
            if (borderWidths[i] != borderWidths[0] || borderColors[i] != borderColors[0]) return false;
        }
        return true;
    }

    private final float[] innerRadii = new float[8];

    /** The area between the outer edge and the inner edge of the borders,
     * into `path` (even-odd). Inner corners are elliptical where adjacent
     * sides differ. */
    private void ring(Rect b) {
        shape(b, 0, path);
        float t = borderWidths[0], r = borderWidths[1], bo = borderWidths[2], l = borderWidths[3];
        float[] radii = fit(b);
        float[][] corner = {{l, t}, {r, t}, {r, bo}, {l, bo}};
        for (int i = 0; i < 4; i++) {
            innerRadii[i * 2] = Math.max(0, radii[i] - corner[i][0]);
            innerRadii[i * 2 + 1] = Math.max(0, radii[i] - corner[i][1]);
        }
        rect.set(b.left + l, b.top + t, b.right - r, b.bottom - bo);
        inner.reset();
        if (rect.width() > 0 && rect.height() > 0) roundedRect(inner, rect, innerRadii, continuous);
        path.setFillType(Path.FillType.EVEN_ODD);
        path.addPath(inner);
    }

    // `transformOrigin` (fractions, or pixels) and `backfaceVisibility`.
    float originX = 0.5f, originY = 0.5f;
    boolean originXFraction = true, originYFraction = true;
    boolean backfaceHidden;

    /** Sets the pivot of `view`'s transform to the origin (after a resize too). */
    void applyPivot(View view) {
        boolean center = originXFraction && originYFraction && originX == 0.5f && originY == 0.5f;
        if (center) {
            if (Build.VERSION.SDK_INT >= 28 && view.isPivotSet()) view.resetPivot();
            return;
        }
        view.setPivotX(originXFraction ? originX * view.getWidth() : originX);
        view.setPivotY(originYFraction ? originY * view.getHeight() : originY);
    }

    /** `visibility: hidden`. */
    boolean hidden;

    /** Hides `view` while it is turned away, with `backfaceVisibility: hidden`,
     * or `visibility: hidden`. */
    void applyBackface(View view) {
        boolean away = hidden;
        if (backfaceHidden && !away) {
            double rx = Math.toRadians(view.getRotationX()), ry = Math.toRadians(view.getRotationY());
            away = Math.cos(rx) * Math.cos(ry) < 0;
        }
        int visibility = away ? View.INVISIBLE : View.VISIBLE;
        if (view.getVisibility() != visibility) view.setVisibility(visibility);
    }

    /**
     * Clips `view` to the rounded shape (outline clipping where possible).
     * A box with continuous corners does not clip by outline: their outline
     * is a path of cubics, and the GPU clips to such a path through a
     * coverage mask made for each draw inside it, every frame
     * (`Box.drawChildren` clips its children instead).
     */
    void clip(View view, boolean clip) {
        boolean byLayer = continuous && view instanceof Box;
        view.setClipToOutline(clip && !byLayer && (uniformRadius() || Build.VERSION.SDK_INT >= 33));
        view.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View v, Outline outline) {
                Rect r = new Rect(0, 0, v.getWidth(), v.getHeight());
                if (uniformRadius()) {
                    outline.setRoundRect(r, fit(r)[0]);
                } else if (Build.VERSION.SDK_INT >= 30) {
                    outline.setPath(shape(r, 0, new Path()));
                } else if (continuous) {
                    // Smoothed corners are not always convex, and Android 8 and 9
                    // takes only convex outlines. Clipping is by path here
                    // (`needsPathClip`), so the outline only casts the shadow:
                    // a round rect of the smallest corner stands in for it.
                    float smallest = Float.MAX_VALUE;
                    for (float corner : fit(r)) smallest = Math.min(smallest, corner);
                    outline.setRoundRect(r, smallest);
                } else {
                    // Rounded rectangles are convex.
                    outline.setConvexPath(shape(r, 0, new Path()));
                }
            }
        });
        view.invalidateOutline();
    }

    /**
     * A box's odd corners before API 33 cannot clip by outline, and its
     * continuous ones do not ({@link #clip}): it clips in dispatchDraw.
     */
    boolean needsPathClip(boolean clip) {
        return clip && (continuous || (!uniformRadius() && Build.VERSION.SDK_INT < 33));
    }

    @Override
    public void setAlpha(int alpha) {}

    @Override
    public void setColorFilter(ColorFilter filter) {}

    @Override
    @SuppressWarnings("deprecation")
    public int getOpacity() {
        return PixelFormat.TRANSLUCENT;
    }

    /** android.graphics.Color without the import clash in callers. */
    static final class Color {
        static int alpha(int c) {
            return c >>> 24;
        }
    }
}
