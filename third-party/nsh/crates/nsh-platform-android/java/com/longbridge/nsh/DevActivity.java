package com.longbridge.nsh;

import android.app.Activity;
import android.os.Build;
import android.os.Bundle;

/**
 * The development host: runs the app served by `nsh dev` (`nsh run --target
 * android` passes the server URL as the `url` extra). With a `package` extra
 * (a `.nshpkg` path on the device) and `root` (a root public key, base64;
 * comma-separated for several) it verifies and runs that signed package as an
 * embedding app would; its trust state lives in the cache directory. Each
 * {@code nsh.env.<name>} string extra sets the variable {@code <name>} in this
 * process's environment before the app starts: the variables of the app's
 * {@code capabilities.process.env} the CLI passes, which the app reads in
 * {@code process.env}. Only this host, which only the CLI installs, applies
 * them: a packaged app's activity is exported, and any app could start it
 * with extras.
 */
public final class DevActivity extends Activity {
    private NshView view;
    private NshTrust trust;

    /** Created by the system from the manifest. */
    public DevActivity() {}

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        edgeToEdge(this);
        // Before the view starts the engine, whose `process.env` reads this
        // process's environment.
        applyEnv(getIntent().getExtras());
        boolean trace = getIntent().getBooleanExtra("trace", false);
        // A test session's app (`nsh test --target android`) keeps its data
        // in a directory of its own, empty when it starts.
        String data = getIntent().getStringExtra("dataDir");
        if (data != null) {
            java.io.File dir = new java.io.File(new java.io.File(getCacheDir(), "nsh-test"), data);
            deleteTree(dir);
            // Its caches too (downloaded images): the app starts with none.
            view = new NshView(this, trace, dir, new java.io.File(dir, "cache"));
        } else {
            view = new NshView(this, trace);
        }
        // An app on its own, not a module embedded in another app: no limits.
        view.useStandaloneLimits();
        setContentView(view);
        view.handleNotificationIntent(getIntent());
        // A recreated activity's intent was handed in already.
        if (state == null) view.handleUrlSchemeIntent(getIntent());
        String pkg = getIntent().getStringExtra("package");
        if (pkg != null) {
            trust = new NshTrust(new java.io.File(getCacheDir(), "nsh-trust"));
            String roots = getIntent().getStringExtra("root");
            if (roots != null) {
                for (String root : roots.split(",")) trust.addRoot(root);
            }
            try {
                view.runPackage(trust.openPackage(new java.io.File(pkg)));
            } catch (NshPackage.RefusedException e) {
                view.reportError(e.getMessage());
            }
            return;
        }
        String url = getIntent().getStringExtra("url");
        view.connectDevServer(url != null ? url : "ws://127.0.0.1:8790/ws");
    }

    /** Sets each {@code nsh.env.<name>} string extra as the variable {@code <name>}. */
    private static void applyEnv(Bundle extras) {
        if (extras == null) return;
        for (String key : extras.keySet()) {
            if (!key.startsWith("nsh.env.")) continue;
            String value = extras.getString(key);
            if (value == null) continue;
            String name = key.substring("nsh.env.".length());
            try {
                android.system.Os.setenv(name, value, true);
            } catch (android.system.ErrnoException e) {
                android.util.Log.w("nsh", "cannot set " + name + ": " + e.getMessage());
            }
        }
    }

    private static void deleteTree(java.io.File file) {
        java.io.File[] children = file.listFiles();
        if (children != null) for (java.io.File c : children) deleteTree(c);
        file.delete();
    }

    /** A notification pressed, or a URL opened, while this activity is in its task. */
    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        if (view != null) {
            view.handleNotificationIntent(intent);
            view.handleUrlSchemeIntent(intent);
        }
    }

    /** Android 12 and older: the app gets the back button first. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (view == null || !view.handleBack()) super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        view.destroy();
        if (trust != null) trust.close();
        super.onDestroy();
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration config) {
        super.onConfigurationChanged(config);
        systemBars(this);
    }

    /** Draw behind the system bars: the app gets them as `safeArea()`. */
    @SuppressWarnings("deprecation")
    static void edgeToEdge(Activity activity) {
        if (Build.VERSION.SDK_INT >= 30) {
            activity.getWindow().setDecorFitsSystemWindows(false);
        } else {
            activity.getWindow().getDecorView().setSystemUiVisibility(
                    android.view.View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | android.view.View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | android.view.View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        activity.getWindow().setStatusBarColor(0);
        activity.getWindow().setNavigationBarColor(0);
        systemBars(activity);
    }

    /** Dark system bar icons in light mode, light ones in dark mode. */
    @SuppressWarnings("deprecation")
    static void systemBars(Activity activity) {
        int night = activity.getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK;
        boolean dark = night == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        // Creates the decor view, which owns the insets controller.
        activity.getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= 30) {
            android.view.WindowInsetsController c = activity.getWindow().getInsetsController();
            if (c == null) return;
            int light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            c.setSystemBarsAppearance(dark ? 0 : light, light);
        } else {
            android.view.View decor = activity.getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility();
            // Both bars, as above: the navigation bar's buttons are drawn
            // over the app (edge to edge), so they follow its mode too.
            int light = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                    | android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(dark ? flags & ~light : flags | light);
        }
    }
}
