package com.longbridge.nsh;

/** JNI entry points of libnsh.so (crates/nsh-platform-android/src/host.rs). */
final class Native {
    static {
        System.loadLibrary("nsh");
    }

    private Native() {}

    // Event kinds, in `nsh_core::EventKind` order.
    static final int PRESS = 0;
    static final int LONG_PRESS = 1;
    static final int PAN_START = 2;
    static final int PAN_END = 3;
    static final int REFRESH = 4;
    static final int LOAD_MORE = 5;
    static final int SCROLL_END = 6;
    static final int LOAD = 7;
    static final int ERROR = 8;
    static final int CHANGE_TEXT = 9;
    static final int SUBMIT_EDITING = 10;
    static final int FOCUS = 11;
    static final int BLUR = 12;
    static final int PRESS_IN = 13;
    static final int PRESS_OUT = 14;
    static final int LAYOUT = 15;
    static final int PINCH_START = 16;
    static final int PINCH_END = 17;
    static final int ROTATION_START = 18;
    static final int ROTATION_END = 19;
    static final int ACCESSIBILITY_ACTION = 20;
    static final int DISMISS = 21;
    static final int REQUEST_CLOSE = 22;
    static final int SHOW = 23;
    static final int INSETS = 24;
    static final int LOAD_START = 25;
    static final int MESSAGE = 26;
    static final int NAVIGATION_STATE_CHANGE = 27;
    static final int PROGRESS = 28;
    static final int END = 29;
    static final int BUFFER = 30;
    static final int VIEWABLE_ITEMS_CHANGE = 31;
    static final int BACK_PRESS = 32;
    static final int SCROLL = 33;
    static final int SCROLL_DRAG_START = 34;
    static final int SCROLL_DRAG_END = 35;
    static final int MOMENTUM_START = 36;
    static final int MOMENTUM_END = 37;
    static final int DIALOG = 38;
    static final int TOUCH = 39;
    static final int SELECTION_CHANGE = 40;
    static final int KEY_PRESS = 41;
    static final int LOAD_END = 42;
    static final int IMAGE_INFO = 43;
    static final int TEXT_LAYOUT = 44;
    static final int CONTENT_SIZE_CHANGE = 45;
    static final int BACK_REQUEST = 46;
    static final int NATIVE_EVENT = 47;
    static final int CLIPBOARD = 48;
    static final int KEY_COMMAND = 49;
    static final int MENU = 50;
    static final int MOUSE_ENTER = 51;
    static final int MOUSE_LEAVE = 52;
    static final int FILE_DRAG_ENTER = 53;
    static final int FILE_DRAG_LEAVE = 54;
    static final int FILE_DROP = 55;
    static final int MOUSE_MOVE = 56;
    static final int CONTEXT_MENU = 57;
    static final int COMPOSITION_CHANGE = 58;
    static final int PRESS_OUTSIDE = 59;
    static final int CANCEL = 60;
    static final int POSITION = 61;
    static final int HOST = 62;
    static final int PICK = 63;
    static final int LOAD_MORE_AT_START = 64;
    static final int OPEN_URL = 65;
    static final int CARET_MOVE = 66;
    static final int PASTE = 67;
    static final int CLIPBOARD_WRITE = 68;
    static final int SCREEN_COLOR = 69;
    static final int FILE_REQUEST = 70;
    static final int DOWNLOAD = 71;
    static final int NOTIFICATION = 72;
    static final int URL_SCHEME = 73;
    static final int SECOND_INSTANCE = 74;
    static final int AUDIO = 75;
    static final int WINDOW = 76;
    static final int EDIT_ACTION = 77;
    static final int WHEEL = 78;
    static final int PINCH = 79;
    static final int WEB_EVALUATION = 80;
    static final int MOUSE_UP = 81;
    static final int CANVAS_IMAGE = 82;
    static final int KEY_DOWN = 83;
    static final int KEY_UP = 84;
    static final int WEB_VIEW_REPLY = 85;
    static final int DOWNLOAD_PENDING = 86;
    static final int DOWNLOAD_OFFER = 87;
    static final int DOWNLOAD_PROGRESS = 88;
    static final int DOWNLOAD_END = 89;
    static final int DETENT_CHANGE = 90;
    static final int FOCUS_IN = 91;
    static final int FOCUS_OUT = 92;
    static final int TEXT_DROP = 93;
    static final int OPEN_APP_SETTINGS = 94;
    static final int BACK_PROGRESS = 95;
    static final int SCROLL_INTENT = 96;

