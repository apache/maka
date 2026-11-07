package com.longbridge.nsh;

import android.graphics.BlendMode;
import android.graphics.ColorMatrix;
import android.graphics.ColorMatrixColorFilter;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffColorFilter;
import android.graphics.RenderEffect;
import android.graphics.Shader;
import android.os.Build;
import android.view.PointerIcon;
import android.view.View;
import android.view.animation.PathInterpolator;
import java.nio.ByteBuffer;

/**
 * The effects of a view style beyond `Decor`'s shapes (`encode.rs`
 * `effects`): filters, blend modes, the pointer, transitions and keyframe
 * animations.
 */
final class Effects {
    /** Box shadows (px): dx, dy, blur, spread, inset (1) per layer. */
    float[] shadows = new float[0];
    int[] shadowColors = new int[0];
    Decor.Gradient[] gradients = new Decor.Gradient[0];
    Filters filters, backdrop;
    int blend;
    float outlineWidth, outlineOffset;
    int outlineColor, outlineStyle;
    boolean hidden;
    int cursor;
    /** Transition: property groups (0: none), ms, ms, cubic Bézier. */
    int transitionProps;
    float transitionDuration, transitionDelay;
    final float[] transitionEasing = new float[4];
    /** Keyframes: 0 none, 1 spin, 2 ping, 3 pulse, 4 bounce. */
    int keyframes;
    float animationDuration, animationDelay;
    final float[] animationEasing = new float[4];
    /** -1 repeats forever. */
    int iterations;

    /** Color filters (one composed matrix), blur and a drop shadow. */
    static final class Filters {
        float[] matrix;
        float blur;
        boolean shadow;
        float shadowDx, shadowDy, shadowBlur;
        int shadowColor;

        boolean isEmpty() {
            return matrix == null && blur <= 0 && !shadow;
        }

        boolean same(Filters o) {
            return java.util.Arrays.equals(matrix, o.matrix) && blur == o.blur && shadow == o.shadow
                    && shadowDx == o.shadowDx && shadowDy == o.shadowDy && shadowBlur == o.shadowBlur
                    && shadowColor == o.shadowColor;
        }
    }

    static Effects read(ByteBuffer b, float density) {
        Effects e = new Effects();
        int shadows = b.getInt();
        e.shadows = new float[shadows * 5];
        e.shadowColors = new int[shadows];
        for (int i = 0; i < shadows; i++) {
            for (int k = 0; k < 4; k++) e.shadows[i * 5 + k] = b.getFloat() * density;
            e.shadowColors[i] = b.getInt();
            e.shadows[i * 5 + 4] = b.getInt() != 0 ? 1 : 0;
        }
        int gradients = b.getInt();
        e.gradients = new Decor.Gradient[gradients];
        for (int i = 0; i < gradients; i++) {
            Decor.Gradient g = new Decor.Gradient();
            g.kind = b.getInt();
            switch (g.kind) {
                case 0: g.angle = b.getFloat(); b.getInt(); b.getInt(); break;
                case 1: b.getFloat(); g.right = b.getInt() != 0; g.bottom = b.getInt() != 0; break;
                case 2: g.circle = b.getInt() != 0; g.size = b.getInt(); g.x = b.getFloat(); g.y = b.getFloat(); break;
                default: g.angle = b.getFloat(); g.x = b.getFloat(); g.y = b.getFloat(); break;
            }
            g.repeating = b.getInt() != 0;
            int stops = b.getInt();
            // Negative: stops as written, some in points, placed when the
            // box is known (`Decor.Gradient.place`).
            boolean written = stops < 0;
            if (written) stops = -stops;
            g.colors = new int[stops];
            g.positions = new float[stops];
            if (written) {
                g.values = new float[stops];
                g.units = new int[stops];
            }
            for (int k = 0; k < stops; k++) {
                g.colors[k] = b.getInt();
                float v = b.getFloat();
                if (written) {
                    g.units[k] = b.getInt();
                    g.values[k] = g.units[k] == 2 ? v * density : v;
                } else {
                    g.positions[k] = v;
                }
            }
            // A transparent stop takes its neighbor's hue: fades to
            // transparent do not darken (CSS mixes premultiplied).
            for (int k = 0; k < stops; k++) {
                if ((g.colors[k] >>> 24) != 0) continue;
                for (int n = 1; n < stops; n++) {
                    int j = k + n < stops ? k + n : k - n;
                    if (j >= 0 && j < stops && (g.colors[j] >>> 24) != 0) {
                        g.colors[k] = g.colors[j] & 0x00ffffff;
                        break;
                    }
                }
            }
            e.gradients[i] = g;
        }
        e.filters = filters(b, density);
        e.backdrop = filters(b, density);
        e.blend = b.getInt();
        e.outlineWidth = b.getFloat() * density;
        e.outlineColor = b.getInt();
        e.outlineStyle = b.getInt();
        e.outlineOffset = b.getFloat() * density;
        e.hidden = b.getInt() != 0;
        e.cursor = b.getInt();
        e.transitionProps = b.getInt();
        e.transitionDuration = b.getFloat();
        e.transitionDelay = b.getFloat();
        for (int i = 0; i < 4; i++) e.transitionEasing[i] = b.getFloat();
        e.keyframes = b.getInt();
        e.animationDuration = b.getFloat();
        e.animationDelay = b.getFloat();
        for (int i = 0; i < 4; i++) e.animationEasing[i] = b.getFloat();
        e.iterations = b.getInt();
        return e;
    }

