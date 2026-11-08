package com.longbridge.nsh;

import android.app.Activity;
import android.os.Bundle;

/** The activity of packaged apps (`nsh package --target android`). */
public final class AppActivity extends Activity {
    private NshView view;

    /** Created by the system from the manifest. */
    public AppActivity() {}

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        DevActivity.edgeToEdge(this);
        view = new NshView(this);
        // An app on its own, not a module embedded in another app: no limits.
        view.useStandaloneLimits();
        setContentView(view);
        view.handleNotificationIntent(getIntent());
        // A recreated activity's intent was handed in already.
        if (state == null) view.handleUrlSchemeIntent(getIntent());
        if (rustApp()) view.runRustApp("nsh");
        // A newer signed package of the app's code it downloaded runs instead.
        else view.loadAssetBundle("nsh", true);
    }

    /** A Rust app (`nsh package --rust` sets the manifest's `com.longbridge.nsh.RUST`). */
    private boolean rustApp() {
        try {
            android.content.pm.ApplicationInfo info = getPackageManager()
                    .getApplicationInfo(getPackageName(), android.content.pm.PackageManager.GET_META_DATA);
            return info.metaData != null && info.metaData.getBoolean("com.longbridge.nsh.RUST", false);
        } catch (android.content.pm.PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    @Override
    public void onConfigurationChanged(android.content.res.Configuration config) {
        super.onConfigurationChanged(config);
        DevActivity.systemBars(this);
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
        super.onDestroy();
    }
}