    /**
     * Draws the SVG {@code bytes} for a view {@code maxPx} pixels on its longer side, with its shorter side that long
     * (0: its intrinsic size, {@code density} pixels per point), as premultiplied RGBA, setting {@code size} to the
     * raster's width and height and the SVG's intrinsic size in whole points; {@code maxPx} below 0 only measures (an
     * empty array). {@code intrinsic} receives its unrounded width and height in points. Null when the bytes are
     * not a valid SVG. Any thread.
     */
    static native byte[] svg(byte[] bytes, int maxPx, float density, int[] size, float[] intrinsic);

    /**
     * A host whose apps keep their data in {@code dataDir} and the images they download in {@code cacheDir} (null:
     * not on disk), each in a directory named by its id.
     */
    static native long create(NshView view, float density, boolean trace, String dataDir, String cacheDir);

    static native void destroy(long handle);

    /** What loaded apps are granted at most (capabilities JSON; null: no ceiling); false if invalid. */
    static native boolean setGranted(long handle, String capabilities);

    /** VM limits of the apps loaded next (0 keeps a default). */
    static native void setLimits(long handle, int memoryMb, int stackKb, int loadMs, int callMs, int maxNodes);

    /** No VM limits for the apps loaded next: they run on their own. */
    static native void setStandaloneLimits(long handle);

    /** Whether scroll views make their content's native views only near their viewport (default: true). */
    static native void setContentCulling(long handle, boolean enabled);

    /** The directory the storage of the apps loaded next is kept in (null: each app's own in the data directory). */
    static native void setStorage(long handle, String dir);

    /**
     * Where the apps loaded next keep their caches ({@code location}: 0 the system's, 1 {@code dir}, 2 none) and how
     * much each keeps ({@code images}: 0 its default, 1 {@code imagesMaxMb} megabytes, 2 none).
     */
    static native void setCache(long handle, int location, String dir, int images, int imagesMaxMb);

    /**
     * What the running app's disk cache holds for {@code url}: its bytes ({@code byte[]}) when fresh, the conditional
     * request headers to revalidate a stale copy with ({@code String[]}, names and values), or null. Any thread.
     */
    static native Object imageCacheLookup(long handle, String url);

    /**
     * Ends a download of {@code url} through the disk cache: {@code status} 0 when the request failed, else the
     * response's status, {@code headers} (names and values), body and {@code redirects}, the URLs the download was
     * redirected to (null: none), which the cache keeps with the copy and checks again before it serves it. Returns
     * the cached bytes when they are what to show (a 304; a stale copy when the request failed), or null. Any thread.
     */
    static native byte[] imageCacheComplete(
            long handle, String url, int status, String[] headers, byte[] body, String[] redirects);

    /**
     * The embedding app's theme overrides (a shadcn/ui theme file, null: the
     * app's own theme). Returns why the file does not parse, or null.
     */
    static native String setThemeOverrides(long handle, String json);

    /** Registers a font file; returns an error, or null. */
    static native String registerFont(long handle, byte[] data);

    /**
     * Whether a web view of the running app may navigate to {@code url}, with
     * its {@code allowOrigin} {@code origin} and its {@code allowNavigation}
     * {@code hosts}, one pattern per line (null: none).
     */
    static native boolean allowsWebview(long handle, String url, String origin, String hosts);

    /**
     * Whether the running app's web pages may capture {@code kind}
     * ({@code "microphone"}, {@code "camera"}): its {@code webview.media}.
     */
    static native boolean allowsWebMedia(long handle, String kind);

    /**
     * The URL a media load redirected from {@code base} to {@code location}
     * goes on to, or null if the running app may not load it.
     */
    static native String mediaRedirect(long handle, String base, String location);

    /**
     * The bytes of the in-memory image {@code uri}: a {@code data:} URI's or a
     * {@code blob:} URL's that a view shows, or an {@code Image.getSize}
     * {@code data:} URI's; null when there are none.
     */
    static native byte[] imageBytes(long handle, String uri);

    /** {@code capabilities}: the app's declaration (JSON), {@code app}: its {@code app.json} ({@code id}); null for none. */
    static native void load(long handle, byte[] code, boolean bytecode, String sourceMap, String capabilities, String app, String updater);

    static native boolean connectDevServer(long handle, String url);

    /** Runs the Rust app this library is (defined by the app's `nsh::main!`; absent from the JS runtime's). */
    static native void runRust(long handle);

