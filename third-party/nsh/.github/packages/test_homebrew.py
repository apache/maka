import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from homebrew import ASSETS, render


class HomebrewFormulaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.sums = Path(self.temp.name)
        self.release = {"tagName": "v0.1.2", "isDraft": False, "isPrerelease": False}
        for i, asset in enumerate(ASSETS.values(), 1):
            (self.sums / (asset + ".sha256")).write_text(f"{str(i) * 64}  {asset}\n")

    def render(self, current=None):
        return render(self.release, self.sums, "longbridge/nsh", current)

    def test_versions_checksums_and_distribution_layout(self):
        formula = self.render()
        for i, asset in enumerate(ASSETS.values(), 1):
            self.assertIn(f"https://github.com/longbridge/nsh/releases/download/v0.1.2/{asset}", formula)
            self.assertIn(f'sha256 "{str(i) * 64}"', formula)
        self.assertNotIn("${", formula)
        self.assertIn("depends_on arch: :arm64", formula)
        self.assertIn("depends_on arch: :x86_64", formula)
        self.assertIn('libexec.install Dir["*"]', formula)
        self.assertIn('bin.install_symlink libexec/"bin/nsh"', formula)
        # The test needs no component: brew test runs offline.
        self.assertIn('"build", "hello", "-o", testpath/"out", "--release"', formula)
        self.assertIn("nsh component list", formula)
        self.assertNotIn('"--target"', formula)

    def test_rejects_unpublished_and_prerelease_versions(self):
        for change in ({"isDraft": True}, {"isPrerelease": True},
                       {"tagName": "v0.1.2-rc.1"}, {"tagName": "0.1.2"},
                       {"tagName": "v01.2.3"}, {"tagName": 'v0.1.2\"\nputs 1'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                render(self.release | change, self.sums, "longbridge/nsh")

    def test_rejects_invalid_repository(self):
        with self.assertRaises(ValueError):
            render(self.release, self.sums, 'longbridge/nsh"', None)

    def test_checksums_must_match_the_asset(self):
        asset = next(iter(ASSETS.values()))
        path = self.sums / (asset + ".sha256")
        for value in ("", "1" * 63 + f"  {asset}", "z" * 64 + f"  {asset}",
                      "1" * 64 + "  wrong.tar.gz", "1" * 64 + f"  {asset}\nextra"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                path.write_text(value)
                self.render()
        path.write_text("A" * 64 + f" *{asset}\n")
        self.assertIn('sha256 "' + "a" * 64 + '"', self.render())

    def test_missing_checksum_fails(self):
        (self.sums / (next(iter(ASSETS.values())) + ".sha256")).unlink()
        with self.assertRaises(FileNotFoundError):
            self.render()

    def test_reruns_are_identical_and_never_downgrade(self):
        formula = self.render()
        self.assertEqual(self.render(current=formula), formula)
        self.assertEqual(self.render(current=formula.replace("v0.1.2/", "v0.1.1/")), formula)
        for version in ("0.1.3", "0.10.0", "1.0.0"):
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "downgrade"):
                self.render(current=formula.replace("v0.1.2/", f"v{version}/"))
        with self.assertRaisesRegex(ValueError, "current Homebrew formula version"):
            self.render(current="an unrecognized formula")

    def test_failed_cli_preserves_existing_output(self):
        release = self.sums / "release.json"
        release.write_text(json.dumps(self.release | {"isDraft": True}))
        output = self.sums / "nsh.rb"
        output.write_text("existing formula")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).with_name("homebrew.py")),
             "--release", str(release), "--sums", str(self.sums),
             "--repository", "longbridge/nsh", "--output", str(output)],
            capture_output=True, text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("published stable release", result.stderr)
        self.assertEqual(output.read_text(), "existing formula")


if __name__ == "__main__":
    unittest.main()
