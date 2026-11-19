"""Reject release runtimes linked with an old SDK or a raised deployment target.

Run on macOS after `cargo xtask dist`, before packing the iOS component.
Read the actual Mach-O load commands; never rewrite them.
"""

import pathlib
import re
import subprocess
import sys


def check(root):
    runtimes = {
        "iphoneos/nsh-ios-app": "2",
        "iphonesimulator/nsh-ios-app": "7",
        "iphonesimulator/nsh-ios-host": "7",
        "maccatalyst/nsh-ios-host": "6",
    }
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
                or int(sdk.split(".")[0]) < 26
            ):
                print(f"::error::{binary}: expected platform {platform}, minos 15.0, SDK >= 26")
                failed = True
    return int(failed)


if __name__ == "__main__":
    sys.exit(check(pathlib.Path(sys.argv[1])))
