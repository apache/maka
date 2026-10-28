package com.longbridge.nsh;

import android.app.Activity;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.util.TypedValue;
import android.view.Choreographer;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * A view running a nsh app. Add it anywhere in a view hierarchy, then load
 * a bundle ({@link #loadBundleFile}, {@link #loadAssetBundle}), a signed
 * package ({@link NshTrust#openPackage}, {@link #runPackage}) or, in
 * development builds, connect to a `nsh dev` server. Call {@link #destroy}
 * when done.
 */
public class NshView extends FrameLayout {
    /** Receives fatal app errors on the UI thread. */
    public interface ErrorListener {
        /**
         * Called for each fatal error.
         *
         * @param message what went wrong
         */
        void onError(String message);
    }

    /**
     * Handles the app's calls ({@code await host.call(name, data)}) and posts
     * ({@code host.post(name, data)}) of one name ({@code nsh/host}), on the
     * UI thread. Register it with {@link #handle}.
     */
    public interface HostHandler {
        /**
         * Called for each call or post.
         *
         * @param data its data: JSON as Java objects ({@code String},
         *     {@code Number}, {@code Boolean}, {@code java.util.List},
         *     {@code java.util.Map}), or null
         * @param reply answers a call, once, now or later, from any thread
         */
        void handle(Object data, NshHostReply reply);
    }

    /**
     * Takes the URLs the app opens ({@code openUrl} of {@code nsh/device}) before
     * the system does, on the UI thread. Register it with {@link #setOpenUrlHandler}.
     */
    public interface OpenUrlHandler {
        /**
         * Called for each URL the app opens, checked and granted (its
         * {@code openUrl} capability).
         *
         * @param url the URL
         * @return true when the embedding app handled it (routed it through
         *     its own router; the app's {@code openUrl} resolves true), false
         *     for the system to open it ({@code Intent.ACTION_VIEW})
         */
        boolean openUrl(String url);
    }

    /** The embedding app's URL handler, or null. */
    private volatile OpenUrlHandler openUrlHandler;

    /** The handlers of the app's calls and posts, by name. */
    private final java.util.Map<String, HostHandler> hostHandlers = new java.util.concurrent.ConcurrentHashMap<>();

    long handle;
    /** Serializes background sends with releasing the native handle. */
    private final Object hostLock = new Object();
    private final float density;
    private final Box root;
    private final Mounter mounter;
    private final TouchTracker touches;

    @Override
    public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (handle != 0) mounter.publishFocusPath();
    }

    @Override
    public boolean dispatchTouchEvent(android.view.MotionEvent e) {
        boolean tracking = touches.onTouch(e);
        // A tracked finger went down: hear the rest of the gesture even if
        // no view takes it.
        return super.dispatchTouchEvent(e) || tracking;
    }

    /**
     * A hardware keyboard's keys go to the app's shortcuts ({@code nsh/keymap}) before the focused view
     * gets them: a key a binding takes is consumed, with its release (the input never sees it).
     */
    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent e) {
        if (handle != 0) {
            int action = e.getAction();
            if (action == android.view.KeyEvent.ACTION_DOWN && keymapKey(e)) {
                return true;
            } else if (action == android.view.KeyEvent.ACTION_UP && Native.keyUp(handle, e.getKeyCode())) {
                return true;
            }
        }
        return super.dispatchKeyEvent(e);
    }

    /**
     * Keys with Control come as shortcuts first (the window's input stage offers them before the key
     * event, and a text field selects all, copies or pastes there): the app's shortcuts take them first.
     */
    @Override
    public boolean dispatchKeyShortcutEvent(android.view.KeyEvent e) {
        if (handle != 0 && e.getAction() == android.view.KeyEvent.ACTION_DOWN && keymapKey(e)) {
            return true;
        }
        return super.dispatchKeyShortcutEvent(e);
    }

    /** Whether the app's shortcuts take key press {@code e}. */
    private boolean keymapKey(android.view.KeyEvent e) {
        // An input or hosted view (a web view, a native component) has the focus: in text.
        View focus = findFocus();
        boolean editing = focus != null && focus != this;
        return Native.keyDown(handle, e.getKeyCode(), e.getUnicodeChar(0), e.getMetaState(),
                e.getRepeatCount() > 0, editing);
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private ErrorListener errorListener;
    /** Where `asset:/…` files come from: an http base, a directory, or APK assets. */
    private volatile String assetHttp;
    private volatile File assetDir;
    private volatile String assetApk;
    private TextView status;
    private View errorView;

    /**
     * Creates an empty view; load an app into it.
     *
     * @param context the activity
     */
    public NshView(Context context) {
        this(context, false);
    }

    /**
     * Creates an empty view; load an app into it.
     *
     * @param context the activity
     * @param trace log per-commit timings
     */
    public NshView(Context context, boolean trace) {
        this(context, trace, new File(context.getFilesDir(), "nsh"), new File(context.getCacheDir(), "nsh"));
    }

    /**
     * As {@link #NshView(Context, boolean)}, the apps keeping their data in {@code dataDir} and the images they
     * download in {@code cacheDir}.
     */
    NshView(Context context, boolean trace, File dataDir, File cacheDir) {
        super(context);
        density = getResources().getDisplayMetrics().density;
        TextLayouts.cacheDir = context.getCacheDir();
        mounter = new Mounter(this, new Images(this::readAsset));
        root = mounter.root;
        addView(root, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        touches = new TouchTracker(mounter, this);
        mounter.touchTrackers.add(touches);
        setClipChildren(false);
        // Holds focus when no input does (see InputBox.blur).
        setFocusable(true);
        setFocusableInTouchMode(true);
        // Not a visible focus target.
        setDefaultFocusHighlightEnabled(false);
        setDescendantFocusability(FOCUS_BEFORE_DESCENDANTS);
        // Apps scroll inputs clear of the keyboard themselves: when the app
        // sets no soft input mode, this makes the system resize (and report
        // the keyboard as insets) instead of panning the window.
        setScrollContainer(true);
        // The keyboard's curve and duration, as it starts to move: what makes
        // room for it moves with it (`LayoutCurve::Keyboard`).
        if (Build.VERSION.SDK_INT >= 30) {
            setWindowInsetsAnimationCallback(new WindowInsetsAnimation.Callback(
                    WindowInsetsAnimation.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                @Override
                public void onPrepare(WindowInsetsAnimation animation) {
                    // Before the end state's insets are applied.
                    if ((animation.getTypeMask() & WindowInsets.Type.ime()) == 0) return;
                    keyboardDuration = animation.getDurationMillis();
                    mounter.keyboardMotion(animation.getInterpolator(), keyboardDuration);
                }

                @Override
                public WindowInsets onProgress(WindowInsets insets, java.util.List<WindowInsetsAnimation> running) {
                    return insets;
                }
            });
        }
        // The back key where the window has no OnBackInvokedCallback in
        // effect (below Android 13, or `enableOnBackInvokedCallback` off).
        addOnUnhandledKeyEventListener((v, e) -> onBackKey(e));
        // Apps keep their data in <dataDir>/<app id>: nsh in the files
        // directory unless the development host's test session says.
        // ... and the images they download in <cacheDir>/<app id>/images: nsh
        // in the cache directory.
        handle = Native.create(this, density, trace, dataDir.getPath(), cacheDir.getPath());
    }

    /**
     * Receives fatal app errors (load failures, uncaught JS exceptions) on the
     * UI thread. They are always logged.
     *
     * @param listener the listener, or null for none
     */
    public void setErrorListener(ErrorListener listener) {
        errorListener = listener;
    }

    /**
     * What the apps this view loads are granted at most, as JSON in the
     * form of {@code nsh.json}'s {@code capabilities} ({@code null}: what
     * each app declares). Applies from the next load.
     *
     * @param capabilities the grant, or null
     * @return false (and ignored) when the grant is invalid
     */
    public boolean setGrantedCapabilities(String capabilities) {
        return Native.setGranted(handle, capabilities);
    }

    /**
     * The VM limits of the apps this view loads next: heap (MB), stack (KB),
     * the time budget of loading and of every other call into JS (ms), and
     * the node quota. 0 keeps a default.
     *
     * @param memoryMb JS heap, in MB
     * @param stackKb interpreter stack, in KB
     * @param loadMs time to evaluate the bundle, in ms
     * @param callMs time of any other call into JS, in ms
     * @param maxNodes nodes the app may keep
     */
    public void setLimits(int memoryMb, int stackKb, int loadMs, int callMs, int maxNodes) {
        Native.setLimits(handle, memoryMb, stackKb, loadMs, callMs, maxNodes);
    }

    /** Runs the apps loaded from now on as apps on their own, without limits (nsh's own activities). */
    void useStandaloneLimits() {
        Native.setStandaloneLimits(handle);
    }

    /**
     * The directory the storage ({@code nsh/storage}) of the apps this view
     * loads from now on is kept in ({@code storage.json} in it). {@code null}
     * (the default): each app's own, {@code nsh/<app id>} in the Context's
     * files directory (the id of {@code nsh.json}, {@code nsh/default}
     * without one).
     *
     * @param dir the directory, or null
     */
    public void setStorageDirectory(File dir) {
        Native.setStorage(handle, dir == null ? null : dir.getPath());
    }

    /**
     * Where the apps this view loads from now on keep their caches (the
     * images they download, so they show again without a download and
     * offline) and how much each keeps. The default
     * ({@code NshCacheOptions.DEFAULT}): {@code nsh} in the Context's cache
     * directory, each app in {@code <dir>/<app id>}, 256 MiB of images.
     *
     * @param options the options
     */
    public void setCacheOptions(NshCacheOptions options) {
        Native.setCache(handle, options.location, options.directory == null ? null : options.directory.getPath(),
                options.images, options.imagesMaxMegabytes);
    }

    /**
     * Overrides the app's theme with the host's: a theme file of shadcn/ui's
     * ({@code { "cssVars": { "theme": {…}, "light": {…}, "dark": {…} } }},
     * values as CSS writes them, the format of {@code nsh.json}'s
     * {@code "theme"}). Its tokens win over the app's of the same names, in
     * light and dark mode; the app's others stay, so a branded host sets only
     * what its brand changes ({@code primary}, {@code radius}, ...). Call it
     * before or after loading: it applies at once (classes such as
     * {@code bg-primary} are resolved again) and to every app loaded later,
     * from its first frame. Main thread.
     *
     * @param json the theme file, or null to give the app its own theme back
     * @throws IllegalArgumentException when the file does not parse; the
     *     overrides then stay as they were
     */
    public void setThemeOverrides(String json) {
        String error = Native.setThemeOverrides(handle, json);
        if (error != null) {
            throw new IllegalArgumentException(error);
        }
    }

    /** The contents of {@code file}, or null when it does not exist. */
    private static String readText(File file) throws java.io.IOException {
        return file.exists() ? new String(Net.readAll(new FileInputStream(file)), StandardCharsets.UTF_8) : null;
    }

    /** The contents of asset {@code path}, or null when the APK has none. */
    private String readAssetText(String path) {
        try {
            return new String(Net.readAll(getContext().getAssets().open(path)), StandardCharsets.UTF_8);
        } catch (java.io.IOException none) {
            return null;
        }
    }

    /**
     * The host app's locale, standing in for the user's: what {@code Intl}
     * formats for by default and what {@code locale()} ({@code nsh/device})
     * reads, at once and for every app loaded later.
     *
     * @param locale the locale, or null to follow the system's again
     */
    public void setLocale(java.util.Locale locale) {
        hostLocale = locale;
        publishEnvironment(getRootWindowInsets());
    }

    /**
     * The host app's text size relative to the default (1), standing in for
     * the system's font size: texts and inputs are laid out again at it and
     * {@code fontScale()} reads it, at once and for every app loaded later;
     * lengths stay as they are.
     *
     * @param scale the text size, or 0 to follow the system's again
     */
    public void setFontScale(float scale) {
        hostFontScale = scale;
        publishEnvironment(getRootWindowInsets());
    }

    /**
     * Runs a JS bundle written by `nsh build` (`bundle.js`); assets come from
     * `assets/` next to it. Bytecode only loads from the APK's own assets
     * ({@link #loadAssetBundle}) or a signed package ({@link #runPackage}):
     * files can be replaced, and QuickJS does not validate bytecode.
     *
     * @param file the bundle
     * @return false (reported to the error listener) if it cannot be read
     */
    public boolean loadBundleFile(File file) {
        if (file.getName().endsWith(".nshc")) {
            reportError("bytecode only loads from the APK's assets or a signed package (.nshpkg); load bundle.js");
            return false;
        }
        try {
            byte[] code = Net.readAll(new FileInputStream(file));
            String map = null;
            File mapFile = new File(file.getParentFile(), "bundle.js.map");
            if (mapFile.exists()) map = new String(Net.readAll(new FileInputStream(mapFile)), StandardCharsets.UTF_8);
            String capabilities = readText(new File(file.getParentFile(), "capabilities.json"));
            String app = readText(new File(file.getParentFile(), "app.json"));
            assetHttp = null;
            assetApk = null;
            assetDir = new File(file.getParentFile(), "assets");
            Native.load(handle, code, false, map, capabilities, app);
            return true;
        } catch (Exception e) {
            reportError("cannot read bundle " + file + ": " + e);
            return false;
        }
    }

    /**
     * Runs {@code dir/bundle.nshc} from the APK's assets; app assets come
     * from {@code dir/assets/}.
     *
     * @param dir the directory in the APK's assets
     * @return false (reported to the error listener) if it cannot be read
     */
    public boolean loadAssetBundle(String dir) {
        try {
            byte[] code = Net.readAll(getContext().getAssets().open(dir + "/bundle.nshc"));
            // Null when the app declares no capabilities / has no id.
            String capabilities = readAssetText(dir + "/capabilities.json");
            String app = readAssetText(dir + "/app.json");
            assetHttp = null;
            assetDir = null;
            assetApk = dir + "/assets/";
            Native.load(handle, code, true, null, capabilities, app);
            return true;
        } catch (Exception e) {
            reportError("cannot read the app bundle: " + e);
            return false;
        }
    }

    /**
     * Runs the Rust app compiled into {@code libnsh.so} (an app built with
     * {@code nsh package --rust}); its assets come from {@code dir/assets/}
     * in the APK.
     *
     * @param dir the directory in the APK's assets
     */
    public void runRustApp(String dir) {
        assetHttp = null;
        assetDir = null;
        assetApk = dir + "/assets/";
        Native.runRust(handle);
    }

    /**
     * Runs a verified package ({@link NshTrust#openPackage}), replacing the
     * running app. Takes the package: it cannot run again.
     *
     * @param pkg the package
     */
    public void runPackage(NshPackage pkg) {
        long taken = pkg.take();
        Native.runPackage(handle, taken);
    }

    /** Called by {@code Native.runPackage} before the package starts. */
    void usePackageAssets(String dir) {
        assetHttp = null;
        assetApk = null;
        assetDir = new File(dir);
    }

    /**
     * Registers native component {@code name} ({@code nativeComponent(name, ...)}
     * in JS): {@code factory} makes one for every element created from now on.
     *
     * Names under {@code nsh/} are NSH's own: registering one logs a warning
     * and changes nothing.
     *
     * @param name the name JS uses
     * @param factory makes the components (UI thread)
     */
    public void registerComponent(String name, NshComponent.Factory factory) {
        if (name.startsWith("nsh/")) {
            android.util.Log.w("nsh", "native component `" + name + "` is not registered: names under `nsh/` are NSH's");
            return;
        }
        mounter.components.put(name, factory);
    }

    /**
     * The launch parameters of the apps loaded from now on: what the app
     * reads synchronously at start as {@code host.params} ({@code nsh/host}),
     * such as the conversation a notification opens. A running app keeps the
     * parameters it started with; later requests are events ({@link #send}).
     *
     * @param params JSON as Java objects (a {@code java.util.Map} or an
     *     {@code org.json.JSONObject}), or null for none
     * @return false (and ignored) when they are not a JSON object
     */
    public boolean setParams(Object params) {
        if (handle == 0) return false;
        return Native.setHostParams(handle, params == null ? null : Json.stringify(params));
    }

    /**
     * Sends event {@code name} with {@code data} to the running app: its
     * {@code host.on(name, listener)} listeners get it ({@code nsh/host}). An
     * app that does not listen to {@code name} yet keeps the event until it
     * does; while no app runs, it waits for the next one loaded. Any thread;
     * it never waits for the app.
     *
     * @param name the event
     * @param data JSON as Java objects (see {@link HostHandler#handle}), or null
     * @return false when the view was destroyed, or the name or data is invalid
     */
    public boolean send(String name, Object data) {
        if (name == null) return false;
        // Serialization may call the host's own code. Finish it before
        // taking the lock and reading the view's current handle.
        String json = data == null ? null : Json.stringify(data);
        synchronized (hostLock) {
            return handle != 0 && Native.sendHostEvent(handle, name, json);
        }
    }

    /**
     * Handles the app's calls ({@code await host.call(name, data)}) and posts
     * ({@code host.post(name, data)}) of {@code name} on the UI thread,
     * replacing the handler it had; null removes it. The app's calls of a
     * name without a handler fail at once.
     *
     * @param name the call's name
     * @param handler the handler, or null
     */
    public void handle(String name, HostHandler handler) {
        if (handle == 0 || name == null) return;
        if (handler == null) hostHandlers.remove(name);
        else hostHandlers.put(name, handler);
        Native.setHostHandler(handle, name, handler != null);
    }

    /**
     * Takes the URLs the app opens ({@code openUrl} of {@code nsh/device}, a
     * {@code TextView}'s links when it opens them) before the system does,
     * replacing the handler it had; null (the default): the system opens
     * every URL.
     *
     * @param handler the handler, or null
     */
    public void setOpenUrlHandler(OpenUrlHandler handler) {
        if (handle == 0) return;
        openUrlHandler = handler;
        Native.setOpenUrlHandler(handle, handler != null);
    }

    /** A URL the app opens ({@code request}, answered once); called by libnsh on the engine thread. */
    void openUrlMessage(String url, long request) {
        main.post(() -> {
            OpenUrlHandler handler = openUrlHandler;
            boolean handled = false;
            try {
                handled = handler != null && handler.openUrl(url);
            } finally {
                Native.openUrlReply(request, handled);
            }
        });
    }

    /** A call ({@code call} != 0) or post of the app; called by libnsh on the engine thread. */
    void hostMessage(String name, String json, long call) {
        main.post(() -> {
            HostHandler handler = hostHandlers.get(name);
            NshHostReply reply = new NshHostReply(call);
            if (handler == null) {
                reply.reject("the embedding app handles no \"" + name + "\"");
                return;
            }
            handler.handle(Json.parse(json), reply);
        });
    }

    /**
     * Development: loads from a `nsh dev` server and reloads on every change.
     *
     * @param url the server, {@code ws://host:port/ws}
     * @return false without development support (the release AAR)
     */
    public boolean connectDevServer(String url) {
        // ws://host:port/ws -> assets at http://host:port/assets/
        if (url.startsWith("ws://")) {
            String rest = url.substring(5);
            int slash = rest.indexOf('/');
            assetHttp = "http://" + (slash >= 0 ? rest.substring(0, slash) : rest) + "/assets/";
        }
        assetDir = null;
        assetApk = null;
        return Native.connectDevServer(handle, url);
    }

    /**
     * Stops the app and calls {@link NshComponent#destroy} on each of its
     * native components. The view can no longer be used.
     */
    public void destroy() {
        long taken;
        synchronized (hostLock) {
            taken = handle;
            handle = 0;
        }
        // A send already in JNI finished before the handle was taken.
        // Joining the engine needs no Java lock.
        if (taken != 0) Native.destroy(taken);
        mounter.destroyComponents();
    }

    /**
     * Called by the native side when the running app stopped because another
     * one replaced it ({@code Host::load}). Batches the old app sent before
     * are already queued, so its components go after them and before the
     * new app's first batch.
     */
    void appStopped() {
        main.post(mounter::destroyComponents);
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        // The environment follows in onLayout.
        if (handle != 0 && w > 0 && h > 0) Native.resize(handle, w / density, h / density);
    }

    // --- Environment ---------------------------------------------------------

    private float keyboard;
    /** How long the keyboard's last move took (ms; `keyboardFrame().duration`). */
    private long keyboardDuration = 250;
    /** The host app's locale and text size ({@link #setLocale}, {@link #setFontScale}). */
    private java.util.Locale hostLocale;
    private float hostFontScale;

    @Override
    public WindowInsets onApplyWindowInsets(WindowInsets insets) {
        publishEnvironment(insets);
        return super.onApplyWindowInsets(insets);
    }

    @Override
    protected void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        publishEnvironment(getRootWindowInsets());
    }

    private static Window windowOf(Context context) {
        while (context instanceof ContextWrapper) {
            if (context instanceof Activity) return ((Activity) context).getWindow();
            context = ((ContextWrapper) context).getBaseContext();
        }
        return null;
    }

    /** Whether the app asked the system to pan the window over the keyboard. */
    private boolean systemPans() {
        Window window = windowOf(getContext());
        return window != null
            && (window.getAttributes().softInputMode & WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST) == WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN;
    }

    @Override
    protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        super.onLayout(changed, left, top, right, bottom);
        // Insets depend on where the view sits in the window.
        if (changed) publishEnvironment(getRootWindowInsets());
    }

    /**
     * Publishes the safe area and keyboard as the parts of the system bars
     * and the keyboard that overlap this view, like UIKit's safe area: an
     * app embedded below a toolbar gets no top inset.
     */
    private void publishEnvironment(WindowInsets insets) {
        if (handle == 0) return;
        float top = 0, right = 0, bottom = 0, left = 0, ime = 0;
        if (insets != null) {
            int barsTop, barsRight, barsBottom, barsLeft, keyboardBottom = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                barsTop = bars.top;
                barsRight = bars.right;
                barsBottom = bars.bottom;
                barsLeft = bars.left;
                keyboardBottom = insets.getInsets(WindowInsets.Type.ime()).bottom;
            } else {
                barsTop = insets.getSystemWindowInsetTop();
                barsRight = insets.getSystemWindowInsetRight();
                barsBottom = insets.getSystemWindowInsetBottom();
                barsLeft = insets.getSystemWindowInsetLeft();
            }
            View window = getRootView();
            int[] at = new int[2];
            getLocationInWindow(at);
            int gapLeft = at[0], gapTop = at[1];
            int gapRight = window.getWidth() - at[0] - getWidth();
            int gapBottom = window.getHeight() - at[1] - getHeight();
            top = Math.max(0, barsTop - gapTop);
            right = Math.max(0, barsRight - gapRight);
            bottom = Math.max(0, barsBottom - gapBottom);
            left = Math.max(0, barsLeft - gapLeft);
            // How far the keyboard reaches into the view (like UIKit: the
            // bottom safe area under it included).
            ime = Math.min(getHeight(), Math.max(0, keyboardBottom - gapBottom));
        }
        if (ime != keyboard) {
            keyboard = ime;
            // Nothing to do when the system pans the window instead.
            int[] at = new int[2];
            getLocationOnScreen(at);
            mounter.keyboard(ime > 0 && !systemPans()
                    ? at[1] + getHeight() - Math.round(ime) : Integer.MAX_VALUE);
        }
        Configuration c = getResources().getConfiguration();
        boolean dark = (c.uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        safe = new float[] {top / density, right / density, bottom / density, left / density};
        java.util.Locale locale = hostLocale != null ? hostLocale : java.util.Locale.getDefault();
        float fontScale = hostFontScale > 0 && !Float.isInfinite(hostFontScale) ? hostFontScale : c.fontScale;
        Native.environment(handle, new float[] {
            top / density, right / density, bottom / density, left / density, ime / density, (float) keyboardDuration, fontScale,
            android.text.TextUtils.getLayoutDirectionFromLocale(java.util.Locale.getDefault()) == LAYOUT_DIRECTION_RTL ? 1 : 0,
            // "Remove animations" sets the animator scale to 0.
            android.provider.Settings.Global.getFloat(getContext().getContentResolver(),
                    android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0 ? 1 : 0,
            density,
            accessibility().isTouchExplorationEnabled() ? 1 : 0,
            Build.VERSION.SDK_INT,
            (c.uiMode & Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_TELEVISION ? 3
                    : c.smallestScreenWidthDp >= 600 ? 1 : 0,
        }, dark, locale.toLanguageTag());
    }

    private android.view.accessibility.AccessibilityManager accessibility() {
        return (android.view.accessibility.AccessibilityManager) getContext().getSystemService(Context.ACCESSIBILITY_SERVICE);
    }

    /** TalkBack turning on or off: `screenReaderEnabled()`. */
    private final android.view.accessibility.AccessibilityManager.TouchExplorationStateChangeListener screenReader =
            enabled -> publishEnvironment(getRootWindowInsets());

    /** The safe-area insets last published (dp: top, right, bottom, left). */
    private float[] safe = new float[4];

    float safeTop() {
        return safe[0];
    }

    float safeRight() {
        return safe[1];
    }

    float safeBottom() {
        return safe[2];
    }

    float safeLeft() {
        return safe[3];
    }

    // --- Back button -------------------------------------------------------------

    private Object backCallback;
    private boolean backRegistered;
    private boolean exiting;

    /** The mounter, for the test agent ({@link TestAgent}). */
    Mounter mounter() {
        return mounter;
    }

    /**
     * Handles the back button for the app: closes modals, pops screens, runs
     * JS `BackHandler` listeners. The view gets the button by itself: through
     * an {@code OnBackInvokedCallback} it registers while the app wants back
     * presses where the window dispatches back that way (Android 13+ with
     * {@code android:enableOnBackInvokedCallback="true"}), else as the back
     * key, which it takes before the activity's {@code onBackPressed} (and
     * so before AndroidX's {@code OnBackPressedDispatcher}). Hosts that see
     * the press first in another way may forward it here, falling back to
     * their own handling when it returns false.
     *
     * @return whether the app handled the press
     */
    public boolean handleBack() {
        if (exiting || handle == 0) return false;
        return mounter.handleBack();
    }

    /** The back key's press went to the app (its release does too). */
    private boolean backKeyDown;

    /**
     * The back key, as the window dispatches it without an
     * {@code OnBackInvokedCallback} in effect: no view on the focus path took
     * it, and the activity is next ({@code onBackPressed}). The app takes it
     * while it wants back presses; with the callback in effect the window
     * never sends the key, so a press is never handled twice.
     */
    private boolean onBackKey(android.view.KeyEvent e) {
        if (e.getKeyCode() != android.view.KeyEvent.KEYCODE_BACK) return false;
        if (e.getAction() == android.view.KeyEvent.ACTION_DOWN) {
            if (e.getRepeatCount() == 0) {
                backKeyDown = !exiting && handle != 0 && isShown() && mounter.wantsBack();
            }
            return backKeyDown;
        }
        if (e.getAction() != android.view.KeyEvent.ACTION_UP || !backKeyDown) return false;
        backKeyDown = false;
        if (!e.isCanceled()) handleBack();
        return true;
    }

    /** Whether the app wants back presses (registers the callback). */
    void setBackHandling(boolean wanted) {
        if (Build.VERSION.SDK_INT < 33) return;
        android.window.OnBackInvokedDispatcher dispatcher = findOnBackInvokedDispatcher();
        if (dispatcher == null) return;
        if (backCallback == null) backCallback = BackCallbacks.create(this, mounter);
        android.window.OnBackInvokedCallback callback = (android.window.OnBackInvokedCallback) backCallback;
        if (wanted && !backRegistered) {
            dispatcher.registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback);
            backRegistered = true;
        } else if (!wanted && backRegistered) {
            dispatcher.unregisterOnBackInvokedCallback(callback);
            backRegistered = false;
        }
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        accessibility().addTouchExplorationStateChangeListener(screenReader);
        // The dispatcher exists once attached.
        if (handle != 0) mounter.updateBack();
    }

    @Override
    protected void onDetachedFromWindow() {
        super.onDetachedFromWindow();
        accessibility().removeTouchExplorationStateChangeListener(screenReader);
    }

    /** `BackHandler.exitApp()`: what the back button does without the app. */
    void exitApp() {
        android.app.Activity activity = activity(getContext());
        if (activity == null) return;
        exiting = true;
        if (Build.VERSION.SDK_INT >= 33) setBackHandling(false);
        activity.onBackPressed();
        exiting = false;
        if (handle != 0) mounter.updateBack();
    }

    private static android.app.Activity activity(Context context) {
        while (context instanceof android.content.ContextWrapper) {
            if (context instanceof android.app.Activity) return (android.app.Activity) context;
            context = ((android.content.ContextWrapper) context).getBaseContext();
        }
        return null;
    }

    // --- Animation frames ------------------------------------------------------

    private boolean ticking;
    private final Choreographer.FrameCallback frame = this::onFrame;

    private void onFrame(long nanos) {
        ticking = false;
        if (handle != 0) mounter.outputs(Native.tick(handle, nanos));
    }

    /** Keeps frames coming while animated values animate. */
    void requestFrames() {
        if (!ticking) {
            ticking = true;
            Choreographer.getInstance().postFrameCallback(frame);
        }
    }

    // --- Called by libnsh (any thread) ----------------------------------------------

    private final Choreographer.FrameCallback jsFrame = nanos -> {
        if (handle != 0) Native.frame(handle);
    };

    /** JS waits for a display frame (`requestAnimationFrame`). */
    void requestJsFrame() {
        main.post(() -> Choreographer.getInstance().postFrameCallback(jsFrame));
    }

    void submit(byte[] ops, Object[] objects, long seq) {
        main.post(() -> {
            if (handle != 0) mounter.apply(ops, objects, seq);
        });
    }

    void reportError(String message) {
        android.util.Log.e("nsh", message);
        main.post(() -> {
            if (errorListener != null) errorListener.onError(message);
        });
    }

    /** Bytes of an `asset:/…` URI, or null. Blocking: engine and image threads. */
    byte[] readAsset(String uri) {
        String path = uri.startsWith("asset:/") ? uri.substring(7) : uri;
        try {
            String http = assetHttp;
            File dir = assetDir;
            String apk = assetApk;
            if (http != null) {
                HttpURLConnection c = (HttpURLConnection) new URL(http + path).openConnection();
                try {
                    return Net.readAll(c.getInputStream());
                } finally {
                    c.disconnect();
                }
            }
            if (dir != null) {
                try (InputStream in = new FileInputStream(new File(dir, path))) {
                    return Net.readAll(in);
                }
            }
            if (apk != null) return Net.readAll(getContext().getAssets().open(apk + path));
        } catch (Exception e) {
            android.util.Log.w("nsh", "cannot read " + uri + ": " + e);
        }
        return null;
    }

    /**
     * Points a media player at a URL or an {@code asset:/…} URI (streamed from
     * the dev server, read from the asset directory or from the APK).
     */
    void setMediaSource(android.media.MediaPlayer player, String uri) throws java.io.IOException {
        if (!uri.startsWith("asset:/")) {
            player.setDataSource(getContext(), android.net.Uri.parse(uri));
            return;
        }
        String path = uri.substring(7);
        String http = assetHttp;
        File dir = assetDir;
        String apk = assetApk;
        if (http != null) {
            player.setDataSource(getContext(), android.net.Uri.parse(http + path));
        } else if (dir != null) {
            player.setDataSource(new File(dir, path).getPath());
        } else if (apk != null) {
            try (android.content.res.AssetFileDescriptor fd = getContext().getAssets().openFd(apk + path)) {
                player.setDataSource(fd);
            } catch (java.io.FileNotFoundException compressed) {
                // Compressed in the APK: players need a seekable file.
                File copy = new File(getContext().getCacheDir(), "nsh-media/" + path);
                if (!copy.exists()) {
                    copy.getParentFile().mkdirs();
                    File tmp = new File(copy.getPath() + ".tmp");
                    try (InputStream in = getContext().getAssets().open(apk + path);
                            java.io.OutputStream out = new java.io.FileOutputStream(tmp)) {
                        byte[] buf = new byte[64 * 1024];
                        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                    }
                    tmp.renameTo(copy);
                }
                player.setDataSource(copy.getPath());
            }
        }
    }

    /** How far the system bars reach into this view from the top (0 when embedded below them). */
    private int topInset() {
        WindowInsets insets = getRootWindowInsets();
        if (insets == null) return 0;
        int[] at = new int[2];
        getLocationInWindow(at);
        return Math.max(0, insets.getSystemWindowInsetTop() - at[1]);
    }

    /** Development: a status line over the app, or none. */
    void devStatus(String text) {
        main.post(() -> {
            if (text == null) {
                if (status != null) removeView(status);
                status = null;
                return;
            }
            if (status == null) {
                status = new TextView(getContext());
                status.setTextColor(Color.WHITE);
                status.setBackgroundColor(0xd91a1a1a);
                status.setGravity(Gravity.CENTER);
                status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
                LayoutParams lp = new LayoutParams(LayoutParams.MATCH_PARENT, Math.round(32 * density));
                lp.gravity = Gravity.TOP;
                status.setTranslationY(topInset());
                addView(status, lp);
            }
            status.setText(text);
            status.bringToFront();
        });
    }

    /** Development: the error screen (tap to dismiss; its Copy button copies the error), or
     * none. With {@code prose} the message wraps to the screen; otherwise its lines are kept
     * (code frames, stack traces) and it scrolls sideways. */
    void devError(String title, String message, boolean prose) {
        main.post(() -> {
            if (errorView != null) removeView(errorView);
            errorView = null;
            if (title == null) return;
            TextView text = new TextView(getContext());
            text.setTextColor(Color.WHITE);
            text.setTypeface(Typeface.MONOSPACE);
            text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
            // The title alone says it is an error, in a soft red.
            SpannableString all = new SpannableString(title + "\n\n" + message + "\n\n(tap to dismiss)");
            all.setSpan(new ForegroundColorSpan(0xffff6b6b), 0, title.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            text.setText(all);
            int pad = Math.round(16 * density);
            text.setPadding(pad, topInset() + pad, pad, pad);
            ScrollView scroll = new ScrollView(getContext());
            if (prose) {
                scroll.addView(text);
            } else {
                HorizontalScrollView sideways = new HorizontalScrollView(getContext());
                sideways.addView(text);
                scroll.addView(sideways);
            }
            TextView copy = new TextView(getContext());
            copy.setText("Copy");
            copy.setTextColor(Color.WHITE);
            copy.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
            copy.setTypeface(Typeface.DEFAULT_BOLD);
            copy.setGravity(Gravity.CENTER);
            GradientDrawable pill = new GradientDrawable();
            pill.setColor(0x2effffff);
            pill.setCornerRadius(6 * density);
            copy.setBackground(pill);
            String error = title + "\n\n" + message;
            copy.setOnClickListener(v -> {
                SystemUi.setClipboard(getContext(), error);
                copy.setText("Copied");
            });
            LayoutParams at = new LayoutParams(Math.round(76 * density), Math.round(30 * density));
            at.gravity = Gravity.TOP | Gravity.END;
            at.topMargin = topInset() + Math.round(12 * density);
            at.rightMargin = pad;
            FrameLayout view = new FrameLayout(getContext());
            view.setBackgroundColor(0xfa1e1f22);
            view.addView(scroll, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
            view.addView(copy, at);
            // Clear of the status and navigation bars, also when the screen shows
            // before the window has its insets.
            view.setOnApplyWindowInsetsListener((v, insets) -> {
                int[] where = new int[2];
                getLocationInWindow(where);
                int top = Math.max(0, insets.getSystemWindowInsetTop() - where[1]);
                text.setPadding(pad, top + pad, pad, insets.getSystemWindowInsetBottom() + pad);
                at.topMargin = top + Math.round(12 * density);
                copy.setLayoutParams(at);
                return insets;
            });
            scroll.setOnClickListener(v -> devError(null, null, false));
            text.setOnClickListener(v -> devError(null, null, false));
            errorView = view;
            addView(view, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
            view.requestApplyInsets();
        });
    }
}
