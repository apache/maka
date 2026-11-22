"""Render the Homebrew formula only from a published stable release."""

import argparse
import json
from pathlib import Path
import re
from string import Template


VERSION = r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
ASSETS = {
    "NSH_MACOS_ARM64": "nsh-macos-arm64.tar.gz",
    "NSH_LINUX_X86_64": "nsh-linux-x86_64.tar.gz",
}


def release_version(release):
    tag = release["tagName"]
    if release["isDraft"] or release["isPrerelease"] or not re.fullmatch("v" + VERSION, tag):
        raise ValueError("Homebrew requires a published stable release tagged vX.Y.Z")
    return tag[1:]


def render(release, sums, repository, current=None):
    version = release_version(release)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("invalid GitHub repository")
    if current is not None:
        # The formula infers its version from the release URL. Refuse a rerun
        # of an older release after a newer one has reached the tap.
        versions = re.findall(r"/releases/download/v(" + VERSION + r")/", current)
        if not versions:
            raise ValueError("cannot determine the current Homebrew formula version")
        requested = tuple(map(int, version.split(".")))
        if any(tuple(map(int, match[1:])) > requested for match in versions):
            raise ValueError(f"refusing to downgrade the Homebrew formula to {version}")
    values = {"NSH_VERSION": version, "NSH_REPO": repository}
    for variable, asset in ASSETS.items():
        checksum_file = sums / (asset + ".sha256")
        checksum = checksum_file.read_text(encoding="utf-8").strip()
        match = re.fullmatch(r"([0-9a-fA-F]{64}) [ *]" + re.escape(asset), checksum)
        if not match:
            raise ValueError(f"invalid SHA-256 or filename in {checksum_file.name}")
        values[variable] = match[1].lower()
    template = Path(__file__).with_name("nsh.rb").read_text(encoding="utf-8")
    return Template(template).substitute(values)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--sums", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--current", type=Path)
    args = parser.parse_args()
    try:
        release = json.loads(args.release.read_text(encoding="utf-8"))
        current = args.current.read_text(encoding="utf-8") if args.current else None
        formula = render(release, args.sums, args.repository, current)
    except (KeyError, ValueError, OSError) as error:
        parser.exit(1, f"Homebrew formula: {error}\n")
    args.output.write_text(formula, encoding="utf-8")


if __name__ == "__main__":
    main()
