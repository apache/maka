// A Java port of rustls-platform-verifier's Android component
// (android/rustls-platform-verifier/src/main/java/org/rustls/platformverifier/
// CertificateVerifier.kt, version 0.2.0 of the `rustls-platform-verifier-android`
// crate, which the `rustls-platform-verifier` crate in Cargo.lock pins).
// Copyright (c) the rustls-platform-verifier authors; MIT OR Apache-2.0.
//
// The upstream component is Kotlin, shipped as an AAR that needs the Kotlin
// standard library; NSH builds its runtime with `javac` + `d8` and no Gradle,
// so the verifier is ported rather than linked. The Rust crate calls
// `verifyCertificateChain` over JNI and reads `VerificationResult.code` and
// `.message`: those names and signatures must stay as upstream defines them.
// The upstream test-only mock roots are left out.

package org.rustls.platformverifier;

import android.content.Context;
import android.net.http.X509TrustManagerExtensions;
import android.os.Build;
import android.util.Log;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.security.KeyStore;
import java.security.KeyStoreException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.PublicKey;
import java.security.cert.CertPathValidator;
import java.security.cert.CertPathValidatorException;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.CertificateExpiredException;
import java.security.cert.CertificateFactory;
import java.security.cert.CertificateNotYetValidException;
import java.security.cert.CertificateParsingException;
import java.security.cert.PKIXBuilderParameters;
import java.security.cert.PKIXRevocationChecker;
import java.security.cert.X509Certificate;
import java.util.AbstractMap;
import java.util.Collections;
import java.util.Date;
import java.util.EnumSet;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import javax.security.auth.x500.X500Principal;

/** Verifies TLS server chains against the system trust store; called from Rust only. */
final class CertificateVerifier {
    private static final String TAG = "rustls-platform-verifier-android";

    // If these change, update the Rust definition too.
    private static final int OK = 0;
    private static final int UNAVAILABLE = 1;
    private static final int EXPIRED = 2;
    private static final int UNKNOWN_CERT = 3;
    private static final int REVOKED = 4;
    private static final int INVALID_ENCODING = 5;
    private static final int INVALID_EXTENSION = 6;

    private static CertificateFactory certFactory;
    private static KeyStore systemKeystore;
    private static boolean systemKeystoreLoaded;
    private static X509TrustManagerExtensions systemTrustManager;
    private static boolean systemTrustManagerCreated;
    private static final Set<Map.Entry<X500Principal, PublicKey>> systemTrustAnchorCache =
            new HashSet<>();
    private static final File systemCertificateDirectory = certificateDirectory();

    private CertificateVerifier() {}

    private static File certificateDirectory() {
        String root = System.getenv("ANDROID_ROOT");
        return root == null ? null : new File(root + "/etc/security/cacerts");
    }

    private static synchronized CertificateFactory certFactory() throws CertificateException {
        if (certFactory == null) {
            certFactory = CertificateFactory.getInstance("X.509");
        }
        return certFactory;
    }

    private static synchronized KeyStore systemKeystore() {
        if (!systemKeystoreLoaded) {
            systemKeystoreLoaded = true;
            try {
                KeyStore keystore = KeyStore.getInstance("AndroidCAStore");
                keystore.load(null);
                systemKeystore = keystore;
            } catch (Exception e) {
                Log.w(TAG, "failed to load the system keystore: " + e);
            }
        }
        return systemKeystore;
    }

    private static synchronized X509TrustManagerExtensions systemTrustManager() {
        if (!systemTrustManagerCreated) {
            systemTrustManagerCreated = true;
            systemTrustManager = createTrustManager(systemKeystore());
        }
        return systemTrustManager;
    }

    private static X509TrustManagerExtensions createTrustManager(KeyStore keystore) {
        TrustManager[] managers;
        try {
            TrustManagerFactory factory =
                    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            factory.init(keystore);
            managers = factory.getTrustManagers();
        } catch (RuntimeException | NoSuchAlgorithmException | KeyStoreException e) {
            Log.w(TAG, "exception thrown creating a TrustManager: " + e);
            return null;
        }
        for (TrustManager manager : managers) {
            if (manager instanceof X509TrustManager) {
                return new X509TrustManagerExtensions((X509TrustManager) manager);
            }
        }
        Log.e(TAG, "failed to find a usable trust manager");
        return null;
    }