    /** A trust store kept in {@code dir}; 0 if its state cannot be read. */
    static native long trustCreate(String dir);

    static native boolean trustAddRoot(long trust, String publicKey);

    static native boolean trustUpdateRevocations(long trust, String json);

    static native void trustDestroy(long trust);

    /**
     * Verifies and unpacks a signed package (any thread): a package handle and
     * {@code info} = id, name, version, build; or 0 and {@code info[0]} = why.
     */
    static native long trustOpenPackage(long trust, String path, String[] info);

    /** Runs a package from {@link #trustOpenPackage}, taking it. */
    static native void runPackage(long handle, long pkg);

    static native void packageFree(long pkg);

    /**
     * The images or files picked for pick {@code id} (none: cancelled); {@code sizes} holds each one's width and height
     * in pixels; a file not read (larger than the pick reads) has {@code null} data and its size in bytes in
     * {@code lengths}.
     */
    static native void picked(long handle, int id, String[] names, String[] types, byte[][] data, int[] sizes, long[] lengths);

    /** A native component emitted {@code name} with {@code json} data (null: none). */
    static native void componentEvent(long handle, int id, String name, String json);

    /** A native component's own size (dp). */
    static native void componentSize(long handle, int id, float width, float height);

    /** Names of native components registered by the app's Rust crate, or null. */
    static native String[] componentNames(long handle);

    /** Notes that host code registered a Java component overriding {@code name}. */
    static native void componentJavaRegistered(long handle, String name);

    /** Creates the native view of a Rust crate component on the UI thread. */
    static native android.view.View componentCreate(long handle, int id, android.content.Context context, String name);

    /** Runs the next queued typed prop, slot, command, or reset step for a Rust component. */
    static native void componentStep(long handle, long seq, int id);

    /** Destroys a Rust component instance when its element or app stops. */
    static native void componentDestroy(long handle, int id);

    /** The launch parameters (a JSON object; null: none) of the apps loaded next; false if it is not one. */
    static native boolean setHostParams(long handle, String json);

    /** Sends event {@code name} with {@code json} data (null: none) to the running app; false if invalid. */
    static native boolean sendHostEvent(long handle, String name, String json);

    /** The app's calls and posts of {@code name} go to {@code NshView.hostMessage} ({@code handled}), or nowhere. */
    static native void setHostHandler(long handle, String name, boolean handled);

    /** Answers a call {@code hostMessage} got: {@code json}, or {@code error} when it failed. Frees it. */
    static native void hostReply(long call, String json, String error);

    /** Frees a call unanswered: it fails in the app. */
    static native void hostCallFree(long call);

    /** The URLs the app opens go to {@code NshView.openUrlMessage} first ({@code handled}), or to the system. */
    static native void setOpenUrlHandler(long handle, boolean handled);

    /** Answers a URL {@code openUrlMessage} got: whether the embedding app took it. Frees it. */
    static native void openUrlReply(long request, boolean handled);

    /** Root size in dp. */
    static native void resize(long handle, float width, float height);

    /**
     * values: safe area top, right, bottom, left, keyboard height, keyboard
     * animation duration (s), font scale, 1 if the language is right to left.
     * locale: the default locale's language tag (`Intl`'s default).
     * timeZone: the system's time zone's ID (`Europe/Berlin`).
     * languages: the preferred languages' tags, most preferred first, comma-separated.
     * regional: the system's format locale's tag, with Android 14's regional
     * preferences as its Unicode extension (`en-US-u-fw-mon-mu-celsius`).
     */
    static native void environment(long handle, float[] values, boolean dark, String locale, String timeZone,
            String languages, String regional);

    static native void event(long handle, int id, int kind, String text, int count, float x, float y);

    /**
     * A hardware key went down: whether the app's shortcuts ({@code nsh/keymap}) or a mounted
     * {@code captureKeys} rule takes it (then Android runs no default). The raw event still goes
     * to {@code focusedId} when {@code raw}, with the same {@code defaultPrevented} decision.
     * {@code unicode}: what it types without modifiers ({@code KeyEvent.getUnicodeChar(0)});
     * {@code text}: the printable character it reports with the modifiers held (the raw
     * {@code key}); {@code scanCode}: the kernel's evdev scan code ({@code KeyEvent.getScanCode()},
     * 0 when Android supplied none: the raw {@code code} is then empty); {@code repeat}: an
     * auto-repeat; {@code editing}: a text input or hosted view has the focus; {@code focusedId}:
     * the focused node ({@code ROOT_ID} when {@code NshView} holds the focus, a modal's id in its
     * dialog, `0` for a native child that owns its keys); {@code windowId}: that window's root node
     * for `nsh/keymap` bindings; {@code control}: the focused node takes presses (`Keymap::find_at`);
     * {@code defaultPrevented}: a mounted rule captures this transition; {@code raw}: the focused
     * view or an ancestor hears raw keys. No capture rule or listener builds no raw event.
     */
    static native boolean keyDown(long handle, int keyCode, int unicode, int text, int meta, int scanCode,
            boolean repeat, boolean editing, int focusedId, int windowId, boolean control,
            boolean defaultPrevented, boolean raw);