    private static Filters filters(ByteBuffer b, float density) {
        Filters f = new Filters();
        boolean matrix = b.getInt() != 0;
        float[] m = new float[20];
        for (int i = 0; i < 20; i++) m[i] = b.getFloat();
        if (matrix) {
            // Offsets are 0..1 here, 0..255 for Android.
            for (int row = 0; row < 4; row++) m[row * 5 + 4] *= 255;
            f.matrix = m;
        }
        f.blur = b.getFloat() * density;
        f.shadow = b.getInt() != 0;
        f.shadowDx = b.getFloat() * density;
        f.shadowDy = b.getFloat() * density;
        f.shadowBlur = b.getFloat() * density;
        f.shadowColor = b.getInt();
        return f;
    }

    static PathInterpolator interpolator(float[] c) {
        return new PathInterpolator(c[0], c[1], c[2], c[3]);
    }

    /** Filters and the blend mode of `v`: render effects (API 31+) or a layer paint. */
    static void apply(View v, Effects e) {
        Filters f = e.filters;
        boolean renderEffects = Build.VERSION.SDK_INT >= 31;
        if (renderEffects) {
            RenderEffect effect = null;
            if (f.matrix != null) effect = RenderEffect.createColorFilterEffect(new ColorMatrixColorFilter(new ColorMatrix(f.matrix)));
            if (f.blur > 0) {
                // CSS blur radii are the deviation.
                RenderEffect blur = RenderEffect.createBlurEffect(f.blur, f.blur, Shader.TileMode.DECAL);
                effect = effect == null ? blur : RenderEffect.createChainEffect(blur, effect);
            }
            if (f.shadow && (f.shadowColor >>> 24) != 0) {
                RenderEffect source = effect != null ? effect : RenderEffect.createOffsetEffect(0, 0);
                // The content's shape in the shadow color, blurred and moved,
                // under the content.
                RenderEffect shadow = RenderEffect.createColorFilterEffect(
                        new PorterDuffColorFilter(f.shadowColor, PorterDuff.Mode.SRC_IN), source);
                if (f.shadowBlur > 0) {
                    shadow = RenderEffect.createBlurEffect(f.shadowBlur / 2, f.shadowBlur / 2, shadow, Shader.TileMode.DECAL);
                }
                shadow = RenderEffect.createOffsetEffect(f.shadowDx, f.shadowDy, shadow);
                effect = RenderEffect.createBlendModeEffect(shadow, source, BlendMode.SRC_OVER);
            }
            v.setRenderEffect(effect);
        }
        Paint paint = null;
        if (!renderEffects && f.matrix != null) {
            paint = new Paint();
            paint.setColorFilter(new ColorMatrixColorFilter(new ColorMatrix(f.matrix)));
        }
        if (e.blend != 0 && Build.VERSION.SDK_INT >= 29) {
            if (paint == null) paint = new Paint();
            paint.setBlendMode(blendMode(e.blend));
        }
        if (paint != null) {
            v.setLayerType(View.LAYER_TYPE_HARDWARE, paint);
        } else if (v.getLayerType() == View.LAYER_TYPE_HARDWARE && v.getTag(R_LAYER) != null) {
            v.setLayerType(View.LAYER_TYPE_NONE, null);
        }
        v.setTag(R_LAYER, paint != null ? Boolean.TRUE : null);
    }

