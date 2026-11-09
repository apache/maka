package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffColorFilter;
import android.graphics.Rect;
import android.graphics.Shader;
import android.graphics.drawable.Animatable;
import android.graphics.drawable.Drawable;
import android.view.View;

/** An image drawn inside the view's rounded shape (always clipped). */
@SuppressLint("ViewConstructor")
final class ImageBox extends View implements Node {
    final Decor decor = new Decor();

    /** An outer box shadow draws outside the bounds, and compositing the
     * view at alpha < 1 into the bounds-clipped offscreen buffer would cut
     * it; such a view reports no overlapping rendering, so the alpha
     * applies per draw op and the shadow fades with the content. */
    @Override
    public boolean hasOverlappingRendering() {
        return !decor.hasOuterShadows();
    }

    final int id;
    int resizeMode; // 0 cover, 1 contain, 2 stretch, 3 center, 4 scale-down
    /**
     * {@code objectPosition}: per axis a distance from the start edge (left, top) or, with the axis's bit 1, the
     * end edge; with its bit 2 a fraction of the free space, else pixels. Bits 0-1 are x's, 2-3 y's. The center
     * by default.
     */
    float positionX = 0.5f, positionY = 0.5f;
    int positionFlags = 2 | (2 << 2);
    String uri;
    /** Size the pending load decodes at. */
    int requestedPx;
    final Images.Callback callback;
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final Matrix matrix = new Matrix();
    private final Path path = new Path();
    private final android.graphics.RectF dest = new android.graphics.RectF();

    ImageBox(Context context, int id, Images.Callback callback, Images.Callback placeholderCallback) {
        super(context);
        this.id = id;
        this.callback = callback;
        this.placeholderCallback = placeholderCallback;
        decor.bordersAbove = true;
        setBackground(decor);
    }

    @Override
    public int nodeId() {
        return id;
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        decor.applyPivot(this);
    }

    /** Press handling, once the view has press listeners. */
    Pressable press;

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    @Override
    public boolean onTouchEvent(android.view.MotionEvent e) {
        return press != null && press.onTouchEvent(e);
    }

    @Override
    public boolean performClick() {
        super.performClick();
        if (press != null) press.click();
        return true;
    }

    /** `placeholder`, `blurRadius` (px), `fadeDuration` (ms, -1: the default). */
    String placeholderUri;
    int blurPx;
    int fadeMs = -1;
    /** Size the pending placeholder load decodes at. */
    int placeholderPx;
    /** The image (not its placeholder) is shown. */
    boolean imageShown;
    final Images.Callback placeholderCallback;

    private int tint;
    /** What is shown: a Bitmap or an animated Drawable. */
    private Object content;
    /** What it fades in over (a placeholder). */
    private Object previous;
    /**
     * The size {@code center} shows an SVG's bitmap at, in pixels: its intrinsic size at the display's density, bounded by the decoded raster (0:
     * a bitmap, shown a pixel per pixel).
     */
    private float contentWidth, contentHeight, previousWidth, previousHeight;
    private final Paint previousPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private long fadeStart;
    private int fading;

    /** `tintColor`: draws the image's opaque pixels in one color (0: none). */
    void setTint(int color) {
        tint = color;
        PorterDuffColorFilter filter = (color >>> 24) == 0 ? null : new PorterDuffColorFilter(color, PorterDuff.Mode.SRC_IN);
        paint.setColorFilter(filter);
        previousPaint.setColorFilter(filter);
        if (content instanceof Drawable) ((Drawable) content).setColorFilter(filter);
        invalidate();
    }

    /** Shows {@code decoded} (a Bitmap or an animated Drawable, or nothing), fading in over {@code fadeMs}. */
    void setImage(Images.Image decoded, int fadeMs) {
        Object image = decoded == null ? null : decoded.content;
        if (content instanceof Drawable && content != image) {
            Drawable old = (Drawable) content;
            if (old instanceof Animatable) ((Animatable) old).stop();
            old.setCallback(null);
        }
        previous = fadeMs > 0 && content instanceof Bitmap ? content : null;
        previousWidth = contentWidth;
        previousHeight = contentHeight;
        previousPaint.setShader(previous == null ? null : shader((Bitmap) previous));
        content = image;
        boolean vector = decoded != null && decoded.vector;
        float density = getResources().getDisplayMetrics().density;
        contentWidth = vector ? decoded.intrinsicWidth * density : 0;
        contentHeight = vector ? decoded.intrinsicHeight * density : 0;
        paint.setShader(image instanceof Bitmap ? shader((Bitmap) image) : null);
        if (image instanceof Drawable) {
            Drawable d = (Drawable) image;
            d.setCallback(this);
            d.setColorFilter(paint.getColorFilter());
            if (d instanceof Animatable) ((Animatable) d).start();
        }
        fading = image == null ? 0 : fadeMs;
        fadeStart = android.os.SystemClock.uptimeMillis();
        invalidate();
    }

