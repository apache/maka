package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BlendMode;
import android.graphics.Canvas;
import android.graphics.DashPathEffect;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RadialGradient;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.SweepGradient;
import android.graphics.drawable.Drawable;
import android.os.Build;
import java.util.ArrayDeque;
import java.util.HashMap;

/**
 * `<canvas>`: replays a drawing (`encode.rs` `canvas`) in {@link #onDraw}.
 * The drawing stays an int array (float bits, animated value slots, string
 * indices) interpreted on every draw, with no objects per operation.
 *
 * As in canvas (and unlike Android), the current path is built in the
 * view's space with the transform current when each piece is added and
 * survives fill / stroke; strokes apply the current transform again so
 * line widths and dashes follow it. Arcs become cubic Béziers here, so
 * transforms apply exactly.
 */
@SuppressLint("ViewConstructor")
final class CanvasBox extends Box {
    private int[] code = new int[0];
    private Object[] objects = new Object[0];
    /** Animated value slots (colors as ARGB bits). */
    private float[] slots = new float[0];
    /** Images it draws, by URI, once loaded. */
    final HashMap<String, Images.Image> images = new HashMap<>();

    CanvasBox(Context context, Mounter mounter, int id) {
        super(context, mounter, id);
        setWillNotDraw(false);
    }

    /** Composite operations or clearRect: the drawing gets a layer of its own. */
    private boolean needsLayer;

    /** Sets the drawing; returns the URIs of the images it draws. */
    java.util.List<String> setDrawing(int[] code, Object[] objects) {
        this.code = code;
        this.objects = objects;
        java.util.ArrayList<String> uris = new java.util.ArrayList<>();
        needsLayer = false;
        Reader r = new Reader();
        while (r.i < code.length) {
            int op = code[r.i];
            if (op == 42) uris.add((String) objects[code[r.i + 1]]);
            if (op == 23 || op == 33 && code[r.i + 1] != 0) needsLayer = true;
            if (!r.skip()) break;
        }
        images.keySet().retainAll(uris);
        invalidate();
        return uris;
    }

    void setSlot(int slot, float value) {
        if (slot >= slots.length) slots = java.util.Arrays.copyOf(slots, slot + 1);
        if (Float.floatToRawIntBits(slots[slot]) == Float.floatToRawIntBits(value)) return;
        slots[slot] = value;
        invalidate();
    }

    private static final int SLOT_MASK = 0xfff00000, SLOT_BITS = 0x7fa00000;

    /** Walks the code without drawing (to find images). */
    private final class Reader {
        int i;

        /** Skips the operation at `i`; false at an unknown one. */
        boolean skip() {
            int op = code[i++];
            switch (op) {
                case 0: case 1: case 7: case 17: return true;
                case 2: case 3: case 8: case 9: i += 2; return true;
                case 4: case 26: case 27: case 28: case 29: case 31: case 32: case 33: case 34: case 35: case 38: case 39:
                    i += 1; return true;
                case 5: case 6: case 11: i += 6; return true;
                case 10: case 15: case 21: case 22: case 23: i += 4; return true;
                case 12: i += 6; return true;
                case 13: i += 5; return true;
                case 14: i += 8; return true;
                case 16: i += 8; return true;
                case 18: case 20: i += 1; return skipPath();
                case 19: return skipPath();
                case 24: case 25: return skipPaint();
                case 30: i += 1 + code[i]; return true;
                case 36: i += 2; return true;
                case 37: i += 5; return true;
                case 43: i += 1; return true;
                case 40: case 41: i += 4; return true;
                case 42: i += 1 + 1 + 4 + 4; return true;
                default: return false;
            }
        }

        boolean skipPath() {
            int n = code[i++];
            for (int k = 0; k < n; k++) if (!skip()) return false;
            return true;
        }

        boolean skipPaint() {
            i = afterPaint(i);
            return true;
        }
    }

    /** The index after the paint at `at` (its kind word). */
    private int afterPaint(int at) {
        int kind = code[at++];
        if (kind == 0 || kind == 1) return at + 1;
        int shape = code[at++];
        at += shape == 0 ? 4 : shape == 1 ? 6 : 3;
        int stops = code[at++];
        return at + stops * 2;
    }

