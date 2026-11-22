package com.longbridge.nsh;

/**
 * A verified signed package ({@link NshTrust#openPackage}), ready to run
 * with {@link NshView#runPackage}. Call {@link #close} if it will not run.
 */
public final class NshPackage implements AutoCloseable {
    /** Why a package was refused (signature, certificate, revocation, rollback, ...). */
    public static final class RefusedException extends Exception {
        RefusedException(String message) {
            super(message);
        }
    }

    private long handle;
    /** The app's id. */
    public final String appId;
    /** The app's name. */
    public final String appName;
    /** The app's version string. */
    public final String version;
    /** The app's build number. */
    public final long build;

    NshPackage(long handle, String appId, String appName, String version, long build) {
        this.handle = handle;
        this.appId = appId;
        this.appName = appName;
        this.version = version;
        this.build = build;
    }

    synchronized long take() {
        if (handle == 0) throw new IllegalStateException("the package already ran or was closed");
        long h = handle;
        handle = 0;
        return h;
    }

    @Override
    public synchronized void close() {
        if (handle != 0) {
            Native.packageFree(handle);
            handle = 0;
        }
    }
}