    private static BitmapShader shader(Bitmap bitmap) {
        return new BitmapShader(bitmap, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
    }

    @Override
    protected boolean verifyDrawable(Drawable who) {
        return who == content || super.verifyDrawable(who);
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        if (content instanceof Animatable) ((Animatable) content).stop();
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (content instanceof Animatable) ((Animatable) content).start();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        if (getWidth() == 0 || getHeight() == 0) return;
        float alpha = 1;
        if (fading > 0) {
            alpha = Math.min(1, (android.os.SystemClock.uptimeMillis() - fadeStart) / (float) fading);
            if (alpha < 1) postInvalidateOnAnimation();
            else previous = null;
        }
        if (previous != null) draw(canvas, previous, previousWidth, previousHeight, previousPaint, 255);
        if (content != null) draw(canvas, content, contentWidth, contentHeight, paint, Math.round(alpha * 255));
        decor.drawBorders(canvas);
    }

    /**
     * Where content starts along one axis, {@code free} pixels being the view's size less the content's (negative
     * when it overflows): {@code value} from the start or end edge ({@code flags} bit 1), in pixels or ({@code
     * flags} bit 2) as a fraction of the free space, as CSS's {@code object-position} places it.
     */
    private static float place(float free, float value, int flags) {
        float d = (flags & 2) != 0 ? value * free : value;
        return (flags & 1) != 0 ? free - d : d;
    }

    /**
     * Draws {@code image} placed by the resize mode, inside the view's shape; {@code center} uses its intrinsic
     * pixel size within the decoded raster (0: a pixel per pixel).
     */
    private void draw(Canvas canvas, Object image, float naturalWidth, float naturalHeight, Paint paint, int alpha) {
        float w = getWidth(), h = getHeight();
        float bw, bh;
        if (image instanceof Bitmap) {
            bw = ((Bitmap) image).getWidth();
            bh = ((Bitmap) image).getHeight();
        } else {
            bw = Math.max(1, ((Drawable) image).getIntrinsicWidth());
            bh = Math.max(1, ((Drawable) image).getIntrinsicHeight());
        }
        matrix.reset();
        switch (resizeMode) {
            case 2:
                matrix.setScale(w / bw, h / bh);
                break;
            case 3:
            case 4: {
                // Preserve the intrinsic SVG dimensions within the decoded raster, as before.
                float sx = naturalWidth > 0 ? Math.min(1, naturalWidth / bw) : 1;
                float sy = naturalHeight > 0 ? Math.min(1, naturalHeight / bh) : 1;
                if (resizeMode == 4) {
                    // Scale-down: shrunk to fit the view where larger.
                    float fit = Math.min(1, Math.min(w / (bw * sx), h / (bh * sy)));
                    sx *= fit;
                    sy *= fit;
                }
                matrix.setScale(sx, sy);
                matrix.postTranslate(place(w - bw * sx, positionX, positionFlags), place(h - bh * sy, positionY, positionFlags >> 2));
                break;
            }
            default: {
                float scale = resizeMode == 1 ? Math.min(w / bw, h / bh) : Math.max(w / bw, h / bh);
                matrix.setScale(scale, scale);
                matrix.postTranslate(
                        place(w - bw * scale, positionX, positionFlags), place(h - bh * scale, positionY, positionFlags >> 2));
            }
        }
        // Only where the image is (a shader clamps: repeats edge pixels).
        dest.set(0, 0, bw, bh);
        matrix.mapRect(dest);
        canvas.save();
        canvas.clipRect(dest);
        Path shape = decor.shape(new Rect(0, 0, getWidth(), getHeight()), 0, path);
        if (image instanceof Bitmap) {
            paint.getShader().setLocalMatrix(matrix);
            paint.setAlpha(alpha);
            canvas.drawPath(shape, paint);
        } else {
            Drawable d = (Drawable) image;
            canvas.clipPath(shape);
            canvas.concat(matrix);
            d.setBounds(0, 0, (int) bw, (int) bh);
            d.setAlpha(alpha);
            d.draw(canvas);
        }
        canvas.restore();
    }
}
