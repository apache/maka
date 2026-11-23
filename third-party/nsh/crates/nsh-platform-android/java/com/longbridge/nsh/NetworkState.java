package com.longbridge.nsh;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.Looper;

/**
 * How the device reaches the network (`network()`): the system's default network, followed by one callback per
 * process ({@link ConnectivityManager#registerDefaultNetworkCallback}) on the main thread, registered by the first view
 * attached and kept while the process runs, so it knows the route while views come and go. Each change goes to the
 * views attached, which report their environments again.
 *
 * <p>The callback needs {@code ACCESS_NETWORK_STATE}, which apps NSH packages and the SDK's AAR declare; where a host
 * removes it, the kind stays unknown, which counts as online.
 */
final class NetworkState {
    /** {@code network().kind} as {@code Native.environment} takes it. */
    static final int UNKNOWN = 0, NONE = 1, WIFI = 2, CELLULAR = 3, WIRED = 4, OTHER = 5;

    private static NetworkState registered;

    /** The default network's kind, and whether it is metered and the user saves data on it (Data Saver). */
    int kind = UNKNOWN;
    boolean expensive;
    boolean constrained;
    /** Data Saver keeps the app from metered networks in the background (and asks it to save data in front). */
    private boolean dataSaver;
    final java.util.ArrayList<NshView> views = new java.util.ArrayList<>();

    /** The process's, registered on the first call (main thread). */
    static NetworkState of(Context context) {
        if (registered == null) {
            registered = new NetworkState();
            registered.register(context.getApplicationContext());
        }
        return registered;
    }

    private void register(Context context) {
        ConnectivityManager manager = context.getSystemService(ConnectivityManager.class);
        if (manager == null) return;
        Handler main = new Handler(Looper.getMainLooper());
        try {
            // The route now: no callback comes while there is no default network.
            Network active = manager.getActiveNetwork();
            dataSaver = manager.getRestrictBackgroundStatus() == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED;
            route(active == null ? null : manager.getNetworkCapabilities(active), active != null);
            manager.registerDefaultNetworkCallback(new ConnectivityManager.NetworkCallback() {
                @Override
                public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) {
                    route(capabilities, true);
                    changed();
                }

                @Override
                public void onLost(Network network) {
                    // Another default network brings its capabilities next.
                    route(null, false);
                    changed();
                }
            }, main);
        } catch (SecurityException e) {
            // No ACCESS_NETWORK_STATE: the route stays unknown.
            kind = UNKNOWN;
            expensive = false;
            constrained = false;
            return;
        }
        // Data Saver turned on or off, or the app taken off its list. The
        // broadcast is the system's alone: no export flag is needed.
        BroadcastReceiver saver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                dataSaver = manager.getRestrictBackgroundStatus()
                        == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED;
                constrained = expensive && dataSaver;
                changed();
            }
        };
        context.registerReceiver(saver, new IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED),
                null, main);
    }

    /** The default network is one of `capabilities`, or none when `connected` is false. */
    private void route(NetworkCapabilities capabilities, boolean connected) {
        if (!connected) {
            kind = NONE;
            expensive = false;
        } else if (capabilities == null) {
            kind = UNKNOWN;
            expensive = false;
        } else {
            kind = kindOf(capabilities);
            expensive = !capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        }
        constrained = expensive && dataSaver;
    }

    /** The link beneath: a VPN names the transports it runs over too. */
    private static int kindOf(NetworkCapabilities capabilities) {
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return WIFI;
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return CELLULAR;
        if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return WIRED;
        return OTHER;
    }

    private void changed() {
        for (NshView view : new java.util.ArrayList<>(views)) view.networkChanged();
    }
}
