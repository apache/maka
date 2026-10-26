package com.longbridge.nsh;

/**
 * The answer to a call of the app ({@code host.call} in {@code nsh/host}),
 * which a {@link NshView.HostHandler} gets: give it once, from any thread,
 * with {@link #resolve} or {@link #reject}. A reply collected unanswered fails
 * the call. A post's reply ({@link #isPost}) goes nowhere.
 */
public final class NshHostReply {
    private long call;

    NshHostReply(long call) {
        this.call = call;
    }

    private synchronized long take() {
        long taken = call;
        call = 0;
        return taken;
    }

    /**
     * Whether this answers a post ({@code host.post}), which expects no answer.
     *
     * @return true for a post
     */
    public synchronized boolean isPost() {
        return call == 0;
    }

    /**
     * Answers the call: the app's promise resolves with {@code value}.
     *
     * @param value JSON as Java objects ({@code String}, {@code Number},
     *     {@code Boolean}, {@code java.util.List}, {@code java.util.Map},
     *     {@code org.json} values), or null
     */
    public void resolve(Object value) {
        long taken = take();
        if (taken != 0) Native.hostReply(taken, value == null ? null : Json.stringify(value), null);
    }

    /**
     * Fails the call: the app's promise rejects with an {@code Error} of
     * {@code message}.
     *
     * @param message why it failed
     */
    public void reject(String message) {
        long taken = take();
        if (taken != 0) Native.hostReply(taken, null, message == null ? "" : message);
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void finalize() throws Throwable {
        try {
            long taken = take();
            if (taken != 0) Native.hostCallFree(taken);
        } finally {
            super.finalize();
        }
    }
}
