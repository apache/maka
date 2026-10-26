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
    /** The app's screens, bottom to top. */
    final List<Integer> screens = new ArrayList<>();
    /** Screens the user popped natively, until the app removes them. */
    final List<Integer> popped = new ArrayList<>();
    /** The screens currently shown, bottom to top. */
    private final List<ScreenBox> shown = new ArrayList<>();
    private Animator transition;

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

    ScreenBox top() {
        return shown.isEmpty() ? null : shown.get(shown.size() - 1);
    }

    /** Shows the app's screens: pushes, pops or replaces as needed. */
    void reconcile() {
        List<ScreenBox> desired = new ArrayList<>();
        for (int s : screens) {
            if (popped.contains(s)) continue;
            View v = mounter.views.get(s);
            if (v instanceof ScreenBox && !((ScreenBox) v).parked) desired.add((ScreenBox) v);
        }
        if (desired.equals(shown)) return;
        ScreenBox oldTop = top();
        ScreenBox newTop = desired.isEmpty() ? null : desired.get(desired.size() - 1);
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
        int animation = pushing ? newTop.animation : oldTop.animation;
        if (animation == 2) {
            settle(leaving);
            return;
        }
        animate(pushing ? oldTop : newTop, pushing ? newTop : oldTop, pushing, animation == 1, 0, leaving);
    }

    /** Retirement parks an SDK screen until its own projection returns. */
    void park(ScreenBox screen) {
        if (transition != null) {
            transition.removeAllListeners();
            transition.cancel();
            transition = null;
        }
        backProgress = -1;
        screen.parked = true;
        shown.remove(screen);
        removeView(screen);
        settle(new ArrayList<>());
    }

    /** Only the top screen is visible; removed screens leave. */
    private void settle(List<ScreenBox> leaving) {
        for (ScreenBox s : leaving) removeView(s);
        for (int i = 0; i < shown.size(); i++) {
            ScreenBox s = shown.get(i);
            s.setTranslationX(0);
            s.setAlpha(1);
            s.setVisibility(i == shown.size() - 1 ? VISIBLE : INVISIBLE);
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

    /** `t` 0: `upper` covers the stack; 1: `upper` is gone. */
    private static void place(View lower, View upper, float t, float w, boolean fade) {
        if (fade) {
            upper.setTranslationX(0);
            lower.setTranslationX(0);
            upper.setAlpha(1 - t);
        } else {
            upper.setTranslationX(t * w);
            lower.setTranslationX(-(1 - t) * w * 0.25f);
        }
    }

    // --- Back -----------------------------------------------------------------

    /** Whether the back button pops a screen of this stack. */
    boolean canPop() {
        ScreenBox top = top();
        return shown.size() > 1 && top != null && !top.preventBack && isShown();
    }

    /** Whether the top screen keeps the user (`popOnBack` false): back only tells JS. */
    boolean preventsBack() {
        ScreenBox top = top();
        return top != null && top.preventBack && isShown();
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
        if (top == null || !isShown()) return;
        if (mounter.wants(top.id, Native.BACK_REQUEST)) mounter.event(top.id, Native.BACK_REQUEST);
        if (!top.preventBack) pop();
    }

    private float backProgress = -1;

    /** Predictive back: the gesture started. */
    void backStarted() {
        if (!canSwipe() || transition != null) return;
        backProgress = 0;
        ScreenBox lower = shown.get(shown.size() - 2);
        lower.setVisibility(VISIBLE);
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
        ScreenBox upper = top();
        ScreenBox lower = shown.get(shown.size() - 2);
        float progress = backProgress >= 0 ? upper.getTranslationX() / Math.max(1, getWidth()) : 0;
        backProgress = -1;
        shown.remove(shown.size() - 1);
        popped.add(upper.id);
        List<ScreenBox> leaving = new ArrayList<>();
        leaving.add(upper);
        if (upper.animation == 2) {
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
        boolean parked;
        private final BackArrow arrow;

        ScreenBox(Context context, Mounter mounter, int id) {
            super(context);
            this.id = id;
            root = new Box(context, mounter, id);
            addView(root);
            toolbar = new Toolbar(context);
            arrow = new BackArrow(mounter.density);
            toolbar.setNavigationOnClickListener(v -> {
                if (getParent() instanceof StackBox) ((StackBox) getParent()).back();
            });
            addView(toolbar, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0));
            setBackgroundColor(themeColor(context, android.R.attr.colorBackground, 0xffffffff));
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

        /** Applies `encode.rs` `screen_config`. */
        void configure(Mounter m, String title, boolean shown, boolean transparent, int tint, int background,
                       int titleColor, boolean backVisible, boolean gesture, boolean preventBack, int animation,
                       int left, int right, int titleView, float headerHeight, boolean canGoBack,
                       String backTitle) {
            this.animation = animation;
            this.gestureEnabled = gesture;
            this.preventBack = preventBack;
            float d = m.density;
            toolbar.setVisibility(shown ? VISIBLE : GONE);
            toolbar.setTitle(titleView >= 0 ? null : title);
            int height = Math.round(headerHeight * d);
            int bar = Math.round(56 * d);
            toolbar.setPadding(0, Math.max(0, height - bar), 0, 0);
            ViewGroup.LayoutParams p = toolbar.getLayoutParams();
            p.height = height;
            toolbar.setLayoutParams(p);
            int foreground = tint != 0 ? tint : themeColor(getContext(), android.R.attr.textColorPrimary, 0xff1f2328);
            toolbar.setTitleTextColor(titleColor != 0 ? titleColor : themeColor(getContext(), android.R.attr.textColorPrimary, 0xff1f2328));
            if (transparent) toolbar.setBackgroundColor(0);
            else toolbar.setBackgroundColor(background != 0 ? background : themeColor(getContext(), android.R.attr.colorBackground, 0xffffffff));
            arrow.setColor(foreground);
            toolbar.setNavigationIcon(backVisible && canGoBack ? arrow : null);
            toolbar.setNavigationContentDescription(backVisible && canGoBack ? upDescription(backTitle) : null);
            // Header items: the core sized them; the toolbar places them. A `header`
            // slot (the whole bar where NSH draws it) is never placed: the toolbar is the bar.
            for (int i = toolbar.getChildCount() - 1; i >= 0; i--) {
                if (toolbar.getChildAt(i) instanceof Box) toolbar.removeViewAt(i);
            }
            add(m, left, android.view.Gravity.START);
            add(m, titleView, android.view.Gravity.START);
            add(m, right, android.view.Gravity.END);
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
            if (!m.headerMounted(itemId, id)) return;
            View item = m.views.get(itemId);
            if (item == null) return;
            if (item.getParent() instanceof ViewGroup) ((ViewGroup) item.getParent()).removeView(item);
            int[] size = m.headerSizes.get(itemId);
            int w = size != null ? size[0] : 1, h = size != null ? size[1] : 1;
            Toolbar.LayoutParams p = new Toolbar.LayoutParams(Math.max(1, w), Math.max(1, h), gravity | android.view.Gravity.CENTER_VERTICAL);
            if (gravity == android.view.Gravity.END) p.rightMargin = Math.round(12 * m.density);
            toolbar.addView(item, p);
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
