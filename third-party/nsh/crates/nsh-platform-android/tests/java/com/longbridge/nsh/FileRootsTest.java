package com.longbridge.nsh;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Coverage for the roots a {@code content:} URI may name. Plain JDK, no
 * Android APIs, so it runs on a developer machine or in CI without a device:
 *
 * <pre>
 * javac -d target/java-tests \
 *   crates/nsh-platform-android/java/com/longbridge/nsh/FileRoots.java \
 *   crates/nsh-platform-android/tests/java/com/longbridge/nsh/FileRootsTest.java
 * java -cp target/java-tests com.longbridge.nsh.FileRootsTest
 * </pre>
 */
public final class FileRootsTest {
    public static void main(String[] args) throws Exception {
        Path base = Files.createTempDirectory("nsh-file-roots-");
        File[] roots = {
                Files.createDirectory(base.resolve("files")).toFile(),
                Files.createDirectory(base.resolve("cache")).toFile(),
                null, // getNoBackupFilesDir() can be unavailable.
                Files.createDirectory(base.resolve("external-files")).toFile(),
                Files.createDirectory(base.resolve("external-cache")).toFile(),
        };
        Path outside = Files.createDirectory(base.resolve("elsewhere"));
        File allowed = Files.createFile(base.resolve("files").resolve("report.pdf")).toFile();
        File externalCache = Files.createFile(
                base.resolve("external-cache").resolve("photo.jpg")).toFile();
        File refused = Files.createFile(outside.resolve("secrets.txt")).toFile();

        check("a file in the app's files dir is served",
                FileRoots.under(allowed, roots) != null);
        check("a file in the external cache dir is served",
                FileRoots.under(externalCache, roots) != null);
        check("an existing file outside the roots is refused",
                FileRoots.under(refused, roots) == null);
        check("a .. that leaves the roots is refused",
                FileRoots.under(new File(base.resolve("files").toFile(),
                        ".." + File.separator + "elsewhere" + File.separator + "secrets.txt"),
                        roots) == null);
        check("a root directory itself is not a file to serve",
                FileRoots.under(base.resolve("files").toFile(), roots) == null);
        System.out.println("FileRootsTest: ok");
    }

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError(what);
    }
}
