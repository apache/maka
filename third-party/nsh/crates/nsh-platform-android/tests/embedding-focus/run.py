#!/usr/bin/env python3
"""Build and run the embedding-focus instrumentation against the local dev runtime."""
import os
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[4]
SDK = Path(os.environ.get("ANDROID_HOME") or os.environ["ANDROID_SDK_ROOT"])
TOOLS = sorted((SDK / "build-tools").iterdir())[-1]
OUT = ROOT / ".nsh" / "android-embedding-focus"
RUNTIME = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "target")) / "android" / "debug-dev"
JAVA = Path(os.environ["JAVA_HOME"]) / "bin" if "JAVA_HOME" in os.environ else None


def run(*args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def jdk(name):
    return JAVA / name if JAVA else name


OUT.mkdir(parents=True, exist_ok=True)
(OUT / "classes").mkdir(exist_ok=True)
(OUT / "dex").mkdir(exist_ok=True)
android_jar = SDK / "platforms" / "android-35" / "android.jar"
source = Path(__file__).resolve().parent.parent / "java" / "com" / "longbridge" / "nsh" / "EmbeddedFocusRegression.java"
run(jdk("javac"), "--release", "17", "-encoding", "UTF-8", "-cp", os.pathsep.join(map(str, [android_jar, RUNTIME / "classes.jar"])), "-d", OUT / "classes", source)
run(jdk("jar"), "cf", OUT / "tests.jar", "-C", OUT / "classes", ".")
run(TOOLS / "d8", "--min-api", "26", "--lib", android_jar, "--output", OUT / "dex", RUNTIME / "classes.jar", OUT / "tests.jar")
run(TOOLS / "aapt2", "link", "-I", android_jar, "--manifest", Path(__file__).with_name("AndroidManifest.xml"), "-o", OUT / "unsigned.apk")
with zipfile.ZipFile(OUT / "unsigned.apk", "a", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as apk:
    apk.write(OUT / "dex" / "classes.dex", "classes.dex")
    for library in (RUNTIME / "lib").glob("*/libnsh.so"):
        apk.write(library, "lib/" + library.relative_to(RUNTIME / "lib").as_posix())
key = OUT / "debug.jks"
if not key.exists():
    run(jdk("keytool"), "-genkeypair", "-keystore", key, "-storepass", "android", "-keypass", "android", "-alias", "androiddebugkey", "-dname", "CN=Android Debug,O=Android,C=US", "-keyalg", "RSA", "-keysize", "2048", "-validity", "3650")
run(TOOLS / "zipalign", "-f", "4", OUT / "unsigned.apk", OUT / "aligned.apk")
run(TOOLS / "apksigner", "sign", "--ks", key, "--ks-pass", "pass:android", "--key-pass", "pass:android", "--out", OUT / "test.apk", OUT / "aligned.apk")
adb = [SDK / "platform-tools" / "adb"]
if os.environ.get("ANDROID_SERIAL"):
    adb += ["-s", os.environ["ANDROID_SERIAL"]]
run(*adb, "install", "-r", "-t", OUT / "test.apk")
result = run(*adb, "shell", "am", "instrument", "-w", "-r", "com.longbridge.nsh.focuschecks/com.longbridge.nsh.EmbeddedFocusRegression", capture_output=True, text=True)
print(result.stdout)
if "EmbeddedFocusRegression: PASS" not in result.stdout or "INSTRUMENTATION_CODE: -1" not in result.stdout:
    raise SystemExit("Native embedding regression failed")
