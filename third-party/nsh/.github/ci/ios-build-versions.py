"""Reject release runtimes linked with an old SDK or a raised deployment target.

Run on macOS after `cargo xtask dist`, before packing the iOS component:
`ios-build-versions.py <runtime/ios> <minimum SDK major> <devices|simulator>`.
`devices` (Apple silicon) expects the device runner too; `simulator` (an Intel
Mac, whose Xcode has an older SDK) the simulator and Mac Catalyst runtimes
only. Read the actual Mach-O load commands; never rewrite them.
"""

import pathlib
import re
import subprocess
import sys


def check(root, min_sdk, devices):
    runtimes = {
        "iphonesimulator/nsh-ios-app": "7",
        "iphonesimulator/nsh-ios-host": "7",
        "maccatalyst/nsh-ios-host": "6",
    }
    if devices:
        runtimes["iphoneos/nsh-ios-app"] = "2"
    failed = False
    for runtime, platform in runtimes.items():
        binary = root / runtime
        output = subprocess.check_output(["otool", "-l", str(binary)], text=True)
        versions = re.findall(
            r"cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform (\d+)"
            r"\s+minos ([\d.]+)\s+sdk ([\d.]+)",
            output,
        )
        if not versions:
            print(f"::error::{binary}: missing LC_BUILD_VERSION")
            failed = True
        for actual_platform, minimum, sdk in versions:
            print(f"{runtime}: platform={actual_platform} minos={minimum} sdk={sdk}")
            if (
                actual_platform != platform
                or minimum not in ("15.0", "15.0.0")
                or int(sdk.split(".")[0]) < min_sdk
            ):
                print(
                    f"::error::{binary}: expected platform {platform}, minos 15.0, SDK >= {min_sdk}"
                )
                failed = True
    return int(failed)


if __name__ == "__main__":
    root, min_sdk, mode = sys.argv[1:4]
    if mode not in ("devices", "simulator"):
        sys.exit(f"mode must be devices or simulator, not {mode}")
    sys.exit(check(pathlib.Path(root), int(min_sdk), mode == "devices"))
