package com.longbridge.nsh;

import android.view.WindowInsets;
import android.view.WindowInsetsAnimation;
import java.util.List;

/**
 * The keyboard's curve and duration for Android 11+ (only loaded there, so
 * that {@code NshView} verifies without these types on older versions).
 */
final class KeyboardAnimation {
    private KeyboardAnimation() {}

    static void install(NshView view, Mounter mounter) {
        view.setWindowInsetsAnimationCallback(new WindowInsetsAnimation.Callback(
                WindowInsetsAnimation.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
            @Override
            public void onPrepare(WindowInsetsAnimation animation) {
                // Before the end state's insets are applied.
                if ((animation.getTypeMask() & WindowInsets.Type.ime()) == 0) return;
                view.keyboardDuration = animation.getDurationMillis();
                mounter.keyboardMotion(animation.getInterpolator(), view.keyboardDuration);
            }

            @Override
            public WindowInsets onProgress(WindowInsets insets, List<WindowInsetsAnimation> running) {
                return insets;
            }
        });
    }
}
