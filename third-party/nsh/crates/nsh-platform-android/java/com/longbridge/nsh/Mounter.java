package com.longbridge.nsh;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.TimeInterpolator;
import android.animation.ValueAnimator;
import android.content.Context;
import android.content.pm.ActivityInfo;
import android.graphics.Rect;
import android.text.Layout;
import android.util.SparseArray;
import android.util.SparseLongArray;
import android.os.Build;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.AccelerateInterpolator;
import android.view.animation.AnimationUtils;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.LinearInterpolator;
import android.view.animation.PathInterpolator;
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
    private static final int COMPONENT_PROP_SLOTS = 34;
    private static final int SHADER = 35;
    private static final int SHADER_TRANSITION = 36;
    private static final int SHADER_INPUT = 37;
    private static final int NAV_SHADER = 38;
    /** The surface lays out right to left: native widgets mirror. */
    boolean rtl;
    /** The app's appearance (`nsh_core::platform::Appearance`): 0 the system's, 1 light, 2 dark. */
    int appearance;
    /**
     * The app's colors for alerts and action sheets ({@code encode.rs} {@code DIALOG_TOKENS}): the dialog, its title,
     * its message, its buttons and a destructive action, each light then dark ARGB (0: the system's).
     */
    final int[] dialogColors = new int[10];
    /**
     * The language the app's text shows in ({@code encode.rs} {@code Command::TextLocale}), which
     * the state words services read ({@link A11y}) follow; null until the core names one (English
     * state words).
     */
    java.util.Locale textLocale;
    /** The alerts shown and not answered yet, by dialog id: what {@link SystemUi#closeDialog} takes back. */
    final SparseArray<android.app.AlertDialog> dialogs = new SparseArray<>();
    /**
     * By dialog id, what takes each of {@link #dialogs} off the activity going for a configuration change, unanswered,
     * and gives what shows it again in the next one ({@link #leaveWindows}).
     */
    final SparseArray<java.util.function.Supplier<Runnable>> dialogMoves = new SparseArray<>();
    /**
     * The status bar the app asked for last (style, hidden; -1: never), applied again when the app's or the system's
     * appearance changes.
     */
    private int barStyle = -1;
    private boolean barHidden;
    /**
     * The activity's system bars are the app's (an app on its own, {@link NshView#ownSystemBars}): their default
     * follows the app's appearance. Embedded in another app's activity, its bars stay the host's until the app asks.
     */
    boolean ownsSystemBars;

    /**
     * Sets the system bars the app has: the status bar it asked for last, else, where it owns the bars, the default,
     * whose icons contrast with the appearance shown, as the navigation bar's. Run again when the app's or the
     * system's appearance changes: the default depends on both, and the activity's own bar setup reads only the
     * system's.
     */
    void applySystemBars() {
        int style = Math.max(barStyle, 0);
        boolean night = night();
        if (ownsSystemBars) DevActivity.systemBars(SystemUi.activity(context), night);
        if (barStyle >= 0 || ownsSystemBars) SystemUi.statusBar(context, style, barHidden, night);
        for (ModalHost m : shownModals) m.systemBars(style, barHidden, night);
    }

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
        /** `headerTitleAlign` "center". */
        boolean centerTitle;
        boolean hidesBottomBar;
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
        int curve; // 0 linear, 1 ease in, 2 ease out, 3 ease in-out, 4 fitted spring, 5 the keyboard's, 6 spring, 7 cubic Bézier
        float damping;
        /** A spring's progress (6), sampled evenly over the time it settles in (the duration), ending at 1. */
        float[] samples;
        /** A cubic Bézier's control points (7): x1, y1, x2, y2. */
        float[] bezier;
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
                case 6: {
                    float[] p = samples;
                    int last = p.length - 1;
                    return t -> {
                        if (t >= 1) return 1;
                        float x = Math.max(t, 0) * last;
                        int i = (int) x;
                        return p[i] + (p[i + 1] - p[i]) * (x - i);
                    };
                }
                case 7: return new PathInterpolator(bezier[0], bezier[1], bezier[2], bezier[3]);
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
    /** The `captureKeys` policy of each view, as `KeyCaptures.java` reads it (`encode.rs` `key_capture`). */
    private final SparseArray<int[]> keyCaptures = new SparseArray<>();
    /** `focusable`: -1 unset, 0 false, 1 true (`encode.rs` `view_props`). */
    private final android.util.SparseIntArray focusProps = new android.util.SparseIntArray();
    /** A portaled view's logical keyboard parent (`ViewProps::key_parent`); absent: ordinary. */
    private final android.util.SparseIntArray keyParents = new android.util.SparseIntArray();
    /**
     * While the views move to the activity made again ({@link NshView#leaveActivity}): the focus they lose and take
     * back on the way is no change for the app, and its listeners do not hear it.
     */
    boolean moving;
    /**
     * A managed view took or lost the focus: the core styles it (`FOCUSED`),
     * and its `onFocus` / `onBlur` listeners hear it as an input's do.
     */
    private final View.OnFocusChangeListener focusChange = (view, focused) -> {
        if (!(view instanceof Node) || moving) return;
        int id = ((Node) view).nodeId();
        // The focus went somewhere (the user's Tab or tap, or the view a
        // pending `focus()` waits for): that request is over.
        if (focused) dropPendingFocus();
        // A programmatic focus only opts this focus session into touch
        // mode. Once it ends, default buttons must remain touch-neutral.
        if (!focused && !Focusable.touch(focusProps.get(id, -1))) {
            view.setFocusableInTouchMode(false);
        }
        if (handle() == 0) return;
        reportState(id, STATE_FOCUSED, focused);
        if (wants(id, focused ? Native.FOCUS : Native.BLUR)) {
            event(id, focused ? Native.FOCUS : Native.BLUR);
        }
    };
    /**
     * A press on a managed stop focuses it before its press handlers run
     * (the focus-a-visible-control behavior the contract asks for), where
     * the focus can go: an explicit `focusable` takes it anywhere,
     * including touch mode; a default pressable only outside touch mode,
     * and never from a text input or hosted native view (only an explicit
     * `focusable` does). A touch-mode tap therefore leaves an input
     * editing and its keyboard up.
     */
    private final View.OnTouchListener pointerFocus = (view, e) -> {
        if (e.getActionMasked() == android.view.MotionEvent.ACTION_DOWN && view instanceof Node) {
            int id = ((Node) view).nodeId();
            int prop = focusProps.get(id, -1);
            boolean nativeFocused = keyNode(view.getRootView().findFocus(), 1) == 0;
            boolean touchMode = view.getRootView().isInTouchMode();
            if (Focusable.pointer(prop, nativeFocused, touchMode) && focusStop(id) && !view.isFocused()) {
                // requestFocus invokes focusChange synchronously. Mark the
                // pointer modality first so focus-visible is not keyboard's.
                if (handle() != 0) Native.pointerInput(handle());
                view.requestFocus();
            }
        }
        return false;
    };
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

    /** Whether a text or a selectable view holds a selection (back ends it first). */
    boolean hasSelection() {
        return selectedText != null || selectedArea != null;
    }

    /** Ends the selection there is; false when there is none. */
    private boolean endSelection() {
        if (selectedArea != null) {
            selectedArea.clear();
            return true;
        }
        if (selectedText != null) {
            selectedText.clearSelection();
            return true;
        }
        return false;
    }
    /** Selectable views (`ViewProps.selectable_view`), by view. */
    private final SparseArray<SelectableView> selectableViews = new SparseArray<>();

    /**
     * A finger went down off the selection's handles while something is selected: if it lifts without
     * moving past the touch slop (a tap), the selection ends; a drag (a scroll) keeps it, as TextView's.
     */
    private boolean tapEndsSelection;
    private float tapX, tapY;

    /** A finger went down at the screen point: a tap away from the selection will end it ({@link #touchUp}). */
    void touchDown(float rawX, float rawY) {
        tapEndsSelection = (selectedText != null && !selectedText.selectionContains(rawX, rawY))
                || (selectedArea != null && !selectedArea.selectionContains(rawX, rawY));
        tapX = rawX;
        tapY = rawY;
    }

    /** The finger moved: past the slop it is no tap, and the selection stays. */
    void touchMoved(float rawX, float rawY, float slop) {
        if (tapEndsSelection && Math.hypot(rawX - tapX, rawY - tapY) > slop) tapEndsSelection = false;
    }

    /** The gesture ended ({@code tap}: lifted, not cancelled): a tap ends the selection. */
    void touchUp(boolean tap) {
        if (!tapEndsSelection) return;
        tapEndsSelection = false;
        if (!tap) return;
        if (selectedText != null) selectedText.clearSelection();
        if (selectedArea != null) selectedArea.clear();
    }

    /** A long press made a new selection: the gesture that made it does not end it. */
    void keepSelection() {
        tapEndsSelection = false;
    }

    /** The outermost selectable view {@code text} is or is in (an area inside another is part of it), or null. */
    SelectableView selectableViewOf(View text) {
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
    /**
     * The view whose node an accessibility service last clicked through its delegate
     * (TalkBack's double tap), and when (uptime ms): a checked or selected state it changes in a
     * later batch is told as that click's (`A11y.changed`).
     */
    View accessibilityClicked;
    long accessibilityClickedAt;
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
    /** The pages and dialogs that come and go through a shader (`transitionShader`; libnsh has it). */
    final android.util.SparseBooleanArray navShaders = new android.util.SparseBooleanArray();
    /** Parents of screens, header items and modals (not their superviews). */
    private final android.util.SparseIntArray hosts = new android.util.SparseIntArray();
    private final java.util.LinkedHashSet<Integer> dirtyStacks = new java.util.LinkedHashSet<>();
    private final java.util.LinkedHashSet<Integer> dirtyScreens = new java.util.LinkedHashSet<>();
    private final java.util.LinkedHashSet<Integer> dirtyModals = new java.util.LinkedHashSet<>();
    /** Stacks and shown modals, oldest first (the back button tries the newest). */
    private final java.util.ArrayList<StackBox> stacks = new java.util.ArrayList<>();
    private final java.util.ArrayList<ModalHost> shownModals = new java.util.ArrayList<>();

    /** Re-syncs the tab bars when stacks, screens, or their visibility changed in a batch. */
    private boolean bottomBarDirty;

    /** The surface root (node 1). */
    final Box root;

    Mounter(NshView host, Images images) {
        this.host = host;
        this.context = host.getContext();
        this.density = host.getResources().getDisplayMetrics().density;
        this.images = images;
        components.put(TabBarComponent.NAME, c -> new TabBarComponent(context, c, this::night));
        components.put(MenuButtonComponent.NAME, c -> new MenuButtonComponent(context, c, this::night));
        components.put(ContextMenuComponent.NAME, c -> new ContextMenuComponent(context, c, this::night));
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
            public byte[] complete(String url, int status, String[] headers, byte[] body, String[] redirects) {
                long handle = handle();
                return handle == 0 ? null : Native.imageCacheComplete(handle, url, status, headers, body, redirects);
            }
        };
        root = new Box(context, this, 1);
        views.put(1, root);
    }

    /**
     * Whether a web view whose {@code allowOrigin} is {@code origin} (null:
     * none) may navigate to {@code url} (the app's capabilities). The origin
     * is compared in Rust.
     */
    boolean allowsWebview(String url, String origin, String hosts) {
        return Native.allowsWebview(handle(), url, origin, hosts);
    }

    /** Whether the running app's web pages may capture {@code kind} (its {@code webview.media}). */
    boolean allowsWebMedia(String kind) {
        return Native.allowsWebMedia(handle(), kind);
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
                case REMOVE: {
                    int id = b.getInt();
                    noteKeyboardLeaving(views.get(id));
                    if (!removeHosted(id)) remove(id);
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
                    // What attachments copy as: offset, string object.
                    int copies = b.getInt();
                    int[] copyAt = copies == 0 ? TextLayouts.NO_COPIES : new int[copies];
                    String[] copyTexts = copies == 0 ? TextLayouts.NO_COPY_TEXTS : new String[copies];
                    for (int i = 0; i < copies; i++) {
                        copyAt[i] = b.getInt();
                        copyTexts[i] = (String) objects[b.getInt()];
                    }
                    if (v instanceof TextBox) {
                        TextBox t = (TextBox) v;
                        t.setCopyTexts(copyAt, copyTexts);
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
                    if (v instanceof InputBox && presses && ((InputBox) v).press == null) {
                        ((InputBox) v).press = new Pressable(v, this, id, false, true);
                    }
                    if (v instanceof TextBox || v instanceof ImageBox) {
                        v.setClickable(presses || (v instanceof TextBox && ((TextBox) v).hasLinks()));
                    }
                    updateFocusable(id, v);
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
                        if (v instanceof StackBox.ScreenBox) ((StackBox.ScreenBox) v).appearanceChanged();
                    }
                    applySystemBars();
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
                    float barTop = b.getFloat(), barRight = b.getFloat(), barBottom = b.getFloat(), barLeft = b.getFloat();
                    if (v instanceof ScrollBox) {
                        ((ScrollBox) v).setBehavior(paging, interval, offsets, alignment, deceleration, enabled, bounces,
                                top, right, bottom, left, taps, oneStep);
                        ((ScrollBox) v).setZoom(zooms, minZoom, maxZoom, bouncesZoom, pinch, center);
                        ((ScrollBox) v).setRefresh(ownIndicator, indicatorHeight);
                        ((ScrollBox) v).setBarInset(barTop, barRight, barBottom, barLeft);
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
                    if (v instanceof ComponentBox) {
                        NshComponent c = ((ComponentBox) v).component;
                        if (c instanceof RustComponent) ((RustComponent) c).step(seq);
                        else ((ComponentBox) v).forgetAnimated();
                    }
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
                    if (v instanceof InputBox) ((InputBox) v).setContent(px(x), px(y), px(x + w) - px(x), px(y + h) - px(y));
                    break;
                }
                case COMMAND: command(b, objects, seq); break;
                case COMPONENT: {
                    int id = b.getInt();
                    component(id, string(objects, b.getInt()));
                    break;
                }
                case SHADER: {
                    // The layer stays in libnsh, which renders it (`shader.rs`).
                    View v = views.get(b.getInt());
                    boolean on = b.getInt() != 0;
                    int role = b.getInt();
                    float overflow = b.getFloat();
                    int inputs = b.getInt();
                    if (v instanceof Box) ((Box) v).setShader(on, role, overflow, inputs);
                    break;
                }
                case SHADER_TRANSITION: {
                    View v = views.get(b.getInt());
                    float ms = b.getFloat();
                    if (v instanceof Box) ((Box) v).startTransition(ms);
                    break;
                }
                case SHADER_INPUT: {
                    View v = views.get(b.getInt());
                    if (v instanceof Box) ((Box) v).picturesChanged();
                    break;
                }
                case NAV_SHADER: {
                    int id = b.getInt();
                    if (b.getInt() != 0) navShaders.put(id, true);
                    else navShaders.delete(id);
                    break;
                }
                case COMPONENT_PROP_SLOTS: {
                    View v = views.get(b.getInt());
                    String[] names = new String[b.getInt()];
                    for (int i = 0; i < names.length; i++) names[i] = string(objects, b.getInt());
                    if (v instanceof ComponentBox) {
                        NshComponent c = ((ComponentBox) v).component;
                        if (c instanceof RustComponent) ((RustComponent) c).step(seq);
                        else ((ComponentBox) v).slots = names;
                    }
                    break;
                }
                case COMPONENT_PROPS: {
                    View v = views.get(b.getInt());
                    int count = b.getInt();
                    NshComponent c = v instanceof ComponentBox ? ((ComponentBox) v).component : null;
                    if (c instanceof RustComponent) {
                        for (int i = 0; i < count; i++) {
                            b.getInt();
                            b.getInt();
                        }
                        ((RustComponent) c).step(seq);
                    } else {
                        for (int i = 0; i < count; i++) {
                            String name = string(objects, b.getInt());
                            String json = string(objects, b.getInt());
                            if (c != null) c.setProp(name, Json.parse(json));
                        }
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
        // Commands run before the navigation: a page's `focus()` in the
        // batch that pushes it finds the page placed only now, so it is
        // focused before the frame draws.
        if (pendingFocus.id() != 0) retryFocus();
        settleKeyboardLeaving();
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
        if (t.curve == 6) {
            t.samples = new float[b.getInt()];
            for (int i = 0; i < t.samples.length; i++) t.samples[i] = b.getFloat();
        }
        if (t.curve == 7) {
            t.bezier = new float[4];
            for (int i = 0; i < 4; i++) t.bezier[i] = b.getFloat();
        }
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
            case 12: v = WebBox.make(context, this, id); break;
            case 13: v = new VideoBox(context, this, host, id); break;
            case 14: v = new CanvasBox(context, this, id); break;
            case 15: v = new ComponentBox(context, this, id); break;
            default: v = new Box(context, this, id);
        }
        views.put(id, v);
        updateFocusable(id, v);
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
        Notifications.forget(this);
        // A page's orientations go with the app, and so does a focus
        // request still waiting (no `DELETE` ends it).
        orientations(0);
        dropPendingFocus();
        if (audio != null) {
            audio.release();
            audio = null;
        }
        for (int i = 0; i < views.size(); i++) {
            View v = views.valueAt(i);
            if (v instanceof ComponentBox) ((ComponentBox) v).destroy();
            if (v instanceof WebBox) ((WebBox) v).destroy();
            if (v instanceof ScrollBox) {
                ((ScrollBox) v).unmounted = true;
                unkeyScroll((ScrollBox) v);
            }
        }
    }

    // Scroll views the host watches (`NshView.watchScroll`), by `nativeID`.
    private final java.util.Map<String, NshView.ScrollWatcher> scrollWatchers = new java.util.HashMap<>();
    private final java.util.Map<String, ScrollBox> keyedScrolls = new java.util.HashMap<>();

    void watchScroll(String key, NshView.ScrollWatcher watcher) {
        if (watcher == null) {
            scrollWatchers.remove(key);
            return;
        }
        scrollWatchers.put(key, watcher);
        ScrollBox box = keyedScrolls.get(key);
        if (box != null) watcher.onAttached(new NshScrollHandle(box, key));
    }

    /** A scroll view's props were applied, with {@code key} its {@code nativeID} (null: none). */
    private void keyScroll(ScrollBox box, String key) {
        if (java.util.Objects.equals(box.hostKey, key)) return;
        unkeyScroll(box);
        if (key == null) return;
        // Another scroll view of the same id makes way: the newest is watched.
        ScrollBox previous = keyedScrolls.get(key);
        if (previous != null) unkeyScroll(previous);
        box.hostKey = key;
        keyedScrolls.put(key, box);
        NshView.ScrollWatcher watcher = scrollWatchers.get(key);
        if (watcher != null) watcher.onAttached(new NshScrollHandle(box, key));
    }

    /** The scroll view is gone or lost its key: its handle goes dead and its watcher hears it. */
    private void unkeyScroll(ScrollBox box) {
        String key = box.hostKey;
        if (key == null) return;
        box.hostKey = null;
        box.hostListeners.clear();
        if (keyedScrolls.get(key) != box) return;
        keyedScrolls.remove(key);
        NshView.ScrollWatcher watcher = scrollWatchers.get(key);
        if (watcher != null) watcher.onDetached();
    }

    /** The app's sounds and players (one per engine), made at its first audio command. UI thread. */
    private Audio audio;

    private Audio audio() {
        if (audio == null) audio = new Audio(this);
        return audio;
    }

    /**
     * The app stopped: its shader views stop picturing and drawing frames
     * libnsh no longer renders (a screen shader gives the surface back), and
     * its pages and dialogs no longer go through a shader. No {@code DELETE}
     * follows for them.
     */
    void dropShaders() {
        for (int i = 0; i < views.size(); i++) {
            View v = views.valueAt(i);
            if (v instanceof Box) ((Box) v).dropShader();
        }
        navShaders.clear();
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
        if (((ComponentBox) v).component instanceof TabBarComponent) bottomBarDirty = true;
    }

    private static ViewGroup container(View parent) {
        if (parent instanceof StackBox.ScreenBox) return ((StackBox.ScreenBox) parent).root;
        if (parent instanceof ScrollBox) return ((ScrollBox) parent).content;
        if (parent instanceof Box) return ((Box) parent).container();
        if (parent instanceof TextBox) return (TextBox) parent;
        return null;
    }

    private void insert(int parentId, int childId, int beforeId) {
        // Moved, not removed: the keyboard is not its to hide.
        if (keyboardLeaving != null && views.get(childId) == keyboardLeaving) forgetKeyboardLeaving();
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

    private static void detach(View v) {
        if (v == null) return;
        ViewParent p = v.getParent();
        if (p instanceof ViewGroup) ((ViewGroup) p).removeView(v);
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
        View v = views.get(id);
        // Still in the tree: a subtree released at once comes as deletes
        // without a remove, and each detaches its view here.
        if (v != null && v.getParent() != null) noteKeyboardLeaving(v);
        if (id == pendingFocus.id()) {
            dropPendingFocus();
            android.util.Log.w("nsh", "focus(): view " + id + " was removed before it was shown; the request is dropped");
        }
        if (v != null && managed(v) && v.isFocused()) {
            // The view goes away: report its blur before it leaves the tree.
            v.setOnFocusChangeListener(focusChange);
            releaseFocus(v);
        }
        removeHosted(id);
        ModalHost modal = modals.get(id);
        if (modal != null) {
            modal.dismiss();
            // The batch's end updates the back button without it.
            shownModals.remove(modal);
            modals.remove(id);
            touchTrackers.remove(modal.touches());
        }
        if (v instanceof StackBox) stacks.remove(v);
        SelectableView area = selectableViews.get(id);
        if (area != null) {
            area.remove();
            selectableViews.remove(id);
        }
        screenOptions.remove(id);
        navShaders.delete(id);
        if (v instanceof Box) ((Box) v).dropShader();
        Animator running = layoutAnimators.get(id);
        if (running != null) running.cancel();
        stopEffects(id);
        detach(v);
        if (v instanceof ImageBox) cancelImage((ImageBox) v);
        if (v instanceof WebBox) ((WebBox) v).destroy();
        if (v instanceof VideoBox) ((VideoBox) v).destroy();
        if (v instanceof ComponentBox) ((ComponentBox) v).destroy();
        if (v instanceof ScrollBox) {
            ((ScrollBox) v).unmounted = true;
            unkeyScroll((ScrollBox) v);
        }
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
        keyCaptures.remove(id);
        focusProps.delete(id);
        keyParents.delete(id);
        slops.remove(id);
        a11y.remove(id);
        held.remove(id);
        if (accessibilityClicked == v) accessibilityClicked = null;
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
            // A header item: the toolbar (or the row of a leading item and its title) places it at its size.
            headerSizes.put(id, new int[] {px(w), px(h)});
            if (v.getParent() instanceof android.widget.Toolbar || v.getParent() instanceof StackBox.ScreenBox.HeaderRow) {
                ViewGroup.LayoutParams p = v.getLayoutParams();
                p.width = Math.max(1, px(w));
                p.height = Math.max(1, px(h));
                v.setLayoutParams(p);
            }
            return;
        }
        Box.Frame f = Box.frame(v);
        boolean wasEmpty = f.right <= f.left || f.bottom <= f.top;
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
        if (!stacks.isEmpty() && wasEmpty != (to[2] <= to[0] || to[3] <= to[1])) bottomBarDirty = true;
        if (v instanceof ImageBox) loadImage((ImageBox) v);
    }

    private Decor decor(View v) {
        return Decor.of(v);
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
        // `clipPath`: whether there is one, then its offsets, fractions and
        // radii (`encode.rs` `view_style`).
        boolean hasClip = b.getInt() != 0;
        float[] clip = new float[12];
        for (int i = 0; i < 12; i++) clip[i] = b.getFloat();
        for (int i = 0; i < 4; i++) {
            clip[i] *= density;
            clip[8 + i] *= density;
        }
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
            // A RippleDrawable rasterizes its mask once; a shape change here
            // would leave the ripple clipped to the stale (pre-change) shape.
            rippleMaskDirty(id);
            decor.borderStyle = borderStyle;
            decor.continuous = continuous;
            decor.originX = originXFraction ? originX : originX * density;
            decor.originXFraction = originXFraction;
            decor.originY = originYFraction ? originY : originY * density;
            decor.originYFraction = originYFraction;
            decor.backfaceHidden = backfaceHidden;
            decor.clipPath = hasClip ? clip : null;
            if (!stacks.isEmpty() && decor.hidden != fx.hidden) bottomBarDirty = true;
            decor.hidden = fx.hidden;
            decor.boxShadows = fx.shadows;
            decor.boxShadowColors = fx.shadowColors;
            decor.gradients = fx.gradients;
            decor.masks = fx.masks;
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
        /** The clip path on screen (mid-transition included), or null. */
        final float[] clipPath;
        final float opacity, tx, ty, sx, sy, rotate;

        Snapshot(View v, Decor decor, Dynamic d) {
            fill = decor != null ? decor.fill : 0;
            clipPath = decor != null && decor.clipPath != null ? decor.clipPath.clone() : null;
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

    /**
     * Interpolates two colors in premultiplied ARGB, as CSS and the core's
     * `lerp_color` (`transition.rs`) do, so that transparent ends do not pass
     * through black. The progress is clamped: an overshooting easing (a bouncy
     * spring's projection) must not carry a channel past its ends, where the
     * packed byte would wrap into a garbage color for a frame.
     */
    static int lerpColor(int a, int b, float t) {
        if (a == b) return a;
        t = Math.max(0f, Math.min(1f, t));
        float alphaA = (a >>> 24) & 0xff, alphaB = (b >>> 24) & 0xff;
        float alpha = alphaA + (alphaB - alphaA) * t;
        int out = Math.round(Math.max(0, Math.min(255, alpha))) << 24;
        if (alpha <= 0) return out;
        for (int shift = 0; shift <= 16; shift += 8) {
            float x = ((a >>> shift) & 0xff) * alphaA, y = ((b >>> shift) & 0xff) * alphaB;
            out |= Math.round(Math.max(0, Math.min(255, (x + (y - x) * t) / alpha))) << shift;
        }
        return out;
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
        // The clip path moves edge by edge (`TransitionProps::CLIP_PATH`);
        // to or from none it changes at once, as in CSS.
        final float[] clipTo = decor != null ? decor.clipPath : null;
        final boolean clip = (props & 32) != 0 && clipTo != null && from.clipPath != null
                && !java.util.Arrays.equals(clipTo, from.clipPath);
        final float[] clipNow = clip ? from.clipPath.clone() : null;
        ValueAnimator a = ValueAnimator.ofFloat(0, 1);
        a.setDuration((long) fx.transitionDuration);
        a.setStartDelay((long) fx.transitionDelay);
        a.setInterpolator(fx.transitionInterpolator());
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
                    // Same as above: the ripple's cached mask must follow the
                    // animated shape (e.g. the press corner morph).
                    rippleMaskDirty(id);
                }
                if (clip) {
                    for (int i = 0; i < 12; i++) clipNow[i] = from.clipPath[i] + (clipTo[i] - from.clipPath[i]) * t;
                    for (int i = 8; i < 12; i++) clipNow[i] = Math.max(0, clipNow[i]);
                    decor.clipPath = clipNow;
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
            // The frame's border colors are what the decor now carries; a
            // fresh Dynamic's all-transparent array would have applyDynamic
            // "restore" them to transparent every frame (an outlined view's
            // border vanished after its first transition and never came
            // back).
            if (decor != null) System.arraycopy(decor.borderColors, 0, now.borderColors, 0, 4);
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
        if (clip) decor.clipPath = clipNow;
        a.start();
    }

    /**
     * Stops the transition and keyframe animation of `id`, which is gone: an
     * endless keyframe animation (a pulsing placeholder) would otherwise run
     * on unseen, and the animation handler keep its view and this mounter.
     */
    private void stopEffects(int id) {
        ValueAnimator transition = transitions.get(id);
        transitions.remove(id);
        if (transition != null) transition.cancel();
        ValueAnimator keyframes = keyframeAnimators.get(id);
        keyframeAnimators.remove(id);
        motions.remove(id);
        if (keyframes != null) keyframes.cancel();
    }

    /**
     * The app stopped: its running animations stop too, since no
     * {@code DELETE} follows for their views. The animation handler is the
     * UI thread's and holds an animation until it ends, so an endless one
     * would keep this mounter, its views and their activity forever.
     */
    void cancelAnimations() {
        java.util.ArrayList<Animator> running = new java.util.ArrayList<>();
        for (int i = 0; i < layoutAnimators.size(); i++) running.add(layoutAnimators.valueAt(i));
        for (int i = 0; i < transitions.size(); i++) running.add(transitions.valueAt(i));
        for (int i = 0; i < keyframeAnimators.size(); i++) running.add(keyframeAnimators.valueAt(i));
        // Their end listeners remove them from these maps: clear first.
        layoutAnimators.clear();
        transitions.clear();
        keyframeAnimators.clear();
        motions.clear();
        for (Animator a : running) a.cancel();
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

    /**
     * An interaction state of `id` changed: tells the core if it reads it.
     * The focus it always hears (`nsh_core::input::reported_states`): it
     * works out `focus-within` from it.
     */
    void reportState(int id, int bit, boolean on) {
        int states = currentStates.get(id);
        int next = on ? states | bit : states & ~bit;
        if (next == states) return;
        currentStates.put(id, next);
        int reported = trackedStates.get(id) | STATE_FOCUSED;
        if ((reported & bit) != 0) Native.states(handle(), id, next & reported);
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
     * Drops the cached mask of the ripple of view {@code id}: a
     * RippleDrawable rasterizes its mask once and reuses it until told
     * otherwise, so any corner-radius change under an active (or later)
     * ripple must invalidate it for the mask to follow the new shape.
     */
    private void rippleMaskDirty(int id) {
        Feedback f = feedback.get(id);
        if (f != null && f.ripple != null) f.ripple.invalidateSelf();
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
        String nativeId = string(objects, b.getInt());
        float longPressDelay = b.getFloat();
        int ripple = b.getInt();
        Integer rippleColor = null;
        float rippleRadius = -1;
        if ((ripple & 1) != 0) {
            rippleColor = optColor(b);
            rippleRadius = b.getFloat();
        }
        if (b.getInt() != 0) {
            // The offsets, then the way it activates in and its edge (`encode.rs`).
            panActivations.put(id, new float[] {
                b.getFloat(), b.getFloat(), b.getFloat(), b.getFloat(), b.getInt(), b.getInt()});
        } else {
            panActivations.remove(id);
        }
        boolean selectableView = b.getInt() != 0;
        boolean continuesText = b.getInt() != 0;
        // `selectionMenu` (`encode.rs` `selection_menu`): the count, then per
        // item its id (-1 a separator), whether it is enabled and its label.
        int menuCount = b.getInt();
        SelectableView.MenuEntry[] selectionMenu = new SelectableView.MenuEntry[menuCount];
        for (int i = 0; i < menuCount; i++) {
            int itemId = b.getInt();
            boolean enabled = b.getInt() != 0;
            String label = string(objects, b.getInt());
            selectionMenu[i] = new SelectableView.MenuEntry(itemId, enabled, label);
        }
        // `captureKeys` (`encode.rs` `key_capture`): mode, then for keys
        // the count and each canonical key id and modifiers.
        int captureMode = b.getInt();
        if (captureMode == KeyCaptures.KEYS) {
            int count = b.getInt();
            int[] policy = new int[2 + count * 2];
            policy[0] = KeyCaptures.KEYS;
            policy[1] = count;
            for (int i = 0; i < count; i++) {
                policy[2 + i * 2] = b.getInt();
                policy[3 + i * 2] = b.getInt();
            }
            keyCaptures.put(id, policy);
        } else if (captureMode == KeyCaptures.ALL) {
            keyCaptures.put(id, new int[] {KeyCaptures.ALL});
        } else {
            keyCaptures.remove(id);
        }
        int focusable = b.getInt();
        focusProps.put(id, focusable);
        int keyParent = b.getInt();
        if (keyParent >= 0) keyParents.put(id, keyParent);
        else keyParents.delete(id);
        if (v == null) return;
        if (v instanceof TextBox) ((TextBox) v).continuesText = continuesText;
        SelectableView area = selectableViews.get(id);
        if (selectableView && (area == null || area.view != v)) {
            if (area != null) area.clear();
            selectableViews.put(id, new SelectableView(this, v, id));
        } else if (!selectableView && area != null) {
            area.clear();
            selectableViews.remove(id);
        }
        area = selectableViews.get(id);
        if (area != null) area.menu = selectionMenu;
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
        A11y before = a11y.get(id);
        a11y.put(id, a);
        a.apply(v);
        updateFocusable(id, v);
        // After the new delegate is in place: services answer by querying the node.
        a.changed(v, before);
        if (v instanceof ScrollBox) keyScroll((ScrollBox) v, nativeId);
    }

    private static String string(Object[] objects, int index) {
        return index >= 0 ? (String) objects[index] : null;
    }

    /** Applies `[animating, (view, prop, value)*]` from the animator. */
    /** A canvas's drawing; loads the images it draws (an SVG as its rasterized bitmap). */
    private void drawing(CanvasBox canvas, int[] code, Object[] objects) {
        for (String uri : canvas.setDrawing(code, objects)) {
            if (canvas.images.containsKey(uri)) continue;
            // At their natural size: the drawing may scale them anyway.
            Images.Image cached = images.request(uri, 0, 0, (image, error) -> {
                if (image != null) {
                    canvas.images.put(uri, image);
                    canvas.invalidate();
                } else {
                    android.util.Log.w("nsh", "canvas image failed: " + error);
                }
            });
            if (cached != null) canvas.images.put(uri, cached);
        }
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
            int id = Float.floatToRawIntBits(out[i]);
            View v = views.get(id);
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
            if (prop <= LAST_LOOK) {
                Held h = held.get(id);
                if (!inSight(v)) {
                    if (h == null) held.put(id, h = new Held());
                    h.put(prop, value);
                    listenForHeld();
                    continue;
                }
                if (h != null) h.mask &= ~(1 << prop);
            }
            animated(v, id, prop, value);
        }
        if (held.size() > 0) showHeld();
        if (out[0] != 0) host.requestFrames();
    }


    /** The last property code of a view's look (alpha through a text's color, `animation.rs`). */
    private static final int LAST_LOOK = 12;

    /** A view's latest animated look properties while out of sight. */
    private static final class Held {
        /** Which properties hold a value (bit per code). */
        int mask;
        final float[] values = new float[LAST_LOOK + 1];

        void put(int prop, float value) {
            // A uniform scale (3) sets both axes: drop the single axes held before it.
            if (prop == 3) mask &= ~((1 << 4) | (1 << 5));
            values[prop] = value;
            mask |= 1 << prop;
        }
    }

    /**
     * The latest animated look of the views out of sight, set once they come
     * into sight. A view's look changing out of sight (a loop on a card
     * scrolled away) would make the window draw a frame for nothing on every
     * tick: HWUI redraws the window for any view that changes, seen or not.
     */
    private final SparseArray<Held> held = new SparseArray<>();
    private final android.graphics.Rect sight = new android.graphics.Rect();
    /** Sets the held values of the views come into sight before a frame draws (a scroll, a pop). */
    private android.view.ViewTreeObserver.OnPreDrawListener heldListener;

    /**
     * Whether `v` may show: its parent is shown and partly on screen. The
     * parent, not the view: a view moved out by its own transform would
     * otherwise never move back in.
     */
    private boolean inSight(View v) {
        if (!(v.getParent() instanceof View)) return true;
        View parent = (View) v.getParent();
        return parent.isShown() && parent.getGlobalVisibleRect(sight);
    }

    private void listenForHeld() {
        if (heldListener != null) return;
        heldListener = () -> {
            showHeld();
            return true;
        };
        host.getViewTreeObserver().addOnPreDrawListener(heldListener);
    }

    /** Sets the held values of the views now in sight. */
    private void showHeld() {
        for (int i = held.size() - 1; i >= 0; i--) {
            Held h = held.valueAt(i);
            int id = held.keyAt(i);
            View v = views.get(id);
            if (h.mask != 0 && v != null && !inSight(v)) continue;
            held.removeAt(i);
            if (v == null) continue;
            for (int prop = 0; prop <= LAST_LOOK; prop++) {
                if ((h.mask & (1 << prop)) != 0) animated(v, id, prop, h.values[prop]);
            }
        }
        if (held.size() == 0 && heldListener != null) {
            android.view.ViewTreeObserver observer = host.getViewTreeObserver();
            if (observer.isAlive()) observer.removeOnPreDrawListener(heldListener);
            heldListener = null;
        }
    }

    /** Sets animated property `prop` of view `id`. */
    private void animated(View v, int id, int prop, float value) {
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
                if (prop == 8) v.setRotationX(value);
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
                Float old = stickyOffsets.put(id, value * density);
                ScrollBox s = stickyHosts.get(id);
                if (s != null && (old == null || old != value * density)) s.pinSticky();
                break;
            }
            default: break;
        }
    }

    // --- Navigation ----------------------------------------------------------

    /** Screens, header items and modals are not subviews of their parent. */
    private boolean insertHosted(int parentId, int childId, int beforeId) {
        View parent = views.get(parentId), child = views.get(childId);
        if (child instanceof StackBox.ScreenBox && parent instanceof StackBox) {
            StackBox stack = (StackBox) parent;
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
        o.centerTitle = b.getInt() == 1;
        o.hidesBottomBar = b.getInt() != 0;
        screenOptions.put(id, o);
        dirtyScreens.add(id);
        int stack = hosts.get(id, -1);
        if (stack >= 0) dirtyStacks.add(stack);
        bottomBarDirty = true;
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
                for (int s : stack.screens) {
                    dirtyScreens.add(s);
                    // The transition reads each screen's animation and hidesBottomBar:
                    // a screen mounted in this batch is configured only below, so give
                    // it its options before the stack reconciles and animates it in.
                    View sv = views.get(s);
                    ScreenOptions so = screenOptions.get(s);
                    if (sv instanceof StackBox.ScreenBox && so != null) {
                        ((StackBox.ScreenBox) sv).animation = so.animation;
                        ((StackBox.ScreenBox) sv).hidesBottomBar = so.hidesBottomBar;
                    }
                }
                stack.reconcile();
                bottomBarDirty = true;
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
                    o.headerHeight, o.centerTitle, o.hidesBottomBar, canGoBack, below != null ? below.backTitle : null);
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
                modal.statusBar(Math.max(barStyle, 0), barHidden, night());
            } else {
                modal.dismiss();
                shownModals.remove(modal);
            }
        }
        dirtyModals.clear();
        if (bottomBarDirty) {
            bottomBarDirty = false;
            for (StackBox s : stacks) s.syncBottomBar(false);
        }
        updateBack();
    }

    /** Pads every mounted screen's toolbar and reports its insets again, after the view's safe area changed. */
    void reportAllScreenInsets() {
        for (int i = 0; i < screenOptions.size(); i++) {
            int id = screenOptions.keyAt(i);
            View v = views.get(id);
            if (!(v instanceof StackBox.ScreenBox)) continue;
            ((StackBox.ScreenBox) v).padToolbar();
            reportScreenInsets(id, screenOptions.valueAt(i));
        }
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
        if (!shownModals.isEmpty() || hasSelection()) return true;
        return backStack() != null || wants(1, Native.BACK_PRESS);
    }

    void updateBack() {
        host.setBackHandling(wantsBack());
    }

    boolean hasShownModal() {
        return !shownModals.isEmpty();
    }

    /** The windows of the dialogs shown, bottom to top (the test agent's screenshots). */
    java.util.List<android.view.Window> modalWindows() {
        java.util.ArrayList<android.view.Window> windows = new java.util.ArrayList<>();
        for (ModalHost m : shownModals) {
            android.view.Window window = m.dialogWindow();
            if (window != null) windows.add(window);
        }
        return windows;
    }

    /**
     * The control a native component draws for the app (a {@code MenuButton}'s
     * button) that the test agent presses: in the view of a node whose
     * {@code testID} is {@code testId}, or labelled {@code label}; null when
     * none shows.
     */
    View componentControl(String testId, String label) {
        for (int i = 0; i < views.size(); i++) {
            View v = views.valueAt(i);
            if (!(v instanceof ComponentBox) || ((ComponentBox) v).component == null) continue;
            View control = ((ComponentBox) v).component.view();
            if (!control.isClickable() || !control.isShown()) continue;
            if (label != null) {
                CharSequence name = control.getContentDescription();
                if (name != null && label.contentEquals(name)) return control;
                continue;
            }
            for (int j = 0; j < a11y.size(); j++) {
                if (!testId.equals(a11y.valueAt(j).testId)) continue;
                View named = views.get(a11y.keyAt(j));
                for (View at = v; named != null && at != null;
                        at = at.getParent() instanceof View ? (View) at.getParent() : null) {
                    if (at == named) return control;
                }
            }
        }
        return null;
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

    // --- Moving to the activity made again ------------------------------------------

    /** The view focused in the host's window as it left the activity. */
    private View movedFocus;
    /** The text field the software keyboard was up for as it left the activity. */
    private View movedKeyboard;
    /** What shows the alerts taken off the activity that went again, in the new one. */
    private final java.util.ArrayList<Runnable> movedDialogs = new java.util.ArrayList<>();

    /**
     * The activity goes, to be made again for a configuration change ({@link NshView#leaveActivity}): what the app
     * shows in windows of the activity's own goes off it now, or the activity would leak with them. Dialogs and
     * alerts come back in {@link #enterWindows}; menus close, as when the user leaves them.
     */
    void leaveWindows() {
        moving = true;
        movedKeyboard = fieldWithKeyboard();
        movedFocus = host.findFocus();
        SystemMenus.dismissOf(context);
        java.util.ArrayList<java.util.function.Supplier<Runnable>> alerts = new java.util.ArrayList<>();
        for (int i = 0; i < dialogMoves.size(); i++) alerts.add(dialogMoves.valueAt(i));
        for (java.util.function.Supplier<Runnable> alert : alerts) movedDialogs.add(alert.get());
        // Those still going too: their dismissal ends now.
        for (int i = 0; i < modals.size(); i++) modals.valueAt(i).leaveWindow();
    }

    /** Shows the dialogs and alerts {@link #leaveWindows} took in the activity made again, the focus as it was. */
    void enterWindows() {
        for (ModalHost m : shownModals) m.enterWindow();
        for (Runnable show : movedDialogs) show.run();
        movedDialogs.clear();
        View focus = movedFocus;
        movedFocus = null;
        if (focus != null && focus.getRootView() == host.getRootView()) focus.requestFocus();
        applySystemBars();
        moving = false;
        // The keyboard comes back up for its field once its window has the focus.
        View field = movedKeyboard;
        movedKeyboard = null;
        for (View v = field; v != null; v = v.getParent() instanceof View ? (View) v.getParent() : null) {
            if (v instanceof InputBox) {
                ((InputBox) v).focus();
                break;
            }
        }
    }

    /** The text field the software keyboard is up for: the focus of the topmost window, the host's or a dialog's. */
    private View fieldWithKeyboard() {
        View field = shownModals.isEmpty() ? host.findFocus() : shownModals.get(shownModals.size() - 1).focus();
        if (field == null || !field.onCheckIsTextEditor()) return null;
        if (Build.VERSION.SDK_INT < 30) return field;
        android.view.WindowInsets insets = field.getRootWindowInsets();
        return insets != null && insets.isVisible(android.view.WindowInsets.Type.ime()) ? field : null;
    }

    /** Whether the app's back listeners hear the button before the stacks. */
    boolean listensToBack() {
        return wants(1, Native.BACK_PRESS);
    }

    /**
     * Whether the app follows the back gesture itself: it listens to the
     * gesture's steps ({@code BackHandler.on("progress")}) and no modal
     * takes the gesture. The stacks then leave it to the app.
     */
    boolean followsBack() {
        return shownModals.isEmpty() && wants(1, Native.BACK_PROGRESS);
    }

    /**
     * A step of the back gesture the app follows: {@code phase} is
     * {@code "start"}, {@code "move"}, {@code "end"} or {@code "cancel"},
     * {@code progress} from 0 to 1, {@code edge} {@code "left"},
     * {@code "right"} or null.
     */
    void backProgress(String phase, float progress, String edge) {
        if (edge == null) {
            eventMap(1, Native.BACK_PROGRESS, new String[] {"phase", "progress"},
                    new Object[] {phase, (double) progress});
        } else {
            eventMap(1, Native.BACK_PROGRESS, new String[] {"phase", "progress", "edge"},
                    new Object[] {phase, (double) progress, edge});
        }
    }

    /** The back button: the newest modal asks to close, else the app's
     * listeners hear it (and send {@code Command::Back} when none takes it),
     * else the innermost stack pops. Returns false if nothing did. */
    boolean handleBack() {
        // A selection goes first, as TextView's: back ends it and goes no further.
        if (endSelection()) return true;
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
        boolean editable = b.getInt() != 0, autoFocus = b.getInt() != 0, selectOnFocus = b.getInt() != 0;
        boolean hasSelection = b.getInt() != 0;
        int selection = b.getInt();
        boolean hasCaret = b.getInt() != 0;
        int caret = b.getInt();
        int submit = b.getInt();
        String autofill = optString(b, objects);
        boolean inputRtl = b.getInt() != 0;
        boolean caretHidden = b.getInt() != 0;
        boolean pasteInserts = b.getInt() != 0;
        int pasteMaxSize = b.getInt();
        boolean scrollbarVisible = b.getInt() != 0, reportScroll = b.getInt() != 0;
        int fontVariant = b.getInt();
        if (!(v instanceof InputBox)) return;
        if (autoFocus && !((InputBox) v).isConfigured()) focusAsked = true;
        ((InputBox) v).pasteInserts = pasteInserts;
        ((InputBox) v).pasteMaxSize = pasteMaxSize;
        ((InputBox) v).setScrollbar(scrollbarVisible, reportScroll);
        ((InputBox) v).edit.setCursorVisible(!caretHidden);
        ((InputBox) v).setAutofill(autofill);
        ((InputBox) v).edit.setLayoutDirection(inputRtl ? View.LAYOUT_DIRECTION_RTL : View.LAYOUT_DIRECTION_LTR);
        String family = familyIndex >= 0 ? (String) objects[familyIndex] : null;
        ((InputBox) v).configure(size, weight, italic, color, family, spacing, align, placeholder,
                hasPlaceholderColor, placeholderColor, secure, keyboard, returnKey, capitalize, autoCorrect,
                multiline, maxLength, editable, autoFocus, selectOnFocus, hasSelection, selection, hasCaret, caret, submit,
                inputRtl, fontVariant);
    }

    /**
     * The view removed or deleted in this batch with the text field that has the keyboard inside it, and that
     * field's window: once detached, the view no longer finds its focus. Settled when the batch ends, never kept
     * across batches.
     */
    private View keyboardLeaving, keyboardWindow;
    private android.os.IBinder keyboardToken;
    /** A field asked for the focus in this batch (`focus()`, or a new field's `autoFocus`): the keyboard is its. */
    private boolean focusAsked;

    private void noteKeyboardLeaving(View v) {
        View f = v == null ? null : v.findFocus();
        if (f == null || !f.onCheckIsTextEditor()) return;
        keyboardLeaving = v;
        keyboardWindow = f.getRootView();
        keyboardToken = f.getWindowToken();
    }

    private void forgetKeyboardLeaving() {
        keyboardLeaving = null;
        keyboardWindow = null;
        keyboardToken = null;
    }

    /**
     * The field with the keyboard was removed or deleted in this batch and not put back: the keyboard hides with
     * it, as when a page or dialog leaves ({@link #hideKeyboardIn}), unless a field takes it: one asked for the
     * focus in the batch, waits for it, or has it once the batch's own posted focus requests ran.
     */
    private void settleKeyboardLeaving() {
        View window = keyboardWindow;
        android.os.IBinder token = keyboardToken;
        boolean asked = focusAsked;
        focusAsked = false;
        forgetKeyboardLeaving();
        if (window == null || asked) return;
        host.post(() -> {
            if (pendingFocus.id() != 0) return;
            View now = window.findFocus();
            if (now != null && now.onCheckIsTextEditor()) return;
            InputMethodManager imm = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
            imm.hideSoftInputFromWindow(token, 0);
            focusWindowRoot(window);
        });
    }

    /** Leaves the focus at the root of {@code window}, where the keyboard's field was: the host's or a dialog's. */
    private void focusWindowRoot(View window) {
        if (window == host.getRootView()) {
            host.requestFocus();
            return;
        }
        for (int i = 0; i < modals.size(); i++) {
            ModalHost modal = modals.valueAt(i);
            if (modal.window() == window) {
                modal.focusRoot();
                return;
            }
        }
    }

    /**
     * A page or dialog leaves with the field that has the keyboard: the
     * keyboard hides with it, as with a native back, not once the field is
     * gone (which leaves it up). Focus goes to the host, as `blur()` does.
     */
    void hideKeyboardIn(View leaving) {
        View f = leaving.findFocus();
        if (f == null || !f.onCheckIsTextEditor()) return;
        InputMethodManager imm = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
        imm.hideSoftInputFromWindow(f.getWindowToken(), 0);
        if (f.getRootView() == host.getRootView()) host.requestFocus();
    }

    /** The activity's requested orientation before a page set one (null: none set). */
    private Integer ownOrientation;

    /**
     * A page's {@code supportedOrientations} ({@code nsh_core::ModalConfig}
     * bits: 1 portrait, 2 upside down, 4 landscape-left, 8 landscape-right;
     * 0 gives the activity back the orientation it had). Landscape-left is
     * UIKit's {@code UIInterfaceOrientationLandscapeLeft}, the device
     * turned clockwise: Android's reverse landscape. Two-sided sets follow
     * the user's rotation lock ({@code USER_*}).
     */
    private void orientations(int bits) {
        android.app.Activity activity = SystemUi.activity(context);
        if (activity == null) return;
        if (bits == 0) {
            if (ownOrientation != null) activity.setRequestedOrientation(ownOrientation);
            ownOrientation = null;
            return;
        }
        if (ownOrientation == null) ownOrientation = activity.getRequestedOrientation();
        boolean portrait = (bits & 1) != 0, upsideDown = (bits & 2) != 0;
        boolean left = (bits & 4) != 0, right = (bits & 8) != 0;
        int requested;
        if ((portrait || upsideDown) && (left || right)) {
            requested = portrait && upsideDown && left && right
                    ? ActivityInfo.SCREEN_ORIENTATION_FULL_USER
                    : ActivityInfo.SCREEN_ORIENTATION_USER;
        } else if (portrait && upsideDown) {
            requested = ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT;
        } else if (portrait) {
            requested = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        } else if (upsideDown) {
            requested = ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT;
        } else if (left && right) {
            requested = ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE;
        } else if (left) {
            requested = ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE;
        } else {
            requested = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
        }
        activity.setRequestedOrientation(requested);
    }

    /**
     * `Haptics` of `nsh/mobile`: the haptic feedback constant closest to
     * `haptic` (`nsh_core::Haptic`, in the order `encode.rs` writes), which
     * the view plays when the user's touch feedback setting allows it.
     * API levels: {@link HapticFeedbackConstants#CONFIRM} /
     * {@link HapticFeedbackConstants#REJECT} from 30 (else
     * {@link HapticFeedbackConstants#VIRTUAL_KEY} /
     * {@link HapticFeedbackConstants#LONG_PRESS});
     * {@link HapticFeedbackConstants#SEGMENT_TICK} from 34 (else
     * {@link HapticFeedbackConstants#CLOCK_TICK} for selection).
     */
    private static void haptic(View view, int haptic) {
        boolean api30 = Build.VERSION.SDK_INT >= 30;
        int feedback;
        switch (haptic) {
            case 0: // selection
                feedback = Build.VERSION.SDK_INT >= 34
                        ? HapticFeedbackConstants.SEGMENT_TICK
                        : HapticFeedbackConstants.CLOCK_TICK;
                break;
            case 1: feedback = HapticFeedbackConstants.KEYBOARD_TAP; break; // light
            case 2: feedback = HapticFeedbackConstants.VIRTUAL_KEY; break; // medium
            case 3: feedback = HapticFeedbackConstants.LONG_PRESS; break; // heavy
            case 4: feedback = HapticFeedbackConstants.CLOCK_TICK; break; // soft
            case 5: feedback = HapticFeedbackConstants.CONTEXT_CLICK; break; // rigid
            case 6: // success
                feedback = api30 ? HapticFeedbackConstants.CONFIRM : HapticFeedbackConstants.VIRTUAL_KEY;
                break;
            case 7: feedback = HapticFeedbackConstants.LONG_PRESS; break; // warning: no constant of its own
            case 8: // error
                feedback = api30 ? HapticFeedbackConstants.REJECT : HapticFeedbackConstants.LONG_PRESS;
                break;
            default: return;
        }
        view.performHapticFeedback(feedback);
    }

    /** Whether {@code inner} is {@code outer} or inside it. */
    private static boolean within(View inner, View outer) {
        for (Object at = inner; at instanceof View; at = ((View) at).getParent()) {
            if (at == outer) return true;
        }
        return false;
    }

    private void command(ByteBuffer b, Object[] objects, long seq) {
        int id = b.getInt(), kind = b.getInt();
        View v = views.get(id);
        switch (kind) {
            case 0:
                focus(id, v);
                break;
            case 1:
                blurPending(id, v);
                if (v instanceof InputBox) {
                    ((InputBox) v).blur();
                } else if (v != null && managed(v) && v.isFocused()) {
                    releaseFocus(v);
                } else if (modals.get(id) != null) {
                    // Blur whatever the dialog window has focused and hide its keyboard.
                    View window = v != null ? v.getRootView() : null;
                    if (window != null) {
                        View f = window.findFocus();
                        if (f != null && f != window) {
                            InputBox input = inputOf(f);
                            if (input != null) input.blur();
                            else releaseFocus(f);
                        }
                        InputMethodManager imm = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
                        imm.hideSoftInputFromWindow(window.getWindowToken(), 0);
                    }
                } else if (id == 1) {
                    // Keyboard.dismiss(): prefer the tracked field (a dialog's
                    // EditText lives in another window, so host.findFocus()
                    // misses it). Else hide whatever still holds the IME.
                    // Matches iOS (#522): dismiss ends editing in modals too.
                    InputBox field = focusedInput();
                    if (field != null) {
                        field.blur();
                        break;
                    }
                    View f = host.findFocus();
                    if (f == null) {
                        View modal = topModalWindow();
                        if (modal != null) f = modal.findFocus();
                    }
                    InputMethodManager imm = (InputMethodManager) context.getSystemService(Context.INPUT_METHOD_SERVICE);
                    if (f != null) {
                        imm.hideSoftInputFromWindow(f.getWindowToken(), 0);
                        if (f != host) releaseFocus(f);
                    } else {
                        // Field gone: hide with the host token unless another
                        // editor outside the host still has the IME (#714).
                        View other = host.getRootView().findFocus();
                        if (other == null || !other.onCheckIsTextEditor() || !imm.isActive(other)) {
                            imm.hideSoftInputFromWindow(host.getWindowToken(), 0);
                        }
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
            case 46: {
                String url = (String) objects[b.getInt()];
                int count = b.getInt();
                java.util.Map<String, String> headers = new java.util.LinkedHashMap<>();
                for (int i = 0; i < count; i++) {
                    String name = (String) objects[b.getInt()];
                    headers.put(name, (String) objects[b.getInt()]);
                }
                if (v instanceof WebBox) ((WebBox) v).load(url, headers);
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
                // Its text field: the text, the placeholder, select all, required.
                String input = null, placeholder = null;
                boolean selectAll = false, required = false;
                if (b.getInt() != 0) {
                    input = (String) objects[b.getInt()];
                    placeholder = optString(b, objects);
                    selectAll = b.getInt() != 0;
                    required = b.getInt() != 0;
                }
                SystemUi.dialog(this, dialog, title, message, cancelable, sheet, texts, styles, input, placeholder,
                        selectAll, required);
                break;
            }
            case 60:
                SystemUi.closeDialog(this, b.getInt());
                break;
            case 14: {
                boolean block = b.getInt() != 0;
                clearJsResponder();
                if (block && v != null) {
                    // Scroll views around the responder stop taking its touches, and the presses around it
                    // end: a handle held past the long press delay is no long press of the text around it.
                    for (ViewParent p = v.getParent(); p != null; p = p.getParent()) {
                        if (p instanceof Box) ((Box) p).cancelPress();
                        else if (p instanceof TextBox && ((TextBox) p).press != null) ((TextBox) p).press.cancel();
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
            case 49: {
                float x = b.getFloat(), y = b.getFloat(), w = b.getFloat(), h = b.getFloat();
                int actions = b.getInt();
                if (v instanceof InputBox) ((InputBox) v).openEditMenu(x, y, w, h, actions);
                break;
            }
            case 51: {
                int request = b.getInt();
                String generation = (String) objects[b.getInt()];
                String start = (String) objects[b.getInt()];
                String poll = (String) objects[b.getInt()];
                String cleanup = (String) objects[b.getInt()];
                if (v instanceof WebBox) ((WebBox) v).evaluate(request, generation, start, poll, cleanup);
                break;
            }
            case 52: {
                int request = b.getInt();
                if (v instanceof WebBox) ((WebBox) v).cancelEvaluation(request);
                break;
            }
            case 50:
                if (v instanceof InputBox) ((InputBox) v).closeEditMenu();
                break;
            case 62: {
                // ref.clearSelection(): the selection of the selectable view
                // v is, is in or holds.
                SelectableView area = selectedArea;
                if (area != null && v != null && (within(area.view, v) || within(v, area.view))) {
                    area.clear();
                }
                break;
            }
            case 69: {
                // ref.selectAll(): every text of the selectable view v is or is in.
                SelectableView area = v != null ? selectableViewOf(v) : null;
                if (area != null) area.selectAll();
                break;
            }
            case 21: {
                String name = string(objects, b.getInt());
                String json = string(objects, b.getInt());
                if (v instanceof ComponentBox) {
                    NshComponent c = ((ComponentBox) v).component;
                    if (c instanceof RustComponent) ((RustComponent) c).step(seq);
                    else if (c != null) c.command(name, Json.parse(json));
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
            case 56: {
                String text = (String) objects[b.getInt()];
                String html = (String) objects[b.getInt()];
                SystemUi.setClipboardHtml(context, text, html);
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
            case 57: {
                Picker.Request request = new Picker.Request();
                request.id = b.getInt();
                request.limit = b.getInt() != 0 ? Integer.MAX_VALUE : 1;
                request.folders = b.getInt() != 0;
                String extensions = (String) objects[b.getInt()];
                request.extensions = extensions.isEmpty() ? new String[0] : extensions.split(",");
                request.files = true;
                request.paths = this;
                request.view = host;
                Picker.show(context, request);
                break;
            }
            case 45: {
                Picker.Request request = new Picker.Request();
                request.id = b.getInt();
                request.limit = b.getInt();
                String extensions = (String) objects[b.getInt()];
                request.extensions = extensions.isEmpty() ? new String[0] : extensions.split(",");
                request.maxBytes = b.getInt();
                request.files = true;
                request.view = host;
                Picker.show(context, request);
                break;
            }
            case 27: {
                for (int i = 0; i < dialogColors.length; i++) dialogColors[i] = b.getInt();
                break;
            }
            case 28: {
                int request = b.getInt();
                String path = (String) objects[b.getInt()];
                boolean opened = SystemUi.openPath(context, path);
                if (opened) {
                    eventMap(1, Native.FILE_REQUEST, new String[] {"id"}, new Object[] {(double) request});
                } else {
                    eventMap(1, Native.FILE_REQUEST, new String[] {"id", "error"},
                            new Object[] {(double) request, "no app opened the file"});
                }
                break;
            }
            case 30: {
                // A file request with no Android implementation: fail it so
                // the waiting call returns instead of hanging.
                int request = b.getInt();
                eventMap(1, Native.FILE_REQUEST, new String[] {"id", "error"},
                        new Object[] {(double) request, "not supported on Android"});
                break;
            }
            case 55: {
                // `encode.rs` `Command::RenderCanvas`: the request, the size in pixels, the scale, the format,
                // then the drawing as `CANVAS` carries it.
                int request = b.getInt(), width = b.getInt(), height = b.getInt();
                float scale = b.getFloat();
                int format = b.getInt(), words = b.getInt();
                int[] code = new int[words];
                b.asIntBuffer().get(code);
                b.position(b.position() + words * 4);
                CanvasRender.render(this, request, width, height, scale, format, code, objects);
                break;
            }
            case 44: {
                Notifications.command(this, b, objects);
                break;
            }
            case 47: {
                audio().command(b, objects);
                break;
            }
            case 26: {
                int request = b.getInt();
                String url = (String) objects[b.getInt()];
                boolean opened = SystemUi.openUrl(context, url);
                eventMap(1, Native.OPEN_URL, new String[] {"id", "opened"}, new Object[] {(double) request, opened});
                break;
            }
            case 67: {
                // `encode.rs` `Command::ReadClipboardImage`: the request and
                // whether only `has` is asked. Providers are read off the main
                // thread; the answer comes back on it.
                int request = b.getInt();
                boolean hasOnly = b.getInt() != 0;
                if (hasOnly) {
                    eventMap(1, Native.CLIPBOARD, new String[] {"id", "has"},
                            new Object[] {(double) request, ClipboardReads.hasImage(context)});
                    break;
                }
                new Thread(() -> {
                    Object[] image = ClipboardReads.readImage(context);
                    String[] keys;
                    Object[] values;
                    if (image == null) {
                        keys = new String[] {"id", "has"};
                        values = new Object[] {(double) request, false};
                    } else if (image[1] == null) {
                        keys = new String[] {"id", "has", "tooLarge"};
                        values = new Object[] {(double) request, true, (double) (Integer) image[2]};
                    } else {
                        String uri = "data:" + image[0] + ";base64,"
                                + android.util.Base64.encodeToString((byte[]) image[1], android.util.Base64.NO_WRAP);
                        keys = new String[] {"id", "has", "uri", "width", "height"};
                        values = new Object[] {(double) request, true, uri,
                                (double) (Integer) image[2], (double) (Integer) image[3]};
                    }
                    host.post(() -> eventMap(1, Native.CLIPBOARD, keys, values));
                }, "nsh-clipboard").start();
                break;
            }
            case 66: {
                // `encode.rs` `Command::ReadClipboardFiles`: the request. The
                // clip's content URIs are copied into the cache off the main
                // thread; their `file:` URLs come back on it.
                int request = b.getInt();
                new Thread(() -> {
                    java.util.List<String> paths = ClipboardReads.readFiles(context);
                    StringBuilder files = new StringBuilder();
                    for (String path : paths) {
                        if (files.length() > 0) files.append('\n');
                        files.append(android.net.Uri.fromFile(new java.io.File(path)));
                    }
                    String joined = files.toString();
                    host.post(() -> eventMap(1, Native.CLIPBOARD, new String[] {"id", "has", "files"},
                            new Object[] {(double) request, !paths.isEmpty(), joined}));
                }, "nsh-clipboard").start();
                break;
            }
            case 68: {
                // `encode.rs` `Command::SetClipboardImage`: the `data:` URI.
                String uri = (String) objects[b.getInt()];
                if (!ClipboardReads.writeImage(context, uri)) {
                    android.util.Log.w("nsh", "Clipboard.writeImage: not a base64 image data: URI; nothing written");
                }
                break;
            }
            case 63: {
                // `encode.rs` `Command::OpenAppSettings`: the request.
                int request = b.getInt();
                boolean opened = SystemUi.openAppSettings(context);
                eventMap(1, Native.OPEN_APP_SETTINGS, new String[] {"id", "opened"},
                        new Object[] {(double) request, opened});
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
            case 65: {
                // ref.insertText(text): in place of the input's selection.
                String text = (String) objects[b.getInt()];
                if (v instanceof InputBox) ((InputBox) v).insertText(text);
                break;
            }
            case 64: {
                textLocale = java.util.Locale.forLanguageTag((String) objects[b.getInt()]);
                // Services keep copies of the nodes: those with state words read them again.
                android.view.accessibility.AccessibilityManager manager = host.accessibility();
                // Without a running service there is no copy to refresh.
                if (manager != null && manager.isEnabled()) {
                    for (int i = 0; i < a11y.size(); i++) {
                        View view = views.get(a11y.keyAt(i));
                        if (view != null) a11y.valueAt(i).wordsChanged(view);
                    }
                }
                break;
            }
            case 48: {
                haptic(host, b.getInt());
                break;
            }
            case 54: {
                orientations(b.getInt());
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
                boolean scroll = b.getInt() != 0, js = b.getInt() != 0, incognito = b.getInt() != 0;
                boolean zoomable = b.getInt() != 0;
                String allowOrigin = optString(b, objects), allowNavigation = optString(b, objects);
                if (v instanceof WebBox) {
                    ((WebBox) v).configure(source, injected, before, ua, scroll, js, incognito, zoomable, allowOrigin,
                            allowNavigation);
                }
                break;
            }
            case 4: {
                String source = optString(b, objects);
                String poster = optString(b, objects);
                boolean paused = b.getInt() != 0, muted = b.getInt() != 0;
                float volume = b.getFloat(), rate = b.getFloat();
                boolean repeat = b.getInt() != 0;
                int mode = b.getInt();
                boolean controls = b.getInt() != 0;
                float interval = b.getFloat();
                int audioSession = b.getInt();
                if (v instanceof VideoBox) {
                    ((VideoBox) v).configure(source, poster, paused, muted, volume, rate, repeat, mode, controls,
                            interval, audioSession);
                }
                break;
            }
            default: throw new IllegalStateException("nsh: unknown native props");
        }
    }

    void inputFocused(InputBox input, boolean focused) {
        if (focused) {
            // As a managed view's focus does (`focusChange`): a request
            // still waiting for another view would take it from the field.
            dropPendingFocus();
            this.focused = input;
            host.post(this::revealFocused);
        } else if (this.focused == input) {
            this.focused = null;
        }
    }

    /** The scroll view padded to clear the keyboard. */
    private int avoided = -1;
    /**
     * The scroll view around the focused input of a modal window while the
     * keyboard is up: it shrinks as the window lays out above the keyboard.
     */
    private int shrinking = -1;

    /**
     * The software keyboard's top edge moved, in screen coordinates
     * ({@code Integer.MAX_VALUE} when hidden): pads the scroll view around
     * the focused input of the surface so it can clear the keyboard. A
     * modal window lays its content out above the keyboard instead
     * ({@link ModalHost}), after this: its scroll view gets no padding and
     * reveals the input once it has shrunk ({@link #scrollShrank}).
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
        shrinking = -1;
        if (scroll == null || hidden) return;
        // Measured now, before the modal window's layout, the padding would
        // be what the keyboard covers of the content where it was, and it
        // would stay under the content once that is above the keyboard.
        if (scroll.getRootView() != host.getRootView()) {
            shrinking = scroll.id;
            return;
        }
        int[] at = new int[2];
        scroll.getLocationOnScreen(at);
        int covered = Math.max(0, at[1] + scroll.getHeight() - screenTop);
        scroll.setContentPaddingBottom(covered);
        avoided = scroll.id;
        host.post(this::revealFocused);
    }

    /**
     * Scroll view {@code scroll} got shorter: the one around the focused
     * input of a modal window that now lays out above the keyboard keeps the
     * input in sight.
     */
    void scrollShrank(ScrollBox scroll) {
        if (scroll.id == shrinking && focused != null) host.post(this::revealFocused);
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

    /**
     * The scroll view whose `keyboardShouldPersistTaps` "never" holds the current touch: if the touch is a tap, it
     * only dismisses the keyboard; meanwhile it presses nothing.
     */
    private ScrollBox tapScroll;
    /** A view of the touch reported a long press: it is no tap. */
    private boolean longPressed;

    void startTapOnly(ScrollBox s) {
        tapScroll = s;
    }

    void endTapOnly(ScrollBox s) {
        if (tapScroll == s) tapScroll = null;
    }

    /**
     * At a root (the surface, a modal), before it dispatches {@code e}: a tap that only dismisses the keyboard
     * reaches the views and JS responders as a cancel, so nothing inside (a responder, a web view) acts on it.
     * Returns the event to dispatch, a new one to recycle when it is not {@code e}.
     */
    android.view.MotionEvent keyboardTap(android.view.MotionEvent e) {
        int action = e.getActionMasked();
        if (action == android.view.MotionEvent.ACTION_DOWN) {
            // Set by the scroll view as the down goes through it; nothing of an earlier touch lingers.
            tapScroll = null;
            longPressed = false;
            return e;
        }
        if (action != android.view.MotionEvent.ACTION_UP || tapScroll == null || longPressed || !tapScroll.stillTap(e)) return e;
        ScrollBox s = tapScroll;
        tapScroll = null;
        s.hideKeyboard();
        android.view.MotionEvent cancel = android.view.MotionEvent.obtain(e);
        cancel.setAction(android.view.MotionEvent.ACTION_CANCEL);
        return cancel;
    }

    boolean wants(int id, int kind) {
        if (kind >= 64) return (eventsHigh.get(id) & (1L << (kind - 64))) != 0;
        return (events.get(id) & (1L << kind)) != 0;
    }

    /** Whether {@code id} is a file drop destination: it listens to `onFileDrop` and is enabled. */
    boolean takesFileDrops(int id) {
        return wants(id, Native.FILE_DROP) && keyEnabled(id);
    }

    /** Whether `id`'s own state lets it hear keys (a disabled view captures and listens to none). */
    private boolean keyEnabled(int id) {
        A11y a = a11y.get(id);
        return a == null || (a.state & 1) == 0;
    }

    /** A view the keyboard manager focuses: not an input and not hosted native content. */
    private static boolean managed(View v) {
        return v instanceof Node && !(v instanceof InputBox)
                && !(v instanceof WidgetBox) && !(v instanceof ComponentBox);
    }

    /**
     * Whether `id` is a Tab stop: {@code focusable} (true, or unset and the
     * view takes presses) and enabled. Inputs are stops of their own (their
     * EditText is the native focus target) and the root is the host itself.
     */
    private boolean focusStop(int id) {
        if (id <= 1) return false;
        View v = views.get(id);
        if (v == null) return false;
        return Focusable.stop(focusProps.get(id, -1), wants(id, Native.PRESS), keyEnabled(id));
    }

    /** Releases focus to the same window's keyboard root, without focusing another field. */
    private void releaseFocus(View v) {
        View window = v.getRootView();
        if (window == host.getRootView()) {
            host.requestFocus();
            return;
        }
        for (int i = 0; i < modals.size(); i++) {
            ModalHost modal = modals.valueAt(i);
            if (modal.window() == window) {
                modal.focusRoot();
                return;
            }
        }
        v.clearFocus();
    }

    /** An input blurring: the focus leaves its own window, not another window's. */
    void releaseFocusOf(View v) {
        releaseFocus(v);
    }

    /** The input whose EditText contains `v`, if any. */
    private static InputBox inputOf(View v) {
        for (View cur = v; cur != null; ) {
            if (cur instanceof InputBox) return (InputBox) cur;
            ViewParent parent = cur.getParent();
            cur = parent instanceof View ? (View) parent : null;
        }
        return null;
    }

    /**
     * Applies `focusable` (and whether the view takes presses) to a managed
     * view: Android's own focus carries it, so Tab/Shift+Tab and
     * `requestFocus` work, and the focus listeners report `FOCUSED`,
     * `onFocus` and `onBlur` to the core. Only an explicit `focusable` is
     * focusable in touch mode; a default pressable is a hardware/Tab stop
     * whose keyboard focus still reveals it in its scroll view, but which
     * never takes a touch-mode focus.
     */
    private void updateFocusable(int id, View v) {
        if (v == null || id <= 1 || !managed(v)) return;
        boolean stop = focusStop(id);
        // Our paired focus/touch listeners mark an installed stop. Unlike
        // the setters, this getter never creates View.ListenerInfo.
        boolean listening = v.getOnFocusChangeListener() == focusChange;
        if (!stop && v.isFocused()) {
            // Report the blur before focusability is dropped.
            if (!listening) {
                v.setOnFocusChangeListener(focusChange);
                listening = true;
            }
            releaseFocus(v);
        }
        if (v.isFocusable() != stop) v.setFocusable(stop);
        // Only an explicit `focusable` (or a programmatic `ref.focus()`,
        // which sets this itself) opts into touch-mode focus. A default
        // pressable stays a hardware/Tab stop, so Android's touch-mode
        // focus path never pulls the focus out of an input or hosted view
        // on a tap. Keep the flag while the view holds the focus: a props
        // update must not blur a `ref.focus()` on a default pressable.
        boolean touch = stop && Focusable.touch(focusProps.get(id, -1));
        if (touch) {
            if (!v.isFocusableInTouchMode()) v.setFocusableInTouchMode(true);
        } else if ((!stop || !v.isFocused()) && v.isFocusableInTouchMode()) {
            v.setFocusableInTouchMode(false);
        }
        if (Build.VERSION.SDK_INT >= 26) v.setDefaultFocusHighlightEnabled(false);
        // Only change listeners when entering/leaving the stop set. Even
        // setting a null listener allocates ListenerInfo on an untouched view.
        if (listening != stop) {
            v.setOnFocusChangeListener(stop ? focusChange : null);
            v.setOnTouchListener(stop ? pointerFocus : null);
        }
    }

    /**
     * A `ref.focus()` whose view is not shown yet (`PendingFocus`: a page
     * the batch pushes, a page under its transition shader, a dialog's
     * content before its window shows).
     */
    private final PendingFocus pendingFocus = new PendingFocus();
    /**
     * Tries a pending focus again each frame, posted only while a managed
     * view waits: Choreographer calls it whichever window the view will
     * show in (the surface's or a dialog's), and nothing runs per frame
     * when no request waits.
     */
    private final android.view.Choreographer.FrameCallback pendingFocusFrame = frameTime -> {
        retryFocus();
        int id = pendingFocus.id();
        if (id != 0 && !(views.get(id) instanceof InputBox)) {
            android.view.Choreographer.getInstance().postFrameCallback(this.pendingFocusFrame);
        }
    };

    /**
     * What held the focus of the pending view's window outside NSH's own
     * views when the request was made (`foreignFocus`), so the request
     * still takes the focus from it, as it would from a shown view.
     */
    private View pendingForeign;

    /** `Command::Focus`: the latest request wins over one still waiting. */
    private void focus(int id, View v) {
        focusAsked = true;
        dropPendingFocus();
        // A field not shown yet waits on its own and reports that wait
        // (`inputFocusWaits`), so a newer request or a blur ends it.
        if (v instanceof InputBox) ((InputBox) v).focus();
        else focusManaged(id);
    }

    /**
     * `ref.focus()` on a managed stop: makes it focusable and focuses it,
     * at once when it is shown, else once it is (`PendingFocus`). The
     * request is explicit, so it opts into touch-mode focus as an
     * explicit `focusable` does; `updateFocusable` keeps that while the
     * view holds the focus. On a shown view that is not a stop it does
     * nothing; a request dropped without effect (no such view, a view
     * neither shown nor a stop) logs a warning. Called only by `focus`,
     * which ends the request before it.
     */
    private void focusManaged(int id) {
        View v = views.get(id);
        if (v == null) {
            android.util.Log.w("nsh", "focus(): no view " + id);
            return;
        }
        boolean stop = focusStop(id);
        if (v.isShown()) {
            if (stop) takeFocus(v);
            return;
        }
        if (!stop) {
            android.util.Log.w("nsh", "focus(): view " + id + " is neither shown nor a focus stop"
                    + " (focusable false, disabled, or no press handler); the request is dropped");
            return;
        }
        pendingFocus.start(id, android.os.SystemClock.uptimeMillis());
        pendingForeign = foreignFocus(v.getRootView());
        android.view.Choreographer.getInstance().postFrameCallback(pendingFocusFrame);
    }

    /** Focuses `v`; whether Android gave it the focus. */
    private boolean takeFocus(View v) {
        if (!v.isFocusable()) v.setFocusable(true);
        if (!v.isFocusableInTouchMode()) v.setFocusableInTouchMode(true);
        return v.requestFocus();
    }

    /** Focuses the view a pending request waits for once it is shown; gives the request up after its bound. */
    private void retryFocus() {
        int id = pendingFocus.id();
        View v = views.get(id);
        // A field waits on its own (`InputBox.focus`).
        if (id == 0 || v instanceof InputBox) return;
        switch (pendingFocus.retry(v != null && v.isShown(), android.os.SystemClock.uptimeMillis())) {
            case PendingFocus.FOCUS: {
                android.view.Choreographer.getInstance().removeFrameCallback(pendingFocusFrame);
                View before = pendingForeign;
                pendingForeign = null;
                View foreign = foreignFocus(v.getRootView());
                if (foreign != null && foreign != before) {
                    // Hosted native content, a web view or the embedding
                    // app's own view took the focus meanwhile (the user's
                    // tap or Tab), which `focusChange` does not see: the
                    // latest focus wins, as a node's would.
                    break;
                }
                // Its props may have changed while it waited.
                if (!focusStop(id)) {
                    android.util.Log.w("nsh", "focus(): view " + id
                            + " stopped being a focus stop before it was shown; the request is dropped");
                } else if (!takeFocus(v)) {
                    android.util.Log.w("nsh", "focus(): view " + id + " was shown but did not take the focus");
                }
                break;
            }
            case PendingFocus.EXPIRED:
                android.view.Choreographer.getInstance().removeFrameCallback(pendingFocusFrame);
                pendingForeign = null;
                android.util.Log.w("nsh", "focus(): view " + id + " was not shown within "
                        + PendingFocus.TIMEOUT_MS + " ms; the request is dropped");
                break;
            default:
                break;
        }
    }

    /**
     * The view holding `window`'s focus when it is not NSH's own: in
     * hosted native content (a `WidgetBox`, a web view's included, or a
     * `ComponentBox`) or one of the embedding app's views. Null when
     * nothing, the surface, a dialog's root or a node (an input's field
     * included) holds it.
     */
    private View foreignFocus(View window) {
        View f = window == null ? null : window.findFocus();
        for (View cur = f; cur != null; ) {
            if (cur == host || ModalHost.isRoot(cur)) return null;
            if (cur instanceof WidgetBox || cur instanceof ComponentBox) return f;
            if (cur instanceof Node) return null;
            ViewParent parent = cur.getParent();
            cur = parent instanceof View ? (View) parent : null;
        }
        return f;
    }

    /** Ends a pending focus request, a field's own wait included. */
    private void dropPendingFocus() {
        int id = pendingFocus.clear();
        if (id == 0) return;
        pendingForeign = null;
        View v = views.get(id);
        if (v instanceof InputBox) ((InputBox) v).cancelPendingFocus();
        else android.view.Choreographer.getInstance().removeFrameCallback(pendingFocusFrame);
    }

    /**
     * An input's `focus()` started waiting for its field (`InputBox.focus`,
     * whoever asked: `ref.focus()`, `autoFocus`): the latest request, so
     * one still waiting for another view ends.
     */
    void inputFocusWaits(InputBox input) {
        int id = input.nodeId();
        if (pendingFocus.id() == id) return;
        dropPendingFocus();
        pendingFocus.start(id, android.os.SystemClock.uptimeMillis());
    }

    /** An input's wait for its field ended, met or not (`InputBox.cancelPendingFocus`). */
    void inputFocusWaitEnded(InputBox input) {
        if (pendingFocus.id() == input.nodeId()) pendingFocus.clear();
    }

    /** `Command::Blur` of `id` (`v`): ends a pending focus of it, of a view it holds, or of any view (`Keyboard.dismiss()`). */
    private void blurPending(int id, View v) {
        int waiting = pendingFocus.id();
        if (PendingFocus.blurs(id, waiting, v != null && waiting != 0 && holds(v, views.get(waiting)))) {
            dropPendingFocus();
        }
    }

    /**
     * The node a key event belongs to: the focused managed view's id, the
     * window's `fallback` root node when nothing in it has a focus, or
     * `0` for an {@code EditText} or hosted native view, which owns its
     * keys.
     */
    int keyNode(View focus, int fallback) {
        if (focus == null || focus == host) return fallback;
        View v = focus;
        while (v != null && v != host) {
            if (v instanceof InputBox || v instanceof WidgetBox || v instanceof ComponentBox) return 0;
            if (v instanceof Node) return ((Node) v).nodeId();
            ViewParent parent = v.getParent();
            v = parent instanceof View ? (View) parent : null;
        }
        return fallback;
    }

    /** Whether the focused node is a managed control (a view that takes presses, not an input or root). */
    boolean control(int node) {
        return node > 1 && keyEnabled(node) && wants(node, Native.PRESS);
    }

    /** Whether `focus` is in hosted native content (not an input), which keeps Tab for itself. */
    private boolean hostedFocus(View focus) {
        View v = focus;
        while (v != null && v != host) {
            if (v instanceof WidgetBox || v instanceof ComponentBox) return true;
            if (v instanceof Node) return false;
            ViewParent parent = v.getParent();
            v = parent instanceof View ? (View) parent : null;
        }
        return false;
    }

    /**
     * The logical keyboard parent of `id`: a portaled view's mounted
     * `key_parent` override first (its native Insert parent is not its
     * logical one), then a screen/header's host parent, else its native
     * parent.
     */
    private int logicalParent(int id) {
        int keyParent = keyParents.get(id, -1);
        int hosted = hosts.get(id, -1);
        if (keyParent >= 0 || hosted >= 0) {
            return KeyAncestry.parent(keyParent, hosted, -1);
        }
        return KeyAncestry.parent(-1, -1, nativeParent(id));
    }

    /** The nearest mounted ancestor node, as a native Insert put it. */
    private int nativeParent(int id) {
        View v = views.get(id);
        if (v == null) return -1;
        ViewParent parent = v.getParent();
        while (parent != null) {
            if (parent instanceof View) {
                View view = (View) parent;
                if (view == host) return -1;
                if (view instanceof Node) return ((Node) view).nodeId();
            }
            parent = parent.getParent();
        }
        return -1;
    }

    /** Whether nodes `id` and `window` are in the same native window (a keyboard boundary). */
    private boolean sameWindow(int id, int window) {
        View a = views.get(id), b = views.get(window);
        return a != null && b != null && a.getRootView() == b.getRootView();
    }

    /**
     * Whether the focused node or an enabled ancestor hears raw keys
     * (`onKeyDown` / `onKeyUp`) or mounts a `captureKeys` policy: only then
     * does a key need a native {@code KeyEvent} and its capture rules. A
     * view that hears nothing takes the existing fast path.
     */
    boolean keyListens(int focused, int window) {
        int id = focused;
        while (id > 0) {
            if (keyEnabled(id)
                    && (wants(id, Native.KEY_DOWN) || wants(id, Native.KEY_UP)
                            || KeyCaptures.capturesAnything(keyCaptures.get(id)))) {
                return true;
            }
            if (id == window || id == 1) break;
            int next = logicalParent(id);
            if (next <= 0 || !sameWindow(next, window)) break;
            id = next;
        }
        return false;
    }

    /**
     * Whether a mounted {@code captureKeys} rule of the focused view or an
     * enabled ancestor captures {@code e}: the same canonical shortcut key
     * as `keymap.rs`, on the UI thread, before Android's defaults. A
     * system key ({@code KeyEvent.isSystem}: Back, Home, volume, media,
     * camera, call) is never captured, not even by {@code all}; Android
     * keeps its default. The raw notification is a separate decision and
     * still reaches the listeners ({@link #keyListens}), with
     * {@code defaultPrevented: false}.
     */
    boolean keyCaptured(int focused, int window, android.view.KeyEvent e) {
        int key = KeyCaptures.eventKey(e.getKeyCode(), e.getUnicodeChar(0));
        int modifiers = KeyCaptures.modifiers(e.getMetaState());
        boolean system = e.isSystem();
        int id = focused;
        while (id > 0) {
            if (keyEnabled(id) && KeyCaptures.captured(keyCaptures.get(id), key, modifiers, system)) {
                return true;
            }
            if (id == window || id == 1) break;
            int next = logicalParent(id);
            if (next <= 0 || !sameWindow(next, window)) break;
            id = next;
        }
        return false;
    }

    /**
     * Tab or Shift+Tab from `focus`: the next managed stop or input in
     * native tree order. The first and last stop yield ({@code false}) to
     * the embedding Android host instead of wrapping, so Android's own
     * focus search and defaults get that Tab. Hosted native content keeps
     * Tab for itself ({@code false}).
     */
    boolean moveFocus(View windowRoot, View focus, boolean forward) {
        if (hostedFocus(focus)) return false;
        java.util.ArrayList<View> stops = new java.util.ArrayList<>();
        collectFocusStops(windowRoot, stops);
        if (stops.isEmpty()) return false;
        int index = -1;
        if (focus != null && focus != host) {
            int holder = -1;
            for (int i = 0; i < stops.size(); i++) {
                if (stops.get(i) == focus) {
                    index = i;
                    break;
                }
                if (holder < 0 && holds(stops.get(i), focus)) holder = i;
            }
            if (index < 0) index = holder;
        }
        index = TabOrder.next(index, stops.size(), forward);
        if (index < 0) return false;
        return keyFocus(stops.get(index));
    }

    /**
     * An arrow key while the window's own root holds the focus
     * ({@link ArrowEntry}): the first stop in `windowRoot` that is on
     * screen in the window, or its first stop when none is; false when it
     * has none.
     */
    boolean enterFocus(View windowRoot) {
        java.util.ArrayList<View> stops = new java.util.ArrayList<>();
        collectFocusStops(windowRoot, stops);
        android.graphics.Rect window = new android.graphics.Rect();
        android.graphics.Rect rect = new android.graphics.Rect();
        boolean shown = windowRoot.getGlobalVisibleRect(window);
        int index = ArrowEntry.stop(stops.size(), i -> shown
                && stops.get(i).getGlobalVisibleRect(rect) && android.graphics.Rect.intersects(window, rect));
        return index >= 0 && keyFocus(stops.get(index));
    }

    /** Focuses the stop `moveFocus` or `enterFocus` picked, as a key does. */
    private boolean keyFocus(View next) {
        if (next instanceof InputBox) {
            ((InputBox) next).focus();
            return true;
        }
        // A Tab (or an arrow into the app) is a keyboard transition: leave
        // touch mode as a hardware key does, so a default pressable (not
        // focusable in touch mode) takes the focus from a real or a
        // synthetic key alike. The enclosing scroll view still reveals the
        // stop (ScrollView's requestChildFocus), as for any keyboard focus.
        return next.requestFocusFromTouch();
    }

    /** Collects the Tab stops under `view` in tree order. */
    private void collectFocusStops(View view, java.util.ArrayList<View> stops) {
        if (view == null || view == host || view.getVisibility() != View.VISIBLE || !view.isShown()) return;
        if (view instanceof InputBox) {
            if (keyEnabled(((InputBox) view).nodeId())) stops.add(view);
            return;
        }
        // Hosted native content owns its internal focus.
        if (view instanceof WidgetBox || view instanceof ComponentBox) return;
        if (view instanceof Node) {
            int id = ((Node) view).nodeId();
            // A split's content wrapper shares its outer box's id; only the
            // mapped view is the stop.
            if (id != 1 && views.get(id) == view && managed(view) && focusStop(id)) {
                stops.add(view);
            }
        }
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                collectFocusStops(group.getChildAt(i), stops);
            }
        }
    }

    private static boolean holds(View ancestor, View view) {
        for (View v = view; v != null; ) {
            if (v == ancestor) return true;
            ViewParent parent = v.getParent();
            v = parent instanceof View ? (View) parent : null;
        }
        return false;
    }

    /** Press callbacks claim a touch; visual feedback alone only observes it. */
    boolean handlesPress(int id) {
        return wants(id, Native.PRESS) || wants(id, Native.LONG_PRESS)
                || wants(id, Native.PRESS_IN) || wants(id, Native.PRESS_OUT);
    }

    /** Listens to taps: a press listener other than `onLongPress`, which alone leaves the taps to the views around. */
    boolean handlesTap(int id) {
        return wants(id, Native.PRESS) || wants(id, Native.PRESS_IN) || wants(id, Native.PRESS_OUT);
    }

    boolean hasPan(int id) {
        return Native.hasPan(handle(), id);
    }

    /** `panActivation`s, by view. */
    private final android.util.SparseArray<float[]> panActivations = new android.util.SparseArray<>();
    /** Scroll views an activated pan gate blocks. */
    private final java.util.ArrayList<ScrollBox> gatedScrolls = new java.util.ArrayList<>();
    private View activeGate;

    private void clearJsResponder() {
        for (ScrollBox s : blockedScrolls) s.jsBlocked = false;
        blockedScrolls.clear();
    }

    /** A native scroll view took the touches over. */
    void cancelTouches() {
        for (TouchTracker t : touchTrackers) t.cancelAll();
    }

    /** See {@link Native#touch}. */
    void touches(int phase, int[] ids, int[] targets, int[] pathLengths, int[] paths, float[] coords, double[] samples,
            boolean[] changed, long time, int activated) {
        Native.touch(handle(), phase, ids, targets, pathLengths, paths, coords, samples, changed, time, activated);
    }

    /**
     * `panActivation` of view {@code id}, or null: points (active x, y, fail x, y; NaN: none), then the way it
     * activates in (0 left, 1 right, 2 up, 3 down; -1 any) and its edge (0 left, 1 right, 2 top, 3 bottom; -1 none).
     */
    float[] panActivation(int id) {
        return panActivations.get(id);
    }

    /** The pan gate of {@code v} activated: the scroll views around it stop taking the touches. */
    void gateBlock(View v) {
        gateRelease();
        activeGate = v;
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
        activeGate = null;
        for (ScrollBox s : gatedScrolls) s.gateBlocked = false;
        gatedScrolls.clear();
    }

    /** The view whose pan gate activated for the touches down now, or null. */
    View activeGate() {
        return activeGate;
    }

    void event(int id, int kind) {
        event(id, kind, null, 0, 0, 0);
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
        if (kind == Native.LONG_PRESS) longPressed = true;
        if (kind == Native.PRESS && tapScroll != null) return;
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
    void paste(int id, String text, byte[][] images, String[] uris, String[] largeNames, String[] largeTypes,
               long[] largeLengths) {
        Native.paste(handle(), id, text, images, uris, largeNames, largeTypes, largeLengths);
    }

    /** A file drag's enter or drop for {@code id} ({@link FileDrops}); a drop's point in the surface's pixels. */
    void fileDrop(int id, int kind, String[] uris, float x, float y) {
        long handle = handle();
        if (handle == 0) return;
        Native.fileDrop(handle, id, kind, uris, x / density, y / density);
    }

    /**
     * Answers `OffscreenCanvas` render {@code request} ({@link CanvasRender}): the encoded image, or why it failed
     * ({@code failure}: {@link CanvasRender#RENDER_FAILED} or {@link CanvasRender#RENDER_TOO_LARGE}, and {@code error}).
     * Once the view is destroyed there is no app to tell.
     */
    void canvasImage(int request, byte[] bytes, int failure, String error) {
        long handle = handle();
        if (handle == 0) return;
        Native.canvasImage(handle, request, bytes, failure, error);
    }

    void eventMap(int id, int kind, String[] keys, Object[] values) {
        long handle = handle();
        if (handle == 0) return;
        Native.eventMap(handle, id, kind, keys, values);
    }

    /**
     * Sends a node's event. Loads finish on their own time (an image's {@code
     * onLoad}, a video's, a web view's): once the view is destroyed there is
     * no app to tell, and the native side takes a live handle only.
     */
    void event(int id, int kind, String text, int count, float x, float y) {
        long handle = handle();
        if (handle == 0) return;
        Native.event(handle, id, kind, text, count, x, y);
    }

    void zoom(int id, float scale) {
        long handle = handle();
        if (handle == 0) return;
        Native.zoom(handle, id, scale);
    }

    void scroll(int id, float x, float y, int applied) {
        long handle = handle();
        if (handle == 0) return;
        outputs(Native.scroll(handle, id, x, y, applied));
    }

    void inputScroll(int id, float y, float contentWidth, float contentHeight, float width, float height) {
        long handle = handle();
        if (handle == 0) return;
        Native.inputScroll(handle, id, y, contentWidth, contentHeight, width, height);
    }

    void pull(int id, float distance) {
        long handle = handle();
        if (handle == 0) return;
        outputs(Native.pull(handle, id, distance));
    }

    /**
     * Scroll view {@code id} came to rest: snapping animated values settle.
     * Its settle timer can fire after the view is destroyed; the native side
     * takes a live handle only.
     */
    void scrollEnded(int id) {
        long handle = handle();
        if (handle == 0) return;
        outputs(Native.scrollEnded(handle, id));
    }

    /**
     * The pan of {@code id} (view {@code v}) moved ({@code state}: 0 began, 1 moved, 2 ended, 3 cancelled), the
     * finger having gone down at the screen point ({@code downRawX}, {@code downRawY}) px: its origin in the view's
     * root view, as presses report theirs.
     */
    void pan(int id, int state, float tx, float ty, float vx, float vy, View v, float downRawX, float downRawY) {
        if (state == 0) for (TouchTracker t : touchTrackers) t.cancelFeedback();
        long handle = handle();
        if (handle == 0) return;
        // The surface, or the window of the modal the view is in.
        View root = v.getRootView() == host.getRootView() ? host : v.getRootView();
        int[] rootAt = new int[2];
        root.getLocationOnScreen(rootAt);
        float d = density;
        outputs(Native.pan(handle, id, state, tx, ty, vx, vy, (downRawX - rootAt[0]) / d, (downRawY - rootAt[1]) / d));
    }

    void transformGesture(int id, boolean rotation, int state, float amount, float velocity) {
        if (state == 0) for (TouchTracker t : touchTrackers) t.cancelFeedback();
        long handle = handle();
        if (handle == 0) return;
        outputs(Native.transformGesture(handle, id, rotation, state, amount, velocity));
    }
}
