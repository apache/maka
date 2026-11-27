package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.ArrayList;
import java.util.List;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Objects;
import org.json.JSONObject;
import org.json.JSONTokener;

/**
 * `<webview>`: an {@code android.webkit.WebView}. Pages reach the app through
 * {@code window.nsh.postMessage};
 * the app's messages arrive as {@code message} events on {@code window}.
 *
 * <p>{@code incognito}: Android's WebView keeps cookies and DOM storage in
 * one store per app, which every web view shares and which stays. An
 * incognito web view only changes what is its own: it loads without the
 * HTTP cache and saves no form data.
 *
 * <p>When the page's renderer process ends (it crashed, or the system
 * reclaimed its memory), the app stays: this WebView is dropped, the app
 * hears {@code onError} with {@code ERR_NSH_WEBVIEW_TERMINATED}, and the
 * next {@code reload()}, {@code load()} or new source makes a new one.
 */
@SuppressLint({"ViewConstructor", "SetJavaScriptEnabled"})
final class WebBox extends WidgetBox {
    private WebView web;
    /** Captures sharing this page's texture; ordinary WebViews need no extra layer. */
    private int captureLayers;
    /** Source kind (0 none, 1 uri, 2 html) and fields; null before the first load. */
    private Object[] source;
    private String injected, injectedBefore, userAgent;
    /** {@code allowOrigin}: the one origin besides the app's hosts (null: none). */
    private String allowOrigin;
    /** {@code allowNavigation}: the hosts this view may show, one per line (null: not narrowed). */
    private String allowNavigation;
    private boolean scrollable = true;
    // The last props, to set up a WebView made after a renderer ended.
    private boolean javaScriptEnabled, incognito, zoomable;
    private boolean disposed, processGone;
    private final Handler evaluationHandler = new Handler(Looper.getMainLooper());
    private final HashMap<Integer, Evaluation> evaluations = new HashMap<>();
    // The shared page wrapper enforces the result limit; leave room for its envelope.
    private static final int MAX_ENVELOPE_BYTES = 1048576 + 1024;

    private final class Evaluation {
        final int request;
        final String generation, pollScript, cleanupScript;
        final Runnable poll;

        Evaluation(int request, String generation, String pollScript, String cleanupScript) {
            this.request = request;
            this.generation = generation;
            this.pollScript = pollScript;
            this.cleanupScript = cleanupScript;
            poll = () -> runEvaluation(this, pollScript);
        }
    }

    private WebBox(Context context, Mounter mounter, int id, WebView web) {
        super(context, mounter, id, web);
        this.web = web;
        attach(web);
    }

