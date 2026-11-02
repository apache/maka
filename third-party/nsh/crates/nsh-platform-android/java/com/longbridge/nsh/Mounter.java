package com.longbridge.nsh;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.TimeInterpolator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Rect;
import android.text.Layout;
import android.util.SparseArray;
import android.util.SparseLongArray;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.AccelerateInterpolator;
import android.view.animation.AnimationUtils;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.LinearInterpolator;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.inputmethod.InputMethodManager;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Applies encoded mount batches (crates/nsh-platform-android/src/encode.rs)
 * to native views on the UI thread. Opcodes must match `encode.rs`.
 */
final class Mounter {
    private static final int CREATE = 0;
    private static final int INSERT = 1;
    private static final int REMOVE = 2;
    private static final int DELETE = 3;
    private static final int FRAME = 4;
    private static final int VIEW_STYLE = 5;
    private static final int TEXT = 6;
    private static final int EVENTS = 7;
    private static final int IMAGE = 8;
    private static final int SCROLL_CONFIG = 9;
    private static final int SCROLL_CONTENT = 10;
    private static final int SCROLL_BY = 11;
    private static final int REFRESHING = 12;
    private static final int DYNAMIC = 13;
    private static final int GESTURES = 14;
    private static final int INPUT = 15;
    private static final int INPUT_VALUE = 16;
    private static final int INPUT_CONTENT = 17;
    private static final int COMMAND = 18;
    private static final int VIEW_PROPS = 19;
    private static final int LAYOUT_ANIMATION = 20;
    private static final int SCREEN_CONFIG = 21;
    private static final int MODAL_CONFIG = 22;
    private static final int NATIVE_PROPS = 23;
    private static final int STICKY_CELLS = 24;
    private static final int SCROLL_BEHAVIOR = 25;
    private static final int LAYOUT_DIRECTION = 26;
    private static final int TRACK_STATES = 27;
    private static final int CANVAS = 28;
    private static final int COMPONENT = 29;
    private static final int COMPONENT_PROPS = 30;
    private static final int OVERFLOW = 31;
    private static final int ACCESSIBILITY_LABEL = 32;
    private static final int APPEARANCE = 33;
    private static final int RETIRE_LIST_CELL = 34;
    private static final int PROJECT_ROOT = 35;
    private static final int COMPONENT_PROP_SLOTS = 36;
    private static final int SHADER = 37;
    /** The surface lays out right to left: native widgets mirror. */
    boolean rtl;
    /** The app's appearance (`nsh_core::platform::Appearance`): 0 the system's, 1 light, 2 dark. */
    int appearance;
    /** The status bar the app asked for last (style, hidden), applied again when the appearance changes. */
    private int barStyle = -1;
    private boolean barHidden;