    /**
     * A hardware key went up: whether its release is consumed (the app's shortcuts held it, or a
     * mounted rule captures it now). The raw {@code KeyUp} goes to {@code focusedId} when the
     * current listeners/raw policy accept it ({@code 0}: a native child has the keys); a
     * shortcut's release is still observed where the focus listens now.
     */
    static native boolean keyUp(long handle, int keyCode, int unicode, int text, int meta, int scanCode,
            int focusedId, boolean defaultPrevented, boolean raw);

    /**
     * A key with Control came as a shortcut first: whether the app's shortcuts take it. No raw
     * event is reported here; a key the shortcuts leave goes on to {@link #keyDown}.
     */
    static native boolean keyShortcut(long handle, int keyCode, int unicode, int meta, int windowId,
            boolean control, boolean repeat, boolean editing);

    /** A key's release was cancelled: forget it without a {@code KeyUp}; whether its press was taken. */
    static native boolean keyCancel(long handle, int keyCode);

    /** The window lost the focus or the app went away: no held key has a release any more. */
    static native void keyReset(long handle);

    /** The user gave the surface input with a pointer (a press that focuses a custom view). */
    static native void pointerInput(long handle);

    /**
     * Mouse event {@code kind} ({@code onMouseEnter}, {@code onMouseMove}, {@code onMouseLeave}) of
     * view {@code id}: the pointer at ({@code x}, {@code y}) in it and at ({@code pageX},
     * {@code pageY}) in its root view (dp), with no button down; {@code modifiers}: 1 Ctrl, 2 Alt,
     * 4 Shift, 8 Meta.
     */
    static native void mouse(long handle, int id, int kind, float x, float y, float pageX, float pageY,
            int modifiers);

    /**
     * Press event {@code kind} ({@code onPress}, {@code onLongPress}, {@code onPressDown},
     * {@code onPressUp}) of node {@code id}: the touch at ({@code x}, {@code y}) in the pressed
     * view and at ({@code pageX}, {@code pageY}) in its root view (dp); {@code modifiers} as
     * {@link #mouse}'s; {@code clicks}: the click count.
     */
    static native void press(long handle, int id, int kind, float x, float y, float pageX, float pageY,
            int modifiers, int clicks);

    /**
     * An event with an object payload ({@code Double}, {@code Boolean} or
     * {@code String} values), or a single value when {@code keys} is null.
     */
    static native void eventMap(long handle, int id, int kind, String[] keys, Object[] values);

    /**
     * `onPaste`: the pasted text, the images' encoded bytes, local files' {@code file:} URLs and the names, types
     * and sizes of the images too large to read (`tooLarge`).
     */
    static native void paste(long handle, int id, String text, byte[][] images, String[] uris, String[] largeNames,
                             String[] largeTypes, long[] largeLengths);

    /**
     * A file drag for node {@code id}: {@link #FILE_DRAG_ENTER} with the files offered (none yet on Android, which
     * opens a drag's data only at the drop) or {@link #FILE_DROP} with the dropped files' app-owned copies, as
     * {@code file:} URLs; a drop's point ({@code x}, {@code y}) in the surface's points.
     */
    static native void fileDrop(long handle, int id, int kind, String[] uris, float x, float y);

    /**
     * {@link #CANVAS_IMAGE} on the root: the answer to `OffscreenCanvas` render {@code request}, the encoded image
     * {@code bytes}, or when they are null why not: {@code failure} ({@link CanvasRender#RENDER_FAILED},
     * {@link CanvasRender#RENDER_TOO_LARGE}) and the message {@code error}.
     */
    static native void canvasImage(long handle, int request, byte[] bytes, int failure, String error);

    /** Applies the animation items of batches up to {@code seq}; returns bound values. */
    static native float[] afterBatch(long handle, long seq);

    static native float[] tick(long handle, long frameNanos);

