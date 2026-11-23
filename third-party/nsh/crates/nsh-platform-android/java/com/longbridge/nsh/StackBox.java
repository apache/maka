package com.longbridge.nsh;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.Toolbar;
import java.util.ArrayList;
import java.util.List;

/**
 * `<stack>`: screens stacked natively, with a toolbar header per screen,
 * push / pop transitions and the back button (predictive back on
 * Android 14). The core lays every screen out at the stack's size, below
 * its header.
 */
@SuppressLint("ViewConstructor")
final class StackBox extends FrameLayout implements Node {
    final Mounter mounter;
    final int id;
    final Decor decor = new Decor();

    // `clipPath`: what it draws shows, and touches reach it and its
    // children, only inside it (`Decor.drawClipped`, `Decor.clipsOut`).
    @Override
    public void draw(android.graphics.Canvas canvas) {
        decor.drawClipped(canvas, this, () -> super.draw(canvas));
    }

    @Override
    public boolean dispatchTouchEvent(android.view.MotionEvent e) {
        if (e.getActionMasked() == android.view.MotionEvent.ACTION_DOWN && decor.clipsOut(this, e.getX(), e.getY())) {
            return false;
        }
        return super.dispatchTouchEvent(e);
    }

    /** An outer box shadow draws outside the bounds, and compositing the
     * view at alpha < 1 into the bounds-clipped offscreen buffer would cut
     * it; such a view reports no overlapping rendering, so the alpha
     * applies per draw op and the shadow fades with the content. */
    @Override
    public boolean hasOverlappingRendering() {
        return !decor.hasOuterShadows();
    }

    /** The app's screens, bottom to top. */
    final List<Integer> screens = new ArrayList<>();
    /** Screens the user popped natively, until the app removes them. */
    final List<Integer> popped = new ArrayList<>();
    /** The screens currently shown, bottom to top. */
    private final List<ScreenBox> shown = new ArrayList<>();
    private Animator transition;
    /** The page transition through a shader playing, if any. */
    private NavTransition navTransition;
    /** A page change through a shader waiting for its screens' layout, and the screens it leaves. */
    private android.view.ViewTreeObserver.OnPreDrawListener navPending;
    private List<ScreenBox> navLeaving;

    StackBox(Context context, Mounter mounter, int id) {
        super(context);
        this.mounter = mounter;
        this.id = id;
        setBackground(decor);
        setClipChildren(true);
    }

    @Override
    public int nodeId() {
        return id;
    }

    int depth() {
        return shown.size();
    }

    /**
     * The screen a pop reveals stays drawn, at alpha 0, while it is
     * invisible under the top one. HWUI drops the display list of a
     * RenderNode that is no longer drawn, and recording a whole page again
     * takes the first frame of the pop tens of milliseconds. Alpha 0 draws
     * nothing; `INVISIBLE` keeps the screen out of touches, accessibility
     * and focus.
     */
    @Override
    protected void dispatchDraw(Canvas canvas) {
        super.dispatchDraw(canvas);
        if (shown.size() < 2 || !canvas.isHardwareAccelerated()) return;
        ScreenBox below = shown.get(shown.size() - 2);
        if (below.getVisibility() == INVISIBLE && below.getAlpha() == 0 && below.getParent() == this) {
            drawChild(canvas, below, getDrawingTime());
        }
    }

    ScreenBox top() {
        return shown.isEmpty() ? null : shown.get(shown.size() - 1);
    }