    /** Dark appearance as shown: the app's, else the system's. */
    boolean night() {
        if (appearance != 0) return appearance == 2;
        return (context.getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    }

    /** A screen's options (`encode.rs` `screen_config`). */
    static final class ScreenOptions {
        String title, backTitle;
        boolean shown = true, transparent, backVisible = true, gesture = true, preventBack;
        int tint, background, titleColor, animation, left = -1, right = -1, titleView = -1;
        float headerHeight;
    }

    /** Properties that animations can override, as last set by a style. */
    private static final class Dynamic {
        float opacity = 1, tx, ty, sx = 1, sy = 1, rotate, rotateX, rotateY, perspective;
        int background;
        /** Border colors. */
        int[] borderColors = new int[4];
    }

    /** One part of a layout animation (`encode.rs` `layout_transition`). */
    private static final class Transition {
        int curve; // 0 linear, 1 ease in, 2 ease out, 3 ease in-out, 4 spring, 5 the keyboard's
        float damping;
        int property; // 0 opacity, 1 scale
        long duration, delay;

        /** The curve's interpolator; the keyboard's (5) is {@link Mounter#interpolator}'s. */
        TimeInterpolator interpolator() {
            switch (curve) {
                case 0: return new LinearInterpolator();
                case 1: return new AccelerateInterpolator();
                case 2: return new DecelerateInterpolator();
                case 4: {
                    // React Native's spring interpolator.
                    float d = damping;
                    return t -> (float) (1 + Math.pow(2, -10 * t) * Math.sin((t - d / 4) * Math.PI * 2 / d));
                }
                default: return new AccelerateDecelerateInterpolator();
            }
        }
    }

    final NshView host;
    /** Pixels per dp; {@link NshView} updates it when the display density changes. */
    float density;
    final Context context;
    final Images images;
    final SparseArray<View> views = new SparseArray<>();
    private final SparseArray<Dynamic> statics = new SparseArray<>();
    /** The events each view listens to: kinds below 64 here, ... */
    private final SparseLongArray events = new SparseLongArray();
    /** ... and kinds 64 and up (`kind - 64`) here. */
    private final SparseLongArray eventsHigh = new SparseLongArray();
    /** Views listening to touches: the touch trackers run while there are any. */
    int touchListeners;
    /** One per root view (the surface, modals). */
    final java.util.ArrayList<TouchTracker> touchTrackers = new java.util.ArrayList<>();
    /** The text with a selection (one at a time, as in TextView). */
    TextBox selectedText;
    /** The selectable view with a selection (one per surface, a text's or an area's). */
    SelectableView selectedArea;
    /** Selectable views (`ViewProps.selectable_view`), by view. */
    private final SparseArray<SelectableView> selectableViews = new SparseArray<>();

    /** A finger went down at the screen point: a selection elsewhere ends. */
    void touchDown(float rawX, float rawY) {
        if (selectedText != null && !selectedText.selectionContains(rawX, rawY)) selectedText.clearSelection();
        if (selectedArea != null && !selectedArea.selectionContains(rawX, rawY)) selectedArea.clear();
    }

    /** The outermost selectable view {@code text} is in (an area inside another is part of it), or null. */
    SelectableView selectableViewOf(TextBox text) {
        if (selectableViews.size() == 0) return null;
        SelectableView outer = null;
        for (Object v = text; v instanceof View; v = ((View) v).getParent()) {
            if (!(v instanceof Node)) continue;
            SelectableView area = selectableViews.get(((Node) v).nodeId());
            if (area != null && area.view == v) outer = area;
        }
        return outer;
    }
    /** Scroll views a JS responder keeps from scrolling. */
    private final java.util.ArrayList<ScrollBox> blockedScrolls = new java.util.ArrayList<>();
    /** `hitSlop` of views that have one (px: top, right, bottom, left). */
    private final SparseArray<float[]> slops = new SparseArray<>();
    private final SparseArray<A11y> a11y = new SparseArray<>();
    /** Layout animation of the batch being applied: create, update, delete. */
    private Transition[] layoutAnimation;
    /** Views created by the batch being applied. */
    private final java.util.HashSet<Integer> created = new java.util.HashSet<>();
    /** Running frame / disappearance animations, by view. */
    private final SparseArray<Animator> layoutAnimators = new SparseArray<>();
    private InputBox focused;

    /** The focused input, if any. */
    InputBox focusedInput() {
        return focused;
    }
    /** Modals by id (their root views are in `views`). */
    private final SparseArray<ModalHost> modals = new SparseArray<>();
    /** Screens' options, applied once the batch's stacks are settled. */
    private final SparseArray<ScreenOptions> screenOptions = new SparseArray<>();
    /** Parents of screens, header items and modals (not their superviews). */
    private final android.util.SparseIntArray hosts = new android.util.SparseIntArray();
    private final java.util.LinkedHashSet<Integer> dirtyStacks = new java.util.LinkedHashSet<>();
    private final java.util.LinkedHashSet<Integer> dirtyScreens = new java.util.LinkedHashSet<>();
    private final java.util.LinkedHashSet<Integer> dirtyModals = new java.util.LinkedHashSet<>();
    /** Stacks and shown modals, oldest first (the back button tries the newest). */
    private final java.util.ArrayList<StackBox> stacks = new java.util.ArrayList<>();
    private final java.util.ArrayList<ModalHost> shownModals = new java.util.ArrayList<>();

    /** The surface root (node 1). */
    final Box root;

    Mounter(NshView host, Images images) {
        this.host = host;
        this.context = host.getContext();
        this.density = host.getResources().getDisplayMetrics().density;
        this.images = images;
        components.put(TabBarComponent.NAME, c -> new TabBarComponent(context, c, this::night));
        images.redirects = (base, location) -> Native.mediaRedirect(handle(), base, location);
        images.inline = uri -> {
            long handle = handle();
            return handle == 0 ? null : Native.imageBytes(handle, uri);
        };
        images.disk = new Images.DiskCache() {
            @Override
            public Object lookup(String url) {
                long handle = handle();
                return handle == 0 ? null : Native.imageCacheLookup(handle, url);
            }

            @Override
            public byte[] complete(String url, int status, String[] headers, byte[] body) {
                long handle = handle();
                return handle == 0 ? null : Native.imageCacheComplete(handle, url, status, headers, body);
            }
        };
        root = new Box(context, this, 1);
        views.put(1, root);
        observeFocus(root);
    }

    /** Whether the running app's web views may navigate to {@code url} (its capabilities). */
    boolean allowsWebview(String url) {
        return Native.allowsWebview(handle(), url);
    }

    long handle() {
        return host.handle;
    }

    /** The view of node {@code id}, or null. */
    View view(int id) {
        return views.get(id);
    }

    private int px(float dp) {
        return Math.round(dp * density);
    }

    /** Keeps pixel-based native state in the new coordinate system. */
    void setDensity(float next) {
        float scale = next / density;
        density = next;
        for (int i = 0; i < views.size(); i++) {
            View view = views.valueAt(i);
            if (view instanceof ScrollBox) ((ScrollBox) view).rescale(scale);
        }
        for (int i = 0; i < modals.size(); i++) modals.valueAt(i).densityChanged();
    }

    void apply(byte[] bytes, Object[] objects, long seq) {
        ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        while (b.hasRemaining()) {
            int op = b.getInt();
            switch (op) {
                case CREATE: create(b.getInt(), b.getInt()); break;
                case INSERT: insert(b.getInt(), b.getInt(), b.getInt()); break;
                case PROJECT_ROOT: {
                    int parent = b.getInt(), id = b.getInt();
                    int[] following = new int[b.getInt()];
                    for (int i = 0; i < following.length; i++) following[i] = b.getInt();
                    projectRoot(parent, id, following);
                    break;
                }
                case REMOVE: {
                    int id = b.getInt();
                    if (!removeHosted(id)) remove(id);
                    break;
                }
                case RETIRE_LIST_CELL: {
                    int id = b.getInt();
                    long request = b.getLong();
                    int[] roots = new int[b.getInt()];
                    for (int i = 0; i < roots.length; i++) roots[i] = b.getInt();
                    retireListCell(id, request, seq, roots);
                    break;
                }
                case DELETE: delete(b.getInt()); break;
                case FRAME: frame(b.getInt(), b.getFloat(), b.getFloat(), b.getFloat(), b.getFloat()); break;
                case VIEW_STYLE: style(b); break;
                case TEXT: {
                    View v = views.get(b.getInt());
                    Object layout = objects[b.getInt()];
                    float x = b.getFloat(), y = b.getFloat(), w = b.getFloat(), h = b.getFloat();
                    int links = b.getInt();
                    int[] linkData = new int[links * 3];
                    long[] linkEvents = new long[links];
                    for (int i = 0; i < links; i++) {
                        linkData[i * 3] = b.getInt();
                        linkData[i * 3 + 1] = b.getInt();
                        linkData[i * 3 + 2] = b.getInt();
                        linkEvents[i] = (b.getInt() & 0xffffffffL) | ((long) b.getInt() << 32);
                        // Kinds 64 and up: spans take presses and hover only,
                        // all below 64.
                        b.getInt();
                        b.getInt();
                    }
                    // `selectable`: 1 asked for, 0 refused, 2 unset (`encode.rs`).
                    int selectable = b.getInt();
                    Integer selectionColor = optColor(b);
                    // The one color all of it is drawn in, if there is one
                    // (`opt_color`: a flag, then the color), unboxed: a text
                    // updating live allocates nothing for it.
                    boolean uniform = b.getInt() != 0;
                    int uniformColor = b.getInt();
                    if (v instanceof TextBox) {
                        TextBox t = (TextBox) v;
                        t.setSelectable(selectable == 1, selectable == 0, selectionColor);
                        t.setLayout((Layout) layout, x * density, y * density, w * density, h * density);
                        t.recolor(uniform, uniformColor, effects.get(t.id));
                        t.setLinks(linkData, linkEvents);
                        if (links > 0 && t.press == null) t.press = new Pressable(t, this, t.id);
                        t.setClickable(links > 0 || (t.press != null && t.press.ownWanted()));
                    }
                    break;
                }
                case EVENTS: {
                    int id = b.getInt();
                    long mask = (b.getInt() & 0xffffffffL) | ((long) b.getInt() << 32);
                    long high = (b.getInt() & 0xffffffffL) | ((long) b.getInt() << 32);
                    if (high != 0) eventsHigh.put(id, high);
                    else eventsHigh.delete(id);
                    long touch = 1L << Native.TOUCH;
                    if ((events.get(id) & touch) != (mask & touch)) touchListeners += (mask & touch) != 0 ? 1 : -1;
                    events.put(id, mask);
                    View v = views.get(id);
                    if (v != null) updateHover(id, v);
                    if (v instanceof Box) {
                        ((Box) v).events = mask;
                        v.setClickable((mask & (1L << Native.PRESS)) != 0);
                    }
                    if (v instanceof ScrollBox) ((ScrollBox) v).events = mask;
                    boolean presses = (mask & ((1L << Native.PRESS) | (1L << Native.LONG_PRESS)
                            | (1L << Native.PRESS_IN) | (1L << Native.PRESS_OUT))) != 0;
                    if (v instanceof TextBox && presses && ((TextBox) v).press == null) {
                        ((TextBox) v).press = new Pressable(v, this, id);
                    }
                    if (v instanceof ImageBox && presses && ((ImageBox) v).press == null) {
                        ((ImageBox) v).press = new Pressable(v, this, id);
                    }
                    if (v instanceof TextBox || v instanceof ImageBox) {
                        v.setClickable(presses || (v instanceof TextBox && ((TextBox) v).hasLinks()));
                    }
                    break;
                }
                case IMAGE: {
                    int id = b.getInt(), uri = b.getInt(), mode = b.getInt();
                    String placeholder = optString(b, objects);
                    float blur = b.getFloat(), fade = b.getFloat();
                    int xFlags = b.getInt();
                    float x = b.getFloat();
                    int yFlags = b.getInt();
                    float y = b.getFloat();
                    image(id, uri >= 0 ? (String) objects[uri] : null, mode, placeholder, px(blur), fade < 0 ? -1 : Math.round(fade));
                    View iv = views.get(id);
                    if (iv instanceof ImageBox) {
                        ImageBox image = (ImageBox) iv;
                        // Lengths in pixels; fractions stay fractions of the free space.
                        image.positionX = (xFlags & 2) != 0 ? x : x * density;
                        image.positionY = (yFlags & 2) != 0 ? y : y * density;
                        image.positionFlags = (xFlags & 3) | ((yFlags & 3) << 2);
                    }
                    break;
                }
                case SCROLL_CONFIG: {
                    View v = views.get(b.getInt());
                    boolean horizontal = b.getInt() != 0, indicator = b.getInt() != 0;
                    int dismiss = b.getInt();
                    boolean mirrored = b.getInt() != 0;
                    if (v instanceof ScrollBox) {
                        ((ScrollBox) v).configure(horizontal, indicator, dismiss);
                        setMirrored((ScrollBox) v, mirrored);
                    }
                    break;
                }
                case OVERFLOW: {
                    View v = views.get(b.getInt());
                    boolean some = b.getInt() != 0;
                    float x = b.getFloat(), y = b.getFloat(), w = b.getFloat(), h = b.getFloat();
                    if (v instanceof Box) {
                        ((Box) v).overflow = some
                                ? new android.graphics.RectF(x * density, y * density, (x + w) * density, (y + h) * density)
                                : null;
                    }
                    break;
                }
                case TRACK_STATES: {
                    int id = b.getInt(), states = b.getInt();
                    trackStates(id, states);
                    break;
                }
                case CANVAS: {
                    int id = b.getInt(), words = b.getInt();
                    int[] code = new int[words];
                    b.asIntBuffer().get(code);
                    b.position(b.position() + words * 4);
                    View v = views.get(id);
                    if (v instanceof CanvasBox) drawing((CanvasBox) v, code, objects);
                    break;
                }
                case APPEARANCE: {
                    appearance = b.getInt();
                    for (int i = 0; i < views.size(); i++) {
                        View v = views.valueAt(i);
                        if (v instanceof ComponentBox && ((ComponentBox) v).component instanceof TabBarComponent) {
                            ((TabBarComponent) ((ComponentBox) v).component).appearanceChanged();
                        }
                    }
                    if (barStyle == 0) {
                        SystemUi.statusBar(context, barStyle, barHidden, night());
                        for (ModalHost m : shownModals) m.statusBar(barStyle, barHidden, night());
                    }
                    break;
                }
                case LAYOUT_DIRECTION: {
                    rtl = b.getInt() != 0;
                    host.setLayoutDirection(rtl ? View.LAYOUT_DIRECTION_RTL : View.LAYOUT_DIRECTION_LTR);
                    for (int i = 0; i < modals.size(); i++) modals.valueAt(i).mirror(rtl);
                    break;
                }
                case SCROLL_BEHAVIOR: {
                    View v = views.get(b.getInt());
                    boolean paging = b.getInt() != 0;
                    float interval = b.getFloat();
                    float[] offsets = new float[b.getInt()];
                    for (int i = 0; i < offsets.length; i++) offsets[i] = b.getFloat();
                    int alignment = b.getInt();
                    float deceleration = b.getFloat();
                    boolean enabled = b.getInt() != 0, bounces = b.getInt() != 0;
                    float top = b.getFloat(), right = b.getFloat(), bottom = b.getFloat(), left = b.getFloat();
                    int taps = b.getInt();
                    boolean oneStep = b.getInt() != 0;
                    boolean zooms = b.getInt() != 0;
                    float minZoom = b.getFloat(), maxZoom = b.getFloat();
                    boolean bouncesZoom = b.getInt() != 0, pinch = b.getInt() != 0, center = b.getInt() != 0;
                    boolean ownIndicator = b.getInt() != 0;
                    float indicatorHeight = b.getFloat();
                    if (v instanceof ScrollBox) {
                        ((ScrollBox) v).setBehavior(paging, interval, offsets, alignment, deceleration, enabled, bounces,
                                top, right, bottom, left, taps, oneStep);
                        ((ScrollBox) v).setZoom(zooms, minZoom, maxZoom, bouncesZoom, pinch, center);
                        ((ScrollBox) v).setRefresh(ownIndicator, indicatorHeight);
                    }
                    break;
                }
                case SCROLL_CONTENT: {
                    View v = views.get(b.getInt());
                    float w = b.getFloat(), h = b.getFloat();
                    if (v instanceof ScrollBox) ((ScrollBox) v).setContentSize(px(w), px(h));
                    break;
                }
                case SCROLL_BY: {
                    View v = views.get(b.getInt());
                    float dx = b.getFloat(), dy = b.getFloat();
                    if (v instanceof ScrollBox) ((ScrollBox) v).scrollByPx(px(dx), px(dy));
                    break;
                }
                case REFRESHING: {
                    View v = views.get(b.getInt());
                    boolean on = b.getInt() != 0;
                    if (v instanceof ScrollBox) ((ScrollBox) v).setRefreshing(on);
                    break;
                }
                case DYNAMIC: {
                    int id = b.getInt();
                    // Bindings changed: back to the static values; the animator
                    // then writes what is still bound.
                    View v = views.get(id);
                    Dynamic d = statics.get(id);
                    if (v != null && d != null) applyDynamic(v, d);
                    // Its props bound again are handed over again.
                    if (v instanceof ComponentBox) ((ComponentBox) v).forgetAnimated();
                    break;
                }
                case GESTURES: {
                    View v = views.get(b.getInt());
                    b.getInt(); // pan values: the animator knows them (`Native.hasPan`)
                    int axis = b.getInt();
                    boolean pinch = b.getInt() != 0, rotation = b.getInt() != 0;
                    if (v instanceof Box) {
                        Box box = (Box) v;
                        box.panAxis = axis;
                        box.pinchable = pinch;
                        box.rotatable = rotation;
                    }
                    break;
                }
                case VIEW_PROPS: viewProps(b, objects); break;
                case ACCESSIBILITY_LABEL: {
                    int id = b.getInt();
                    String label = string(objects, b.getInt());
                    View v = views.get(id);
                    A11y a = a11y.get(id);
                    if (v == null || a == null) break;
                    a.label = label;
                    a.apply(v);
                    break;
                }
                case SCREEN_CONFIG: screenConfig(b, objects); break;
                case NATIVE_PROPS: nativeProps(b, objects); break;
                case STICKY_CELLS: {
                    View v = views.get(b.getInt());
                    int n = b.getInt();
                    int[] cells = new int[n];
                    float[] start = new float[n], end = new float[n];
                    for (int i = 0; i < n; i++) {
                        cells[i] = b.getInt();
                        start[i] = b.getFloat() * density;
                        end[i] = b.getFloat() * density;
                    }
                    if (v instanceof ScrollBox) ((ScrollBox) v).setSticky(cells, start, end);
                    break;
                }
                case MODAL_CONFIG: {
                    ModalHost modal = modals.get(b.getInt());
                    int animation = b.getInt();
                    b.getInt(); // presentation: Android modals cover the window
                    boolean translucent = b.getInt() != 0;
                    boolean closeOnEscape = b.getInt() != 0;
                    if (modal != null) {
                        modal.animation = animation;
                        modal.closeOnEscape = closeOnEscape;
                        modal.setStatusBarTranslucent(translucent);
                    }
                    break;
                }
                case LAYOUT_ANIMATION:
                    layoutAnimation = new Transition[] {transition(b), transition(b), transition(b)};
                    break;
                case INPUT: input(b, objects); break;
                case INPUT_VALUE: {
                    View v = views.get(b.getInt());
                    String text = (String) objects[b.getInt()];
                    int count = b.getInt();
                    if (v instanceof InputBox) ((InputBox) v).setValue(text, count);
                    break;
                }
                case INPUT_CONTENT: {
                    View v = views.get(b.getInt());
                    float x = b.getFloat(), y = b.getFloat(), w = b.getFloat(), h = b.getFloat();
                    if (v instanceof InputBox) {
                        InputBox in = (InputBox) v;
                        Box.Frame f = Box.frame(in);
                        int width = f.right - f.left, height = f.bottom - f.top;
                        in.setContent(px(x), px(y), Math.max(0, width - px(x + w)), Math.max(0, height - px(y + h)));
                    }
                    break;
                }
                case COMMAND: command(b, objects); break;
                case COMPONENT: {
                    int id = b.getInt();
                    component(id, string(objects, b.getInt()));
                    break;
                }
                case SHADER: {
                    // The layer stays in libnsh, which renders it (`shader.rs`).
                    View v = views.get(b.getInt());
                    boolean on = b.getInt() != 0;
                    if (v instanceof Box) ((Box) v).setShader(on);
                    break;
                }
                case COMPONENT_PROP_SLOTS: {
                    View v = views.get(b.getInt());
                    String[] names = new String[b.getInt()];
                    for (int i = 0; i < names.length; i++) names[i] = string(objects, b.getInt());
                    if (v instanceof ComponentBox) ((ComponentBox) v).slots = names;
                    break;
                }
                case COMPONENT_PROPS: {
                    View v = views.get(b.getInt());
                    int count = b.getInt();
                    NshComponent c = v instanceof ComponentBox ? ((ComponentBox) v).component : null;
                    for (int i = 0; i < count; i++) {
                        String name = string(objects, b.getInt());
                        String json = string(objects, b.getInt());
                        if (c != null) c.setProp(name, Json.parse(json));
                    }
                    break;
                }
                default:
                    throw new IllegalStateException("nsh: unknown mount opcode " + op);
            }
        }
        if (layoutAnimation != null) {
            appear(layoutAnimation[0]);
            layoutAnimation = null;
        }
        created.clear();
        finishNavigation();
        outputs(Native.afterBatch(handle(), seq));
    }

    // --- The keyboard's motion --------------------------------------------------

    /** How the software keyboard last moved: what curve 5 follows (`LayoutCurve::Keyboard`). */
    private TimeInterpolator keyboardInterpolator = new AccelerateDecelerateInterpolator();
    private long keyboardDuration = 250;
    /** When it started to move ({@link AnimationUtils#currentAnimationTimeMillis}). */
    private long keyboardStart = Long.MIN_VALUE;

    /** The keyboard starts to move, along {@code interpolator} for {@code duration} ms. */
    void keyboardMotion(TimeInterpolator interpolator, long duration) {
        keyboardInterpolator = interpolator != null ? interpolator : new AccelerateDecelerateInterpolator();
        keyboardDuration = duration;
        keyboardStart = AnimationUtils.currentAnimationTimeMillis();
    }

    private TimeInterpolator interpolator(Transition t) {
        return t.curve == 5 ? keyboardInterpolator : t.interpolator();
    }

    /**
     * Starts {@code a}; on the keyboard's curve, as if it had started when
     * the keyboard did, so that it keeps pace with the keyboard however late
     * the batch came (the engine thread answers the insets a frame or more
     * after the system dispatched them).
     */
    private void start(ValueAnimator a, Transition t) {
        a.start();
        if (t.curve == 5) keyboardAligned(a);
    }

    private void keyboardAligned(ValueAnimator a) {
        long elapsed = AnimationUtils.currentAnimationTimeMillis() - keyboardStart - a.getStartDelay();
        if (elapsed > 0 && elapsed < a.getDuration()) a.setCurrentPlayTime(elapsed);
    }

    private static Transition transition(ByteBuffer b) {
        if (b.getInt() == 0) return null;
        Transition t = new Transition();
        t.curve = b.getInt();
        t.damping = b.getFloat();
        t.property = b.getInt();
        t.duration = (long) b.getFloat();
        t.delay = (long) b.getFloat();
        return t;
    }

    private void create(int id, int kind) {
        View v;
        switch (kind) {
            case 1: v = new TextBox(context, this, id); break;
            case 2: {
                ImageBox[] self = new ImageBox[1];
                self[0] = new ImageBox(context, id, new Images.Callback() {
                    @Override
                    public void done(Images.Image image, String error) {
                        imageDone(self[0], image, error);
                    }

                    @Override
                    public void progress(long loaded, long total) {
                        if (wants(id, Native.PROGRESS)) {
                            eventMap(id, Native.PROGRESS, new String[] {"loaded", "total"},
                                    new Object[] {(double) loaded, (double) total});
                        }
                    }
                }, (image, error) -> placeholderDone(self[0], image));
                v = self[0];
                break;
            }
            case 3: v = new ScrollBox(context, this, id); break;
            case 4: v = new InputBox(context, this, id); break;
            case 5: {
                StackBox stack = new StackBox(context, this, id);
                stacks.add(stack);
                v = stack;
                break;
            }
            case 6: v = new StackBox.ScreenBox(context, this, id); break;
            case 8: {
                headerItems.add(id);
                v = new Box(context, this, id);
                break;
            }
            case 7: {
                ModalHost modal = new ModalHost(context, this, id);
                modals.put(id, modal);
                v = modal.root;
                break;
            }
            case 12: v = new WebBox(context, this, id); break;
            case 13: v = new VideoBox(context, this, host, id); break;
            case 14: v = new CanvasBox(context, this, id); break;
            case 15: v = new ComponentBox(context, this, id); break;
            default: v = new Box(context, this, id);
        }
        views.put(id, v);
        if (layoutAnimation != null) created.add(id);
    }

    /**
     * The components the app registered ({@link NshView#registerComponent}),
     * and NSH's own (named under {@code nsh/}), which the app cannot replace.
     */
    final java.util.Map<String, NshComponent.Factory> components = new java.util.HashMap<>();
    private final java.util.Set<String> missingComponents = new java.util.HashSet<>();

    /**
     * The app stopped (the view was destroyed, or another app replaced it):
     * its native components hear {@link NshComponent#destroy} now, since no
     * {@code DELETE} follows for them. Those already deleted are not told
     * again.
     */
    void destroyComponents() {
        for (int i = 0; i < views.size(); i++) {
            View v = views.valueAt(i);
            if (v instanceof ComponentBox) ((ComponentBox) v).destroy();
        }
    }

    /** Makes registered component {@code name} in box {@code id}. */
    private void component(int id, String name) {
        View v = views.get(id);
        if (!(v instanceof ComponentBox)) return;
        NshComponent.Factory factory = components.get(name);
        if (factory == null) {
            if (missingComponents.add(name)) {
                android.util.Log.w("nsh", "no native component is registered as `" + name + "`: it renders an empty view");
            }
            return;
        }
        ((ComponentBox) v).attach(factory.create(new NshComponentContext(host, id)));
    }

    private static ViewGroup container(View parent) {
        if (parent instanceof StackBox.ScreenBox) return ((StackBox.ScreenBox) parent).root;
        if (parent instanceof ScrollBox) return ((ScrollBox) parent).content;
        if (parent instanceof Box) return ((Box) parent).container();
        if (parent instanceof TextBox) return (TextBox) parent;
        return null;
    }

    private void insert(int parentId, int childId, int beforeId) {
        if (insertHosted(parentId, childId, beforeId)) return;
        View parent = views.get(parentId), child = views.get(childId);
        ViewGroup group = container(parent);
        if (group == null || child == null) return;
        Animator running = layoutAnimators.get(childId);
        if (running != null) {
            // Back before its removal finished animating.
            running.cancel();
            Dynamic d = statics.get(childId);
            if (d != null) applyDynamic(child, d);
        }
        detach(child);
        int index = -1;
        if (beforeId >= 0) {
            View before = views.get(beforeId);
            if (before != null) index = group.indexOfChild(before);
        }
        group.addView(child, index);
        Box.place(child);
        // Cells of a mirrored list flip back.
        int mirror = parent instanceof ScrollBox && mirrors.get(parentId) == 1 ? 2 : 0;
        if (mirrors.get(childId) != mirror) {
            if (mirror == 0) mirrors.delete(childId);
            else mirrors.put(childId, mirror);
            Dynamic d = statics.get(childId);
            applyDynamic(child, d != null ? d : new Dynamic());
        }
        if (parent instanceof ScrollBox && ((ScrollBox) parent).hasSticky()) ((ScrollBox) parent).frontSticky();
    }

    private void projectRoot(int parentId, int id, int[] following) {
        View parent = views.get(parentId), child = views.get(id);
        ModalHost modal = modals.get(id);
        if (modal != null) {
            if (hosts.get(id, -1) == parentId && modal.root.isShown() && modal.shown()) return;
            insert(parentId, id, -1);
            return;
        }
        ViewGroup group;
        if (child instanceof StackBox.ScreenBox && parent instanceof StackBox) group = (StackBox) parent;
        else if (headerItem(id) && parent instanceof StackBox.ScreenBox) group = ((StackBox.ScreenBox) parent).toolbar;
        else group = container(parent);
        int before = -1;
        if (group != null) {
            for (int candidate : following) {
                View view = views.get(candidate);
                if (child instanceof StackBox.ScreenBox && !(view instanceof StackBox.ScreenBox)) continue;
                if (view != null && view.getParent() == group && group.indexOfChild(view) >= 0) {
                    before = candidate;
                    break;
                }
            }
            int index = group.indexOfChild(child);
            int at = before >= 0 ? group.indexOfChild(views.get(before)) : group.getChildCount();
            boolean hosted = child instanceof StackBox.ScreenBox || headerItem(id);
            if (index >= 0 && index + 1 == at && layoutAnimators.get(id) == null
                    && (!hosted || hosts.get(id, -1) == parentId)) return;
        }
        insert(parentId, id, before);
    }

    private static void detach(View v) {
        if (v == null) return;
        ViewParent p = v.getParent();
        if (p instanceof ViewGroup) ((ViewGroup) p).removeView(v);
    }

    void observeFocus(View view) {
        view.getViewTreeObserver().addOnGlobalFocusChangeListener((old, focused) -> publishFocusPath());
    }

    void publishFocusPath() {
        if (handle() != 0) Native.focusPath(handle(), focusPath());
    }

    private int[] focusPath(View focused) {
        java.util.ArrayList<Integer> path = new java.util.ArrayList<>();
        for (View view = focused; view != null; ) {
            if (view instanceof Node) {
                int id = ((Node) view).nodeId();
                if (views.get(id) == view) path.add(id);
            }
            ViewParent parent = view.getParent();
            view = parent instanceof View ? (View) parent : null;
        }
        int[] result = new int[path.size()];
        for (int i = 0; i < result.length; i++) result[i] = path.get(i);
        return result;
    }

    private int[] focusPath() {
        for (int i = modals.size() - 1; i >= 0; i--) {
            ModalHost modal = modals.valueAt(i);
            if (modal.root.isShown() && modal.root.hasWindowFocus()) {
                View focused = modal.root.findFocus();
                return focusPath(focused != null ? focused : modal.root);
            }
        }
        return focusPath(host.hasWindowFocus() ? host.findFocus() : null);
    }

    private void retireListCell(int id, long request, long seq, int[] roots) {
        int[] path = focusPath();
        for (int node : path) {
            for (int root : roots) {
                if (node == root) {
                    Native.retireListCell(handle(), seq, id, request, false, path);
                    return;
                }
            }
        }
        for (int root : roots) {
            View view = views.get(root);
            if (view == null) continue;
            for (TouchTracker tracker : touchTrackers) tracker.cancelWithin(view);
            android.view.MotionEvent cancel = android.view.MotionEvent.obtain(
                    0, android.os.SystemClock.uptimeMillis(), android.view.MotionEvent.ACTION_CANCEL, 0, 0, 0);
            view.dispatchTouchEvent(cancel);
            cancel.recycle();
            cancelRetiredInput(view);
            ModalHost modal = modals.get(root);
            if (modal != null) {
                dirtyModals.remove(root);
                modal.park();
            } else if (view instanceof StackBox.ScreenBox) {
                View parent = views.get(hosts.get(root, -1));
                if (parent instanceof StackBox) ((StackBox) parent).park((StackBox.ScreenBox) view);
                else detach(view);
            } else {
                if (headerItem(root)) {
                    int parent = hosts.get(root, -1);
                    hosts.delete(root);
                    if (parent >= 0) dirtyScreens.add(parent);
                }
                detach(view);
            }
        }
        Native.retireListCell(handle(), seq, id, request, true, focusPath());
    }

    private void cancelRetiredInput(View view) {
        if (view instanceof InputBox) ((InputBox) view).cancelAutoFocus();
        if (view instanceof ScrollBox) ((ScrollBox) view).cancelPendingScroll();
        view.cancelPendingInputEvents();
        if (view instanceof Node) {
            int id = ((Node) view).nodeId();
            Animator animation = views.get(id) == view ? layoutAnimators.get(id) : null;
            if (animation != null) {
                layoutAnimators.remove(id);
                animation.cancel();
            }
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) cancelRetiredInput(group.getChildAt(i));
        }
    }

