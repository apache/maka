package com.longbridge.nsh;

import java.io.File;

/**
 * The keys, revocations and accepted builds that signed packages
 * ({@link #openPackage}) are verified against. Usable from any thread. The newest revocation
 * list and the highest build accepted per app persist in its state
 * directory, and packages' assets are extracted under it. Trusts no key
 * until {@link #addRoot}. Call {@link #close} when done.
 */
public final class NshTrust implements AutoCloseable {
    private long handle;

    /**
     * Opens (or creates) the store in {@code stateDir}.
     *
     * @param stateDir where its state persists, e.g. under {@code getFilesDir()}
     * @throws IllegalStateException if the state cannot be read
     */
    public NshTrust(File stateDir) {
        handle = Native.trustCreate(stateDir.getAbsolutePath());
        if (handle == 0) throw new IllegalStateException("cannot open the trust store in " + stateDir);
    }

    /**
     * Trusts a root public key (base64, as `nsh keygen` writes it in a
     * {@code .pub} file): packages whose release key it certified load.
     *
     * @param publicKey the key
     * @return false for an invalid key
     */
    public boolean addRoot(String publicKey) {
        return Native.trustAddRoot(handle(), publicKey.trim());
    }

    /**
     * Applies a revocation list (the JSON `nsh revoke` writes) signed by a
     * trusted root and newer than the one the store has.
     *
     * @param json the list
     * @return false if it is invalid, untrusted or not newer
     */
    public boolean updateRevocations(String json) {
        return Native.trustUpdateRevocations(handle(), json);
    }

    /**
     * Verifies the signed package {@code file} (`.nshpkg`, written by `nsh
     * publish`): its release key must be certified by a trusted root for the
     * app's id, not revoked, and its build not older than one accepted
     * before. Extracts its assets and accepts it (older builds of the app are
     * refused from now on). Slow for large packages: call it off the UI
     * thread, then {@link NshView#runPackage} on it.
     *
     * @param file the package
     * @return the verified package
     * @throws NshPackage.RefusedException with the reason
     */
    public NshPackage openPackage(File file) throws NshPackage.RefusedException {
        String[] info = new String[4];
        long pkg = Native.trustOpenPackage(handle(), file.getAbsolutePath(), info);
        if (pkg == 0) throw new NshPackage.RefusedException(info[0] != null ? info[0] : "refused package");
        return new NshPackage(pkg, info[0], info[1], info[2], Long.parseLong(info[3]));
    }

    long handle() {
        if (handle == 0) throw new IllegalStateException("NshTrust is closed");
        return handle;
    }

    @Override
    public synchronized void close() {
        if (handle != 0) {
            Native.trustDestroy(handle);
            handle = 0;
        }
    }
}
