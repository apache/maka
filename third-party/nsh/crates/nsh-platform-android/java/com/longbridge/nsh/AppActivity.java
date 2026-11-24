package com.longbridge.nsh;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

/** The activity of packaged apps (`nsh package --target android`). */
public final class AppActivity extends Activity {
    private NshView view;
    private final ShareReceiver shares = new ShareReceiver();

    /** Created by the system from the manifest. */
    public AppActivity() {}

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent intent = getIntent();
        DevActivity.edgeToEdge(this);
        // `nsh run` passes the app's declared environment as extras. Only a
        // development build (debuggable) takes them: the activity is
        // exported, so any app could start a store build with extras.
        if (intent != null && !ShareReceiver.isShare(intent)
                && (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            DevActivity.applyEnv(intent.getExtras());
        }
        view = new NshView(this);
        // An app on its own, not a module embedded in another app: no limits.
        view.useStandaloneLimits();
        view.ownSystemBars();
        setContentView(view);
        handleIntent(intent, state == null);
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
        if (view != null) view.mounter().applySystemBars();
    }

    /** A notification pressed, a URL opened or files shared while this activity is in its task. */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (view != null) handleIntent(intent, true);
    }

    private void handleIntent(Intent intent, boolean firstDelivery) {
        if (ShareReceiver.isShare(intent)) {
            if (firstDelivery) shares.handle(this, intent, view::openUrl);
            return;
        }
        view.handleNotificationIntent(intent);
        if (!firstDelivery || intent == null) return;
        // An explicit VIEW intent can bypass the manifest filters. Only files
        // copied from a share should reach the open-files route.
        Uri data = intent.getData();
        if (data == null || !"file".equalsIgnoreCase(data.getScheme())) view.handleUrlSchemeIntent(intent);
    }

    /** Android 12 and older: the app gets the back button first. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (view == null || !view.handleBack()) super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        shares.destroy();
        view.destroy();
        super.onDestroy();
    }
}
