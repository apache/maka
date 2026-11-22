package com.longbridge.nsh;

import java.io.File;
import java.io.IOException;

/**
 * Which of an app's own directories a {@code content:} URI may name. Free of
 * Android APIs so the rule can be exercised with plain {@code javac} / {@code
 * java}: see {@code tests/java/FileRootsTest.java}.
 */
final class FileRoots {
    private FileRoots() {}

    /**
     * {@code file} canonicalized when it is a file inside one of {@code
     * roots}, else {@code null}. Canonicalizing both sides also resolves a
     * {@code ..} or a symlink that would otherwise name a file outside the
     * roots. A root directory itself is not a file to serve.
     */
    static File under(File file, File[] roots) {
        File canonical;
        try {
            canonical = file.getCanonicalFile();
        } catch (IOException e) {
            return null;
        }
        String path = canonical.getAbsolutePath();
        for (File root : roots) {
            if (root == null) continue;
            String prefix;
            try {
                prefix = root.getCanonicalFile().getAbsolutePath();
            } catch (IOException e) {
                continue;
            }
            if (path.startsWith(prefix + File.separator)) {
                return canonical;
            }
        }
        return null;
    }
}