    /** Shows the app's screens: pushes, pops or replaces as needed. */
    void reconcile() {
        List<ScreenBox> desired = new ArrayList<>();
        for (int s : screens) {
            if (popped.contains(s)) continue;
            View v = mounter.views.get(s);
            if (v instanceof ScreenBox) desired.add((ScreenBox) v);
        }
        if (desired.equals(shown)) return;
        // A change through a shader still running ends first: its screens
        // settle (one it removed is added again below if it comes back).
        finishNav();
        ScreenBox oldTop = top();
        ScreenBox newTop = desired.isEmpty() ? null : desired.get(desired.size() - 1);
        // The page on top leaves (a pop, a replace): its keyboard hides with the transition.
        if (oldTop != null && !desired.contains(oldTop)) mounter.hideKeyboardIn(oldTop);
        for (ScreenBox s : desired) {
            if (s.getParent() != this) {
                if (s.getParent() instanceof ViewGroup) ((ViewGroup) s.getParent()).removeView(s);
                addView(s, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
            }
        }
        // Order the children like the stack (top screen drawn last).
        for (ScreenBox s : desired) s.bringToFront();
        boolean pushing = !shown.isEmpty() && desired.size() >= shown.size() && !shown.contains(newTop);
        List<ScreenBox> leaving = new ArrayList<>(shown);
        leaving.removeAll(desired);
        shown.clear();
        shown.addAll(desired);
        if (transition != null) transition.cancel();
        if (oldTop == newTop || oldTop == null || newTop == null) {
            settle(leaving);
            return;
        }
        if (shaderAnimate(pushing ? oldTop : newTop, pushing ? newTop : oldTop, pushing, leaving)) return;
        int animation = pushing ? newTop.animation : oldTop.animation;
        if (animation == 2) {
            settle(leaving);
            return;
        }
        animate(pushing ? oldTop : newTop, pushing ? newTop : oldTop, pushing, animation == 1, 0, leaving);
    }

    /**
     * `upper` comes over `lower` (`push`) or goes from it through its
     * `transitionShader`, once the screens are laid out; false where none
     * runs (no shader, before Android 10, less motion).
     */
    private boolean shaderAnimate(ScreenBox lower, ScreenBox upper, boolean push, List<ScreenBox> leaving) {
        if (!NavTransition.wanted(mounter, upper.id)) return false;
        // What showed stays until the shader's first frame covers it.
        lower.setVisibility(push ? VISIBLE : INVISIBLE);
        upper.setVisibility(push ? INVISIBLE : VISIBLE);
        for (ScreenBox s : new ScreenBox[] {lower, upper}) {
            s.setTranslationX(0);
            s.setAlpha(1);
        }
        View[] both = {lower, upper}, one = {lower};
        navLeaving = leaving;
        navPending = new android.view.ViewTreeObserver.OnPreDrawListener() {
            @Override
            public boolean onPreDraw() {
                getViewTreeObserver().removeOnPreDrawListener(this);
                if (navPending != this) return true;
                navPending = null;
                navLeaving = null;
                if (shown.isEmpty() || top() != (push ? upper : lower)) return true;
                NavTransition t = NavTransition.start(mounter, StackBox.this, id, upper.id, one, both,
                        !push, () -> {
                            lower.setVisibility(INVISIBLE);
                            upper.setVisibility(INVISIBLE);
                        }, () -> {
                            navTransition = null;
                            settle(leaving);
                        }, () -> {
                            navTransition = null;
                            ownMotion(lower, upper, push, leaving);
                        });
                // No picture, or no GPU: the page moves with its own
                // animation.
                if (t == null) ownMotion(lower, upper, push, leaving);
                else navTransition = t;
                return true;
            }
        };
        getViewTreeObserver().addOnPreDrawListener(navPending);
        invalidate();
        return true;
    }

    /** `upper` comes over `lower` (`push`) or goes from it with its own animation. */
    private void ownMotion(ScreenBox lower, ScreenBox upper, boolean push, List<ScreenBox> leaving) {
        if (upper.animation == 2) settle(leaving);
        else animate(lower, upper, push, upper.animation == 1, 0, leaving);
    }

    /**
     * Ends the page change through a shader that runs, or waits for its
     * layout to start, at once: its screens settle where it ends (the ones
     * it leaves are removed), its frames go.
     */
    private void finishNav() {
        if (navPending != null) {
            getViewTreeObserver().removeOnPreDrawListener(navPending);
            List<ScreenBox> leaving = navLeaving;
            navPending = null;
            navLeaving = null;
            settle(leaving);
        }
        NavTransition t = navTransition;
        navTransition = null;
        if (t != null) t.finish();
    }

    /**
     * Only the top screen is visible; removed screens leave. The screens
     * below are at alpha 0 for {@link #dispatchDraw}.
     */
    private void settle(List<ScreenBox> leaving) {
        for (ScreenBox s : leaving) {
            s.setLayerType(LAYER_TYPE_NONE, null);
            removeView(s);
        }
        for (int i = 0; i < shown.size(); i++) {
            ScreenBox s = shown.get(i);
            boolean top = i == shown.size() - 1;
            s.setTranslationX(0);
            s.setAlpha(top ? 1 : 0);
            s.setLayerType(LAYER_TYPE_NONE, null);
            s.setVisibility(top ? VISIBLE : INVISIBLE);
        }
        transition = null;
        mounter.updateBack();
    }

    /**
     * Moves `upper` over `lower` (push) or away from it (pop), from
     * `progress` (0..1 of the way to the popped state).
     */
    private void animate(ScreenBox lower, ScreenBox upper, boolean push, boolean fade, float progress,
                         List<ScreenBox> leaving) {
        float w = getWidth();
        lower.setVisibility(VISIBLE);
        upper.setVisibility(VISIBLE);
        lower.setAlpha(1);
        upper.setAlpha(1);
        // Each screen is drawn into a layer once, then the slide only moves
        // the layers: drawing both pages every frame (their paths, shadows
        // and text) takes the RenderThread longer than a frame.
        lower.setLayerType(LAYER_TYPE_HARDWARE, null);
        upper.setLayerType(LAYER_TYPE_HARDWARE, null);
        android.animation.ValueAnimator a = android.animation.ValueAnimator.ofFloat(push ? 1 : progress, push ? 0 : 1);
        a.setDuration(push ? 300 : Math.round(300 * (1 - progress)));
        a.setInterpolator(new DecelerateInterpolator(1.5f));
        a.addUpdateListener(x -> place(lower, upper, (float) x.getAnimatedValue(), w, fade));
        a.addListener(new AnimatorListenerAdapter() {
            private boolean cancelled;

            @Override
            public void onAnimationCancel(Animator animation) {
                cancelled = true;
            }

            @Override
            public void onAnimationEnd(Animator animation) {
                if (!cancelled) settle(leaving);
            }
        });
        place(lower, upper, push ? 1 : progress, w, fade);
        transition = a;
        a.start();
    }

    /**
     * `t` 0: `upper` covers the stack; 1: `upper` is gone. Slides move by
     * whole pixels: Skia keys the blurred masks of shadows on the subpixel
     * part of their position, so a fractional offset each frame blurs every
     * shadow the screens draw again, frame after frame.
     */
    private static void place(View lower, View upper, float t, float w, boolean fade) {
        if (fade) {
            upper.setTranslationX(0);
            lower.setTranslationX(0);
            upper.setAlpha(1 - t);
        } else {
            upper.setTranslationX(Math.round(t * w));
            lower.setTranslationX(Math.round(-(1 - t) * w * 0.25f));
        }
    }

    // --- Back -----------------------------------------------------------------

    /** Whether the back button pops a screen of this stack. */
    boolean canPop() {
        ScreenBox top = top();
        return shown.size() > 1 && top != null && !top.preventBack && showsForBack();
    }

    /** Whether the top screen keeps the user (`popOnBack` false): back only tells JS. */
    boolean preventsBack() {
        ScreenBox top = top();
        return top != null && top.preventBack && showsForBack();
    }

    /**
     * Whether going back may act on this stack: shown, and it and every
     * view of the app around it laid out with a size
     * (`nsh_core::navigation::shown_in_layout`: `display: none`, a tab not
     * selected, is laid out at no size, which `isShown` does not see). The
     * frames are the core's (`Box.Frame`), set when a batch lands: a screen
     * just added has not been measured yet, and the views the platform
     * places between (screens, a scroll view's content) have none.
     */
    private boolean showsForBack() {
        if (!isShown()) return false;
        for (ViewParent p = this; p instanceof View && !(p instanceof NshView); p = p.getParent()) {
            if (((View) p).getLayoutParams() instanceof Box.Frame) {
                Box.Frame f = (Box.Frame) ((View) p).getLayoutParams();
                if (f.right <= f.left || f.bottom <= f.top) return false;
            }
        }
        return true;
    }

    /** Whether a back gesture may drag the top screen away (`popOnSwipe`). */
    boolean canSwipe() {
        ScreenBox top = top();
        return canPop() && top.gestureEnabled;
    }

    /**
     * The back button, the toolbar's arrow or a finished back gesture: the
     * top screen hears of it (`onBackPress`) when it listens, and pops
     * unless it keeps the user (`popOnBack` false).
     */
    void back() {
        ScreenBox top = top();
        if (top == null || !showsForBack()) return;
        if (mounter.wants(top.id, Native.BACK_REQUEST)) mounter.event(top.id, Native.BACK_REQUEST);
        if (!top.preventBack) pop();
    }

    private float backProgress = -1;

    /** Predictive back: the gesture started. */
    void backStarted() {
        if (!canSwipe() || transition != null || navTransition != null || navPending != null) return;
        backProgress = 0;
        ScreenBox lower = shown.get(shown.size() - 2);
        lower.setVisibility(VISIBLE);
        lower.setAlpha(1);
        // As in `animate`: the screens follow the finger as layers.
        lower.setLayerType(LAYER_TYPE_HARDWARE, null);
        top().setLayerType(LAYER_TYPE_HARDWARE, null);
        place(lower, top(), 0, getWidth(), false);
    }

    /** Predictive back: the finger moved (`progress` 0..1). */
    void backProgressed(float progress) {
        if (backProgress < 0) return;
        backProgress = progress;
        // Follow the finger part of the way, like the system animation.
        place(shown.get(shown.size() - 2), top(), progress * 0.4f, getWidth(), false);
    }

    /** Predictive back: the gesture was abandoned. */
    void backCancelled() {
        if (backProgress < 0) return;
        backProgress = -1;
        List<ScreenBox> none = new ArrayList<>();
        ScreenBox lower = shown.get(shown.size() - 2), upper = top();
        android.animation.ValueAnimator a = android.animation.ValueAnimator.ofFloat(upper.getTranslationX() / Math.max(1, getWidth()), 0);
        a.setDuration(200);
        a.addUpdateListener(x -> place(lower, upper, (float) x.getAnimatedValue(), getWidth(), false));
        a.addListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(Animator animation) {
                settle(none);
            }
        });
        a.start();
    }

    /** The back button (or a completed back gesture): pops the top screen. */
    void pop() {
        if (!canPop()) return;
        // A change through a shader still running ends first.
        finishNav();
        ScreenBox upper = top();
        ScreenBox lower = shown.get(shown.size() - 2);
        mounter.hideKeyboardIn(upper);
        float progress = backProgress >= 0 ? upper.getTranslationX() / Math.max(1, getWidth()) : 0;
        backProgress = -1;
        shown.remove(shown.size() - 1);
        popped.add(upper.id);
        List<ScreenBox> leaving = new ArrayList<>();
        leaving.add(upper);
        if (progress == 0 && shaderAnimate(lower, upper, false, leaving)) {
            // Through its shader.
        } else if (upper.animation == 2) {
            settle(leaving);
        } else {
            animate(lower, upper, false, upper.animation == 1, progress, leaving);
        }
        mounter.event(upper.id, Native.DISMISS);
    }

    // --- Screens --------------------------------------------------------------

    /** One screen: the core's root view plus a toolbar for its header. */
    @SuppressLint("ViewConstructor")
    static final class ScreenBox extends ViewGroup implements Node {
        final int id;
        final Box root;
        final Toolbar toolbar;
        int animation;
        boolean gestureEnabled = true;
        /** `popOnBack` false: the back buttons only send `onBackPress`. */
        boolean preventBack;
        private final BackArrow arrow;
        /**
         * The title when the page has a `headerLeft` and a plain `title`: the
         * toolbar lays its own title out before the views it holds, so the
         * leading item would land after the title. This one is a view styled
         * as the toolbar's title, in {@link #leadRow} after the leading item.
         */
        private final android.widget.TextView leadTitle;
        /**
         * The leading item and {@link #leadTitle}, side by side, as one view of
         * the toolbar: the row mirrors itself in RTL and measures the item
         * before the title, which the toolbar's own views do not (it measures
         * them in order but lays them out reversed in RTL).
         */
        private final HeaderRow leadRow;
        /** The toolbar's start content inset from its theme, kept for a page without a leading item. */
        private final int themeInsetStart;
        /**
         * The title when the page centers it (`headerTitleAlign` "center"): the
         * toolbar's own title always starts at the leading edge, while a view it
         * holds with a centered gravity sits midway, between the items on either side.
         */
        private final android.widget.TextView centerTitle;
        private final Mounter mounter;
        /** The toolbar's gap above the bar (the status bar's height, in px), kept for a safe-area change. */
        private int barTop;
        /** The header's colors as configured (0: the theme's), kept for an appearance change. */
        private int tint, background, titleColor;
        private boolean transparent;

        ScreenBox(Context context, Mounter mounter, int id) {
            super(context);
            this.id = id;
            this.mounter = mounter;
            root = new Box(context, mounter, id);
            addView(root);
            toolbar = new Toolbar(context);
            arrow = new BackArrow(mounter.density);
            toolbar.setNavigationOnClickListener(v -> {
                if (getParent() instanceof StackBox) ((StackBox) getParent()).back();
            });
            addView(toolbar, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));
            leadTitle = new android.widget.TextView(context);
            // The toolbar's own title style, from the same theme (a host's toolbarStyle, the device's font).
            android.content.res.TypedArray style = context.obtainStyledAttributes(null,
                    new int[] {android.R.attr.titleTextAppearance}, android.R.attr.toolbarStyle, 0);
            int appearance = style.getResourceId(0, android.R.style.TextAppearance_Material_Widget_Toolbar_Title);
            style.recycle();
            leadTitle.setTextAppearance(appearance);
            leadTitle.setSingleLine(true);
            leadTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
            // The gap to the leading item is the title's own padding: a margin on a
            // toolbar's view left no gap on an API 35 emulator.
            leadTitle.setPaddingRelative(Math.round(16 * mounter.density), 0, 0, 0);
            leadRow = new HeaderRow(context);
            leadRow.setGravity(android.view.Gravity.CENTER_VERTICAL);
            themeInsetStart = toolbar.getContentInsetStart();
            centerTitle = new android.widget.TextView(context);
            centerTitle.setTextAppearance(appearance);
            centerTitle.setSingleLine(true);
            centerTitle.setEllipsize(android.text.TextUtils.TruncateAt.END);
            colors();
        }

        /**
         * The theme's colors in the appearance shown: the app's own
         * (`setColorScheme`) in the system's default theme of that
         * appearance, as `SystemUi`'s dialogs take, else the activity's theme.
         */
        private Context themed() {
            if (mounter.appearance == 0) return getContext();
            return new android.view.ContextThemeWrapper(getContext(), mounter.night()
                    ? android.R.style.Theme_DeviceDefault
                    : android.R.style.Theme_DeviceDefault_Light);
        }

        /** Colors the screen and its header: what the page set, else the theme's. */
        private void colors() {
            Context theme = themed();
            setBackgroundColor(themeColor(theme, android.R.attr.colorBackground, 0xffffffff));
            int primary = themeColor(theme, android.R.attr.textColorPrimary, 0xff1f2328);
            toolbar.setTitleTextColor(titleColor != 0 ? titleColor : primary);
            leadTitle.setTextColor(titleColor != 0 ? titleColor : primary);
            centerTitle.setTextColor(titleColor != 0 ? titleColor : primary);
            if (transparent) toolbar.setBackgroundColor(0);
            else toolbar.setBackgroundColor(background != 0 ? background : themeColor(theme, android.R.attr.colorBackground, 0xffffffff));
            arrow.setColor(tint != 0 ? tint : primary);
        }

        /** The app's appearance changed (`setColorScheme`): the theme's colors follow it. */
        void appearanceChanged() {
            colors();
        }

        @Override
        public int nodeId() {
            return id;
        }

        @Override
        protected void onMeasure(int widthSpec, int heightSpec) {
            int w = MeasureSpec.getSize(widthSpec), h = MeasureSpec.getSize(heightSpec);
            setMeasuredDimension(w, h);
            // The core places the root; the toolbar spans the header area.
            Box.Frame f = Box.frame(root);
            root.measure(MeasureSpec.makeMeasureSpec(f.right - f.left, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(f.bottom - f.top, MeasureSpec.EXACTLY));
            toolbar.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
                    MeasureSpec.makeMeasureSpec(toolbar.getLayoutParams().height, MeasureSpec.EXACTLY));
        }

        @Override
        protected void onLayout(boolean changed, int l, int t, int r, int b) {
            Box.Frame f = Box.frame(root);
            root.layout(f.left, f.top, f.right, f.bottom);
            toolbar.layout(0, 0, r - l, toolbar.getMeasuredHeight());
        }

        /**
         * Pads the toolbar: the gap above the bar, and at the sides the view's
         * safe area, the insets the screen reports to its page. A navigation
         * bar or display cutout at a side (a phone in landscape with
         * three-button navigation) then does not cover the up arrow, the
         * title or the items, while the toolbar's background still spans the
         * full width. Called again when the safe area changes.
         */
        void padToolbar() {
            float d = mounter.density;
            toolbar.setPadding(Math.round(mounter.host.safeLeft() * d), barTop,
                    Math.round(mounter.host.safeRight() * d), 0);
        }

        /** Applies `encode.rs` `screen_config`. */
        void configure(Mounter m, String title, boolean shown, boolean transparent, int tint, int background,
                       int titleColor, boolean backVisible, boolean gesture, boolean preventBack, int animation,
                       int left, int right, int titleView, float headerHeight, boolean centered,
                       boolean canGoBack, String backTitle) {
            this.animation = animation;
            this.gestureEnabled = gesture;
            this.preventBack = preventBack;
            float d = m.density;
            toolbar.setVisibility(shown ? VISIBLE : GONE);
            boolean titled = titleView < 0 && title != null && !title.isEmpty();
            boolean centerTitled = centered && titled;
            boolean leadTitled = !centered && titled && left >= 0 && m.views.get(left) != null;
            toolbar.setTitle(titleView >= 0 || leadTitled || centerTitled ? null : title);
            int height = Math.round(headerHeight * d);
            int bar = Math.round(56 * d);
            barTop = Math.max(0, height - bar);
            padToolbar();
            ViewGroup.LayoutParams p = toolbar.getLayoutParams();
            p.height = height;
            toolbar.setLayoutParams(p);
            this.tint = tint;
            this.background = background;
            this.titleColor = titleColor;
            this.transparent = transparent;
            colors();
            boolean up = backVisible && canGoBack;
            toolbar.setNavigationIcon(up ? arrow : null);
            toolbar.setNavigationContentDescription(up ? upDescription(backTitle) : null);
            // A leading item stands where the navigation icon would: the toolbar's
            // navigation button starts at the edge and centers its icon in it, so
            // the item starts LEADING_INSET from the edge instead of after the
            // theme's content inset (16dp), which is the gap kept for a title.
            boolean leads = !up && left >= 0 && m.views.get(left) != null;
            toolbar.setContentInsetsRelative(leads ? Math.round(LEADING_INSET * d) : themeInsetStart,
                    toolbar.getContentInsetEnd());
            // Header items: the core sized them; the toolbar places them. A `header`
            // slot (the whole bar where NSH draws it) is never placed: the toolbar is the bar.
            for (int i = toolbar.getChildCount() - 1; i >= 0; i--) {
                View child = toolbar.getChildAt(i);
                if (child instanceof Box || child == leadRow || child == centerTitle) toolbar.removeViewAt(i);
            }
            leadRow.removeAllViews();
            if (leadTitled) {
                // The toolbar measures the views it holds in order: the trailing item
                // first, so a long title is cut short rather than pushing it off.
                add(m, right, android.view.Gravity.END);
                View item = m.views.get(left);
                if (item.getParent() instanceof ViewGroup) ((ViewGroup) item.getParent()).removeView(item);
                int[] size = m.headerSizes.get(left);
                leadRow.addView(item, new android.widget.LinearLayout.LayoutParams(
                        Math.max(1, size != null ? size[0] : 1), Math.max(1, size != null ? size[1] : 1)));
                leadTitle.setText(title);
                leadRow.addView(leadTitle, new android.widget.LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                toolbar.addView(leadRow, new Toolbar.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT, android.view.Gravity.START | android.view.Gravity.CENTER_VERTICAL));
            } else {
                add(m, left, android.view.Gravity.START);
                if (!centered) add(m, titleView, android.view.Gravity.START);
                add(m, right, android.view.Gravity.END);
                // Centered, the title comes last: the toolbar measures the views it holds
                // in order, so a long plain title gets what the items on either side leave
                // and is cut short between them. A `headerTitle` view keeps the size the
                // core laid it out at.
                if (centered) add(m, titleView, android.view.Gravity.CENTER_HORIZONTAL);
                if (centerTitled) {
                    centerTitle.setText(title);
                    toolbar.addView(centerTitle, new Toolbar.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT,
                            ViewGroup.LayoutParams.WRAP_CONTENT,
                            android.view.Gravity.CENTER_HORIZONTAL | android.view.Gravity.CENTER_VERTICAL));
                }
            }
        }

        /**
         * What the up arrow reads as: the `headerBackTitle` of the screen it
         * leads back to, else the system's own words for it (the action
         * bar's, not in the public resources).
         */
        private static CharSequence upDescription(String backTitle) {
            if (backTitle != null) return backTitle;
            android.content.res.Resources system = android.content.res.Resources.getSystem();
            int up = system.getIdentifier("action_bar_up_description", "string", "android");
            return up != 0 ? system.getString(up) : null;
        }

        private void add(Mounter m, int itemId, int gravity) {
            if (itemId < 0) return;
            View item = m.views.get(itemId);
            if (item == null) return;
            if (item.getParent() instanceof ViewGroup) ((ViewGroup) item.getParent()).removeView(item);
            int[] size = m.headerSizes.get(itemId);
            int w = size != null ? size[0] : 1, h = size != null ? size[1] : 1;
            Toolbar.LayoutParams p = new Toolbar.LayoutParams(Math.max(1, w), Math.max(1, h), gravity | android.view.Gravity.CENTER_VERTICAL);
            // An end margin: in RTL the Toolbar lays END items out from the left edge.
            if (gravity == android.view.Gravity.END) p.setMarginEnd(Math.round(12 * m.density));
            toolbar.addView(item, p);
        }

        /**
         * Where a page's leading header item starts (dp): Material's top app
         * bar puts its 48dp navigation target 4dp from the edge.
         */
        private static final float LEADING_INSET = 4;

        /** The row holding a page's leading header item and its title (see {@link #leadRow}). */
        static final class HeaderRow extends android.widget.LinearLayout {
            HeaderRow(Context context) {
                super(context);
            }
        }

        private static int themeColor(Context context, int attr, int fallback) {
            TypedValue v = new TypedValue();
            if (!context.getTheme().resolveAttribute(attr, v, true)) return fallback;
            if (v.resourceId != 0) {
                try {
                    return context.getColorStateList(v.resourceId).getDefaultColor();
                } catch (Exception e) {
                    return fallback;
                }
            }
            return v.data;
        }
    }

    /** Material's "arrow back" icon, drawn from its path. */
    static final class BackArrow extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private final int size;

        BackArrow(float density) {
            size = Math.round(24 * density);
            float s = density;
            // M20,11H7.83l5.59-5.59L12,4l-8,8 8,8 1.41-1.41L7.83,13H20v-2z
            path.moveTo(20 * s, 11 * s);
            path.lineTo(7.83f * s, 11 * s);
            path.lineTo(13.42f * s, 5.41f * s);
            path.lineTo(12 * s, 4 * s);
            path.lineTo(4 * s, 12 * s);
            path.lineTo(12 * s, 20 * s);
            path.lineTo(13.41f * s, 18.59f * s);
            path.lineTo(7.83f * s, 13 * s);
            path.lineTo(20 * s, 13 * s);
            path.close();
        }

        void setColor(int color) {
            paint.setColor(color);
            invalidateSelf();
        }

        @Override
        public void draw(Canvas canvas) {
            canvas.save();
            canvas.translate(getBounds().left, getBounds().top);
            canvas.drawPath(path, paint);
            canvas.restore();
        }

        @Override
        public int getIntrinsicWidth() {
            return size;
        }

        @Override
        public int getIntrinsicHeight() {
            return size;
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
    }
}
