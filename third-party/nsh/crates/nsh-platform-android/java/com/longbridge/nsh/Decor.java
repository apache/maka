package com.longbridge.nsh;

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

    /** Outer box shadows: only outside the box, as CSS draws them. */
    private void drawOuterShadows(Canvas canvas, Rect b) {
        if (!hasOuterShadows()) return;
        canvas.save();
        if (android.os.Build.VERSION.SDK_INT >= 26) canvas.clipOutPath(shape(b, 0, path));
        paint.setStyle(Paint.Style.FILL);
        // Bottom layer first.
        for (int n = boxShadowColors.length - 1; n >= 0; n--) {
            int i = n * 5;
            if (boxShadows[i + 4] != 0) continue;
            int color = boxShadowColors[n];
            if (Color.alpha(color) == 0) continue;
            float spread = boxShadows[i + 3];
            // The caster sits far away; only its shadow lands here.
            paint.setColor(0xff000000);
            paint.setShadowLayer(shadowRadius(boxShadows[i + 2]), boxShadows[i] + AWAY, boxShadows[i + 1], color);
            shadowPath.reset();
            grown(b, spread, shadowPath);
            shadowPath.offset(-AWAY, 0);
            canvas.drawPath(shadowPath, paint);
        }
        paint.clearShadowLayer();
        canvas.restore();
    }

    /** Inset box shadows: inside the padding box, above the background. */
    private void drawInsetShadows(Canvas canvas, Rect b) {
        boolean any = false;
        for (int n = 0; n < boxShadowColors.length; n++) any |= boxShadows[n * 5 + 4] != 0 && Color.alpha(boxShadowColors[n]) > 0;
        if (!any) return;
        float t = borderWidths[0], r = borderWidths[1], bo = borderWidths[2], l = borderWidths[3];
        Rect pad = new Rect(Math.round(b.left + l), Math.round(b.top + t), Math.round(b.right - r), Math.round(b.bottom - bo));
        canvas.save();
        canvas.clipPath(shape(pad, 0, path));
        paint.setStyle(Paint.Style.FILL);
        for (int n = boxShadowColors.length - 1; n >= 0; n--) {
            int i = n * 5;
            if (boxShadows[i + 4] == 0) continue;
            int color = boxShadowColors[n];
            if (Color.alpha(color) == 0) continue;
            float dx = boxShadows[i], dy = boxShadows[i + 1], blur = boxShadows[i + 2], spread = boxShadows[i + 3];
            // A frame around the shifted, shrunk inner shape casts the shadow
            // inwards.
            float reach = Math.abs(dx) + Math.abs(dy) + Math.abs(spread) + blur * 2 + 4;
            shadowPath.reset();
            shadowPath.setFillType(Path.FillType.EVEN_ODD);
            shadowPath.addRect(pad.left - reach, pad.top - reach, pad.right + reach, pad.bottom + reach, Path.Direction.CW);
            Path hole = new Path();
            grown(pad, -spread, hole);
            hole.offset(dx, dy);
            shadowPath.addPath(hole);
            shadowPath.offset(-AWAY, 0);
            paint.setColor(0xff000000);
            paint.setShadowLayer(shadowRadius(blur), AWAY, 0, color);
            canvas.drawPath(shadowPath, paint);
        }
        paint.clearShadowLayer();
        canvas.restore();
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
        float w = Math.max(1, b.width()), h = Math.max(1, b.height());
        paint.setStyle(Paint.Style.FILL);
        Path box = shape(b, 0, path);
        for (int i = gradients.length - 1; i >= 0; i--) {
            Gradient g = gradients[i];
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
            paint.setShader(shader);
            paint.setColor(0xff000000);
            canvas.drawPath(box, paint);
            paint.setShader(null);
        }
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

    private boolean uniformBorder() {
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

    /** Clips `view` to the rounded shape (outline clipping where possible). */
    void clip(View view, boolean clip) {
        view.setClipToOutline(clip && (uniformRadius() || Build.VERSION.SDK_INT >= 33));
        view.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View v, Outline outline) {
                Rect r = new Rect(0, 0, v.getWidth(), v.getHeight());
                if (uniformRadius()) {
                    outline.setRoundRect(r, fit(r)[0]);
                } else if (Build.VERSION.SDK_INT >= 30) {
                    outline.setPath(shape(r, 0, new Path()));
                } else {
                    // Rounded rectangles are convex.
                    outline.setConvexPath(shape(r, 0, new Path()));
                }
            }
        });
        view.invalidateOutline();
    }

    /** Odd corners before API 33 cannot clip by outline: clip in dispatchDraw. */
    boolean needsPathClip(boolean clip) {
        return clip && !uniformRadius() && Build.VERSION.SDK_INT < 33;
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
