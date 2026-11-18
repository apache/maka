package com.longbridge.nsh;

import android.annotation.TargetApi;
import android.os.Build;
import android.window.BackEvent;
import android.window.OnBackAnimationCallback;
import android.window.OnBackInvokedCallback;

/**
 * Back callbacks for Android 13+ (only loaded there). On Android 14+ the
 * top screen follows the back gesture (predictive back).
 */
final class BackCallbacks {
    private BackCallbacks() {}

    static Object create(NshView view, Mounter mounter) {
        if (Build.VERSION.SDK_INT >= 34) return new Animated(view, mounter);
        return (OnBackInvokedCallback) view::handleBack;
    }

    @TargetApi(34)
    private static final class Animated implements OnBackAnimationCallback {
        private final NshView view;
        private final Mounter mounter;
        private StackBox stack;

        Animated(NshView view, Mounter mounter) {
            this.view = view;
            this.mounter = mounter;
        }

        @Override
        public void onBackStarted(BackEvent event) {
            // Only a pop follows the finger; modals and the app's listeners
            // (they hear the button before the stack) decide on release.
            stack = mounter.wantsBack() ? mounter.backStack() : null;
            if (stack != null && !mounter.hasShownModal() && !mounter.listensToBack() && stack.canSwipe()) {
                stack.backStarted();
            } else {
                stack = null;
            }
        }

        @Override
        public void onBackProgressed(BackEvent event) {
            if (stack != null) stack.backProgressed(event.getProgress());
        }

        @Override
        public void onBackCancelled() {
            if (stack != null) stack.backCancelled();
            stack = null;
            // A cancelled back key: its press is forgotten here, before a
            // cancelled key-up may follow (Android 15 QPR1 to 16).
            view.backCancelled();
        }

        @Override
        public void onBackInvoked() {
            stack = null;
            view.handleBack();
        }
    }
}