    /** Removes a view from its parent, fading it out under a layout animation. */
    private void remove(int id) {
        View v = views.get(id);
        Transition t = layoutAnimation != null ? layoutAnimation[2] : null;
        if (v == null || t == null || v.getParent() == null) {
            detach(v);
            return;
        }
        ValueAnimator a = ValueAnimator.ofFloat(0, 1);
        a.setDuration(t.duration);
        a.setStartDelay(t.delay);
        a.setInterpolator(interpolator(t));
        float alpha = v.getAlpha(), sx = v.getScaleX(), sy = v.getScaleY();
        a.addUpdateListener(x -> {
            float f = 1 - (float) x.getAnimatedValue();
            if (t.property == 1) {
                v.setScaleX(sx * f);
                v.setScaleY(sy * f);
            } else {
                v.setAlpha(alpha * f);
            }
        });
        a.addListener(new AnimatorListenerAdapter() {
            private boolean cancelled;

            @Override
            public void onAnimationCancel(Animator animation) {
                cancelled = true;
            }

            @Override
            public void onAnimationEnd(Animator animation) {
                if (layoutAnimators.get(id) == animation) layoutAnimators.remove(id);
                if (!cancelled) {
                    detach(v);
                    Dynamic d = statics.get(id);
                    if (d != null) applyDynamic(v, d);
                }
            }
        });
        layoutAnimators.put(id, a);
        start(a, t);
    }

