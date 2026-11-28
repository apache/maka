package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Path;
import android.graphics.Rect;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.widget.HorizontalScrollView;
import android.widget.ScrollView;

/**
 * A container positioning its children at the frames the core computed
 * (no Android layout pass decides anything). Hosts `<view>`, list cells and
 * the root. Children may draw outside (shadows): clipping is explicit.
 *
 * Touch handling follows React Native: `onPressIn` when a finger lands
 * (after a short delay inside scroll views, which may take the touch for a
 * scroll), `onPressOut` when it lifts or leaves, `onLongPress`, `onPress`;
 * drags drive `pan` values; two fingers drive `pinch` / `rotation`.
 */
@SuppressLint("ViewConstructor")
class Box extends ViewGroup implements Node, NshView.ShaderFrames {
    final Mounter mounter;
    final int id;
    /** The events it listens to, kinds below 64 ({@link Mounter#wants} has all). */
    long events;
    final Decor decor = new Decor();

    /** An outer box shadow draws outside the bounds, and compositing the
     * view at alpha < 1 into the bounds-clipped offscreen buffer would cut
     * it; such a view reports no overlapping rendering, so the alpha
     * applies per draw op and the shadow fades with the content. */
    @Override
    public boolean hasOverlappingRendering() {
        return !decor.hasOuterShadows();
    }

    boolean clip;
    /** 0 auto, 1 none, 2 box-none, 3 box-only. */
    int pointerEvents;
    /** Opacity factor while pressed, or NaN. */
    /** Pan axis lock: 0 free, 1 horizontal, 2 vertical. */
    int panAxis;
    boolean pinchable, rotatable;
    /**
     * The area descendants cover outside the bounds (px, own coordinates;
     * `MountItem::Overflow`), or null: touches there go to the children.
     */
    android.graphics.RectF overflow;
    /** The child taking the current gesture where ViewGroup would not deliver it (outside its bounds). */
    private View overflowTarget;
    /** Children go here while the box both clips and casts a shadow. */
    private Box content;
    /**
     * True on a wrapper a split created (another box's {@link #content}): it
     * only draws and clips. The event messages update the view the mounter
     * maps the shared id to (the outer box), so a wrapper handling a touch
     * itself would consume it with an empty event mask and dispatch nothing;
     * its frame is the outer box's, so every touch it would take is the
     * outer box's to take.
     */
    private boolean contentWrapper;
    private final Path clipPath = new Path();
    /** Whether a shader draws its box (`SHADER`; libnsh renders it). */
    private boolean shader;
    /**
     * What it draws (`nsh_core::shader::ShaderRole`): {@link #FILL} under the
     * children, {@link #EFFECT} through them, {@link #TRANSITION} changing them,
     * {@link #SCREEN} and {@link #SCREEN_TRANSITION} the same over the whole
     * `NshView` (this box has no size then).
     */
    private int shaderRole;
    static final int FILL = 0, EFFECT = 1, TRANSITION = 2, SCREEN = 3, SCREEN_TRANSITION = 4;
    /** The pictures it reads, bit `nsh_core::shader::ShaderInput::index`. */
    private int shaderInputs;
    static final int CONTENT = 0, BACKDROP = 1, FROM = 2, TO = 3;
    /** Its frame shows instead of the children (or the surface). */
    private boolean replaced;
    /** How far its frames reach beyond the box, px. */
    private int shaderOverflow;
    /** The children changed since their picture was taken. */
    private boolean stale;
    /** Until when (`uptimeMillis`) a transition started here runs. */
    private long transitionEnd;
    private Pictures pictures, backdropPictures;
    /** What showed when a transition started, shown until its first frame comes. */
    private Bitmap fromBitmap;
    private final android.view.ViewTreeObserver.OnPreDrawListener picturing = () -> {
        takePictures();
        return true;
    };
    private boolean watching;
    /** The shader's last frame, reused while its size stays. */
    private Bitmap shaderBitmap;
    private final Path shaderPath = new Path();
    private final Rect shaderBounds = new Rect();
    private final android.graphics.Paint shaderPaint = new android.graphics.Paint(android.graphics.Paint.FILTER_BITMAP_FLAG);

    Box(Context context, Mounter mounter, int id) {
        super(context);
        this.mounter = mounter;
        this.id = id;
        setClipChildren(false);
        setClipToPadding(false);
        setBackground(decor);
        setWillNotDraw(false);
    }

    @Override
    public int nodeId() {
        return id;
    }

    /** Where children are added. */
    ViewGroup container() {
        return content != null ? content : this;
    }

    /**
     * Assistive technologies see only a child component that stands for its
     * siblings ({@link MenuButtonComponent}'s button over the app's content,
     * as iOS's {@code accessibilityElements}): the content under it is drawn,
     * not read twice. The siblings keep their own accessibility settings,
     * which {@link A11y} owns.
     */
    @Override
    public void addChildrenForAccessibility(java.util.ArrayList<View> out) {
        if (content == null) {
            for (int i = 0; i < getChildCount(); i++) {
                View c = getChildAt(i);
                if (c instanceof ComponentBox && ((ComponentBox) c).component instanceof MenuButtonComponent) {
                    c.addChildrenForAccessibility(out);
                    return;
                }
            }
        }
        super.addChildrenForAccessibility(out);
    }

    /** Frame of a child, in px, relative to its parent. Margin layout params,
     * so frame layouts (screens, modals) can host core-placed views. */
    static final class Frame extends ViewGroup.MarginLayoutParams {
        int left, top, right, bottom;

        Frame() {
            super(0, 0);
        }
    }

    static Frame frame(View v) {
        ViewGroup.LayoutParams p = v.getLayoutParams();
        if (p instanceof Frame) return (Frame) p;
        Frame f = new Frame();
        v.setLayoutParams(f);
        return f;
    }