    // --- Replay ---------------------------------------------------------------

    private static final class State {
        int fillKind, fillColor, fillAt; // kind 0 color, 1 slot, 2 gradient (at: its code offset)
        int strokeKind, strokeColor, strokeAt;
        float lineWidth = 1, miter = 10, dashOffset, alpha = 1;
        int cap, join, composite;
        float[] dash;
        int shadowColor;
        float shadowBlur, shadowX, shadowY;
        float fontSize = 10;
        int fontWeight = 400;
        boolean italic;
        String family;
        /** The font's OpenType feature bits, and `fontVariantNumeric`'s. */
        int variant, numeric;
        int align, baseline;
        final Matrix ctm = new Matrix();

        State copy() {
            State s = new State();
            s.fillKind = fillKind; s.fillColor = fillColor; s.fillAt = fillAt;
            s.strokeKind = strokeKind; s.strokeColor = strokeColor; s.strokeAt = strokeAt;
            s.lineWidth = lineWidth; s.miter = miter; s.dashOffset = dashOffset; s.alpha = alpha;
            s.cap = cap; s.join = join; s.composite = composite; s.dash = dash;
            s.shadowColor = shadowColor; s.shadowBlur = shadowBlur; s.shadowX = shadowX; s.shadowY = shadowY;
            s.fontSize = fontSize; s.fontWeight = fontWeight; s.italic = italic; s.family = family;
            s.variant = variant; s.numeric = numeric;
            s.align = align; s.baseline = baseline;
            s.ctm.set(ctm);
            return s;
        }
    }

    private int i;
    private State s;
    private final ArrayDeque<State> stack = new ArrayDeque<>();
    private Path path = new Path();
    /** The path being built has a current point: `curX`, `curY` (view space), its subpath starting at `startX`, `startY`. */
    private boolean hasPoint;
    private float curX, curY, startX, startY;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float[] pts = new float[6];

    private float num() {
        int raw = code[i++];
        if ((raw & SLOT_MASK) == SLOT_BITS) {
            int slot = raw & 0xfffff;
            return slot < slots.length ? slots[slot] : 0;
        }
        return Float.intBitsToFloat(raw);
    }

    private float flt() {
        return Float.intBitsToFloat(code[i++]);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (code.length == 0) return;
        s = new State();
        stack.clear();
        path = new Path();
        hasPoint = false;
        int base = canvas.save();
        // A canvas draws within its bounds (parents do not clip children).
        canvas.clipRect(0, 0, getWidth(), getHeight());
        float density = mounter.density;
        canvas.scale(density, density);
        // Composite operations compose with the drawing only, not the views behind.
        if (needsLayer) canvas.saveLayer(null, null);
        i = 0;
        while (i < code.length) {
            if (!op(canvas)) break;
        }
        canvas.restoreToCount(base);
    }