    /** Fades or grows in the views a layout animation created. */
    private void appear(Transition t) {
        if (t == null) return;
        for (int id : created) {
            View v = views.get(id);
            if (v == null || v.getParent() == null) continue;
            float alpha = v.getAlpha(), sx = v.getScaleX(), sy = v.getScaleY();
            if (t.property == 1) {
                v.setScaleX(0);
                v.setScaleY(0);
            } else {
                v.setAlpha(0);
            }
            ValueAnimator a = ValueAnimator.ofFloat(0, 1);
            a.setDuration(t.duration);
            a.setStartDelay(t.delay);
            a.setInterpolator(interpolator(t));
            a.addUpdateListener(x -> {
                float f = (float) x.getAnimatedValue();
                if (t.property == 1) {
                    v.setScaleX(sx * f);
                    v.setScaleY(sy * f);
                } else {
                    v.setAlpha(alpha * f);
                }
            });
            start(a, t);
        }
    }

    private void delete(int id) {
        removeHosted(id);
        ModalHost modal = modals.get(id);
        if (modal != null) {
            modal.dismiss();
            // The batch's end updates the back button without it.
            shownModals.remove(modal);
            modals.remove(id);
            touchTrackers.remove(modal.touches());
        }
        View v = views.get(id);
        if (v instanceof StackBox) stacks.remove(v);
        SelectableView area = selectableViews.get(id);
        if (area != null) {
            area.clear();
            selectableViews.remove(id);
        }
        screenOptions.remove(id);
        Animator running = layoutAnimators.get(id);
        if (running != null) running.cancel();
        detach(v);
        if (v instanceof ImageBox) cancelImage((ImageBox) v);
        if (v instanceof WebBox) ((WebBox) v).destroy();
        if (v instanceof VideoBox) ((VideoBox) v).destroy();
        if (v instanceof ComponentBox) ((ComponentBox) v).destroy();
        if (v == focused) focused = null;
        views.remove(id);
        headerItems.remove(id);
        headerSizes.remove(id);
        statics.remove(id);
        feedback.remove(id);
        mirrors.delete(id);
        if ((events.get(id) & (1L << Native.TOUCH)) != 0) touchListeners--;
        events.delete(id);
        eventsHigh.delete(id);
        slops.remove(id);
        a11y.remove(id);
    }

    private void frame(int id, float x, float y, float w, float h) {
        View v = views.get(id);
        if (v == null || id == 1) return;
        if (v instanceof StackBox.ScreenBox) {
            // The screen fills its stack; the core places its root view.
            Box root = ((StackBox.ScreenBox) v).root;
            Box.Frame f = Box.frame(root);
            f.left = 0;
            f.top = 0;
            f.right = px(w);
            f.bottom = px(h);
            Box.place(root);
            return;
        }
        if (headerItems.contains(id)) {
            // A header item: the toolbar places it at its size.
            headerSizes.put(id, new int[] {px(w), px(h)});
            if (v.getParent() instanceof android.widget.Toolbar) {
                ViewGroup.LayoutParams p = v.getLayoutParams();
                p.width = Math.max(1, px(w));
                p.height = Math.max(1, px(h));
                v.setLayoutParams(p);
            }
            return;
        }
        Box.Frame f = Box.frame(v);
        Transition t = layoutAnimation != null ? layoutAnimation[1] : null;
        // A view never placed has no frame to move from; one placed zero
        // high (a collapsed reveal) or zero wide grows from it, as on iOS.
        boolean moves = t != null && !created.contains(id) && (f.right > f.left || f.bottom > f.top);
        int[] from = {f.left, f.top, f.right, f.bottom};
        int[] to = {px(x), px(y), px(x + w), px(y + h)};
        Animator running = layoutAnimators.get(id);
        if (running != null && !moves) running.cancel();
        if (moves) {
            ValueAnimator a = ValueAnimator.ofFloat(0, 1);
            a.setDuration(t.duration);
            a.setStartDelay(t.delay);
            a.setInterpolator(interpolator(t));
            a.addUpdateListener(x2 -> {
                float k = (float) x2.getAnimatedValue();
                f.left = Math.round(from[0] + (to[0] - from[0]) * k);
                f.top = Math.round(from[1] + (to[1] - from[1]) * k);
                f.right = Math.round(from[2] + (to[2] - from[2]) * k);
                f.bottom = Math.round(from[3] + (to[3] - from[3]) * k);
                Box.place(v);
            });
            if (running != null) running.cancel();
            layoutAnimators.put(id, a);
            start(a, t);
        } else {
            f.left = to[0];
            f.top = to[1];
            f.right = to[2];
            f.bottom = to[3];
            Box.place(v);
        }
        if (v instanceof ImageBox) loadImage((ImageBox) v);
    }

    private Decor decor(View v) {
        if (v instanceof StackBox.ScreenBox) return ((StackBox.ScreenBox) v).root.decor;
        if (v instanceof StackBox) return ((StackBox) v).decor;
        if (v instanceof Box) return ((Box) v).decor;
        if (v instanceof TextBox) return ((TextBox) v).decor;
        if (v instanceof ImageBox) return ((ImageBox) v).decor;
        if (v instanceof ScrollBox) return ((ScrollBox) v).decor;
        if (v instanceof InputBox) return ((InputBox) v).decor;
        return null;
    }

    private void style(ByteBuffer b) {
        int id = b.getInt();
        View v = views.get(id);
        int background = b.getInt();
        float[] radii = {b.getFloat(), b.getFloat(), b.getFloat(), b.getFloat()};
        boolean continuous = b.getInt() != 0;
        float[] borderWidths = {b.getFloat(), b.getFloat(), b.getFloat(), b.getFloat()};
        int[] borderColors = {b.getInt(), b.getInt(), b.getInt(), b.getInt()};
        int borderStyle = b.getInt();
        float opacity = b.getFloat();
        boolean overflow = b.getInt() != 0;
        Dynamic d = new Dynamic();
        d.tx = b.getFloat();
        d.ty = b.getFloat();
        d.sx = b.getFloat();
        d.sy = b.getFloat();
        d.rotate = b.getFloat();
        d.rotateX = b.getFloat();
        d.rotateY = b.getFloat();
        d.perspective = b.getFloat();
        boolean hasTint = b.getInt() != 0;
        int tint = b.getInt();
        float elevation = b.getFloat();
        boolean originXFraction = b.getInt() == 1;
        float originX = b.getFloat();
        boolean originYFraction = b.getInt() == 1;
        float originY = b.getFloat();
        boolean backfaceHidden = b.getInt() != 0;
        Effects fx = Effects.read(b, density);
        d.opacity = opacity;
        d.background = background;
        d.borderColors = borderColors;
        if (v == null) return;
        Dynamic old = statics.get(id);
        statics.put(id, d);
        Decor decor = decor(v);
        // A transition animates from what is on screen now.
        Snapshot from = fx.transitionProps != 0 && old != null && v.isAttachedToWindow() ? new Snapshot(v, decor, old) : null;
        if (decor != null) {
            for (int i = 0; i < 4; i++) {
                decor.radii[i] = radii[i] * density;
                decor.borderWidths[i] = borderWidths[i] * density;
                decor.borderColors[i] = borderColors[i];
            }
            decor.borderStyle = borderStyle;
            decor.continuous = continuous;
            decor.originX = originXFraction ? originX : originX * density;
            decor.originXFraction = originXFraction;
            decor.originY = originYFraction ? originY : originY * density;
            decor.originYFraction = originYFraction;
            decor.backfaceHidden = backfaceHidden;
            decor.hidden = fx.hidden;
            decor.boxShadows = fx.shadows;
            decor.boxShadowColors = fx.shadowColors;
            decor.gradients = fx.gradients;
            decor.outlineWidth = fx.outlineWidth;
            decor.outlineColor = fx.outlineColor;
            decor.outlineStyle = fx.outlineStyle;
            decor.outlineOffset = fx.outlineOffset;
            decor.setBackdrop(v, fx.backdrop.blur);
            decor.applyPivot(v);
        }
        Effects previous = effects.get(id);
        if (previous == null || !previous.filters.same(fx.filters) || previous.blend != fx.blend) Effects.apply(v, fx);
        if (previous == null ? fx.cursor != 0 : previous.cursor != fx.cursor) Effects.cursor(v, fx.cursor);
        effects.put(id, fx);
        boolean keyframesChanged = previous == null ? fx.keyframes != 0
                : previous.keyframes != fx.keyframes || previous.animationDuration != fx.animationDuration;
        // Material shadow: needs an outline (the decor's shape).
        v.setElevation(elevation * density);
        if (elevation > 0 && decor != null && !(v instanceof Box || v instanceof TextBox || v instanceof InputBox)) {
            decor.clip(v, false);
        }
        if (v instanceof Box) {
            ((Box) v).clip = overflow;
            ((Box) v).updateClip();
        } else if (v instanceof ScrollBox) {
            decor.clip(v, true);
        } else if (v instanceof TextBox || v instanceof InputBox) {
            decor.clip(v, overflow);
        }
        if (v instanceof ImageBox) ((ImageBox) v).setTint(hasTint ? tint : 0);
        applyDynamic(v, d);
        if (from != null) transition(v, id, decor, from, d, fx);
        if (keyframesChanged) keyframes(v, id, fx);
        v.invalidate();
    }

    /** The effects last applied to each view. */
    private final SparseArray<Effects> effects = new SparseArray<>();
    private final SparseArray<ValueAnimator> transitions = new SparseArray<>();
    private final SparseArray<ValueAnimator> keyframeAnimators = new SparseArray<>();
    private final SparseArray<Effects.Motion> motions = new SparseArray<>();

    /** What a transition starts from. */
    private static final class Snapshot {
        final int fill;
        final int[] borderColors = new int[4];
        final float[] radii = new float[4];
        final float[] borderWidths = new float[4];
        final float opacity, tx, ty, sx, sy, rotate;

        Snapshot(View v, Decor decor, Dynamic d) {
            fill = decor != null ? decor.fill : 0;
            if (decor != null) {
                System.arraycopy(decor.borderColors, 0, borderColors, 0, 4);
                System.arraycopy(decor.radii, 0, radii, 0, 4);
                System.arraycopy(decor.borderWidths, 0, borderWidths, 0, 4);
            }
            // Mid-transition values are on the view already.
            opacity = v.getAlpha();
            tx = d.tx;
            ty = d.ty;
            sx = d.sx;
            sy = d.sy;
            rotate = d.rotate;
        }
    }

    static int lerpColor(int a, int b, float t) {
        int r = 0;
        for (int shift = 0; shift < 32; shift += 8) {
            int ca = (a >>> shift) & 0xff, cb = (b >>> shift) & 0xff;
            r |= Math.round(ca + (cb - ca) * t) << shift;
        }
        return r;
    }