    /** Tag key marking layers this class set (an id unlikely to clash). */
    private static final int R_LAYER = 0x7f0e7f01;

    private static BlendMode blendMode(int code) {
        switch (code) {
            case 1: return BlendMode.MULTIPLY;
            case 2: return BlendMode.SCREEN;
            case 3: return BlendMode.OVERLAY;
            case 4: return BlendMode.DARKEN;
            case 5: return BlendMode.LIGHTEN;
            case 6: return BlendMode.COLOR_DODGE;
            case 7: return BlendMode.COLOR_BURN;
            case 8: return BlendMode.HARD_LIGHT;
            case 9: return BlendMode.SOFT_LIGHT;
            case 10: return BlendMode.DIFFERENCE;
            case 11: return BlendMode.EXCLUSION;
            case 12: return BlendMode.HUE;
            case 13: return BlendMode.SATURATION;
            case 14: return BlendMode.COLOR;
            case 15: return BlendMode.LUMINOSITY;
            case 16: return BlendMode.DARKEN;
            case 17: return BlendMode.PLUS;
            default: return BlendMode.SRC_OVER;
        }
    }

    /** The pointer over `v` (mice): `cursor`. */
    static void cursor(View v, int code) {
        int type;
        switch (code) {
            case 0: v.setPointerIcon(null); return;
            case 2: type = PointerIcon.TYPE_HAND; break;
            case 3: type = PointerIcon.TYPE_TEXT; break;
            case 4: case 5: type = PointerIcon.TYPE_WAIT; break;
            case 6: type = PointerIcon.TYPE_HELP; break;
            case 7: type = PointerIcon.TYPE_CROSSHAIR; break;
            case 8: type = PointerIcon.TYPE_ALL_SCROLL; break;
            case 9: type = PointerIcon.TYPE_GRAB; break;
            case 10: type = PointerIcon.TYPE_GRABBING; break;
            case 11: type = PointerIcon.TYPE_NO_DROP; break;
            case 12: type = PointerIcon.TYPE_ZOOM_IN; break;
            case 13: type = PointerIcon.TYPE_ZOOM_OUT; break;
            case 14: type = PointerIcon.TYPE_HORIZONTAL_DOUBLE_ARROW; break;
            case 15: type = PointerIcon.TYPE_VERTICAL_DOUBLE_ARROW; break;
            case 16: type = PointerIcon.TYPE_NULL; break;
            case 17: type = PointerIcon.TYPE_TOP_LEFT_DIAGONAL_DOUBLE_ARROW; break;
            case 18: type = PointerIcon.TYPE_TOP_RIGHT_DIAGONAL_DOUBLE_ARROW; break;
            default: type = PointerIcon.TYPE_ARROW;
        }
        v.setPointerIcon(PointerIcon.getSystemIcon(v.getContext(), type));
    }

    /** Offsets a keyframe animation adds to a view's static transform. */
    static final class Motion {
        float rotate, scale = 1, alpha = 1, ty;
    }

    /** The offsets of keyframes `kind` at `fraction` of an iteration, for a `height` px view. */
    static void keyframes(int kind, float fraction, float height, float[] easing, Motion out) {
        out.rotate = 0;
        out.scale = 1;
        out.alpha = 1;
        out.ty = 0;
        switch (kind) {
            case 1: out.rotate = 360 * new PathInterpolator(easing[0], easing[1], easing[2], easing[3]).getInterpolation(fraction); break;
            case 2: {
                float t = Math.min(1, fraction / 0.75f);
                float e = new PathInterpolator(easing[0], easing[1], easing[2], easing[3]).getInterpolation(t);
                out.scale = 1 + e;
                out.alpha = 1 - e;
                break;
            }
            case 3: {
                float t = fraction < 0.5f ? fraction * 2 : (1 - fraction) * 2;
                out.alpha = 1 - 0.5f * new PathInterpolator(0.4f, 0, 0.6f, 1).getInterpolation(t);
                break;
            }
            case 4: {
                // Up a quarter of the height and back: ease out to the
                // ground, ease in to the top (Tailwind's keyframes).
                float up = -0.25f * height;
                if (fraction < 0.5f) {
                    out.ty = up * (1 - new PathInterpolator(0, 0, 0.2f, 1).getInterpolation(fraction * 2));
                } else {
                    out.ty = up * new PathInterpolator(0.8f, 0, 1, 1).getInterpolation((fraction - 0.5f) * 2);
                }
                break;
            }
            default: break;
        }
    }
}
