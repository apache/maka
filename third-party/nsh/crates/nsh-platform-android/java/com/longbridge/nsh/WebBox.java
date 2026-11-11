package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
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
 */
@SuppressLint({"ViewConstructor", "SetJavaScriptEnabled"})
final class WebBox extends WidgetBox {
    private final WebView web;
    /** Source kind (0 none, 1 uri, 2 html) and fields; null before the first load. */
    private Object[] source;
    private String injected, injectedBefore, userAgent;
    private boolean scrollable = true;
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
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "nsh");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());
        web.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) {
                // The page scrolls itself: keep enclosing scroll views out.
                v.getParent().requestDisallowInterceptTouchEvent(true);
            }
            return !scrollable && e.getActionMasked() == MotionEvent.ACTION_MOVE;
        });
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
        /** Top-level navigations stay within the app's `webview` capability. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (disposed || processGone) return true;
            if (!request.isForMainFrame()) return false;
            String url = request.getUrl().toString();
            if (mounter.allowsWebview(url)) return false;
            android.util.Log.w("nsh", "web view navigation to " + url + " is not granted");
            mounter.eventMap(id, Native.ERROR, new String[] {"message", "code", "url"},
                    new Object[] {"navigation to " + url + " is not granted", "ERR_ACCESS_DENIED", url});
            return true;
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (disposed || processGone) return;
            cancelEvaluations("ERR_NSH_WEBVIEW_ABORTED", "The document navigated");
            if (injectedBefore != null) view.evaluateJavascript(injectedBefore, null);
            state(Native.LOAD_START, url, true);
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
            if (disposed || processGone) return true;
            processGone = true;
            cancelEvaluations("ERR_NSH_WEBVIEW_ABORTED", "The web content process terminated");
            // A WebView with a lost renderer cannot be reused. Handling the
            // callback and destroying it keeps the embedding app alive.
            removeView(web);
            web.destroy();
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
            } else if (context instanceof Activity) {
                MediaPermissions.of((Activity) context).ask(missing.toArray(new String[0]), allowed -> {
                    if (allowed) request.grant(resources);
                    else request.deny();
                });
            } else {
                request.deny();
            }
        }
    }

    /** Asks the user for the system's media permissions, across configuration changes. */
    @SuppressWarnings("deprecation")
    public static final class MediaPermissions extends android.app.Fragment {
        private static final String TAG = "com.longbridge.nsh.WebBox.MediaPermissions";
        private static final int CODE = 0x4f01;
        private final List<java.util.function.Consumer<Boolean>> waiting = new ArrayList<>();

        static MediaPermissions of(Activity activity) {
            android.app.FragmentManager fragments = activity.getFragmentManager();
            MediaPermissions found = (MediaPermissions) fragments.findFragmentByTag(TAG);
            if (found == null) {
                found = new MediaPermissions();
                fragments.beginTransaction().add(found, TAG).commitNow();
            }
            return found;
        }

        @Override
        public void onCreate(android.os.Bundle state) {
            super.onCreate(state);
            setRetainInstance(true);
        }

        void ask(String[] permissions, java.util.function.Consumer<Boolean> answer) {
            waiting.add(answer);
            if (waiting.size() == 1) requestPermissions(permissions, CODE);
        }

        @Override
        public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
            if (code != CODE) {
                super.onRequestPermissionsResult(code, permissions, results);
                return;
            }
            boolean allowed = results.length > 0;
            for (int r : results) allowed &= r == PackageManager.PERMISSION_GRANTED;
            List<java.util.function.Consumer<Boolean>> answered = new ArrayList<>(waiting);
            waiting.clear();
            for (java.util.function.Consumer<Boolean> a : answered) a.accept(allowed);
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
            boolean scrollable, boolean javaScriptEnabled, boolean incognito) {
        if (disposed || processGone) return;
        if (!javaScriptEnabled) cancelEvaluations("ERR_NSH_WEBVIEW_SCRIPT", "JavaScript is disabled");
        // Read with the first props: the core keeps it from changing.
        if (this.source == null && incognito) {
            WebSettings settings = web.getSettings();
            settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
            settings.setSaveFormData(false);
        }
        boolean scriptsChanged = !Objects.equals(injected, this.injected)
                || !Objects.equals(injectedBefore, this.injectedBefore);
        this.injected = injected;
        this.injectedBefore = injectedBefore;
        this.scrollable = scrollable;
        web.setVerticalScrollBarEnabled(scrollable);
        web.setHorizontalScrollBarEnabled(scrollable);
        web.getSettings().setJavaScriptEnabled(javaScriptEnabled);
        if (!Objects.equals(userAgent, this.userAgent)) {
            this.userAgent = userAgent;
            web.getSettings().setUserAgentString(userAgent);
        }
        if (this.source == null || !java.util.Arrays.equals(source, this.source) || scriptsChanged) {
            this.source = source;
            if ((int) source[0] != 0) {
                cancelEvaluations("ERR_NSH_WEBVIEW_ABORTED", "The document navigated");
            }
            switch ((int) source[0]) {
                case 1: web.loadUrl((String) source[1]); break;
                case 2: web.loadDataWithBaseURL((String) source[2], (String) source[1], "text/html", "UTF-8", null); break;
                default: break;
            }
        }
    }

    /** Commands 4–9 of `Mounter.command`. */
    void command(int kind, String text) {
        if (disposed || processGone) return;
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
        if (disposed || processGone) return;
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
