package com.longbridge.nsh;

/**
 * Independent hiding reasons for {@link TabBarComponent}: the visible
 * navigation stack owns {@code hidesBottomBarWhenPushed}; the app owns
 * {@code TabBar.hidden}.
 */
final class BottomBarVisibility {
    private boolean navigation;
    private boolean app;

    void setNavigation(boolean hidden) {
        navigation = hidden;
    }

    void setApp(boolean hidden) {
        app = hidden;
    }

    boolean hidden() {
        return navigation || app;
    }
}