    /** Animates the style change of `v` from `from` to the values just set. */
    private void transition(View v, int id, Decor decor, Snapshot from, Dynamic to, Effects fx) {
        ValueAnimator running = transitions.get(id);
        if (running != null) running.cancel();
        final int fill = decor != null ? decor.fill : 0;
        final int[] borders = decor != null ? decor.borderColors.clone() : new int[4];
        final float[] radii = decor != null ? decor.radii.clone() : new float[4];
        final float[] widths = decor != null ? decor.borderWidths.clone() : new float[4];
        final int props = fx.transitionProps;
        boolean colors = (props & 1) != 0, opacity = (props & 2) != 0, transform = (props & 4) != 0, shape = (props & 16) != 0;
        ValueAnimator a = ValueAnimator.ofFloat(0, 1);
        a.setDuration((long) fx.transitionDuration);
        a.setStartDelay((long) fx.transitionDelay);
        a.setInterpolator(Effects.interpolator(fx.transitionEasing));
        Dynamic now = new Dynamic();
        a.addUpdateListener(animation -> {
            float t = (float) animation.getAnimatedValue();
            if (decor != null) {
                if (colors) {
                    decor.fill = lerpColor(from.fill, fill, t);
                    for (int i = 0; i < 4; i++) decor.borderColors[i] = lerpColor(from.borderColors[i], borders[i], t);
                }
                if (shape) {
                    for (int i = 0; i < 4; i++) {
                        decor.radii[i] = from.radii[i] + (radii[i] - from.radii[i]) * t;
                        decor.borderWidths[i] = from.borderWidths[i] + (widths[i] - from.borderWidths[i]) * t;
                    }
                }
            }
            now.opacity = opacity ? from.opacity + (to.opacity - from.opacity) * t : to.opacity;
            now.tx = transform ? from.tx + (to.tx - from.tx) * t : to.tx;
            now.ty = transform ? from.ty + (to.ty - from.ty) * t : to.ty;
            now.sx = transform ? from.sx + (to.sx - from.sx) * t : to.sx;
            now.sy = transform ? from.sy + (to.sy - from.sy) * t : to.sy;
            now.rotate = transform ? from.rotate + (to.rotate - from.rotate) * t : to.rotate;
            now.rotateX = to.rotateX;
            now.rotateY = to.rotateY;
            now.perspective = to.perspective;
            now.background = decor != null ? decor.fill : to.background;
            applyDynamic(v, now);
            v.invalidate();
        });
        a.addListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(Animator animation) {
                if (transitions.get(id) == animation) transitions.remove(id);
            }
        });
        transitions.put(id, a);
        // Start from the old look in this frame.
        if (decor != null && colors) {
            decor.fill = from.fill;
            System.arraycopy(from.borderColors, 0, decor.borderColors, 0, 4);
        }
        a.start();
    }

    /** Starts (or stops) the keyframe animation of `v`. */
    private void keyframes(View v, int id, Effects fx) {
        ValueAnimator running = keyframeAnimators.get(id);
        if (running != null) running.cancel();
        keyframeAnimators.remove(id);
        motions.remove(id);
        if (fx.keyframes == 0) {
            Dynamic d = statics.get(id);
            if (d != null) applyDynamic(v, d);
            return;
        }
        Effects.Motion motion = new Effects.Motion();
        motions.put(id, motion);
        ValueAnimator a = ValueAnimator.ofFloat(0, 1);
        a.setDuration((long) fx.animationDuration);
        a.setStartDelay((long) fx.animationDelay);
        a.setInterpolator(new android.view.animation.LinearInterpolator());
        a.setRepeatCount(fx.iterations < 0 ? ValueAnimator.INFINITE : Math.max(0, fx.iterations - 1));
        int kind = fx.keyframes;
        float[] easing = fx.animationEasing.clone();
        a.addUpdateListener(animation -> {
            Effects.keyframes(kind, (float) animation.getAnimatedValue(), v.getHeight(), easing, motion);
            Dynamic d = statics.get(id);
            if (d != null) applyDynamic(v, d);
        });
        keyframeAnimators.put(id, a);
        a.start();
    }

    // --- Interaction states (`active:`, `hover:`, `focus:`) ---------------

    private final android.util.SparseIntArray trackedStates = new android.util.SparseIntArray();
    private final android.util.SparseIntArray currentStates = new android.util.SparseIntArray();
    static final int STATE_PRESSED = 1, STATE_HOVERED = 2, STATE_FOCUSED = 4;

    boolean tracksPress(int id) {
        return (trackedStates.get(id) & STATE_PRESSED) != 0;
    }

    private void trackStates(int id, int states) {
        trackedStates.put(id, states);
        View v = views.get(id);
        if (v == null) return;
        updateHover(id, v);
    }

    private static final long MOUSE_EVENTS =
            (1L << Native.MOUSE_ENTER) | (1L << Native.MOUSE_LEAVE) | (1L << Native.MOUSE_MOVE);

    /**
     * Mice and styluses hovering `v`: its `hover:` state and its mouse events
     * (`onMouseEnter`, `onMouseMove`, `onMouseLeave`; hover events come with no
     * button down).
     */
    private void updateHover(int id, View v) {
        if ((trackedStates.get(id) & STATE_HOVERED) == 0 && (events.get(id) & MOUSE_EVENTS) == 0) {
            v.setOnHoverListener(null);
            return;
        }
        v.setOnHoverListener((view, e) -> {
            int action = e.getActionMasked();
            int kind;
            if (action == android.view.MotionEvent.ACTION_HOVER_ENTER) {
                reportState(id, STATE_HOVERED, true);
                kind = Native.MOUSE_ENTER;
            } else if (action == android.view.MotionEvent.ACTION_HOVER_EXIT) {
                reportState(id, STATE_HOVERED, false);
                kind = Native.MOUSE_LEAVE;
            } else if (action == android.view.MotionEvent.ACTION_HOVER_MOVE) {
                kind = Native.MOUSE_MOVE;
            } else {
                return false;
            }
            if (wants(id, kind)) mouse(id, kind, view, e);
            // The movement that brings the pointer in is a move too, as on
            // the desktops and in the DOM.
            if (kind == Native.MOUSE_ENTER && wants(id, Native.MOUSE_MOVE)) mouse(id, Native.MOUSE_MOVE, view, e);
            return false;
        });
    }

    /** Mouse event `kind`: where the pointer is in `v` and in its root view (dp). */
    private void mouse(int id, int kind, View v, android.view.MotionEvent e) {
        // The surface, or the window of the modal the view is in.
        View root = v.getRootView() == host.getRootView() ? host : v.getRootView();
        int[] at = new int[2], rootAt = new int[2];
        v.getLocationOnScreen(at);
        root.getLocationOnScreen(rootAt);
        float d = density;
        Native.mouse(handle(), id, kind, e.getX() / d, e.getY() / d,
                (e.getX() + at[0] - rootAt[0]) / d, (e.getY() + at[1] - rootAt[1]) / d,
                modifiers(e.getMetaState()));
    }

    /** An interaction state of `id` changed: tells the core if it reads it. */
    void reportState(int id, int bit, boolean on) {
        int states = currentStates.get(id);
        int next = on ? states | bit : states & ~bit;
        if (next == states) return;
        currentStates.put(id, next);
        int tracked = trackedStates.get(id);
        if ((tracked & bit) != 0) Native.states(handle(), id, next & tracked);
    }

    /**
     * Horizontal lists laid out right to left are mirrored as a whole (1)
     * and their cells mirrored back (2): the list's offsets stay left to
     * right. View transforms compose with the flip.
     */
    private final android.util.SparseIntArray mirrors = new android.util.SparseIntArray();

    private void setMirrored(ScrollBox list, boolean mirrored) {
        int id = list.id;
        if ((mirrors.get(id) == 1) == mirrored) return;
        if (mirrored) mirrors.put(id, 1);
        else mirrors.delete(id);
        Dynamic d = statics.get(id);
        applyDynamic(list, d != null ? d : new Dynamic());
        ViewGroup content = list.content;
        for (int i = 0; i < content.getChildCount(); i++) {
            View cell = content.getChildAt(i);
            if (!(cell instanceof Node)) continue;
            int cellId = ((Node) cell).nodeId();
            if (mirrored) mirrors.put(cellId, 2);
            else mirrors.delete(cellId);
            Dynamic c = statics.get(cellId);
            applyDynamic(cell, c != null ? c : new Dynamic());
        }
    }

    /** Sign of x-axis transforms of {@code v}: -1 for mirrored cells. */
    private int mirror(View v) {
        return v instanceof Node ? mirrors.get(((Node) v).nodeId()) : 0;
    }

    private void applyDynamic(View v, Dynamic d) {
        int mirror = mirror(v);
        // A cell flips back last: its x translation and rotations about the
        // y and z axes turn around.
        float back = mirror == 2 ? -1 : 1;
        Effects.Motion m = motions.get(v instanceof Node ? ((Node) v).nodeId() : -1);
        float ma = m != null ? m.alpha : 1, ms = m != null ? m.scale : 1;
        float mr = m != null ? m.rotate : 0, mty = m != null ? m.ty : 0;
        v.setAlpha(d.opacity * ma);
        v.setTranslationX(back * d.tx * density);
        v.setTranslationY(d.ty * density + mty);
        v.setScaleX((mirror != 0 ? -d.sx : d.sx) * ms);
        v.setScaleY(d.sy * ms);
        v.setRotation(back * (d.rotate + mr));
        v.setRotationX(d.rotateX);
        v.setRotationY(back * d.rotateY);
        setPerspective(v, d.perspective);
        Decor backface = decor(v);
        if (backface != null) backface.applyBackface(v);
        Decor decor = decor(v);
        if (decor != null && (decor.fill != d.background || !java.util.Arrays.equals(decor.borderColors, d.borderColors))) {
            decor.fill = d.background;
            System.arraycopy(d.borderColors, 0, decor.borderColors, 0, 4);
            v.invalidate();
        }
        if (v instanceof TextBox) ((TextBox) v).setColor(false, 0);
    }

    /**
     * `perspective` as a camera distance (React Native's normalization), set
     * only when it moves: `setCameraDistance` invalidates the view on every
     * call, and animated values and transitions come here each frame with
     * the distance unchanged.
     */
    private void setPerspective(View v, float term) {
        if (term == 0) term = 0.00078125f;
        float distance = Math.abs(density * density * (-1 / term) * (float) Math.sqrt(5));
        // The view keeps it divided by the screen's dpi: equal within a hair.
        if (Math.abs(Math.abs(v.getCameraDistance()) - distance) <= distance * 1e-5f) return;
        v.setCameraDistance(distance);
    }

    /** Press feedback of a view: `delayLongPress`, `android_ripple`. */
    static final class Feedback {
        int longPressDelay = -1;
        android.graphics.drawable.RippleDrawable ripple;
        boolean rippleForeground;
    }

    private final android.util.SparseArray<Feedback> feedback = new android.util.SparseArray<>();

    /** Milliseconds before a press on {@code id} becomes a long press. */
    int longPressDelay(int id) {
        Feedback f = feedback.get(id);
        return f != null && f.longPressDelay >= 0 ? f.longPressDelay : ViewConfiguration.getLongPressTimeout();
    }

    /**
     * Whether presses on {@code id} show feedback. A view that also handles
     * presses shows it itself; for one that does not, the root's
     * `TouchTracker` does, and the view stays unclickable.
     */
    boolean hasPressFeedback(int id) {
        Feedback f = feedback.get(id);
        return tracksPress(id) || f != null && f.ripple != null;
    }

    /** Shows (or ends) the press feedback of view {@code id}, pressed at ({@code x}, {@code y}). */
    void pressFeedback(View v, int id, boolean pressed, float x, float y) {
        reportState(id, STATE_PRESSED, pressed);
        Feedback f = feedback.get(id);
        if (f == null) return;
        if (f.ripple != null) {
            if (pressed) f.ripple.setHotspot(x, y);
            f.ripple.setState(pressed
                    ? new int[] {android.R.attr.state_pressed, android.R.attr.state_enabled}
                    : new int[] {android.R.attr.state_enabled});
        }
    }

    /** `android_ripple`: flags 1 set, 2 borderless, 4 foreground. */
    private void setRipple(View v, Feedback f, int flags, Integer color, float radius) {
        Decor decor = v instanceof Box ? ((Box) v).decor : v instanceof TextBox ? ((TextBox) v).decor
                : v instanceof ImageBox ? ((ImageBox) v).decor : null;
        if (decor == null) return;
        // Undo the previous ripple.
        if (f.ripple != null) {
            if (f.rippleForeground) v.setForeground(null);
            else v.setBackground(decor);
            f.ripple = null;
        }
        if ((flags & 1) == 0) return;
        int c = color != null ? color : themeHighlight();
        android.graphics.drawable.Drawable mask = (flags & 2) != 0 ? null : new android.graphics.drawable.Drawable() {
            private final android.graphics.Path path = new android.graphics.Path();
            private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);

            @Override
            public void draw(android.graphics.Canvas canvas) {
                paint.setColor(0xffffffff);
                canvas.drawPath(decor.shape(getBounds(), 0, path), paint);
            }

            @Override
            public void setAlpha(int alpha) {}

            @Override
            public void setColorFilter(android.graphics.ColorFilter filter) {}

            @SuppressWarnings("deprecation")
            @Override
            public int getOpacity() {
                return android.graphics.PixelFormat.TRANSLUCENT;
            }
        };
        android.graphics.drawable.RippleDrawable ripple = new android.graphics.drawable.RippleDrawable(
                android.content.res.ColorStateList.valueOf(c), null, mask);
        if (radius >= 0) ripple.setRadius(Math.round(radius * density));
        f.ripple = ripple;
        f.rippleForeground = (flags & 4) != 0;
        if (f.rippleForeground) {
            v.setForeground(ripple);
        } else {
            v.setBackground(new android.graphics.drawable.LayerDrawable(new android.graphics.drawable.Drawable[] {decor, ripple}));
        }
    }

    private int themeHighlight() {
        android.util.TypedValue value = new android.util.TypedValue();
        if (context.getTheme().resolveAttribute(android.R.attr.colorControlHighlight, value, true)) {
            return value.resourceId != 0 ? context.getColor(value.resourceId) : value.data;
        }
        return 0x1f000000;
    }

    boolean hasHitSlop() {
        return slops.size() > 0;
    }

    float[] hitSlop(int id) {
        return slops.get(id);
    }

    private void viewProps(ByteBuffer b, Object[] objects) {
        int id = b.getInt();
        View v = views.get(id);
        int pointerEvents = b.getInt();
        float[] slop = {b.getFloat() * density, b.getFloat() * density, b.getFloat() * density, b.getFloat() * density};
        A11y a = new A11y(this, id);
        a.accessible = b.getInt();
        a.label = string(objects, b.getInt());
        a.hint = string(objects, b.getInt());
        a.role = b.getInt();
        a.state = b.getInt();
        a.hasValue = b.getInt() != 0;
        if (a.hasValue) {
            a.min = b.getFloat();
            a.max = b.getFloat();
            a.now = b.getFloat();
            a.valueText = string(objects, b.getInt());
        }
        a.hidden = b.getInt() != 0;
        a.liveRegion = b.getInt();
        int actions = b.getInt();
        a.actionNames = new String[actions];
        a.actionLabels = new String[actions];
        for (int i = 0; i < actions; i++) {
            a.actionNames[i] = string(objects, b.getInt());
            a.actionLabels[i] = string(objects, b.getInt());
        }
        a.testId = string(objects, b.getInt());
        float longPressDelay = b.getFloat();
        int ripple = b.getInt();
        Integer rippleColor = null;
        float rippleRadius = -1;
        if ((ripple & 1) != 0) {
            rippleColor = optColor(b);
            rippleRadius = b.getFloat();
        }
        if (b.getInt() != 0) {
            panActivations.put(id, new float[] {b.getFloat(), b.getFloat(), b.getFloat(), b.getFloat()});
        } else {
            panActivations.remove(id);
        }
        boolean selectableView = b.getInt() != 0;
        if (v == null) return;
        SelectableView area = selectableViews.get(id);
        if (selectableView && (area == null || area.view != v)) {
            if (area != null) area.clear();
            selectableViews.put(id, new SelectableView(this, v));
        } else if (!selectableView && area != null) {
            area.clear();
            selectableViews.remove(id);
        }
        Feedback f = feedback.get(id);
        if (f == null) feedback.put(id, f = new Feedback());
        f.longPressDelay = longPressDelay >= 0 ? Math.round(longPressDelay) : -1;
        setRipple(v, f, ripple, rippleColor, rippleRadius);
        if (slop[0] != 0 || slop[1] != 0 || slop[2] != 0 || slop[3] != 0) slops.put(id, slop);
        else slops.remove(id);
        if (v instanceof Box) {
            Box box = (Box) v;
            box.pointerEvents = pointerEvents;
        }
        if (v instanceof InputBox) ((InputBox) v).pointerEvents = pointerEvents;
        if (v instanceof TextBox) ((TextBox) v).a11y = a;
        a11y.put(id, a);
        a.apply(v);
    }

    private static String string(Object[] objects, int index) {
        return index >= 0 ? (String) objects[index] : null;
    }

    /** Applies `[animating, (view, prop, value)*]` from the animator. */
    /** A canvas's drawing; loads the images it draws (bitmaps: an SVG is an image that failed to load). */
    private void drawing(CanvasBox canvas, int[] code, Object[] objects) {
        for (String uri : canvas.setDrawing(code, objects)) {
            if (canvas.images.containsKey(uri)) continue;
            // At their natural size: the drawing may scale them anyway.
            Images.Image cached = images.request(uri, 0, 0, (image, error) -> {
                if (image != null && !image.vector) {
                    canvas.images.put(uri, image);
                    canvas.invalidate();
                } else {
                    android.util.Log.w("nsh", "canvas image failed: " + (image != null ? notABitmap(uri) : error));
                }
            });
            if (cached != null && cached.vector) android.util.Log.w("nsh", "canvas image failed: " + notABitmap(uri));
            else if (cached != null) canvas.images.put(uri, cached);
        }
    }

    private static String notABitmap(String uri) {
        return uri + " is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)";
    }

    /** Canvas animated value slot `n` arrives as property `CANVAS_ARG + n` (`animation.rs`). */
    private static final int CANVAS_ARG = 1000;
    /** A native component's animated prop slot `n`: a number as `COMPONENT_NUMBER + n`, a color (ARGB bits) as `COMPONENT_COLOR + n` (`animation.rs`). */
    private static final int COMPONENT_NUMBER = 70000, COMPONENT_COLOR = 140000;

    /** How much further each sticky cell sticks (px; an animated `StickyCell::offset`). */
    private final java.util.HashMap<Integer, Float> stickyOffsets = new java.util.HashMap<>();
    /** The scroll view that pins each sticky cell. */
    final java.util.HashMap<Integer, ScrollBox> stickyHosts = new java.util.HashMap<>();

    /** How much further sticky cell `id` sticks (px). */
    float stickyOffset(int id) {
        Float offset = stickyOffsets.get(id);
        return offset == null ? 0 : offset;
    }

    /** Sticky cell `id` sticks no animated value further in (until an output says so). */
    void forgetStickyOffset(int id) {
        stickyOffsets.remove(id);
    }

    void outputs(float[] out) {
        if (out == null || out.length == 0) return;
        for (int i = 1; i + 2 < out.length; i += 3) {
            View v = views.get(Float.floatToRawIntBits(out[i]));
            if (v == null) continue;
            float value = out[i + 2];
            int prop = (int) out[i + 1];
            if (prop >= COMPONENT_NUMBER) {
                if (v instanceof ComponentBox) {
                    boolean color = prop >= COMPONENT_COLOR;
                    ((ComponentBox) v).setAnimated(prop - (color ? COMPONENT_COLOR : COMPONENT_NUMBER), color, value);
                }
                continue;
            }
            if (prop >= CANVAS_ARG) {
                if (v instanceof CanvasBox) ((CanvasBox) v).setSlot(prop - CANVAS_ARG, value);
                continue;
            }
            switch (prop) {
                case 0: v.setAlpha(Math.max(0, Math.min(1, value))); break;
                case 1: v.setTranslationX((mirror(v) == 2 ? -1 : 1) * value * density); break;
                case 2: v.setTranslationY(value * density); break;
                case 3: v.setScaleX(mirror(v) != 0 ? -value : value); v.setScaleY(value); break;
                case 4: v.setScaleX(mirror(v) != 0 ? -value : value); break;
                case 5: v.setScaleY(value); break;
                case 6: v.setRotation((mirror(v) == 2 ? -1 : 1) * value); break;
                case 8:
                case 9: {
                    if ((int) out[i + 1] == 8) v.setRotationX(value);
                    else v.setRotationY((mirror(v) == 2 ? -1 : 1) * value);
                    Decor decor = decor(v);
                    if (decor != null) decor.applyBackface(v);
                    break;
                }
                case 10: setPerspective(v, value); break;
                case 7: {
                    Decor decor = decor(v);
                    int color = Float.floatToRawIntBits(value);
                    if (decor != null && decor.fill != color) {
                        decor.fill = color;
                        v.invalidate();
                    }
                    break;
                }
                case 11: {
                    Decor decor = decor(v);
                    int color = Float.floatToRawIntBits(value);
                    if (decor != null && (decor.borderColors[0] != color || decor.borderColors[1] != color
                            || decor.borderColors[2] != color || decor.borderColors[3] != color)) {
                        java.util.Arrays.fill(decor.borderColors, color);
                        v.invalidate();
                    }
                    break;
                }
                case 12:
                    if (v instanceof TextBox) ((TextBox) v).setColor(true, Float.floatToRawIntBits(value));
                    break;
                case 15: {
                    // A sticky cell sticks further in: its scroll view pins it again.
                    int id = Float.floatToRawIntBits(out[i]);
                    Float old = stickyOffsets.put(id, value * density);
                    ScrollBox s = stickyHosts.get(id);
                    if (s != null && (old == null || old != value * density)) s.pinSticky();
                    break;
                }
                default: break;
            }
        }
        if (out[0] != 0) host.requestFrames();
    }

    // --- Navigation ----------------------------------------------------------

    /** Screens, header items and modals are not subviews of their parent. */
    private boolean insertHosted(int parentId, int childId, int beforeId) {
        View parent = views.get(parentId), child = views.get(childId);
        if (child instanceof StackBox.ScreenBox && parent instanceof StackBox) {
            StackBox stack = (StackBox) parent;
            ((StackBox.ScreenBox) child).parked = false;
            stack.screens.remove((Integer) childId);
            int pos = beforeId >= 0 ? stack.screens.indexOf(beforeId) : -1;
            stack.screens.add(pos >= 0 ? pos : stack.screens.size(), childId);
            dirtyStacks.add(parentId);
        } else if (modals.get(childId) != null) {
            dirtyModals.add(childId);
        } else if (parent instanceof StackBox.ScreenBox && child instanceof Box && headerItem(childId)) {
            dirtyScreens.add(parentId);
        } else {
            return false;
        }
        hosts.put(childId, parentId);
        return true;
    }

    /** Header items are views created as kind 8; they stay `Box`es. */
    private final java.util.HashSet<Integer> headerItems = new java.util.HashSet<>();

    /** Sizes of header items (px), placed by toolbars. */
    final SparseArray<int[]> headerSizes = new SparseArray<>();

    private boolean headerItem(int id) {
        return headerItems.contains(id);
    }

    boolean headerMounted(int id, int screen) {
        return hosts.get(id, -1) == screen;
    }

    private boolean removeHosted(int id) {
        int parentId = hosts.get(id, -1);
        if (parentId < 0) return false;
        hosts.delete(id);
        View parent = views.get(parentId), child = views.get(id);
        if (parent instanceof StackBox) {
            StackBox stack = (StackBox) parent;
            stack.screens.remove((Integer) id);
            stack.popped.remove((Integer) id);
            dirtyStacks.add(parentId);
        } else if (modals.get(id) != null) {
            dirtyModals.add(id);
        } else if (child != null) {
            detach(child);
            dirtyScreens.add(parentId);
        }
        return true;
    }

    private void screenConfig(ByteBuffer b, Object[] objects) {
        int id = b.getInt();
        ScreenOptions o = new ScreenOptions();
        o.title = string(objects, b.getInt());
        o.shown = b.getInt() != 0;
        b.getInt(); // large titles: iOS only
        o.transparent = b.getInt() != 0;
        o.tint = b.getInt() != 0 ? b.getInt() : skip(b);
        o.background = b.getInt() != 0 ? b.getInt() : skip(b);
        o.titleColor = b.getInt() != 0 ? b.getInt() : skip(b);
        o.backVisible = b.getInt() != 0;
        o.gesture = b.getInt() != 0;
        o.preventBack = b.getInt() != 0;
        o.animation = b.getInt();
        o.left = b.getInt();
        o.right = b.getInt();
        o.titleView = b.getInt();
        o.headerHeight = b.getFloat();
        o.backTitle = string(objects, b.getInt());
        screenOptions.put(id, o);
        dirtyScreens.add(id);
        int stack = hosts.get(id, -1);
        if (stack >= 0) dirtyStacks.add(stack);
    }

    private static int skip(ByteBuffer b) {
        b.getInt();
        return 0;
    }

    /** Pushes and pops screens, applies headers, shows and hides modals. */
    private void finishNavigation() {
        for (int id : dirtyStacks) {
            View v = views.get(id);
            if (v instanceof StackBox) {
                StackBox stack = (StackBox) v;
                for (int s : stack.screens) dirtyScreens.add(s);
                stack.reconcile();
            }
        }
        dirtyStacks.clear();
        for (int id : dirtyScreens) {
            View v = views.get(id);
            ScreenOptions o = screenOptions.get(id);
            if (!(v instanceof StackBox.ScreenBox) || o == null) continue;
            View stack = views.get(hosts.get(id, -1));
            int index = stack instanceof StackBox ? ((StackBox) stack).screens.indexOf(id) : -1;
            boolean canGoBack = index > 0;
            // The up arrow is named after the screen it leads back to.
            ScreenOptions below = canGoBack ? screenOptions.get(((StackBox) stack).screens.get(index - 1)) : null;
            ((StackBox.ScreenBox) v).configure(this, o.title, o.shown, o.transparent, o.tint, o.background,
                    o.titleColor, o.backVisible, o.gesture, o.preventBack, o.animation, o.left, o.right, o.titleView,
                    o.headerHeight, canGoBack, below != null ? below.backTitle : null);
            reportScreenInsets(id, o);
        }
        dirtyScreens.clear();
        for (int id : dirtyModals) {
            ModalHost modal = modals.get(id);
            if (modal == null) continue;
            if (hosts.get(id, -1) >= 0) {
                modal.show();
                shownModals.remove(modal);
                shownModals.add(modal);
                if (barStyle >= 0) modal.statusBar(barStyle, barHidden, night());
            } else {
                modal.dismiss();
                shownModals.remove(modal);
            }
        }
        dirtyModals.clear();
        updateBack();
    }

    /** A screen's insets below its header, for `safeAreaInsets()`. */
    private void reportScreenInsets(int id, ScreenOptions o) {
        float top = o.shown && !o.transparent ? 0 : host.safeTop();
        insets(id, top, host.safeRight(), host.safeBottom(), host.safeLeft());
    }

    /** Reports `onInsets` (dp): left / right packed in the count. */
    void insets(int id, float top, float right, float bottom, float left) {
        int packed = (Math.round(left) << 16) | (Math.round(right) & 0xffff);
        Native.event(handle(), id, Native.INSETS, null, packed, top, bottom);
    }

    void rootSize(int id, float w, float h, float top, float right, float bottom, float left) {
        Native.rootSize(handle(), id, w, h, top, right, bottom, left);
        insets(id, top, right, bottom, left);
    }

    /**
     * Whether the back button means something to the app now. Decided from
     * what is mounted (modals, stacks, `popOnBack`, a `BackHandler`), never
     * by asking JS: the system asks synchronously.
     */
    boolean wantsBack() {
        if (!shownModals.isEmpty()) return true;
        return backStack() != null || wants(1, Native.BACK_PRESS);
    }

    void updateBack() {
        host.setBackHandling(wantsBack());
    }

    boolean hasShownModal() {
        return !shownModals.isEmpty();
    }

    /** The window of the topmost dialog shown, or null. */
    View topModalWindow() {
        for (int i = shownModals.size() - 1; i >= 0; i--) {
            View window = shownModals.get(i).window();
            if (window != null) return window;
        }
        return null;
    }

    /** The stack the back button acts on (pops, or asks to leave), if any. */
    StackBox backStack() {
        for (int i = stacks.size() - 1; i >= 0; i--) {
            StackBox s = stacks.get(i);
            if (s.preventsBack() || s.canPop()) return s;
        }
        return null;
    }

    /** A modal closed itself (`closeOnEscape`): the back button no longer goes to it. */
    void modalClosed(ModalHost modal) {
        shownModals.remove(modal);
        updateBack();
    }

    /** Whether the app's back listeners hear the button before the stacks. */
    boolean listensToBack() {
        return wants(1, Native.BACK_PRESS);
    }

    /** The back button: the newest modal asks to close, else the app's
     * listeners hear it (and send {@code Command::Back} when none takes it),
     * else the innermost stack pops. Returns false if nothing did. */
    boolean handleBack() {
        if (!shownModals.isEmpty()) {
            shownModals.get(shownModals.size() - 1).backPressed();
            return true;
        }
        if (listensToBack()) {
            event(1, Native.BACK_PRESS);
            return true;
        }
        StackBox stack = backStack();
        if (stack != null) {
            stack.back();
            return true;
        }
        return false;
    }

    /** {@code Command::Back}: the back button as without the app's
     * listeners. The newest modal asks to close, else the innermost stack
     * pops, else the app leaves. */
    private void defaultBack() {
        if (!shownModals.isEmpty()) {
            shownModals.get(shownModals.size() - 1).backPressed();
            return;
        }
        StackBox stack = backStack();
        if (stack != null) stack.back();
        else host.exitApp();
    }

    // --- Images ------------------------------------------------------------

    private void image(int id, String uri, int mode, String placeholder, int blurPx, int fadeMs) {
        View v = views.get(id);
        if (!(v instanceof ImageBox)) return;
        ImageBox image = (ImageBox) v;
        image.resizeMode = mode;
        image.fadeMs = fadeMs;
        boolean same = (uri == null ? image.uri == null : uri.equals(image.uri))
                && (placeholder == null ? image.placeholderUri == null : placeholder.equals(image.placeholderUri))
                && blurPx == image.blurPx;
        if (same) {
            image.invalidate();
            return;
        }
        cancelImage(image);
        image.setImage(null, 0);
        image.imageShown = false;
        image.uri = uri;
        image.placeholderUri = placeholder;
        image.blurPx = blurPx;
        loadImage(image);
    }

    private void loadImage(ImageBox image) {
        if (image.requestedPx > 0 || image.placeholderPx > 0) return;
        Box.Frame f = Box.frame(image);
        int maxPx = Math.max(f.right - f.left, f.bottom - f.top);
        if (maxPx <= 0) return;
        if (image.uri != null && !image.imageShown) {
            image.requestedPx = maxPx;
            Images.Image cached = images.request(image.uri, maxPx, image.blurPx, image.callback);
            if (cached != null) {
                image.requestedPx = 0;
                image.setImage(cached, 0);
                image.imageShown = true;
                loaded(image, cached);
            } else if (wants(image.id, Native.LOAD_START)) {
                event(image.id, Native.LOAD_START);
            }
        }
        // The placeholder, until the image shows.
        if (image.placeholderUri != null && !image.imageShown) {
            image.placeholderPx = maxPx;
            Images.Image cached = images.request(image.placeholderUri, maxPx, 0, image.placeholderCallback);
            if (cached != null) {
                image.placeholderPx = 0;
                image.setImage(cached, 0);
            }
        }
    }

    private void cancelImage(ImageBox image) {
        if (image.uri != null && image.requestedPx > 0) images.cancel(image.uri, image.requestedPx, image.blurPx, image.callback);
        if (image.placeholderUri != null && image.placeholderPx > 0) {
            images.cancel(image.placeholderUri, image.placeholderPx, 0, image.placeholderCallback);
        }
        image.requestedPx = 0;
        image.placeholderPx = 0;
    }

    private void imageDone(ImageBox image, Images.Image result, String error) {
        image.requestedPx = 0;
        int id = image.id;
        if (views.get(id) != image) return;
        if (result != null) {
            // React Native fades in images on Android (300 ms by default).
            image.setImage(result, image.fadeMs < 0 ? 300 : image.fadeMs);
            image.imageShown = true;
            loaded(image, result);
        } else {
            // The placeholder (if any) stays.
            if (wants(id, Native.ERROR)) event(id, Native.ERROR, error, 0, 0, 0);
            if (wants(id, Native.LOAD_END)) event(id, Native.LOAD_END);
        }
    }

    private void placeholderDone(ImageBox image, Images.Image result) {
        image.placeholderPx = 0;
        if (views.get(image.id) != image || image.imageShown || result == null) return;
        image.setImage(result, 0);
    }

    /** `onLoad` reports the source's size in pixels (an SVG's: in points), as on iOS. */
    private void loaded(ImageBox image, Images.Image result) {
        if (wants(image.id, Native.LOAD)) event(image.id, Native.LOAD, null, 0, result.width, result.height);
        if (wants(image.id, Native.LOAD_END)) event(image.id, Native.LOAD_END);
    }

    // --- Inputs and commands -------------------------------------------------

    private void input(ByteBuffer b, Object[] objects) {
        View v = views.get(b.getInt());
        float size = b.getFloat();
        int weight = b.getInt();
        boolean italic = b.getInt() != 0;
        int color = b.getInt();
        int familyIndex = b.getInt();
        float spacing = b.getFloat();
        int align = b.getInt();
        String placeholder = (String) objects[b.getInt()];
        boolean hasPlaceholderColor = b.getInt() != 0;
        int placeholderColor = b.getInt();
        boolean secure = b.getInt() != 0;
        int keyboard = b.getInt(), returnKey = b.getInt(), capitalize = b.getInt();
        boolean autoCorrect = b.getInt() != 0, multiline = b.getInt() != 0;
        int maxLength = b.getInt();
        boolean editable = b.getInt() != 0, autoFocus = b.getInt() != 0, hasSelection = b.getInt() != 0;
        int selection = b.getInt();
        boolean hasCaret = b.getInt() != 0;
        int caret = b.getInt();
        int submit = b.getInt();
        String autofill = optString(b, objects);
        boolean inputRtl = b.getInt() != 0;
        boolean caretHidden = b.getInt() != 0;
        boolean pasteInserts = b.getInt() != 0;
        boolean scrollbarVisible = b.getInt() != 0, replaced = b.getInt() != 0;
        if (!(v instanceof InputBox)) return;
        ((InputBox) v).pasteInserts = pasteInserts;
        ((InputBox) v).setScrollbar(scrollbarVisible, replaced);
        ((InputBox) v).edit.setCursorVisible(!caretHidden);
        ((InputBox) v).setAutofill(autofill);
        ((InputBox) v).edit.setLayoutDirection(inputRtl ? View.LAYOUT_DIRECTION_RTL : View.LAYOUT_DIRECTION_LTR);
        String family = familyIndex >= 0 ? (String) objects[familyIndex] : null;
        ((InputBox) v).configure(size, weight, italic, color, family, spacing, align, placeholder,
                hasPlaceholderColor, placeholderColor, secure, keyboard, returnKey, capitalize, autoCorrect,
                multiline, maxLength, editable, autoFocus, hasSelection, selection, hasCaret, caret, submit);
    }

    private void command(ByteBuffer b, Object[] objects) {
        int id = b.getInt(), kind = b.getInt();
        View v = views.get(id);
        switch (kind) {
            case 0:
                if (v instanceof InputBox) ((InputBox) v).focus();
                break;
            case 1:
                if (v instanceof InputBox) {
                    ((InputBox) v).blur();
                } else if (id == 1) {
                    View f = host.findFocus();
                    if (f != null && f != host) {
                        InputMethodManager imm = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
                        imm.hideSoftInputFromWindow(f.getWindowToken(), 0);
                        host.requestFocus();
                    }
                }
                break;
            case 2: {
                float x = b.getFloat(), y = b.getFloat();
                boolean animated = b.getInt() != 0;
                if (v instanceof ScrollBox) ((ScrollBox) v).scrollToPx(px(x), px(y), animated);
                else if (v instanceof InputBox) ((InputBox) v).scrollTextTo(y);
                break;
            }
            case 3: host.exitApp(); break;
            case 24: defaultBack(); break;
            case 4: case 5: case 6: case 7:
                if (v instanceof WebBox) ((WebBox) v).command(kind, null);
                break;
            case 8: case 9: {
                String text = (String) objects[b.getInt()];
                if (v instanceof WebBox) ((WebBox) v).command(kind, text);
                break;
            }
            case 10: {
                float seconds = b.getFloat();
                if (v instanceof VideoBox) ((VideoBox) v).seek(seconds);
                break;
            }
            case 11: {
                int style = b.getInt();
                boolean hidden = b.getInt() != 0;
                b.getInt(); // animated: the system animates bar changes
                barStyle = style;
                barHidden = hidden;
                SystemUi.statusBar(context, style, hidden, night());
                for (ModalHost m : shownModals) m.statusBar(style, hidden, night());
                break;
            }
            case 12: {
                int dialog = b.getInt();
                String title = optString(b, objects), message = optString(b, objects);
                boolean cancelable = b.getInt() != 0, sheet = b.getInt() != 0;
                int n = b.getInt();
                String[] texts = new String[n];
                int[] styles = new int[n];
                for (int i = 0; i < n; i++) {
                    texts[i] = (String) objects[b.getInt()];
                    styles[i] = b.getInt();
                }
                SystemUi.dialog(this, dialog, title, message, cancelable, sheet, texts, styles);
                break;
            }
            case 14: {
                boolean block = b.getInt() != 0;
                clearJsResponder();
                if (block && v != null) {
                    // Scroll views around the responder stop taking its touches.
                    for (ViewParent p = v.getParent(); p != null; p = p.getParent()) {
                        if (p instanceof ScrollBox) {
                            ((ScrollBox) p).jsBlocked = true;
                            blockedScrolls.add((ScrollBox) p);
                        }
                    }
                    if (v.getParent() != null) v.getParent().requestDisallowInterceptTouchEvent(true);
                }
                break;
            }
            case 15: clearJsResponder(); break;
            case 16: {
                int start = b.getInt(), end = b.getInt();
                if (v instanceof InputBox) ((InputBox) v).select(start, end);
                break;
            }
            case 21: {
                String name = string(objects, b.getInt());
                String json = string(objects, b.getInt());
                if (v instanceof ComponentBox && ((ComponentBox) v).component != null) {
                    ((ComponentBox) v).component.command(name, Json.parse(json));
                }
                break;
            }
            case 20: {
                float scale = b.getFloat();
                boolean hasCenter = b.getInt() != 0;
                float x = b.getFloat(), y = b.getFloat();
                boolean animated = b.getInt() != 0;
                if (v instanceof ScrollBox) ((ScrollBox) v).zoomTo(scale, hasCenter, x, y, animated);
                break;
            }
            case 22: {
                SystemUi.setClipboard(context, (String) objects[b.getInt()]);
                break;
            }
            case 25: {
                Picker.Request request = new Picker.Request();
                request.id = b.getInt();
                request.limit = b.getInt();
                request.maxDimension = b.getInt();
                request.quality = b.getFloat();
                request.current = b.getInt() != 0;
                request.view = host;
                Picker.show(context, request);
                break;
            }
            case 26: {
                int request = b.getInt();
                String url = (String) objects[b.getInt()];
                boolean opened = SystemUi.openUrl(context, url);
                eventMap(1, Native.OPEN_URL, new String[] {"id", "opened"}, new Object[] {(double) request, opened});
                break;
            }
            case 23: {
                int request = b.getInt();
                boolean hasOnly = b.getInt() != 0;
                String text = SystemUi.readClipboard(context, hasOnly);
                boolean has = text != null;
                if (hasOnly || text == null) {
                    eventMap(1, Native.CLIPBOARD, new String[] {"id", "has"}, new Object[] {(double) request, has});
                } else {
                    eventMap(1, Native.CLIPBOARD, new String[] {"id", "has", "text"},
                            new Object[] {(double) request, true, text});
                }
                break;
            }
            case 19: {
                int request = b.getInt();
                String uri = (String) objects[b.getInt()];
                images.info(uri, (width, height, error) -> {
                    if (error != null) {
                        eventMap(1, Native.IMAGE_INFO, new String[] {"id", "error"}, new Object[] {(double) request, error});
                    } else {
                        eventMap(1, Native.IMAGE_INFO, new String[] {"id", "width", "height"},
                                new Object[] {(double) request, (double) width, (double) height});
                    }
                });
                break;
            }
            case 17: {
                String text = (String) objects[b.getInt()];
                (v != null ? v : host).announceForAccessibility(text);
                break;
            }
            case 18: {
                if (v != null) {
                    v.performAccessibilityAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null);
                }
                break;
            }
            default: break;
        }
    }

    private static Integer optColor(ByteBuffer b) {
        boolean set = b.getInt() != 0;
        int color = b.getInt();
        return set ? color : null;
    }

    private static String optString(ByteBuffer b, Object[] objects) {
        int i = b.getInt();
        return i >= 0 ? (String) objects[i] : null;
    }

    /** `encode.rs` `native_props`. */
    private void nativeProps(ByteBuffer b, Object[] objects) {
        View v = views.get(b.getInt());
        switch (b.getInt()) {
            case 3: {
                Object[] source;
                switch (b.getInt()) {
                    case 1: source = new Object[] {1, objects[b.getInt()]}; break;
                    case 2: {
                        Object html = objects[b.getInt()];
                        source = new Object[] {2, html, optString(b, objects)};
                        break;
                    }
                    default: source = new Object[] {0};
                }
                String injected = optString(b, objects), before = optString(b, objects), ua = optString(b, objects);
                boolean scroll = b.getInt() != 0, js = b.getInt() != 0;
                if (v instanceof WebBox) ((WebBox) v).configure(source, injected, before, ua, scroll, js);
                break;
            }
            case 4: {
                String source = optString(b, objects);
                boolean paused = b.getInt() != 0, muted = b.getInt() != 0;
                float volume = b.getFloat(), rate = b.getFloat();
                boolean repeat = b.getInt() != 0;
                int mode = b.getInt();
                boolean controls = b.getInt() != 0;
                float interval = b.getFloat();
                int audioSession = b.getInt();
                if (v instanceof VideoBox) {
                    ((VideoBox) v).configure(source, paused, muted, volume, rate, repeat, mode, controls, interval,
                            audioSession);
                }
                break;
            }
            default: throw new IllegalStateException("nsh: unknown native props");
        }
    }

    void inputFocused(InputBox input, boolean focused) {
        if (focused) {
            this.focused = input;
            host.post(this::revealFocused);
        } else if (this.focused == input) {
            this.focused = null;
        }
    }

    /** The scroll view padded to clear the keyboard. */
    private int avoided = -1;

    /**
     * The software keyboard's top edge moved, in screen coordinates
     * ({@code Integer.MAX_VALUE} when hidden): pads the scroll view around
     * the focused input so it can clear the keyboard (in the surface or a
     * modal window).
     */
    void keyboard(int screenTop) {
        ScrollBox scroll = focused == null ? null : scrollAround(focused);
        boolean hidden = screenTop == Integer.MAX_VALUE;
        if (avoided >= 0) {
            View previous = views.get(avoided);
            if (previous instanceof ScrollBox && (previous != scroll || hidden)) {
                ((ScrollBox) previous).setContentPaddingBottom(0);
            }
            avoided = -1;
        }
        if (scroll == null || hidden) return;
        int[] at = new int[2];
        scroll.getLocationOnScreen(at);
        int covered = Math.max(0, at[1] + scroll.getHeight() - screenTop);
        scroll.setContentPaddingBottom(covered);
        avoided = scroll.id;
        host.post(this::revealFocused);
    }

    private void revealFocused() {
        if (focused == null) return;
        int margin = px(12);
        ScrollBox scroll = scrollAround(focused);
        if (scroll != null) {
            // With the keyboard: along its curve, from when it started.
            ValueAnimator a = ValueAnimator.ofFloat(0, 1);
            a.setDuration(keyboardDuration);
            a.setInterpolator(keyboardInterpolator);
            if (scroll.reveal(focused, margin, a)) {
                a.start();
                keyboardAligned(a);
            }
        } else {
            Rect r = new Rect(0, -margin, focused.getWidth(), focused.getHeight() + margin);
            focused.requestRectangleOnScreen(r, false);
        }
    }

    private ScrollBox scrollAround(View v) {
        ViewParent p = v.getParent();
        while (p != null) {
            if (p instanceof ScrollBox) return (ScrollBox) p;
            p = p.getParent();
        }
        return null;
    }

    // --- Events --------------------------------------------------------------

    boolean wants(int id, int kind) {
        if (kind >= 64) return (eventsHigh.get(id) & (1L << (kind - 64))) != 0;
        return (events.get(id) & (1L << kind)) != 0;
    }

    /** Press callbacks claim a touch; visual feedback alone only observes it. */
    boolean handlesPress(int id) {
        return wants(id, Native.PRESS) || wants(id, Native.LONG_PRESS)
                || wants(id, Native.PRESS_IN) || wants(id, Native.PRESS_OUT);
    }

    boolean hasPan(int id) {
        return Native.hasPan(handle(), id);
    }

    /** `panActivation`s, by view. */
    private final android.util.SparseArray<float[]> panActivations = new android.util.SparseArray<>();
    /** Scroll views an activated pan gate blocks. */
    private final java.util.ArrayList<ScrollBox> gatedScrolls = new java.util.ArrayList<>();

    private void clearJsResponder() {
        for (ScrollBox s : blockedScrolls) s.jsBlocked = false;
        blockedScrolls.clear();
    }

    /** A native scroll view took the touches over. */
    void cancelTouches() {
        for (TouchTracker t : touchTrackers) t.cancelAll();
    }

    /** See {@link Native#touch}. */
    void touches(int phase, int[] ids, int[] targets, int[] pathLengths, int[] paths, float[] coords, boolean[] changed, long time, int activated) {
        Native.touch(handle(), phase, ids, targets, pathLengths, paths, coords, changed, time, activated);
    }

    /** `panActivation` of view {@code id} (points: active x, y, fail x, y; NaN: none), or null. */
    float[] panActivation(int id) {
        return panActivations.get(id);
    }

    /** The pan gate of {@code v} activated: the scroll views around it stop taking the touches. */
    void gateBlock(View v) {
        gateRelease();
        for (ViewParent p = v.getParent(); p != null; p = p.getParent()) {
            if (p instanceof ScrollBox) {
                ((ScrollBox) p).gateBlocked = true;
                gatedScrolls.add((ScrollBox) p);
            }
        }
        if (v.getParent() != null) v.getParent().requestDisallowInterceptTouchEvent(true);
    }

    /** The touches of an activated pan gate ended. */
    void gateRelease() {
        for (ScrollBox s : gatedScrolls) s.gateBlocked = false;
        gatedScrolls.clear();
    }

    void event(int id, int kind) {
        Native.event(handle(), id, kind, null, 0, 0, 0);
    }

    /** A press's touch: where it is now and the modifier keys it began with. */
    static final class PressAt {
        float x, y, rawX, rawY;
        int meta;

        /** Follows the touch's events (the pressed view's own). */
        void track(android.view.MotionEvent e) {
            if (e.getActionMasked() == android.view.MotionEvent.ACTION_DOWN) meta = e.getMetaState();
            x = e.getX();
            y = e.getY();
            rawX = e.getRawX();
            rawY = e.getRawY();
        }
    }

    /**
     * Press event {@code kind} of node {@code id} (view {@code v}, or a text span of it), with
     * where the touch is in {@code v} and in its root view.
     */
    void press(int id, int kind, View v, PressAt at) {
        // The surface, or the window of the modal the view is in.
        View root = v.getRootView() == host.getRootView() ? host : v.getRootView();
        int[] rootAt = new int[2];
        root.getLocationOnScreen(rootAt);
        float d = density;
        Native.press(handle(), id, kind, at.x / d, at.y / d,
                (at.rawX - rootAt[0]) / d, (at.rawY - rootAt[1]) / d, modifiers(at.meta), 1);
    }

    /** Modifier keys of a meta state: 1 Ctrl, 2 Alt, 4 Shift, 8 Meta. */
    private static int modifiers(int meta) {
        int modifiers = 0;
        if ((meta & android.view.KeyEvent.META_CTRL_ON) != 0) modifiers |= 1;
        if ((meta & android.view.KeyEvent.META_ALT_ON) != 0) modifiers |= 2;
        if ((meta & android.view.KeyEvent.META_SHIFT_ON) != 0) modifiers |= 4;
        if ((meta & android.view.KeyEvent.META_META_ON) != 0) modifiers |= 8;
        return modifiers;
    }

    /** `RequestClose` with what the user did (`cancel`, `swipe`). */
    void requestClose(int id, String reason) {
        eventMap(id, Native.REQUEST_CLOSE, new String[] {"reason"}, new Object[] {reason});
    }

    /** An event with an object payload. */
    void paste(int id, String text, byte[][] images, String[] uris) {
        Native.paste(handle(), id, text, images, uris);
    }

    void eventMap(int id, int kind, String[] keys, Object[] values) {
        Native.eventMap(handle(), id, kind, keys, values);
    }

    void event(int id, int kind, String text, int count, float x, float y) {
        Native.event(handle(), id, kind, text, count, x, y);
    }

    void zoom(int id, float scale) {
        Native.zoom(handle(), id, scale);
    }

    void scroll(int id, float x, float y, int applied) {
        outputs(Native.scroll(handle(), id, x, y, applied));
    }

    void inputScroll(int id, float y, float contentWidth, float contentHeight, float width, float height) {
        Native.inputScroll(handle(), id, y, contentWidth, contentHeight, width, height);
    }

    void pull(int id, float distance) {
        outputs(Native.pull(handle(), id, distance));
    }

    /** Scroll view {@code id} came to rest: snapping animated values settle. */
    void scrollEnded(int id) {
        outputs(Native.scrollEnded(handle(), id));
    }

    void pan(int id, int state, float tx, float ty, float vx, float vy) {
        if (state == 0) for (TouchTracker t : touchTrackers) t.cancelFeedback();
        outputs(Native.pan(handle(), id, state, tx, ty, vx, vy));
    }

    void transformGesture(int id, boolean rotation, int state, float amount, float velocity) {
        if (state == 0) for (TouchTracker t : touchTrackers) t.cancelFeedback();
        outputs(Native.transformGesture(handle(), id, rotation, state, amount, velocity));
    }
}