    /** Places `v` at its frame right away (no layout pass). */
    static void place(View v) {
        Frame f = frame(v);
        int w = f.right - f.left, h = f.bottom - f.top;
        f.width = w;
        f.height = h;
        v.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY));
        v.layout(f.left, f.top, f.right, f.bottom);
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        setMeasuredDimension(MeasureSpec.getSize(widthSpec), MeasureSpec.getSize(heightSpec));
        for (int i = 0; i < getChildCount(); i++) {
            View child = getChildAt(i);
            if (child == content) {
                child.measure(widthSpec, heightSpec);
                continue;
            }
            Frame f = frame(child);
            child.measure(MeasureSpec.makeMeasureSpec(f.right - f.left, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(f.bottom - f.top, MeasureSpec.EXACTLY));
        }
    }

    @Override
    protected void onLayout(boolean changed, int l, int t, int r, int b) {
        for (int i = 0; i < getChildCount(); i++) {
            View child = getChildAt(i);
            if (child == content) {
                child.layout(0, 0, r - l, b - t);
                continue;
            }
            Frame f = frame(child);
            child.layout(f.left, f.top, f.right, f.bottom);
        }
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        invalidateOutline();
        decor.applyPivot(this);
        if (content != null) content.layout(0, 0, w, h);
        if (shader && !screen()) {
            shaderSize();
            stale = true;
        }
    }

    // --- Shaders -----------------------------------------------------------------

    /**
     * A shader draws (or no longer does): its `role`, how far it reaches
     * beyond the box (`overflow`, points) and the pictures it reads
     * (`inputs`).
     */
    void setShader(boolean on, int role, float overflow, int inputs) {
        shader = on;
        shaderRole = on ? role : FILL;
        shaderInputs = on ? inputs : 0;
        shaderOverflow = Math.round(Math.max(0, overflow) * mounter.density);
        stale = true;
        // A screen shader draws over the surface while it is in the window;
        // one not in it yet takes the surface once attached.
        if (on && screen()) {
            if (isAttachedToWindow()) takeScreen();
        } else {
            giveUpScreen();
        }
        if (on) {
            shaderSize();
        } else {
            shaderBitmap = null;
            replaced = false;
            transitionEnd = 0;
            fromBitmap = null;
            if (pictures != null) pictures.release();
            if (backdropPictures != null) backdropPictures.release();
            pictures = backdropPictures = null;
            shown().invalidate();
        }
        watch();
    }

    /** Its node is deleted: its shader goes, with its pictures and the surface it drew over. */
    void dropShader() {
        if (shader) setShader(false, FILL, 0, 0);
    }

    /** Whether a shader draws it, or a transition's picture stands in for its children. */
    boolean hasShader() {
        return shader || fromBitmap != null;
    }

    /** Whether it draws over the whole surface. */
    boolean screen() {
        return shaderRole == SCREEN || shaderRole == SCREEN_TRANSITION;
    }

    /**
     * Draws over the surface (a screen shader's frame, the surface as it is
     * until one comes), in place of another screen shader's frame.
     */
    private void takeScreen() {
        NshView host = mounter.host;
        if (host.screen == this) return;
        host.screen = this;
        // The surface changed unseen while another shader (or none) had it.
        stale = true;
        host.invalidate();
    }

    /**
     * Stops drawing over the surface, which draws itself again: its display
     * list holds this shader's frame instead of the views. A screen shader
     * that replaced this one keeps it.
     */
    private void giveUpScreen() {
        NshView host = mounter.host;
        if (host.screen != this) return;
        host.screen = null;
        host.invalidate();
    }

    private boolean reads(int input) {
        return (shaderInputs & 1 << input) != 0;
    }

    /** The view its frame shows in. */
    private View shown() {
        return screen() ? mounter.host : this;
    }

    /** Tells libnsh the size its frames are rendered at (the surface's for a screen shader). */
    void shaderSize() {
        long handle = mounter.handle();
        View v = shown();
        if (handle != 0 && Native.shaderSize(handle, id, v.getWidth(), v.getHeight())) mounter.host.requestFrames();
    }

    /** What its pictures show changed (`SHADER_INPUT`). */
    void picturesChanged() {
        stale = true;
        if (watching) shown().invalidate();
    }

    /**
     * A screen shader's surface: a view in it draws anew, which brings the
     * window frame its picture is taken before.
     */
    void surfaceChanged() {
        stale = true;
    }

    @Override
    public void onDescendantInvalidated(View child, View target) {
        super.onDescendantInvalidated(child, target);
        stale = true;
    }

    /** Whether a transition started here still runs. */
    private boolean transitioning() {
        return replaced || android.os.SystemClock.uptimeMillis() < transitionEnd;
    }

    /** Whether pictures are taken before every window frame. */
    private boolean needsPictures() {
        if (!shader || !Pictures.supported()) return false;
        boolean effect = shaderRole == EFFECT || shaderRole == SCREEN;
        boolean transition = shaderRole == TRANSITION || shaderRole == SCREEN_TRANSITION;
        return effect && reads(CONTENT) || transition && reads(TO) && transitioning() || reads(BACKDROP);
    }

    /** Starts or stops taking pictures before window frames, as needed. */
    private void watch() {
        boolean want = needsPictures() && isAttachedToWindow();
        if (want == watching) return;
        watching = want;
        if (want) getViewTreeObserver().addOnPreDrawListener(picturing);
        else getViewTreeObserver().removeOnPreDrawListener(picturing);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (shader && screen() && mounter.host.screen == null) takeScreen();
        watch();
    }

    @Override
    protected void onDetachedFromWindow() {
        // Its subtree left the window, maybe before its node is deleted:
        // the surface shows as it is (moved, it takes it back when attached).
        giveUpScreen();
        if (watching) {
            getViewTreeObserver().removeOnPreDrawListener(picturing);
            watching = false;
        }
        // Each holds a HardwareRenderer and an ImageReader: they go now and
        // are made again for the first picture once it is back, which is
        // due then (what it shows may have changed out of the window).
        if (pictures != null) pictures.release();
        if (backdropPictures != null) backdropPictures.release();
        pictures = backdropPictures = null;
        stale = true;
        super.onDetachedFromWindow();
    }

    /**
     * Before a window frame: the pictures that changed go to libnsh. The
     * children (a screen shader's surface: `NshView.onDescendantInvalidated`)
     * are pictured only after they drew anew; the backdrop before every
     * frame, libnsh dropping one equal to the last.
     */
    private void takePictures() {
        long handle = mounter.handle();
        if (handle == 0 || !needsPictures()) {
            watch();
            return;
        }
        boolean more = false;
        if (stale) {
            int input = shaderRole == EFFECT || shaderRole == SCREEN ? CONTENT : TO;
            if (reads(input)) more |= picture(input, false);
            stale = false;
        }
        if (reads(BACKDROP)) more |= picture(BACKDROP, false);
        if (more) mounter.host.requestFrames();
    }

    /**
     * Takes picture `input` (the backdrop, or what the children draw: `now`,
     * what shows on screen, the frame where it replaces them), covering the
     * box and its overflow; whether libnsh wants a frame.
     */
    private boolean picture(int input, boolean now) {
        View v = shown();
        int m = screen() ? 0 : shaderOverflow;
        int w = v.getWidth() + 2 * m, h = v.getHeight() + 2 * m;
        boolean backdrop = input == BACKDROP;
        if (backdrop && backdropPictures == null) backdropPictures = new Pictures();
        if (!backdrop && pictures == null) pictures = new Pictures();
        boolean[] wants = new boolean[1];
        long handle = mounter.handle();
        boolean taken = (backdrop ? backdropPictures : pictures).take(w, h, canvas -> {
            canvas.translate(m, m);
            if (backdrop) Pictures.drawBehind(canvas, v);
            else if (now && (replaced || fromBitmap != null)) drawFrame(canvas);
            else if (screen()) mounter.host.drawSurface(canvas);
            else drawChildren(canvas);
        }, (pixels, pw, ph, stride) -> {
            if (input == FROM) keepFrom(pixels, pw, ph, stride);
            wants[0] = Native.shaderInput(handle, id, input, pixels, pw, ph, stride);
        });
        return taken && wants[0];
    }

    /** Copies the `from` rows (`stride` bytes apart) into {@link #fromBitmap}. */
    private void keepFrom(java.nio.ByteBuffer pixels, int width, int height, int stride) {
        if (fromBitmap == null || fromBitmap.getWidth() != width || fromBitmap.getHeight() != height) {
            fromBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        }
        if (stride == width * 4) {
            fromBitmap.copyPixelsFromBuffer(pixels);
            return;
        }
        java.nio.ByteBuffer tight = java.nio.ByteBuffer.allocateDirect(width * height * 4);
        for (int y = 0; y < height; y++) {
            pixels.limit(y * stride + width * 4).position(y * stride);
            tight.put(pixels);
        }
        tight.rewind();
        fromBitmap.copyPixelsFromBuffer(tight);
    }

    /**
     * A transition starts (`SHADER_TRANSITION`), before the rest of its batch:
     * what shows now becomes its `from`, and its progress runs over `ms`.
     */
    void startTransition(float ms) {
        long handle = mounter.handle();
        boolean transition = shaderRole == TRANSITION || shaderRole == SCREEN_TRANSITION;
        if (!shader || !transition || handle == 0 || !Pictures.supported()) return;
        if (shown().getWidth() <= 0 || shown().getHeight() <= 0) return;
        if (!picture(FROM, true) || !Native.shaderTransition(handle, id, ms)) {
            // No run (no GPU): the children show as they are, not the
            // picture of what showed.
            if (!transitioning()) fromBitmap = null;
            return;
        }
        transitionEnd = android.os.SystemClock.uptimeMillis() + Math.round(ms);
        stale = true;
        shown().invalidate();
        mounter.host.requestFrames();
        watch();
    }

    /**
     * A new frame: premultiplied RGBA rows, copied before returning (the
     * buffer is libnsh's); whether it `replaces` the children, how far it
     * reaches beyond the box (`overflow`, points).
     */
    @Override
    public void shaderFrame(java.nio.ByteBuffer pixels, int width, int height, boolean replaces, float overflow) {
        if (!shader) return;
        if (pixels == null || width <= 0 || height <= 0) {
            shaderBitmap = null;
        } else {
            if (shaderBitmap == null || shaderBitmap.getWidth() != width || shaderBitmap.getHeight() != height) {
                shaderBitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
            }
            shaderBitmap.copyPixelsFromBuffer(pixels);
        }
        shaderOverflow = Math.round(Math.max(0, overflow) * mounter.density);
        replaced = replaces && shaderBitmap != null;
        if (replaced || !transitioning()) fromBitmap = null;
        shown().invalidate();
        watch();
    }

    /** The shader's frame, stretched over the box inside its rounded corners, under the children. */
    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (shaderRole != FILL || shaderBitmap == null || getWidth() <= 0 || getHeight() <= 0) return;
        shaderBounds.set(0, 0, getWidth(), getHeight());
        canvas.save();
        if (decor.rounded()) canvas.clipPath(decor.shape(shaderBounds, 0, shaderPath));
        else canvas.clipRect(shaderBounds);
        shaderBounds.inset(-shaderOverflow, -shaderOverflow);
        canvas.drawBitmap(shaderBitmap, null, shaderBounds, shaderPaint);
        canvas.restore();
    }

    /**
     * Draws the frame where it replaces the children (or the surface), from
     * the box's top-left, or what showed when a transition started until its
     * first frame comes; false where they show as they are.
     */
    private boolean drawFrame(Canvas canvas) {
        Bitmap bitmap = replaced ? shaderBitmap : transitioning() ? fromBitmap : null;
        if (bitmap == null) return false;
        int m = screen() ? 0 : shaderOverflow;
        View v = shown();
        shaderBounds.set(-m, -m, v.getWidth() + m, v.getHeight() + m);
        canvas.drawBitmap(bitmap, null, shaderBounds, shaderPaint);
        return true;
    }

    /** Draws the surface's frame for a screen shader; false where the surface shows as it is. */
    boolean drawScreen(Canvas canvas) {
        return drawFrame(canvas);
    }

    /** Applies clipping after a style change. */
    void updateClip() {
        boolean split = clip && decor.hasOuterShadows();
        if (split && content == null) {
            // Clipping this view would clip its shadow: children move into a
            // content box that clips instead.
            content = new Box(getContext(), mounter, id);
            content.setBackground(null);
            content.setClickable(false);
            content.contentWrapper = true;
            while (getChildCount() > 0) {
                View child = getChildAt(0);
                removeViewAt(0);
                content.addView(child);
            }
            addView(content);
            content.layout(0, 0, getWidth(), getHeight());
        } else if (!split && content != null) {
            Box old = content;
            content = null;
            removeView(old);
            while (old.getChildCount() > 0) {
                View child = old.getChildAt(0);
                old.removeViewAt(0);
                addView(child);
            }
        }
        if (content != null) {
            System.arraycopy(decor.radii, 0, content.decor.radii, 0, 4);
            content.decor.continuous = decor.continuous;
            content.clip = true;
            content.decor.clip(content, true);
            decor.clip(this, false);
        } else {
            decor.clip(this, clip);
        }
        invalidate();
    }

    @Override
    public void draw(Canvas canvas) {
        // `clipPath` clips everything, its shadows and children included.
        decor.drawClipped(canvas, this, () -> {
            if (decor.masks.length == 0) super.draw(canvas);
            else decor.drawMasked(canvas, this, () -> super.draw(canvas));
        });
    }

    @Override
    protected void dispatchDraw(Canvas canvas) {
        // An effect, or a running transition, shows its frame instead (the
        // children still take touches and stay accessible).
        if (!screen() && drawFrame(canvas)) return;
        drawChildren(canvas);
    }

    /** Draws the children as they are. */
    private void drawChildren(Canvas canvas) {
        // The outline clips at the border's outer edge, so children would cover
        // the border at the corners: like CSS, a uniform border clips inside it.
        float inset = clip && decor.rounded() && decor.hasBorder() && decor.uniformBorder() ? decor.borderWidths[0] : 0;
        if ((decor.needsPathClip(clip) || inset > 0) && content == null) {
            Path shape = decor.shape(new Rect(0, 0, getWidth(), getHeight()), inset, clipPath);
            if (decor.continuous && canvas.isHardwareAccelerated() && outside(shape, inset)) {
                drawInCorners(canvas);
                return;
            }
            canvas.save();
            canvas.clipPath(shape);
            super.dispatchDraw(canvas);
            canvas.restore();
        } else {
            super.dispatchDraw(canvas);
        }
    }

    /**
     * Draws the children clipped to continuous corners without clipping to
     * their path. The GPU clips to a path of cubics through a coverage mask
     * made for each draw inside it, every frame: the gallery's index, a
     * banner of 330 dots and cards, uploaded 440 textures a frame. Here the
     * children are drawn clipped to rectangles (the shape's box but its
     * corners' squares), which the GPU clips exactly, and into a small layer
     * per corner's square, where what lies outside the corner
     * ({@link #outside}) is erased: those paths stay while the box does, so
     * their coverage is made once. A box too small for its corners' squares
     * to leave a middle is drawn into one layer, and so is one with a child
     * drawn through a layer of its own ({@link Effects#layered}): drawn in
     * seven pieces, each under another clip, hwui would filter the child's
     * layer again for each (a blurred child: seven blurs a frame, the
     * gallery's Aurora card at 75–85 % janky frames on a Pixel 10 Pro).
     */
    private void drawInCorners(Canvas canvas) {
        float left = edges[0], top = edges[1], right = edges[2], bottom = edges[3];
        float l = edges[4], t = edges[5], r = edges[6], b = edges[7];
        if (l >= r || t >= b || layeredChild()) {
            int layer = canvas.saveLayer(left, top, right, bottom, null);
            canvas.clipRect(left, top, right, bottom);
            super.dispatchDraw(canvas);
            for (Path p : outside) canvas.drawPath(p, eraser);
            canvas.restoreToCount(layer);
            return;
        }
        float[][] bands = {{left, t, right, b}, {l, top, r, t}, {l, b, r, bottom}};
        for (float[] band : bands) {
            if (band[2] <= band[0] || band[3] <= band[1]) continue;
            canvas.save();
            canvas.clipRect(band[0], band[1], band[2], band[3]);
            super.dispatchDraw(canvas);
            canvas.restore();
        }
        float[][] squares = {{left, top, l, t}, {r, top, right, t}, {r, b, right, bottom}, {left, b, l, bottom}};
        for (int q = 0; q < 4; q++) {
            float[] s = squares[q];
            if (s[2] <= s[0] || s[3] <= s[1]) continue;
            int layer = canvas.saveLayer(s[0], s[1], s[2], s[3], null);
            canvas.clipRect(s[0], s[1], s[2], s[3]);
            super.dispatchDraw(canvas);
            canvas.drawPath(outside[q], eraser);
            canvas.restoreToCount(layer);
        }
    }

    /** Whether a child draws through a layer of its own. */
    private boolean layeredChild() {
        for (int i = 0; i < getChildCount(); i++) {
            if (Effects.layered(getChildAt(i))) return true;
        }
        return false;
    }

    /**
     * What lies outside continuous corners within the shape's box, one piece
     * per quarter of it (each only near its corner), for
     * {@link #drawInCorners}.
     */
    private final Path[] outside = {new Path(), new Path(), new Path(), new Path()};
    /**
     * For {@link #drawInCorners} (px): the shape's box (left, top, right,
     * bottom), then where its corners' squares end along each side (the
     * left ones' right edge, the top ones' bottom edge, the right ones' left
     * edge, the bottom ones' top edge), on whole pixels so the bands and the
     * squares meet on pixel edges (`clipRect` does not antialias).
     */
    private final float[] edges = new float[8];
    /** What {@link #outside} is for: width, height, inset and the four radii. */
    private final float[] outsideFor = new float[7];
    private android.graphics.Paint eraser;

    /** Updates {@link #outside} for `shape`; false where the paths could not be made. */
    private boolean outside(Path shape, float inset) {
        float w = getWidth(), h = getHeight();
        float[] key = {w, h, inset, decor.radii[0], decor.radii[1], decor.radii[2], decor.radii[3]};
        if (eraser != null && java.util.Arrays.equals(key, outsideFor)) return true;
        float left = inset, top = inset, right = w - inset, bottom = h - inset;
        float cx = (left + right) / 2, cy = (top + bottom) / 2;
        float[][] quarters = {{left, top, cx, cy}, {cx, top, right, cy}, {cx, cy, right, bottom}, {left, cy, cx, bottom}};
        android.graphics.RectF[] at = new android.graphics.RectF[4];
        for (int q = 0; q < 4; q++) {
            Path p = outside[q];
            p.reset();
            p.addRect(quarters[q][0], quarters[q][1], quarters[q][2], quarters[q][3], Path.Direction.CW);
            if (!p.op(shape, Path.Op.DIFFERENCE)) {
                eraser = null;
                return false;
            }
            at[q] = new android.graphics.RectF();
            if (!p.isEmpty()) p.computeBounds(at[q], true);
        }
        edges[0] = left;
        edges[1] = top;
        edges[2] = right;
        edges[3] = bottom;
        edges[4] = (float) Math.ceil(Math.max(at[0].isEmpty() ? left : at[0].right, at[3].isEmpty() ? left : at[3].right));
        edges[5] = (float) Math.ceil(Math.max(at[0].isEmpty() ? top : at[0].bottom, at[1].isEmpty() ? top : at[1].bottom));
        edges[6] = (float) Math.floor(Math.min(at[1].isEmpty() ? right : at[1].left, at[2].isEmpty() ? right : at[2].left));
        edges[7] = (float) Math.floor(Math.min(at[2].isEmpty() ? bottom : at[2].top, at[3].isEmpty() ? bottom : at[3].top));
        if (eraser == null) {
            eraser = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
            eraser.setXfermode(new android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.DST_OUT));
        }
        System.arraycopy(key, 0, outsideFor, 0, key.length);
        return true;
    }

    // --- Hover routing: pointerEvents -----------------------------------------

    /*
     * Hovers follow pointerEvents as touches do (below). Android gives a
     * hover to the topmost view under the pointer that handles it, and a
     * clickable view handles it whatever its pointerEvents. So an inert
     * overlay (pointerEvents none, a press-to-dismiss scrim kept mounted
     * while hidden) took the hovers of the views under it, and neither a
     * mouse nor a screen reader's touch exploration (TalkBack explores with
     * hover events) reached them.
     *
     * ViewGroup keeps its own hover state and sends no exit or enter when
     * only pointerEvents changes: a box that turns inert while hovered stays
     * its parent's hover target, with no exit until the pointer leaves its
     * area (a full-screen overlay's never), so it sends itself the exit.
     */

    /** The last hover this box passed on, to its children or itself, was not an exit. */
    private boolean hoverPassed;
    /** The last hover this box handled itself was not an exit. */
    private boolean hoverSelf;

    @Override
    protected boolean dispatchHoverEvent(MotionEvent e) {
        boolean exit = e.getActionMasked() == MotionEvent.ACTION_HOVER_EXIT;
        if (pointerEvents == 1) {
            if (!hoverPassed) return false;
            hoverPassed = false;
            if (exit) return super.dispatchHoverEvent(e);
            hoverAs(e, MotionEvent.ACTION_HOVER_EXIT, true);
            return false;
        }
        hoverPassed = !exit;
        return super.dispatchHoverEvent(e);
    }

    @Override
    public boolean onInterceptHoverEvent(MotionEvent e) {
        if (pointerEvents == 3) return true;
        return super.onInterceptHoverEvent(e);
    }

    @Override
    public boolean onHoverEvent(MotionEvent e) {
        int action = e.getActionMasked();
        boolean exit = action == MotionEvent.ACTION_HOVER_EXIT;
        if (pointerEvents == 2) {
            if (!hoverSelf) return false;
            hoverSelf = false;
            if (exit) return super.onHoverEvent(e);
            hoverAs(e, MotionEvent.ACTION_HOVER_EXIT, false);
            return false;
        }
        // Box-none no longer: the group, which counted this view hovered all
        // along, sends a move, not the enter that marks it hovered.
        if (!hoverSelf && action == MotionEvent.ACTION_HOVER_MOVE) hoverAs(e, MotionEvent.ACTION_HOVER_ENTER, false);
        hoverSelf = !exit;
        return super.onHoverEvent(e);
    }

    /** {@code e} as {@code action}, through the group (children and self) or to this view only. */
    private void hoverAs(MotionEvent e, int action, boolean group) {
        MotionEvent copy = MotionEvent.obtainNoHistory(e);
        copy.setAction(action);
        if (group) super.dispatchHoverEvent(copy);
        else super.onHoverEvent(copy);
        copy.recycle();
    }

    // --- Touch routing: pointerEvents and hitSlop -----------------------------

    // The down time of the touch whose DOWN this view, or a view inside it, took; -1 for none.
    private long tookDown = -1;

    @Override
    public boolean dispatchTouchEvent(MotionEvent e) {
        boolean handled = dispatchTouch(e);
        if (e.getActionMasked() == MotionEvent.ACTION_DOWN) {
            tookDown = handled ? e.getDownTime() : -1;
        }
        return handled;
    }

    /**
     * Whether this view, or a view inside it, took the DOWN of a touch: the views on the touch's path, which a
     * scroll view around asks about to find the pan the touch went to.
     *
     * @param downTime the down time of the touch
     * @return whether the touch's DOWN went to this view or into it
     */
    boolean took(long downTime) {
        return tookDown == downTime;
    }

    private boolean dispatchTouch(MotionEvent e) {
        if (pointerEvents == 1) return false;
        int action = e.getActionMasked();
        // Outside its clip path, neither the box nor its children: the touch
        // goes on to what is under it.
        if (action == MotionEvent.ACTION_DOWN && decor.clipsOut(this, e.getX(), e.getY())) {
            overflowTarget = null;
            return false;
        }
        if (action == MotionEvent.ACTION_DOWN) {
            overflowTarget = null;
            // ViewGroup only delivers a touch to a child that contains it: a
            // touch on a descendant placed outside its parent (a dropdown
            // under its field) goes to the child whose area holds it, and
            // a touch outside this box (delivered so by its parent) only
            // to its children, never to the box itself.
            float x = e.getX(), y = e.getY();
            boolean outside = x < 0 || y < 0 || x >= getWidth() || y >= getHeight();
            if (outside || hasOverflowingChild()) {
                View target = pointerEvents == 3 ? null : overflowChild(x, y, outside);
                if (target != null && dispatchTo(target, e)) {
                    overflowTarget = target;
                    return true;
                }
                // Outside this box but in a child's hit slop, which the
                // box's area takes in: moved inside the child, as below.
                if (outside && pointerEvents != 3 && mounter.hasHitSlop()) {
                    View slop = slopTarget(x, y);
                    if (slop != null && dispatchInside(slop, e)) return true;
                }
                if (outside) return false;
            }
        } else if (overflowTarget != null) {
            boolean handled = dispatchTo(overflowTarget, e);
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) overflowTarget = null;
            return handled;
        }
        if (action == MotionEvent.ACTION_DOWN && mounter.hasHitSlop()) {
            View target = slopTarget(e.getX(), e.getY());
            if (target != null) return dispatchInside(target, e);
        }
        return super.dispatchTouchEvent(e);
    }

    /**
     * A touch in child {@code target}'s hit slop: moved inside the child, so
     * the regular dispatch delivers it (and the rest of the gesture) there.
     */
    private boolean dispatchInside(View target, MotionEvent e) {
        MotionEvent inside = MotionEvent.obtain(e);
        float x = clamp(e.getX(), target.getLeft() + 1, target.getRight() - 1);
        float y = clamp(e.getY(), target.getTop() + 1, target.getBottom() - 1);
        inside.offsetLocation(x - e.getX(), y - e.getY());
        boolean handled = super.dispatchTouchEvent(inside);
        inside.recycle();
        return handled;
    }

    private boolean hasOverflowingChild() {
        ViewGroup group = container();
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (c instanceof Box && ((Box) c).overflow != null) return true;
        }
        return false;
    }

    /** ({@code x}, {@code y}) of this box in child {@code c}. */
    private float[] inChild(View c, float x, float y) {
        ViewGroup group = container();
        float[] pt = {x, y};
        if (group != this) {
            pt[0] -= group.getLeft();
            pt[1] -= group.getTop();
        }
        pt[0] += group.getScrollX() - c.getLeft();
        pt[1] += group.getScrollY() - c.getTop();
        android.graphics.Matrix m = c.getMatrix();
        if (!m.isIdentity()) {
            android.graphics.Matrix inverse = new android.graphics.Matrix();
            if (m.invert(inverse)) inverse.mapPoints(pt);
        }
        return pt;
    }

    /**
     * The topmost child to deliver a touch at ({@code x}, {@code y}) to
     * that ViewGroup would not: one whose overflow area holds it, or (with
     * {@code inBounds}) one that contains it. Null when a child above
     * contains the point (the regular dispatch delivers it).
     */
    private View overflowChild(float x, float y, boolean inBounds) {
        ViewGroup group = container();
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (c.getVisibility() != VISIBLE) continue;
            float[] pt = inChild(c, x, y);
            // Clipped out of the child: the point is for those under it.
            Decor clipped = Decor.of(c);
            if (clipped != null && clipped.clipsOut(c, pt[0], pt[1])) continue;
            if (pt[0] >= 0 && pt[1] >= 0 && pt[0] < c.getWidth() && pt[1] < c.getHeight()) {
                return inBounds ? c : null;
            }
            if (c instanceof Box) {
                Box b = (Box) c;
                if (b.overflow != null && b.pointerEvents != 1 && b.pointerEvents != 3 && !b.clip
                        && b.overflow.contains(pt[0], pt[1])) return c;
            }
        }
        return null;
    }

    /** Delivers {@code e} (of this box) to child {@code c}, in its coordinates. */
    private boolean dispatchTo(View c, MotionEvent e) {
        ViewGroup group = container();
        MotionEvent local = MotionEvent.obtain(e);
        float dx = group.getScrollX() - c.getLeft(), dy = group.getScrollY() - c.getTop();
        if (group != this) {
            dx -= group.getLeft();
            dy -= group.getTop();
        }
        local.offsetLocation(dx, dy);
        android.graphics.Matrix m = c.getMatrix();
        if (!m.isIdentity()) {
            android.graphics.Matrix inverse = new android.graphics.Matrix();
            if (m.invert(inverse)) local.transform(inverse);
        }
        boolean handled = c.dispatchTouchEvent(local);
        local.recycle();
        return handled;
    }

    private static float clamp(float v, float min, float max) {
        return Math.max(min, Math.min(max, v));
    }

    /** The child whose hit slop (but no child's bounds) contains the point. */
    private View slopTarget(float x, float y) {
        ViewGroup group = container();
        float ox = group == this ? 0 : group.getLeft(), oy = group == this ? 0 : group.getTop();
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (c.getVisibility() == VISIBLE && contains(c, x - ox, y - oy, null)) return null;
        }
        for (int i = group.getChildCount() - 1; i >= 0; i--) {
            View c = group.getChildAt(i);
            if (!(c instanceof Node) || c.getVisibility() != VISIBLE) continue;
            float[] slop = mounter.hitSlop(((Node) c).nodeId());
            if (slop != null && contains(c, x - ox, y - oy, slop)) return c;
        }
        return null;
    }

    private static boolean contains(View c, float x, float y, float[] slop) {
        float t = 0, r = 0, b = 0, l = 0;
        if (slop != null) {
            t = slop[0];
            r = slop[1];
            b = slop[2];
            l = slop[3];
        }
        float left = c.getLeft() + c.getTranslationX(), top = c.getTop() + c.getTranslationY();
        return x >= left - l && x < left + c.getWidth() + r && y >= top - t && y < top + c.getHeight() + b;
    }

    // --- Gestures ----------------------------------------------------------

    private float downRawX, downRawY;
    /** This touch never starts the pan: it went down away from an edge pan's edge, or its activation failed. */
    private boolean panRefused;
    /** Where the press went down (for the ripple). */
    private float pressX, pressY;
    /** The touch, for the press events' payload. */
    private final Mounter.PressAt at = new Mounter.PressAt();
    private boolean panning, tracking, pressedIn, longPressed;
    private VelocityTracker velocity;
    /** The pressable box around this pan gate its touch is handed to ({@link #forwardTap}). */
    private Box tapTarget;
    private final Runnable longPress = this::onLongPress;
    /** Handles the taps of this long-press-only box's touch ({@link LongOnly}). */
    private final LongOnly longOnly = new LongOnly(this);
    private final Runnable pressIn = this::onPressIn;
    /** Two-finger gesture: start span / angle, last values for velocity. */
    private boolean transforming;
    private float startSpan, startAngle, lastScale, lastAngle;
    private long lastTime;
    private float scaleVelocity, angleVelocity;

    private boolean wants(int kind) {
        return (events & (1L << kind)) != 0;
    }

    private boolean pressable() {
        return mounter.handlesPress(id);
    }

    private boolean pannable() {
        return wants(Native.PAN_START) || wants(Native.PAN_END) || mounter.hasPan(id);
    }

    private boolean twoFinger() {
        return pinchable || rotatable || wants(Native.PINCH_START) || wants(Native.PINCH_END)
                || wants(Native.ROTATION_START) || wants(Native.ROTATION_END);
    }

    private void onLongPress() {
        if (tracking && !panning) {
            if (!pressedIn) onPressIn();
            longPressed = true;
            longOnly.longPressed();
            mounter.press(id, Native.LONG_PRESS, this, at);
        }
    }

    private void onPressIn() {
        if (pressedIn || !tracking) return;
        pressedIn = true;
        if (wants(Native.PRESS_IN)) mounter.press(id, Native.PRESS_IN, this, at);
        mounter.pressFeedback(this, id, true, pressX, pressY);
    }

    private void pressOut() {
        removeCallbacks(pressIn);
        removeCallbacks(longPress);
        if (!pressedIn) return;
        pressedIn = false;
        if (wants(Native.PRESS_OUT)) mounter.press(id, Native.PRESS_OUT, this, at);
        mounter.pressFeedback(this, id, false, pressX, pressY);
    }

    /**
     * A responder inside took the touch (`SetJsResponder`): this view's press ends here, with no long press or
     * press after it, as iOS cancels the press recognizers around a responder.
     */
    void cancelPress() {
        if (!tracking) return;
        tracking = false;
        pressOut();
    }

    /** Whether a scroll view may still take this touch for a scroll. */
    private boolean insideScrollView() {
        for (ViewParent p = getParent(); p != null; p = p.getParent()) {
            if (p instanceof ScrollView || p instanceof HorizontalScrollView) return true;
        }
        return false;
    }

    private void track(MotionEvent e) {
        if (velocity == null) return;
        MotionEvent screen = MotionEvent.obtain(e);
        screen.setLocation(e.getRawX(), e.getRawY());
        velocity.addMovement(screen);
        screen.recycle();
    }

    /**
     * Whether this view, on the path of a touch in a scroll view around it, pans for a drag by ({@code dx},
     * {@code dy}) px: {@link #takesPan}, except for a content wrapper, which shares its box's id but never handles
     * touches itself.
     *
     * @param dx the drag along x, px
     * @param dy the drag along y, px
     * @return whether this view's pan would take the drag
     */
    boolean takesPanInside(float dx, float dy) {
        return !contentWrapper && takesPan(dx, dy);
    }

    /**
     * Whether this view's pan waits for its `panActivation` to decide, which may still fail for the touch.
     *
     * @return whether the pan has a `panActivation`
     */
    boolean panGated() {
        return mounter.panActivation(id) != null;
    }

    /** Whether this view's pan would start for a drag by ({@code dx}, {@code dy}) px (a scroll view inside asks). */
    boolean takesPan(float dx, float dy) {
        if (!pannable() || panRefused) return false;
        float[] a = mounter.panActivation(id);
        if (a == null) return panStarts(dx, dy, 0);
        float d = mounter.density;
        return TouchTracker.mayActivate(a, dx / d, dy / d);
    }

    /**
     * Whether a movement of (dx, dy) px starts this view's pan: past the slop, along its axis, or as its
     * `panActivation` decides when it has one (once that fails, never for this touch).
     */
    private boolean panStarts(float dx, float dy, float slop) {
        if (panRefused || Math.hypot(dx, dy) <= slop) return false;
        float[] a = mounter.panActivation(id);
        if (a != null) {
            float d = mounter.density;
            Boolean decision = TouchTracker.decideActivation(a, dx / d, dy / d);
            if (decision == null) return false;
            panRefused = !decision;
            return decision;
        }
        if (panAxis == 1) return Math.abs(dx) > Math.abs(dy);
        if (panAxis == 2) return Math.abs(dy) > Math.abs(dx);
        return true;
    }

    /**
     * A finger went down at the screen point ({@code rawX}, {@code rawY}): away from the edge of an edge pan
     * (`PanActivation::edge`), the pan does not start for this touch.
     */
    private void panDown(float rawX, float rawY) {
        downRawX = rawX;
        downRawY = rawY;
        float[] a = mounter.panActivation(id);
        panRefused = a != null && !TouchTracker.startsAt(a, this, rawX, rawY, mounter.density);
    }

    /**
     * Whether a scroll view inside {@code v} that took this touch's DOWN (at {@code downTime}) can move for this
     * drag: the drag is its scroll, and the pan takes only what it cannot (a sheet's list scrolls; at its top, a drag
     * down moves the sheet). A scroll view under a button that took the touch does not count. iOS shares the touch
     * the same way, with the scroll views between the touched view and the pan (`pan_touch`, `pan_scroll_handoff`).
     */
    private static boolean scrollTakes(View v, long downTime, float dx, float dy) {
        if (!(v instanceof ViewGroup)) return false;
        ViewGroup g = (ViewGroup) v;
        for (int i = g.getChildCount() - 1; i >= 0; i--) {
            View c = g.getChildAt(i);
            if (c.getVisibility() != VISIBLE) continue;
            if (c instanceof ScrollBox) {
                // A scroll view the touch did not go to: nor did it go to anything inside.
                if (!((ScrollBox) c).took(downTime)) continue;
                if (((ScrollBox) c).scrolls(dx, dy)) return true;
            }
            if (scrollTakes(c, downTime, dx, dy)) return true;
        }
        return false;
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent e) {
        if (contentWrapper) return false;
        if (pointerEvents == 3) return true;
        int action = e.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) panDown(e.getRawX(), e.getRawY());
        if (action == MotionEvent.ACTION_POINTER_DOWN && twoFinger() && e.getPointerCount() == 2) {
            // A second finger: take over from the child for pinch / rotation.
            tracking = false;
            return true;
        }
        // Take over a drag that starts on a child (e.g. the card's label).
        if (pannable() && action == MotionEvent.ACTION_MOVE && !panning) {
            float slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
            float dx = e.getRawX() - downRawX, dy = e.getRawY() - downRawY;
            if (panStarts(dx, dy, slop) && !scrollTakes(this, e.getDownTime(), dx, dy)) {
                // The DOWN went to the child: the pan starts with this move
                // (which onTouchEvent never sees), so a quick flick still
                // pans and ends.
                tracking = false;
                if (velocity != null) velocity.recycle();
                velocity = VelocityTracker.obtain();
                track(e);
                panning = true;
                getParent().requestDisallowInterceptTouchEvent(true);
                float density = mounter.density;
                mounter.pan(id, 0, dx / density, dy / density, 0, 0, this, downRawX, downRawY);
                return true;
            }
        }
        return false;
    }

    @SuppressLint("ClickableViewAccessibility")
    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (contentWrapper) return false;
        if (pointerEvents == 2) return false;
        boolean pressable = pressable(), pannable = pannable(), twoFinger = twoFinger();
        if (!pressable && !pannable && !twoFinger) {
            // A pan gate keeps the touches that go down on it, as UIKit's hit test gives them to it: left untaken, the
            // down falls through to a scroll view under it (a chat's composer over its messages), which then scrolls.
            if (mounter.panActivation(id) == null) return false;
            forwardTap(e);
            return true;
        }
        float density = mounter.density;
        if (pressable) at.track(e);
        if (pressable) longOnly.forward(e, mounter.handlesTap(id), mounter);
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                panDown(e.getRawX(), e.getRawY());
                tracking = true;
                pressedIn = false;
                longPressed = false;
                panning = false;
                transforming = false;
                if (velocity != null) velocity.recycle();
                velocity = VelocityTracker.obtain();
                track(e);
                pressX = e.getX();
                pressY = e.getY();
                if (pressable) {
                    if (insideScrollView()) postDelayed(pressIn, ViewConfiguration.getTapTimeout());
                    else onPressIn();
                    if (wants(Native.LONG_PRESS)) postDelayed(longPress, mounter.longPressDelay(id));
                }
                return true;
            case MotionEvent.ACTION_POINTER_DOWN:
                if (twoFinger && e.getPointerCount() == 2) {
                    tracking = false;
                    pressOut();
                    startTransform(e);
                }
                return true;
            case MotionEvent.ACTION_MOVE: {
                track(e);
                if (transforming && e.getPointerCount() >= 2) {
                    moveTransform(e, 1);
                    return true;
                }
                float dx = e.getRawX() - downRawX, dy = e.getRawY() - downRawY;
                float slop = ViewConfiguration.get(getContext()).getScaledTouchSlop();
                if (!panning && pannable && panStarts(dx, dy, slop)) {
                    panning = true;
                    tracking = false;
                    pressOut();
                    getParent().requestDisallowInterceptTouchEvent(true);
                    mounter.pan(id, 0, dx / density, dy / density, 0, 0, this, downRawX, downRawY);
                } else if (panning) {
                    mounter.pan(id, 1, dx / density, dy / density, 0, 0, this, downRawX, downRawY);
                } else if (tracking && !inside(e)) {
                    tracking = false;
                    pressOut();
                }
                return true;
            }
            case MotionEvent.ACTION_POINTER_UP:
                if (transforming && e.getPointerCount() == 2) endTransform(2);
                return true;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                boolean up = e.getActionMasked() == MotionEvent.ACTION_UP;
                if (transforming) endTransform(up ? 2 : 3);
                if (panning) {
                    track(e);
                    velocity.computeCurrentVelocity(1000);
                    float dx = e.getRawX() - downRawX, dy = e.getRawY() - downRawY;
                    // Velocity in the parent's space, like the translation.
                    mounter.pan(id, up ? 2 : 3, dx / density, dy / density,
                            velocity.getXVelocity() / density, velocity.getYVelocity() / density,
                            this, downRawX, downRawY);
                } else if (up && tracking) {
                    if (!pressedIn) onPressIn();
                    boolean press = !longPressed && wants(Native.PRESS);
                    pressOut();
                    if (press) mounter.press(id, Native.PRESS, this, at);
                }
                pressOut();
                panning = false;
                tracking = false;
                if (velocity != null) {
                    velocity.recycle();
                    velocity = null;
                }
                return true;
            }
        }
        return true;
    }

    /**
     * A pan gate's touch, handed to the nearest pressable box around it, which the gate took the down from: until the
     * gate activates or the finger passes the touch slop, so a tap presses that box, as UIKit's press recognizers
     * around a view see its touches.
     */
    private void forwardTap(MotionEvent e) {
        int action = e.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            tapTarget = null;
            downRawX = e.getRawX();
            downRawY = e.getRawY();
            for (ViewParent p = getParent(); p instanceof View; p = p.getParent()) {
                if (p instanceof Box && ((Box) p).pressable()) {
                    tapTarget = (Box) p;
                    break;
                }
            }
        }
        Box target = tapTarget;
        if (target == null) return;
        boolean ends = action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL;
        boolean leaves = action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_MOVE
                && (mounter.activeGate() == this || Math.hypot(e.getRawX() - downRawX, e.getRawY() - downRawY)
                        > ViewConfiguration.get(getContext()).getScaledTouchSlop());
        if (leaves || ends) tapTarget = null;
        // A pannable box that intercepted the drag (this view got the cancel) handles the touch itself now.
        if ((leaves || action == MotionEvent.ACTION_CANCEL) && target.panning) return;
        if (!leaves && !ends && action != MotionEvent.ACTION_DOWN && action != MotionEvent.ACTION_MOVE) return;
        MotionEvent local = MotionEvent.obtain(e);
        if (leaves) local.setAction(MotionEvent.ACTION_CANCEL);
        android.graphics.Matrix m = new android.graphics.Matrix();
        for (View v = this; v != target; ) {
            View p = (View) v.getParent();
            if (!v.getMatrix().isIdentity()) m.postConcat(v.getMatrix());
            m.postTranslate(v.getLeft() - p.getScrollX(), v.getTop() - p.getScrollY());
            v = p;
        }
        local.transform(m);
        target.onTouchEvent(local);
        local.recycle();
    }

    /**
     * The taps of a view that listens only to `onLongPress`: as a long press recognizer on the Web, iOS and Android
     * takes no taps from the views around it, its touch goes on to the nearest box outwards that listens to taps, which
     * gets its presses, and the view keeps the long press. The long press cancels that box's press.
     */
    static final class LongOnly {
        private final View view;
        private Box target;

        LongOnly(View view) {
            this.view = view;
        }

        void forward(MotionEvent e, boolean taps, Mounter mounter) {
            int action = e.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                target = null;
                if (taps) return;
                for (ViewParent p = view.getParent(); p instanceof View; p = p.getParent()) {
                    if (p instanceof Box && mounter.handlesTap(((Box) p).id)) {
                        target = (Box) p;
                        break;
                    }
                }
            }
            Box to = target;
            if (to == null) return;
            if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) target = null;
            // A box that intercepted the drag (this view got the cancel) handles the touch itself now.
            if (action == MotionEvent.ACTION_CANCEL && to.panning) return;
            if (action != MotionEvent.ACTION_DOWN && action != MotionEvent.ACTION_MOVE
                    && action != MotionEvent.ACTION_UP && action != MotionEvent.ACTION_CANCEL) return;
            send(to, e, action);
        }

        /** The view's long press fired: the taps' box gets no press. */
        void longPressed() {
            Box to = target;
            target = null;
            if (to == null) return;
            long now = android.os.SystemClock.uptimeMillis();
            MotionEvent cancel = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, 0, 0, 0);
            to.onTouchEvent(cancel);
            cancel.recycle();
        }

        private void send(Box to, MotionEvent e, int action) {
            MotionEvent local = MotionEvent.obtain(e);
            local.setAction(action);
            android.graphics.Matrix m = new android.graphics.Matrix();
            for (View v = view; v != to; ) {
                View p = (View) v.getParent();
                if (!v.getMatrix().isIdentity()) m.postConcat(v.getMatrix());
                m.postTranslate(v.getLeft() - p.getScrollX(), v.getTop() - p.getScrollY());
                v = p;
            }
            local.transform(m);
            to.onTouchEvent(local);
            local.recycle();
        }
    }

    /** Whether the finger is still over the view (with a margin). */
    private boolean inside(MotionEvent e) {
        float margin = 20 * mounter.density;
        return e.getX() >= -margin && e.getY() >= -margin
                && e.getX() <= getWidth() + margin && e.getY() <= getHeight() + margin;
    }

    private static float span(MotionEvent e) {
        return (float) Math.hypot(e.getX(1) - e.getX(0), e.getY(1) - e.getY(0));
    }

    private static float angle(MotionEvent e) {
        return (float) Math.toDegrees(Math.atan2(e.getY(1) - e.getY(0), e.getX(1) - e.getX(0)));
    }

    private void startTransform(MotionEvent e) {
        transforming = true;
        startSpan = Math.max(1, span(e));
        startAngle = angle(e);
        lastScale = 1;
        lastAngle = 0;
        lastTime = e.getEventTime();
        scaleVelocity = angleVelocity = 0;
        getParent().requestDisallowInterceptTouchEvent(true);
        if (pinchable || wants(Native.PINCH_START)) mounter.transformGesture(id, false, 0, 1, 0);
        if (rotatable || wants(Native.ROTATION_START)) mounter.transformGesture(id, true, 0, 0, 0);
    }

    private void moveTransform(MotionEvent e, int state) {
        float scale = span(e) / startSpan;
        float angle = angle(e) - startAngle;
        if (angle > 180) angle -= 360;
        if (angle < -180) angle += 360;
        float dt = Math.max(1, e.getEventTime() - lastTime) / 1000f;
        scaleVelocity = (scale - lastScale) / dt;
        angleVelocity = (angle - lastAngle) / dt;
        lastScale = scale;
        lastAngle = angle;
        lastTime = e.getEventTime();
        if (pinchable || wants(Native.PINCH_END)) mounter.transformGesture(id, false, state, scale, scaleVelocity);
        if (rotatable || wants(Native.ROTATION_END)) mounter.transformGesture(id, true, state, angle, angleVelocity);
    }

    private void endTransform(int state) {
        if (!transforming) return;
        transforming = false;
        if (pinchable || wants(Native.PINCH_END)) mounter.transformGesture(id, false, state, lastScale, scaleVelocity);
        if (rotatable || wants(Native.ROTATION_END)) mounter.transformGesture(id, true, state, lastAngle, angleVelocity);
    }

    /** TalkBack's double tap (and `performClick`) presses the view. */
    @Override
    public boolean performClick() {
        super.performClick();
        if (wants(Native.PRESS)) mounter.event(id, Native.PRESS);
        return true;
    }
}
