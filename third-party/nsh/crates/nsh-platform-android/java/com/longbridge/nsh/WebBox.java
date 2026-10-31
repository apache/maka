package com.longbridge.nsh;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.view.MotionEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.Objects;
import org.json.JSONObject;

/**
 * `<webview>`: an {@code android.webkit.WebView}. Pages reach the app through
 * {@code window.nsh.postMessage};
 * the app's messages arrive as {@code message} events on {@code window}.
 */
@SuppressLint({"ViewConstructor", "SetJavaScriptEnabled"})
final class WebBox extends WidgetBox {
    private final WebView web;
    /** Source kind (0 none, 1 uri, 2 html) and fields; null before the first load. */
    private Object[] source;
    private String injected, injectedBefore, userAgent;
    private boolean scrollable = true;

    WebBox(Context context, Mounter mounter, int id) {
        super(context, mounter, id, new WebView(context));
        web = (WebView) widget;
        web.getSettings().setDomStorageEnabled(true);
        web.addJavascriptInterface(new Bridge(), "nsh");
        web.setWebViewClient(new Client());
        web.setOnTouchListener((v, e) -> {
            if (e.getActionMasked() == MotionEvent.ACTION_DOWN) {
                // The page scrolls itself: keep enclosing scroll views out.
                v.getParent().requestDisallowInterceptTouchEvent(true);
            }
            return !scrollable && e.getActionMasked() == MotionEvent.ACTION_MOVE;
        });
    }

    /** Called from the page on a binder thread. */
    private final class Bridge {
        @JavascriptInterface
        public void postMessage(String data) {
            post(() -> mounter.eventMap(id, Native.MESSAGE, new String[] {"data"}, new Object[] {data}));
        }
    }

    private final class Client extends WebViewClient {
        /** Top-level navigations stay within the app's `webview` capability. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
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
            if (injectedBefore != null) view.evaluateJavascript(injectedBefore, null);
            state(Native.LOAD_START, url, true);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (injected != null) view.evaluateJavascript(injected, null);
            state(Native.LOAD, url, false);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            mounter.eventMap(id, Native.ERROR, new String[] {"message", "url"},
                    new Object[] {String.valueOf(error.getDescription()), request.getUrl().toString()});
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

    void configure(Object[] source, String injected, String injectedBefore, String userAgent,
            boolean scrollable, boolean javaScriptEnabled) {
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
            switch ((int) source[0]) {
                case 1: web.loadUrl((String) source[1]); break;
                case 2: web.loadDataWithBaseURL((String) source[2], (String) source[1], "text/html", "UTF-8", null); break;
                default: break;
            }
        }
    }

    /** Commands 4–9 of `Mounter.command`. */
    void command(int kind, String text) {
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

    void destroy() {
        web.stopLoading();
        web.destroy();
    }
}