    /** Runs the functions the app asked to run on the UI thread. */
    static native void runMainThreadTasks(long handle);

    /** Shader view {@code id} is {@code width} × {@code height} px; whether frames should come. */
    static native boolean shaderSize(long handle, int id, int width, int height);

    /**
     * Shader view {@code id}'s picture of {@code input} (0 content, 1 backdrop,
     * 2 from, 3 to): {@code height} rows of {@code width} premultiplied RGBA
     * pixels {@code stride} bytes apart in a direct buffer (null: none);
     * whether frames should come.
     */
    static native boolean shaderInput(long handle, int id, int input, java.nio.ByteBuffer pixels, int width,
                                      int height, int stride);

    /**
     * Shader view {@code id}'s transition starts, {@code ms} long; whether it
     * runs (not without a GPU: the children show as they are).
     */
    static native boolean shaderTransition(long handle, int id, float ms);

    /**
     * Page or dialog {@code page} comes or goes ({@code reverse}) through
     * its shader over {@code key} (its stack, or the dialog), {@code width}
     * × {@code height} px: {@code from} its lower side, {@code to} its upper
     * side; whether it runs.
     */
    static native boolean navTransition(long handle, int key, int page, int width, int height,
                                        java.nio.ByteBuffer from, int fromStride, java.nio.ByteBuffer to, int toStride,
                                        boolean reverse);

    /**
     * The page or dialog transition over {@code key} ends at once (a change
     * that starts while it runs ended it): no more frames come for it.
     */
    static native void navTransitionEnd(long handle, int key);

    /**
     * A scroll view's offset, after applying {@code applied} of the scrolls
     * the core asked for. Returns bound values when a scroll value changed,
     * else null.
     */
    static native float[] scroll(long handle, int id, float x, float y, int applied);

    /**
     * How far a multiline input's text scrolled ({@code y}), the size of that
     * text and of the input's viewport, in points; sent while a built-in bar
     * replaces its scroll indicator.
     */
    /** Keeps the virtual list rows holding views {@code ids} rendered wherever they scroll (a selection's ends); none lets go. */
    static native void keepRendered(long handle, int[] ids);

    static native void inputScroll(long handle, int id, float y, float contentWidth, float contentHeight,
                                   float width, float height);

    /**
     * How far (points) a vertical scroll view is pulled past its top.
     * Returns bound values when a pull value changed, else null.
     */
    static native float[] pull(long handle, int id, float distance);

    /**
     * A scroll view came to rest: the snapping animated values that follow it settle. Returns
     * bound values when one starts moving, else null.
     */
    static native float[] scrollEnded(long handle, int id);

    /** A zoomable scroll view's zoom scale, reported before its offset. */
    static native void zoom(long handle, int id, float scale);

    /**
     * Touches for the JS responder system. phase: 0 start, 1 move, 2 end,
     * 3 cancel. Per finger: id, target node, path length (in {@code paths},
     * innermost first), pageX, pageY, locationX, locationY (dp), pressure,
     * tiltX, tiltY (degrees), kind (0 touch, 1 pen, 2 mouse), eraser and
     * barrel (1 or 0: a pen's eraser end, its primary button held) (10
     * floats in {@code coords}) and whether it changed. {@code samples}: the
     * samples a move merged before its own, oldest first, 7 doubles each:
     * the finger's index, pageX, pageY (dp), pressure, tiltX, tiltY and
     * time. {@code time} and the samples' times: uptime ms.
     */
    static native void touch(long handle, int phase, int[] ids, int[] targets, int[] pathLengths, int[] paths,
            float[] coords, double[] samples, boolean[] changed, long time, int activated);

    static native boolean hasPan(long handle, int id);

    /** state: 0 began, 1 moved, 2 ended, 3 cancelled; (ox, oy): where the finger went down in the root (dp). */
    static native float[] pan(long handle, int id, int state, float tx, float ty, float vx, float vy, float ox, float oy);

    /** A pinch (scale) or two-finger rotation (degrees); state as for pan. */
    static native float[] transformGesture(long handle, int id, boolean rotation, int state, float amount, float velocity);

    /** The window of modal {@code id} is {@code width} x {@code height} dp. */
    static native void rootSize(long handle, int id, float width, float height, float top, float right, float bottom, float left);

    /** A display frame began after {@code NshView.requestJsFrame}. */
    static native void frame(long handle);

    /** Interaction states of view {@code id} the core tracks ({@code Mounter.STATE_*}). */
    static native void states(long handle, int id, int states);
}