    @SuppressWarnings("unused") // JNI
    private static VerificationResult verifyCertificateChain(
            Context context,
            String serverName,
            String authMethod,
            String[] allowedEkus,
            byte[] ocspResponse,
            long time,
            byte[][] certChain) {
        X509Certificate[] chain = new X509Certificate[certChain.length];
        try {
            CertificateFactory factory = certFactory();
            for (int i = 0; i < certChain.length; i++) {
                chain[i] = (X509Certificate)
                        factory.generateCertificate(new ByteArrayInputStream(certChain[i]));
            }
        } catch (CertificateException | ClassCastException e) {
            return new VerificationResult(INVALID_ENCODING, null);
        }

        // rustls always passes the end entity.
        X509Certificate endEntity = chain[0];
        try {
            endEntity.checkValidity(new Date(time));
        } catch (CertificateExpiredException | CertificateNotYetValidException e) {
            return new VerificationResult(EXPIRED, null);
        }

        if (!verifyCertUsage(endEntity, allowedEkus)) {
            return new VerificationResult(INVALID_EXTENSION, null);
        }

        X509TrustManagerExtensions trustManager = systemTrustManager();
        if (trustManager == null) {
            return new VerificationResult(UNAVAILABLE, null);
        }
        KeyStore keystore = systemKeystore();

        // The chain only: Rust checks the server name (Android has no
        // RFC 6125 verifier). Returns the chain from end entity to anchor.
        List<X509Certificate> validChain;
        try {
            validChain = trustManager.checkServerTrusted(chain, authMethod, serverName);
        } catch (CertificateException e) {
            return new VerificationResult(UNKNOWN_CERT, e.toString());
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            // Revocation is best effort and at the end entity only; roots an
            // administrator or user installed skip it unless OCSP is stapled
            // (rustls/rustls-platform-verifier#69).
            if (ocspResponse == null && !isKnownRoot(validChain.get(validChain.size() - 1))) {
                return new VerificationResult(OK, null);
            }
            try {
                PKIXBuilderParameters parameters = new PKIXBuilderParameters(keystore, null);
                CertPathValidator validator = CertPathValidator.getInstance("PKIX");
                PKIXRevocationChecker revocationChecker =
                        (PKIXRevocationChecker) validator.getRevocationChecker();
                revocationChecker.setOptions(EnumSet.of(
                        PKIXRevocationChecker.Option.SOFT_FAIL,
                        PKIXRevocationChecker.Option.ONLY_END_ENTITY));
                if (ocspResponse != null) {
                    revocationChecker.setOcspResponses(
                            Collections.<X509Certificate, byte[]>singletonMap(endEntity, ocspResponse));
                }
                parameters.setCertPathCheckers(
                        Collections.<java.security.cert.PKIXCertPathChecker>singletonList(revocationChecker));
                parameters.setRevocationEnabled(false);
                validator.validate(certFactory().generateCertPath(validChain), parameters);
            } catch (CertPathValidatorException e) {
                return new VerificationResult(REVOKED, e.toString());
            } catch (Exception e) {
                // Upstream lets these escape to JNI, failing the handshake.
                return new VerificationResult(UNKNOWN_CERT, e.toString());
            }
        } else {
            Log.w(TAG, "did not attempt to validate OCSP due to Android version");
        }

        return new VerificationResult(OK, null);
    }

    private static boolean verifyCertUsage(X509Certificate certificate, String[] allowedEkus) {
        List<String> ekus;
        try {
            ekus = certificate.getExtendedKeyUsage();
        } catch (CertificateParsingException e) {
            return false;
        } catch (NullPointerException e) {
            // Chromium notes this can happen when the EKU data is malformed.
            Log.w(TAG, "exception handling certificate EKU");
            return false;
        }
        if (ekus == null) {
            return true;
        }
        for (String eku : ekus) {
            for (String allowed : allowedEkus) {
                if (allowed.equals(eku)) {
                    return true;
                }
            }
        }
        return false;
    }

    // The first four bytes of the principal's MD5 digest, reversed, in
    // lowercase hex: how Android names system anchors (Chromium's X509Util).
    private static String hashPrincipal(X500Principal principal) throws NoSuchAlgorithmException {
        char[] hexDigits = "0123456789abcdef".toCharArray();
        byte[] digest = MessageDigest.getInstance("MD5").digest(principal.getEncoded());
        char[] hexChars = new char[8];
        for (int i = 0; i < 4; i++) {
            int digestByte = digest[3 - i];
            hexChars[2 * i] = hexDigits[(digestByte >> 4) & 0xf];
            hexChars[2 * i + 1] = hexDigits[digestByte & 0xf];
        }
        return new String(hexChars);
    }

    // Whether `root` is a preinstalled system anchor rather than one a user or
    // administrator added.
    private static synchronized boolean isKnownRoot(X509Certificate root) {
        KeyStore keystore = systemKeystore();
        if (keystore == null || systemCertificateDirectory == null) {
            return false;
        }
        Map.Entry<X500Principal, PublicKey> key =
                new AbstractMap.SimpleImmutableEntry<>(root.getSubjectX500Principal(), root.getPublicKey());
        if (systemTrustAnchorCache.contains(key)) {
            return true;
        }
        String hash;
        try {
            hash = hashPrincipal(root.getSubjectX500Principal());
        } catch (NoSuchAlgorithmException e) {
            return false;
        }
        for (int i = 0; ; i++) {
            String alias = hash + "." + i;
            if (!new File(systemCertificateDirectory, alias).exists()) {
                break;
            }
            Certificate anchor;
            try {
                anchor = keystore.getCertificate("system:" + alias);
            } catch (KeyStoreException e) {
                continue;
            }
            if (anchor == null) {
                continue;
            }
            if (!(anchor instanceof X509Certificate)) {
                Log.e(TAG, "anchor is not a certificate, alias: " + alias);
                continue;
            }
            X509Certificate certificate = (X509Certificate) anchor;
            if (root.getSubjectX500Principal().equals(certificate.getSubjectX500Principal())
                    && root.getPublicKey().equals(certificate.getPublicKey())) {
                systemTrustAnchorCache.add(key);
                return true;
            }
        }
        return false;
    }
}

/** The outcome Rust reads over JNI: `code` and `message`. */
final class VerificationResult {
    @SuppressWarnings("unused") // JNI
    private final int code;
    @SuppressWarnings("unused") // JNI
    private final String message;

    VerificationResult(int code, String message) {
        this.code = code;
        this.message = message;
    }
}