    private void attach(WebView web) {
        if (captureLayers > 0) web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "nsh");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) {
                // The page handles its drags (scrolls, sliders, sortable lists): keep enclosing scroll views out.
                v.getParent().requestDisallowInterceptTouchEvent(true);
            }
            // Every touch reaches the page, also with `scrollable={false}`, which only stops its viewport
            // scrolling ({@link #NO_SCROLL}): its own drag handlers still hear the moves.
            return false;
        });
    }

    /**
     * {@code scrollable={false}}: a style keeps the page's viewport from scrolling ({@code overflow: hidden} on
     * its root element) while its scripts still may and its inner scrollable elements still scroll, as on iOS
     * (a {@code UIScrollView} with scrolling off), Windows and Linux. Applied as each document starts and when
     * the prop changes; {@code scrollable} turned back on removes it.
     */
    private static String noScroll(boolean scrollable) {
        return "(function () { var on = " + scrollable + "; var id = 'nsh-no-scroll';"
                + " function apply() { var s = document.getElementById(id);"
                + " if (on) { if (s) s.remove(); return; }"
                + " if (!s && document.documentElement) { s = document.createElement('style'); s.id = id;"
                + " s.textContent = 'html { overflow: hidden !important; }';"
                + " document.documentElement.appendChild(s); } }"
                + " if (document.documentElement) apply();"
                + " else document.addEventListener('readystatechange', apply, { once: true }); })();";
    }

    private static final String NO_SCROLL = noScroll(false);

    /** Puts the {@link #NO_SCROLL} style in the current document when the page does not scroll. */
    private void applyNoScroll(WebView view) {
        if (!scrollable) view.evaluateJavascript(NO_SCROLL, null);
    }

    /** Lets captures sample the page without replaying its functor at another viewport size. */
    void retainCaptureLayer() {
        if (captureLayers++ == 0) web.setLayerType(View.LAYER_TYPE_HARDWARE, null);
    }

    void releaseCaptureLayer() {
        if (--captureLayers == 0) web.setLayerType(View.LAYER_TYPE_NONE, null);
    }

    /**
     * A web view, or an empty box when the system has no WebView (no
     * provider installed or enabled: {@code new WebView} throws). The app
     * then hears {@code onError} with {@code ERR_FEATURE_UNAVAILABLE_ON_PLATFORM}
     * and shows what it has instead.
     */
    static Box make(Context context, Mounter mounter, int id) {
        WebView web;
        try {
            web = new WebView(context);
        } catch (RuntimeException e) {
            android.util.Log.w("nsh", "WebView is not available: " + e);
            mounter.eventMap(id, Native.ERROR, new String[] {"message", "code"},
                    new Object[] {"WebView is not available: " + e.getMessage(),
                            "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"});
            return new Box(context, mounter, id);
        }
        return new WebBox(context, mounter, id, web);
    }

    /** Called from the page on a binder thread. */
    private final class Bridge {
        @JavascriptInterface
        public void postMessage(String data) {
            post(() -> {
                if (!disposed && !processGone) {
                    mounter.eventMap(id, Native.MESSAGE, new String[] {"data"}, new Object[] {data});
                }
            });
        }
    }

    private final class Client extends WebViewClient {
        /**
         * Top-level navigations stay within the app's `webview` capability
         * and the web view's {@code allowOrigin}.
         */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (disposed || processGone) return true;
            if (!request.isForMainFrame()) return false;
            String url = request.getUrl().toString();
            if (mounter.allowsWebview(url, allowOrigin, allowNavigation)) return false;
            android.util.Log.w("nsh", "web view navigation to " + url + " is not granted");
            mounter.eventMap(id, Native.ERROR, new String[] {"message", "code", "url"},
                    new Object[] {"navigation to " + url + " is not granted", "ERR_ACCESS_DENIED", url});
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (disposed || processGone) return;
            cancelEvaluations("ERR_NSH_WEBVIEW_ABORTED", "The document navigated");
            applyNoScroll(view);
            if (injectedBefore != null) view.evaluateJavascript(injectedBefore, null);
            state(Native.LOAD_START, url, true);
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            // onPageStarted can come before the new document replaces the old one: its first paint has the style.
            if (disposed || processGone) return;
            applyNoScroll(view);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (disposed || processGone) return;
            if (injected != null) view.evaluateJavascript(injected, null);
            state(Native.LOAD, url, false);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (disposed || processGone) return;
            if (!request.isForMainFrame()) return;
            mounter.eventMap(id, Native.ERROR, new String[] {"message", "url"},
                    new Object[] {String.valueOf(error.getDescription()), request.getUrl().toString()});
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // Returning true for every WebView keeps the app alive: unhandled,
            // Android ends the app's process along with the renderer.
            if (disposed || processGone || view != web) return true;
            processGone = true;
            cancelEvaluations("ERR_NSH_WEBVIEW_ABORTED", "The web content process terminated");
            // A WebView with a lost renderer cannot be reused: drop it and
            // make a new one when the app asks for a page again.
            removeView(web);
            web.destroy();
            String message = detail.didCrash()
                    ? "The web content process crashed"
                    : "The system ended the web content process";
            android.util.Log.w("nsh", "web view: " + message);
            mounter.eventMap(id, Native.ERROR, new String[] {"message", "code"},
                    new Object[] {message, "ERR_NSH_WEBVIEW_TERMINATED"});
            return true;
        }
    }

    /** Media capture ({@code getUserMedia}): what the app's {@code webview.media} grants. */
    private final class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            List<String> granted = new ArrayList<>();
            List<String> system = new ArrayList<>();
            for (String resource : request.getResources()) {
                String kind, permission;
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                    kind = "microphone";
                    permission = android.Manifest.permission.RECORD_AUDIO;
                } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                    kind = "camera";
                    permission = android.Manifest.permission.CAMERA;
                } else {
                    continue;
                }
                if (!mounter.allowsWebMedia(kind)) {
                    android.util.Log.w("nsh", "web view " + kind + " capture is not granted: add it to capabilities.webview.media");
                    continue;
                }
                granted.add(resource);
                system.add(permission);
            }
            if (granted.isEmpty()) {
                request.deny();
                return;
            }
            String[] resources = granted.toArray(new String[0]);
            Context context = getContext();
            List<String> missing = new ArrayList<>();
            for (String p : system) {
                if (context.checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
            }
            if (missing.isEmpty()) {
                request.grant(resources);
            } else if (SystemUi.activity(context) != null) {
                boolean asked = Permissions.ask(SystemUi.activity(context), missing.toArray(new String[0]), results -> {
                    boolean allowed = results != null && results.length > 0;
                    if (results != null) {
                        for (int r : results) allowed &= r == PackageManager.PERMISSION_GRANTED;
                    }
                    if (allowed) request.grant(resources);
                    else request.deny();
                });
                if (!asked) request.deny();
            } else {
                request.deny();
            }
        }
    }

    private void state(int kind, String url, boolean loading) {
        String[] keys = {"url", "title", "loading", "canGoBack", "canGoForward"};
        Object[] values = {url, Objects.toString(web.getTitle(), ""), loading, web.canGoBack(), web.canGoForward()};
        if (mounter.wants(id, kind)) mounter.eventMap(id, kind, keys, values);
        if (mounter.wants(id, Native.NAVIGATION_STATE_CHANGE)) {
            mounter.eventMap(id, Native.NAVIGATION_STATE_CHANGE, keys, values);
        }
    }

    @SuppressWarnings("deprecation") // setSaveFormData: still honored before Android 8.
    void configure(Object[] source, String injected, String injectedBefore, String userAgent,
            boolean scrollable, boolean javaScriptEnabled, boolean incognito, boolean zoomable,
            String allowOrigin, String allowNavigation) {
        if (disposed) return;
        boolean revived = processGone;
        if (processGone && !revive()) return;
        if (!javaScriptEnabled) cancelEvaluations("ERR_NSH_WEBVIEW_SCRIPT", "JavaScript is disabled");
        // Read with the first props: the core keeps it from changing.
        if (this.source == null && incognito) {
            WebSettings settings = web.getSettings();
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            settings.setSaveFormData(false);
        }
        if (this.source == null && zoomable) zoom(web.getSettings());
        // Before the source loads: a new origin applies to the next navigation.
        this.allowOrigin = allowOrigin;
        this.allowNavigation = allowNavigation;
        boolean scriptsChanged = !Objects.equals(injected, this.injected)
                || !Objects.equals(injectedBefore, this.injectedBefore);
        this.injected = injected;
        this.injectedBefore = injectedBefore;
        // The page shown takes the change now; pages loaded later as they start.
        if (this.source != null && scrollable != this.scrollable) web.evaluateJavascript(noScroll(scrollable), null);
        this.scrollable = scrollable;
        this.javaScriptEnabled = javaScriptEnabled;
        if (this.source == null) {
            this.incognito = incognito;
            this.zoomable = zoomable;
        }
        web.setVerticalScrollBarEnabled(scrollable);
        web.setHorizontalScrollBarEnabled(scrollable);
        web.getSettings().setJavaScriptEnabled(javaScriptEnabled);
        if (!Objects.equals(userAgent, this.userAgent)) {
            this.userAgent = userAgent;
            web.getSettings().setUserAgentString(userAgent);
        }
        if (revived || this.source == null || !java.util.Arrays.equals(source, this.source) || scriptsChanged) {
            this.source = source;
            if ((int) source[0] != 0) {
                cancelEvaluations("ERR_NSH_WEBVIEW_ABORTED", "The document navigated");
            }
            loadSource();
        }
    }

    /**
     * {@code zoomable}: pinch zoom with no on-screen buttons. The page's
     * viewport keeps its say over the layout width (wide viewport and
     * overview mode stay as they are).
     */
    static void zoom(WebSettings settings) {
        settings.setSupportZoom(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
    }

    private void loadSource() {
        switch ((int) source[0]) {
            case 1: web.loadUrl((String) source[1]); break;
            case 2: web.loadDataWithBaseURL((String) source[2], (String) source[1], "text/html", "UTF-8", null); break;
            default: break;
        }
    }

    /**
     * A new WebView in place of the one whose renderer ended, set up with
     * the last props; false (the app hears why) when none can be made.
     */
    @SuppressWarnings("deprecation") // setSaveFormData, as in configure.
    private boolean revive() {
        WebView fresh;
        try {
            fresh = new WebView(getContext());
        } catch (RuntimeException e) {
            android.util.Log.w("nsh", "WebView is not available: " + e);
            mounter.eventMap(id, Native.ERROR, new String[] {"message", "code"},
                    new Object[] {"WebView is not available: " + e.getMessage(),
                            "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"});
            return false;
        }
        web = fresh;
        attach(fresh);
        replaceWidget(fresh);
        processGone = false;
        WebSettings settings = fresh.getSettings();
        if (incognito) {
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            settings.setSaveFormData(false);
        }
        if (zoomable) zoom(settings);
        settings.setJavaScriptEnabled(javaScriptEnabled);
        if (userAgent != null) settings.setUserAgentString(userAgent);
        fresh.setVerticalScrollBarEnabled(scrollable);
        fresh.setHorizontalScrollBarEnabled(scrollable);
        return true;
    }

    /** Commands 4–9 of `Mounter.command`. */
    void command(int kind, String text) {
        if (disposed) return;
        if (processGone) {
            // reload() shows the app's page again in a new WebView.
            if (kind == 4 && source != null && revive()) loadSource();
            return;
        }
        if (kind >= 4 && kind <= 6) {
            cancelEvaluations("ERR_NSH_WEBVIEW_ABORTED", "The document navigated");
        }
        switch (kind) {
            case 4: web.reload(); break;
            case 5: web.goBack(); break;
            case 6: web.goForward(); break;
            case 7: web.stopLoading(); break;
            case 8: web.evaluateJavascript(text, null); break;
            case 9:
                web.evaluateJavascript("window.dispatchEvent(new MessageEvent('message', { data: "
                        + JSONObject.quote(text) + " }));", null);
                break;
            default: break;
        }
    }

    /**
     * Command 46 of `Mounter.command` (`load()`): `url` with `headers` on its
     * own request; WebView sends them with no subresource or later navigation.
     */
    void load(String url, java.util.Map<String, String> headers) {
        if (disposed) return;
        if (processGone && !revive()) return;
        cancelEvaluations("ERR_NSH_WEBVIEW_ABORTED", "The document navigated");
        web.loadUrl(url, headers);
    }

    /** Starts a request without exposing a page-to-native bridge. */
    void evaluate(int request, String generation, String start, String poll, String cleanup) {
        if (disposed) return;
        if (processGone || !web.getSettings().getJavaScriptEnabled()) {
            evaluationError(request, generation, processGone ? "ERR_NSH_WEBVIEW_ABORTED" : "ERR_NSH_WEBVIEW_SCRIPT",
                    processGone ? "The web content process terminated" : "JavaScript is disabled");
            return;
        }
        cancelEvaluation(request);
        Evaluation evaluation = new Evaluation(request, generation, poll, cleanup);
        evaluations.put(request, evaluation);
        // The core keeps the deadline: it cancels the request when the
        // app's timeout passes.
        runEvaluation(evaluation, start);
    }

    private boolean active(Evaluation evaluation) {
        return !disposed && !processGone && evaluations.get(evaluation.request) == evaluation;
    }

    private void runEvaluation(Evaluation evaluation, String script) {
        if (!active(evaluation)) return;
        try {
            web.evaluateJavascript(script, encoded -> {
                if (!active(evaluation)) return;
                try {
                    // Android JSON-encodes the string returned by the shared
                    // wrapper. Decode that one extra layer, not the result value.
                    if (encoded == null) {
                        failEvaluation(evaluation, "ERR_NSH_WEBVIEW_SCRIPT", "WebView returned an invalid evaluation response");
                        return;
                    }
                    if (encoded.length() > MAX_ENVELOPE_BYTES * 6 + 2) {
                        failEvaluation(evaluation, "ERR_NSH_QUOTA_EXCEEDED", "The JavaScript result is too large");
                        return;
                    }
                    Object decoded = new JSONTokener(encoded).nextValue();
                    if (!(decoded instanceof String)) {
                        failEvaluation(evaluation, "ERR_NSH_WEBVIEW_SCRIPT", "WebView returned an invalid evaluation response");
                        return;
                    }
                    String envelope = (String) decoded;
                    if (envelope.getBytes(StandardCharsets.UTF_8).length > MAX_ENVELOPE_BYTES) {
                        failEvaluation(evaluation, "ERR_NSH_QUOTA_EXCEEDED", "The JavaScript result is too large");
                        return;
                    }
                    String status = new JSONObject(envelope).getString("status");
                    if (status.equals("pending")) {
                        evaluationHandler.postDelayed(evaluation.poll, 25);
                    } else if (status.equals("ok") || status.equals("error")) {
                        finishEvaluation(evaluation, envelope);
                    } else {
                        failEvaluation(evaluation, "ERR_NSH_WEBVIEW_SCRIPT", "WebView returned an invalid evaluation response");
                    }
                } catch (org.json.JSONException error) {
                    failEvaluation(evaluation, "ERR_NSH_WEBVIEW_SCRIPT", "WebView returned an invalid evaluation response");
                }
            });
        } catch (RuntimeException error) {
            failEvaluation(evaluation, "ERR_NSH_WEBVIEW_SCRIPT", "WebView could not evaluate JavaScript");
        }
    }

    private void evaluationReply(int request, String generation, String envelope) {
        // Internal completions do not depend on an app event listener.
        mounter.eventMap(id, Native.WEB_EVALUATION, new String[] {"id", "data", "generation"},
                new Object[] {Double.valueOf(Integer.toUnsignedLong(request)), envelope, generation});
    }

    private void evaluationError(int request, String generation, String code, String message) {
        evaluationReply(request, generation, "{\"status\":\"error\",\"code\":" + JSONObject.quote(code)
                + ",\"message\":" + JSONObject.quote(message) + "}");
    }

    private void finishEvaluation(Evaluation evaluation, String envelope) {
        if (!active(evaluation)) return;
        cancelEvaluation(evaluation.request);
        evaluationReply(evaluation.request, evaluation.generation, envelope);
    }

    private void failEvaluation(Evaluation evaluation, String code, String message) {
        if (!active(evaluation)) return;
        cancelEvaluation(evaluation.request);
        evaluationError(evaluation.request, evaluation.generation, code, message);
    }

    /** Core cancellation is silent and also removes the page's pending cell. */
    void cancelEvaluation(int request) {
        Evaluation evaluation = evaluations.remove(request);
        if (evaluation == null) return;
        evaluationHandler.removeCallbacks(evaluation.poll);
        if (!disposed && !processGone) {
            try {
                web.evaluateJavascript(evaluation.cleanupScript, null);
            } catch (RuntimeException ignored) {
                // A dead renderer has no remaining page cell to release.
            }
        }
    }

    private void cancelEvaluations(String code, String message) {
        for (Evaluation evaluation : evaluations.values().toArray(new Evaluation[0])) {
            cancelEvaluation(evaluation.request);
            evaluationError(evaluation.request, evaluation.generation, code, message);
        }
    }

    void destroy() {
        if (disposed) return;
        cancelEvaluations("ERR_NSH_WEBVIEW_ABORTED", "The web view was disposed");
        disposed = true;
        evaluationHandler.removeCallbacksAndMessages(null);
        if (!processGone) {
            web.stopLoading();
            removeView(web);
            web.destroy();
        }
    }
}
