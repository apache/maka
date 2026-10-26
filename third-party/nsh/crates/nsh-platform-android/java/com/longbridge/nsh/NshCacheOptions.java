package com.longbridge.nsh;

import java.io.File;

/**
 * Where the apps an {@link NshView} loads keep their caches, and how much each
 * keeps: today the images they download, kept as the server sent them so they
 * show again without a download (and offline). Immutable: make one with
 * {@link #builder()}.
 *
 * <pre>{@code
 * nsh.setCacheOptions(NshCacheOptions.builder()
 *         .location(new File(getCacheDir(), "nsh"))
 *         .imagesMaxMegabytes(64)
 *         .build());
 * }</pre>
 */
public final class NshCacheOptions {
    /** The system's cache directory ({@code nsh} in the Context's), each cache at its default size. */
    public static final NshCacheOptions DEFAULT = builder().build();

    static final int LOCATION_SYSTEM = 0, LOCATION_DIRECTORY = 1, LOCATION_OFF = 2;
    static final int POLICY_DEFAULT = 0, POLICY_MAX_SIZE = 1, POLICY_OFF = 2;

    final int location;
    final File directory;
    final int images;
    final int imagesMaxMegabytes;

    private NshCacheOptions(Builder b) {
        location = b.location;
        directory = b.directory;
        images = b.images;
        imagesMaxMegabytes = b.imagesMaxMegabytes;
    }

    /** A builder starting from {@link #DEFAULT}. */
    public static Builder builder() {
        return new Builder();
    }

    /** A builder starting from these options. */
    public Builder toBuilder() {
        Builder b = new Builder();
        b.location = location;
        b.directory = directory;
        b.images = images;
        b.imagesMaxMegabytes = imagesMaxMegabytes;
        return b;
    }

    /** Builds {@link NshCacheOptions}. */
    public static final class Builder {
        private int location = LOCATION_SYSTEM;
        private File directory;
        private int images = POLICY_DEFAULT;
        private int imagesMaxMegabytes;

        private Builder() {}

        /**
         * Keeps the caches in {@code dir}, each app's in {@code <dir>/<app id>}.
         *
         * @param dir the directory
         * @return this builder
         */
        public Builder location(File dir) {
            if (dir == null) throw new IllegalArgumentException("dir");
            location = LOCATION_DIRECTORY;
            directory = dir;
            return this;
        }

        /**
         * Keeps the caches in the system's cache directory ({@code nsh} in the Context's): the default.
         *
         * @return this builder
         */
        public Builder systemLocation() {
            location = LOCATION_SYSTEM;
            directory = null;
            return this;
        }

        /**
         * Keeps nothing on disk.
         *
         * @return this builder
         */
        public Builder noDiskCache() {
            location = LOCATION_OFF;
            directory = null;
            return this;
        }

        /**
         * Keeps at most {@code megabytes} MiB of downloaded images per app (256 by default); the least recently used
         * go first.
         *
         * @param megabytes the size in mebibytes
         * @return this builder
         */
        public Builder imagesMaxMegabytes(int megabytes) {
            if (megabytes < 0) throw new IllegalArgumentException("megabytes");
            images = POLICY_MAX_SIZE;
            imagesMaxMegabytes = megabytes;
            return this;
        }

        /**
         * Keeps no downloaded image on disk.
         *
         * @return this builder
         */
        public Builder imagesOff() {
            images = POLICY_OFF;
            return this;
        }

        /**
         * The options.
         *
         * @return the options
         */
        public NshCacheOptions build() {
            return new NshCacheOptions(this);
        }
    }
}