    /** Replays one operation; false at an unknown one. */
    private boolean op(Canvas canvas) {
        int op = code[i++];
        switch (op) {
            case 0: stack.push(s.copy()); canvas.save(); return true;
            case 1:
                if (!stack.isEmpty()) {
                    s = stack.pop();
                    canvas.restore();
                }
                return true;
            case 2: { float x = num(), y = num(); s.ctm.preTranslate(x, y); return true; }
            case 3: { float x = num(), y = num(); s.ctm.preScale(x, y); return true; }
            case 4: s.ctm.preRotate((float) Math.toDegrees(num())); return true;
            case 5: { Matrix m = matrix(); s.ctm.preConcat(m); return true; }
            case 6: { Matrix m = matrix(); s.ctm.set(m); return true; }
            case 7: path = new Path(); hasPoint = false; return true;
            case 8: case 9: case 10: case 11: case 12: case 13: case 14: case 15: case 16: case 17:
                i--;
                return pathOp(path, s.ctm);
            case 18: {
                int rule = code[i++];
                Path p = readPath();
                if (p == null) return false;
                p.setFillType(rule == 1 ? Path.FillType.EVEN_ODD : Path.FillType.WINDING);
                fill(canvas, p);
                return true;
            }
            case 19: {
                Path p = readPath();
                if (p == null) return false;
                stroke(canvas, p);
                return true;
            }
            case 20: {
                int rule = code[i++];
                Path p = readPath();
                if (p == null) return false;
                p.setFillType(rule == 1 ? Path.FillType.EVEN_ODD : Path.FillType.WINDING);
                canvas.clipPath(p);
                return true;
            }
            case 21: fill(canvas, rectPath()); return true;
            case 22: stroke(canvas, rectPath()); return true;
            case 23: {
                Path p = rectPath();
                paint.reset();
                paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.CLEAR));
                canvas.drawPath(p, paint);
                paint.setXfermode(null);
                return true;
            }
            // Paints are read where they are used, with the slot values then.
            case 24: s.fillKind = code[i]; s.fillAt = i + 1; i = afterPaint(i); return true;
            case 25: s.strokeKind = code[i]; s.strokeAt = i + 1; i = afterPaint(i); return true;
            case 26: { float w = num(); if (w > 0 && !Float.isInfinite(w) && !Float.isNaN(w)) s.lineWidth = w; return true; }
            case 27: s.cap = code[i++]; return true;
            case 28: s.join = code[i++]; return true;
            case 29: s.miter = flt(); return true;
            case 30: {
                int n = code[i++];
                float[] d = new float[n];
                for (int k = 0; k < n; k++) d[k] = flt();
                s.dash = n == 0 ? null : d;
                return true;
            }
            case 31: s.dashOffset = num(); return true;
            case 32: { float a = num(); if (a >= 0 && a <= 1) s.alpha = a; return true; }
            case 33: s.composite = code[i++]; return true;
            case 34: s.shadowColor = code[i++]; return true;
            case 35: s.shadowBlur = flt(); return true;
            case 36: s.shadowX = flt(); s.shadowY = flt(); return true;
            case 37: {
                s.fontSize = flt();
                s.fontWeight = code[i++];
                s.italic = code[i++] != 0;
                int family = code[i++];
                s.family = family >= 0 ? (String) objects[family] : null;
                s.variant = code[i++];
                return true;
            }
            case 43: s.numeric = code[i++]; return true;
            case 38: s.align = code[i++]; return true;
            case 39: s.baseline = code[i++]; return true;
            case 40: case 41: {
                String text = (String) objects[code[i++]];
                float x = num(), y = num(), max = flt();
                text(canvas, text, x, y, max, op == 41);
                return true;
            }
            case 42: {
                String uri = (String) objects[code[i++]];
                boolean hasSource = code[i++] != 0;
                float sx = flt(), sy = flt(), sw = flt(), sh = flt();
                float dx = num(), dy = num(), dw = num(), dh = num();
                image(canvas, uri, hasSource, sx, sy, sw, sh, dx, dy, dw, dh);
                return true;
            }
            default: return false;
        }
    }

    private Matrix matrix() {
        float a = num(), b = num(), c = num(), d = num(), e = num(), f = num();
        Matrix m = new Matrix();
        m.setValues(new float[] {a, c, e, b, d, f, 0, 0, 1});
        return m;
    }

    /** A path operand: -1 is the current path, else a list of operations. */
    private Path readPath() {
        int n = code[i++];
        if (n < 0) return new Path(path);
        Path p = new Path();
        // A Path2D has a current point of its own.
        boolean had = hasPoint;
        float cx = curX, cy = curY, sx = startX, sy = startY;
        hasPoint = false;
        boolean ok = true;
        for (int k = 0; k < n && ok; k++) ok = pathOp(p, s.ctm);
        hasPoint = had;
        curX = cx; curY = cy; startX = sx; startY = sy;
        return ok ? p : null;
    }

    /** The rectangle of fillRect / strokeRect / clearRect (not the current path). */
    private Path rectPath() {
        float x = num(), y = num(), w = num(), h = num();
        Path p = new Path();
        float[] q = {x, y, x + w, y, x + w, y + h, x, y + h};
        s.ctm.mapPoints(q);
        p.moveTo(q[0], q[1]);
        p.lineTo(q[2], q[3]);
        p.lineTo(q[4], q[5]);
        p.lineTo(q[6], q[7]);
        p.close();
        return p;
    }

    private void map(Matrix m, int n) {
        m.mapPoints(pts, 0, pts, 0, n);
    }

    private void moveTo(Path p, Matrix m, float x, float y) {
        pts[0] = x; pts[1] = y;
        map(m, 1);
        p.moveTo(pts[0], pts[1]);
        hasPoint = true;
        curX = startX = pts[0];
        curY = startY = pts[1];
    }

    private void lineTo(Path p, Matrix m, float x, float y) {
        if (!hasPoint) {
            moveTo(p, m, x, y);
            return;
        }
        pts[0] = x; pts[1] = y;
        map(m, 1);
        p.lineTo(pts[0], pts[1]);
        curX = pts[0];
        curY = pts[1];
    }

    private void cubicTo(Path p, Matrix m, float x1, float y1, float x2, float y2, float x, float y) {
        if (!hasPoint) moveTo(p, m, x1, y1);
        pts[0] = x1; pts[1] = y1; pts[2] = x2; pts[3] = y2; pts[4] = x; pts[5] = y;
        map(m, 3);
        p.cubicTo(pts[0], pts[1], pts[2], pts[3], pts[4], pts[5]);
        curX = pts[4];
        curY = pts[5];
    }

    private void close(Path p) {
        p.close();
        curX = startX;
        curY = startY;
    }

    /** Appends one path operation (codes 8–17) to `p`. */
    private boolean pathOp(Path p, Matrix m) {
        int op = code[i++];
        switch (op) {
            case 8: { float x = num(), y = num(); moveTo(p, m, x, y); return true; }
            case 9: { float x = num(), y = num(); lineTo(p, m, x, y); return true; }
            case 10: {
                float cx = num(), cy = num(), x = num(), y = num();
                if (!hasPoint) moveTo(p, m, cx, cy);
                pts[0] = cx; pts[1] = cy; pts[2] = x; pts[3] = y;
                map(m, 2);
                p.quadTo(pts[0], pts[1], pts[2], pts[3]);
                curX = pts[2];
                curY = pts[3];
                return true;
            }
            case 11: {
                float a = num(), b = num(), c = num(), d = num(), e = num(), f = num();
                cubicTo(p, m, a, b, c, d, e, f);
                return true;
            }
            case 12: {
                float x = num(), y = num(), r = num(), start = num(), end = num();
                boolean ccw = code[i++] != 0;
                arc(p, m, x, y, Math.max(0, r), Math.max(0, r), 0, start, sweep(start, end, ccw));
                return true;
            }
            case 13: {
                float x1 = num(), y1 = num(), x2 = num(), y2 = num(), r = num();
                arcTo(p, m, x1, y1, x2, y2, Math.max(0, r));
                return true;
            }
            case 14: {
                float x = num(), y = num(), rx = num(), ry = num(), rot = num(), start = num(), end = num();
                boolean ccw = code[i++] != 0;
                if (rx >= 0 && ry >= 0) arc(p, m, x, y, rx, ry, rot, start, sweep(start, end, ccw));
                return true;
            }
            case 15: {
                float x = num(), y = num(), w = num(), h = num();
                moveTo(p, m, x, y);
                lineTo(p, m, x + w, y);
                lineTo(p, m, x + w, y + h);
                lineTo(p, m, x, y + h);
                close(p);
                moveTo(p, m, x, y);
                return true;
            }
            case 16: {
                float x = num(), y = num(), w = num(), h = num();
                float[] r = fitRadii(w, h, new float[] {num(), num(), num(), num()});
                float hp = (float) (Math.PI / 2);
                moveTo(p, m, x + r[0], y);
                lineTo(p, m, x + w - r[1], y);
                arc(p, m, x + w - r[1], y + r[1], r[1], r[1], 0, -hp, hp);
                lineTo(p, m, x + w, y + h - r[2]);
                arc(p, m, x + w - r[2], y + h - r[2], r[2], r[2], 0, 0, hp);
                lineTo(p, m, x + r[3], y + h);
                arc(p, m, x + r[3], y + h - r[3], r[3], r[3], 0, hp, hp);
                lineTo(p, m, x, y + r[0]);
                arc(p, m, x + r[0], y + r[0], r[0], r[0], 0, 2 * hp, hp);
                close(p);
                moveTo(p, m, x, y);
                return true;
            }
            case 17: close(p); return true;
            default: return false;
        }
    }

    /** `nsh_core::canvas::arc_sweep`. */
    private static float sweep(float start, float end, boolean ccw) {
        double tau = Math.PI * 2;
        if (!ccw) return (float) (end - start >= tau ? tau : mod(end - start, tau));
        return (float) (start - end >= tau ? -tau : -mod(start - end, tau));
    }

    private static double mod(double a, double b) {
        double r = a % b;
        return r < 0 ? r + b : r;
    }

    /** `nsh_core::canvas::fit_radii`. */
    private static float[] fitRadii(float w, float h, float[] r) {
        for (int k = 0; k < 4; k++) r[k] = Math.max(0, r[k]);
        w = Math.abs(w);
        h = Math.abs(h);
        float scale = 1;
        float[] sides = {r[0] + r[1], r[2] + r[3], r[0] + r[3], r[1] + r[2]};
        float[] limits = {w, w, h, h};
        for (int k = 0; k < 4; k++) if (sides[k] > 0) scale = Math.min(scale, limits[k] / sides[k]);
        for (int k = 0; k < 4; k++) r[k] *= scale;
        return r;
    }

    /** An elliptical arc as cubics (at most a quarter turn each), connected to the current point. */
    private void arc(Path p, Matrix m, float cx, float cy, float rx, float ry, float rotation, float start, float sweep) {
        int segments = Math.max(1, (int) Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-6));
        double step = sweep / (double) segments;
        double k = 4.0 / 3.0 * Math.tan(step / 4);
        double cr = Math.cos(rotation), sr = Math.sin(rotation);
        double t = start;
        double x0 = Math.cos(t), y0 = Math.sin(t);
        float sx = (float) (cx + rx * x0 * cr - ry * y0 * sr), sy = (float) (cy + rx * x0 * sr + ry * y0 * cr);
        lineTo(p, m, sx, sy);
        for (int n = 0; n < segments; n++) {
            double t2 = t + step;
            double c1 = Math.cos(t), s1 = Math.sin(t), c2 = Math.cos(t2), s2 = Math.sin(t2);
            // Points on the unit circle, then scaled and rotated.
            double ax = c1 - k * s1, ay = s1 + k * c1;
            double bx = c2 + k * s2, by = s2 - k * c2;
            cubicTo(p, m,
                    (float) (cx + rx * ax * cr - ry * ay * sr), (float) (cy + rx * ax * sr + ry * ay * cr),
                    (float) (cx + rx * bx * cr - ry * by * sr), (float) (cy + rx * bx * sr + ry * by * cr),
                    (float) (cx + rx * c2 * cr - ry * s2 * sr), (float) (cy + rx * c2 * sr + ry * s2 * cr));
            t = t2;
        }
    }

    /** Canvas `arcTo`: the arc tangent to the lines to (x1, y1) and from it to (x2, y2). */
    private void arcTo(Path p, Matrix m, float x1, float y1, float x2, float y2, float r) {
        if (!hasPoint) {
            moveTo(p, m, x1, y1);
            return;
        }
        // The current point, back in user space.
        Matrix inverse = new Matrix();
        if (!m.invert(inverse)) return;
        float[] last = {curX, curY};
        inverse.mapPoints(last);
        float x0 = last[0], y0 = last[1];
        double dx0 = x0 - x1, dy0 = y0 - y1, dx2 = x2 - x1, dy2 = y2 - y1;
        double l0 = Math.hypot(dx0, dy0), l2 = Math.hypot(dx2, dy2);
        double cross = dx0 * dy2 - dy0 * dx2;
        if (r == 0 || l0 == 0 || l2 == 0 || Math.abs(cross) < 1e-9) {
            lineTo(p, m, x1, y1);
            return;
        }
        double angle = Math.acos(Math.max(-1, Math.min(1, (dx0 * dx2 + dy0 * dy2) / (l0 * l2))));
        double tangent = r / Math.tan(angle / 2);
        double tx0 = x1 + dx0 / l0 * tangent, ty0 = y1 + dy0 / l0 * tangent;
        double tx2 = x1 + dx2 / l2 * tangent, ty2 = y1 + dy2 / l2 * tangent;
        // The center: from the first tangent point, perpendicular towards the inside.
        double nx = -dy0 / l0, ny = dx0 / l0;
        if (cross > 0) {
            nx = -nx;
            ny = -ny;
        }
        double ccx = tx0 + nx * r, ccy = ty0 + ny * r;
        double a0 = Math.atan2(ty0 - ccy, tx0 - ccx), a2 = Math.atan2(ty2 - ccy, tx2 - ccx);
        double sweep = a2 - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        lineTo(p, m, (float) tx0, (float) ty0);
        arc(p, m, (float) ccx, (float) ccy, r, r, 0, (float) a0, (float) sweep);
    }

    // --- Painting -------------------------------------------------------------

    private static int withAlpha(int color, float alpha) {
        int a = Math.round(((color >>> 24) & 0xff) * alpha);
        return (a << 24) | (color & 0x00ffffff);
    }

    /** Sets the paint's color or shader for the fill or stroke style; `local` maps the gradient's space. */
    private void applyStyle(boolean fill, Matrix local) {
        int kind = fill ? s.fillKind : s.strokeKind;
        int at = fill ? s.fillAt : s.strokeAt;
        if (at == 0) {
            // Never set: black.
            paint.setColor(withAlpha(0xff000000, s.alpha));
            return;
        }
        if (kind == 0) {
            paint.setColor(withAlpha(code[at], s.alpha));
        } else if (kind == 1) {
            int slot = code[at];
            int color = slot < slots.length ? Float.floatToRawIntBits(slots[slot]) : 0;
            paint.setColor(withAlpha(color, s.alpha));
        } else {
            paint.setColor(withAlpha(0xff000000, s.alpha));
            Shader shader = gradient(at, local);
            if (shader != null) paint.setShader(shader);
        }
    }

    /** The gradient at `at`, its coordinates mapped by `local`. */
    private Shader gradient(int at, Matrix local) {
        int shape = code[at++];
        float[] g = new float[shape == 0 ? 4 : shape == 1 ? 6 : 3];
        for (int k = 0; k < g.length; k++) g[k] = Float.intBitsToFloat(code[at++]);
        int n = code[at++];
        if (n == 0) return null;
        int[] colors = new int[Math.max(2, n)];
        float[] positions = new float[Math.max(2, n)];
        for (int k = 0; k < n; k++) {
            positions[k] = Float.intBitsToFloat(code[at++]);
            colors[k] = code[at++];
        }
        if (n == 1) {
            colors[1] = colors[0];
            positions[1] = 1;
        }
        Shader shader;
        Matrix m = new Matrix(local);
        switch (shape) {
            case 0:
                shader = new LinearGradient(g[0], g[1], g[2], g[3], colors, positions, Shader.TileMode.CLAMP);
                break;
            case 1: {
                // Android's radial gradients have one circle (the end one):
                // the start circle's radius becomes where the stops begin.
                float r1 = Math.max(1e-3f, g[5]);
                float shift = Math.max(0, Math.min(1, g[2] / r1));
                for (int k = 0; k < positions.length; k++) positions[k] = shift + positions[k] * (1 - shift);
                shader = new RadialGradient(g[3], g[4], r1, colors, positions, Shader.TileMode.CLAMP);
                break;
            }
            default:
                shader = new SweepGradient(g[1], g[2], colors, positions);
                // Its start angle, inside the canvas transform.
                m.preRotate((float) Math.toDegrees(g[0]), g[1], g[2]);
        }
        shader.setLocalMatrix(m);
        return shader;
    }

    private void compositing() {
        if (s.shadowColor >>> 24 != 0 && (s.shadowBlur > 0 || s.shadowX != 0 || s.shadowY != 0)) {
            // Canvas blurs by half the radius as the deviation.
            paint.setShadowLayer(Math.max(0.01f, s.shadowBlur / 2), s.shadowX, s.shadowY, withAlpha(s.shadowColor, s.alpha));
        }
        if (s.composite != 0) {
            if (Build.VERSION.SDK_INT >= 29) paint.setBlendMode(blend(s.composite));
            else paint.setXfermode(new PorterDuffXfermode(porterDuff(s.composite)));
        }
    }

    private void fill(Canvas canvas, Path p) {
        paint.reset();
        paint.setAntiAlias(true);
        paint.setStyle(Paint.Style.FILL);
        applyStyle(true, s.ctm);
        compositing();
        canvas.drawPath(p, paint);
    }

    private void stroke(Canvas canvas, Path p) {
        Matrix inverse = new Matrix();
        if (!s.ctm.invert(inverse)) return;
        Path local = new Path();
        p.transform(inverse, local);
        paint.reset();
        paint.setAntiAlias(true);
        paint.setStyle(Paint.Style.STROKE);
        paint.setStrokeWidth(s.lineWidth);
        paint.setStrokeCap(s.cap == 1 ? Paint.Cap.ROUND : s.cap == 2 ? Paint.Cap.SQUARE : Paint.Cap.BUTT);
        paint.setStrokeJoin(s.join == 1 ? Paint.Join.ROUND : s.join == 2 ? Paint.Join.BEVEL : Paint.Join.MITER);
        paint.setStrokeMiter(s.miter);
        if (s.dash != null && s.dash.length >= 2) {
            float total = 0;
            for (float d : s.dash) total += d;
            if (total > 0) paint.setPathEffect(new DashPathEffect(s.dash, s.dashOffset));
        }
        applyStyle(false, new Matrix());
        compositing();
        canvas.save();
        canvas.concat(s.ctm);
        canvas.drawPath(local, paint);
        canvas.restore();
    }

    private void text(Canvas canvas, String text, float x, float y, float max, boolean stroke) {
        if (text.isEmpty()) return;
        paint.reset();
        paint.setAntiAlias(true);
        paint.setTextSize(s.fontSize);
        paint.setTypeface(TextLayouts.typeface(s.family, s.fontWeight, s.italic));
        // `fontVariantNumeric` replaces the font's number forms (bits as
        // `nsh_core::FontVariant`: 1 is small caps).
        String features = TextLayouts.features(s.numeric != 0 ? (s.variant & 1) | s.numeric : s.variant);
        if (features != null) paint.setFontFeatureSettings(features);
        float width = paint.measureText(text);
        Paint.FontMetrics fm = paint.getFontMetrics();
        float ascent = -fm.ascent, descent = fm.descent;
        float dx;
        switch (s.align) {
            case 4: dx = -width / 2; break; // center
            case 1: case 3: dx = -width; break; // end, right
            default: dx = 0;
        }
        float down;
        switch (s.baseline) {
            case 1: down = ascent; break;
            case 2: down = ascent * 0.8f; break;
            case 3: down = (ascent - descent) / 2; break;
            case 4: case 5: down = -descent; break;
            default: down = 0;
        }
        float squeeze = !Float.isNaN(max) && max < width && width > 0 ? Math.max(0, max / width) : 1;
        if (stroke) {
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(s.lineWidth);
        }
        applyStyle(!stroke, new Matrix());
        compositing();
        canvas.save();
        canvas.concat(s.ctm);
        canvas.translate(x, y + down);
        canvas.scale(squeeze, 1);
        canvas.drawText(text, dx, 0, paint);
        canvas.restore();
    }

    private void image(Canvas canvas, String uri, boolean hasSource, float sx, float sy, float sw, float sh,
            float dx, float dy, float dw, float dh) {
        Images.Image image = images.get(uri);
        if (image == null) return;
        Rect source = null;
        if (hasSource) source = new Rect(Math.round(sx), Math.round(sy), Math.round(sx + sw), Math.round(sy + sh));
        float scale = mounter.density;
        if (Float.isNaN(dw)) dw = (hasSource ? sw : image.width) / scale;
        if (Float.isNaN(dh)) dh = (hasSource ? sh : image.height) / scale;
        paint.reset();
        paint.setFilterBitmap(true);
        paint.setAlpha(Math.round(s.alpha * 255));
        compositing();
        canvas.save();
        canvas.concat(s.ctm);
        RectF dest = new RectF(dx, dy, dx + dw, dy + dh);
        if (image.content instanceof Bitmap) {
            Bitmap bitmap = (Bitmap) image.content;
            if (source != null && image.width > 0) {
                // The source is in the image's pixels; the bitmap may be smaller.
                float k = bitmap.getWidth() / (float) image.width;
                source.set(Math.round(source.left * k), Math.round(source.top * k),
                        Math.round(source.right * k), Math.round(source.bottom * k));
            }
            canvas.drawBitmap(bitmap, source, dest, paint);
        } else if (image.content instanceof Drawable) {
            Drawable d = (Drawable) image.content;
            canvas.clipRect(dest);
            d.setBounds(Math.round(dest.left), Math.round(dest.top), Math.round(dest.right), Math.round(dest.bottom));
            d.draw(canvas);
        }
        canvas.restore();
    }

    private static BlendMode blend(int c) {
        switch (c) {
            case 1: return BlendMode.SRC_IN;
            case 2: return BlendMode.SRC_OUT;
            case 3: return BlendMode.SRC_ATOP;
            case 4: return BlendMode.DST_OVER;
            case 5: return BlendMode.DST_IN;
            case 6: return BlendMode.DST_OUT;
            case 7: return BlendMode.DST_ATOP;
            case 8: return BlendMode.PLUS;
            case 9: return BlendMode.SRC;
            case 10: return BlendMode.XOR;
            case 11: return BlendMode.MULTIPLY;
            case 12: return BlendMode.SCREEN;
            case 13: return BlendMode.OVERLAY;
            case 14: return BlendMode.DARKEN;
            case 15: return BlendMode.LIGHTEN;
            case 16: return BlendMode.COLOR_DODGE;
            case 17: return BlendMode.COLOR_BURN;
            case 18: return BlendMode.HARD_LIGHT;
            case 19: return BlendMode.SOFT_LIGHT;
            case 20: return BlendMode.DIFFERENCE;
            case 21: return BlendMode.EXCLUSION;
            case 22: return BlendMode.HUE;
            case 23: return BlendMode.SATURATION;
            case 24: return BlendMode.COLOR;
            case 25: return BlendMode.LUMINOSITY;
            default: return BlendMode.SRC_OVER;
        }
    }

    private static PorterDuff.Mode porterDuff(int c) {
        switch (c) {
            case 1: return PorterDuff.Mode.SRC_IN;
            case 2: return PorterDuff.Mode.SRC_OUT;
            case 3: return PorterDuff.Mode.SRC_ATOP;
            case 4: return PorterDuff.Mode.DST_OVER;
            case 5: return PorterDuff.Mode.DST_IN;
            case 6: return PorterDuff.Mode.DST_OUT;
            case 7: return PorterDuff.Mode.DST_ATOP;
            case 8: return PorterDuff.Mode.ADD;
            case 9: return PorterDuff.Mode.SRC;
            case 10: return PorterDuff.Mode.XOR;
            case 11: return PorterDuff.Mode.MULTIPLY;
            case 12: return PorterDuff.Mode.SCREEN;
            case 13: return PorterDuff.Mode.OVERLAY;
            case 14: return PorterDuff.Mode.DARKEN;
            case 15: return PorterDuff.Mode.LIGHTEN;
            default: return PorterDuff.Mode.SRC_OVER;
        }
    }
}
