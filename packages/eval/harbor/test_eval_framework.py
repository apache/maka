import importlib.util
import unittest
from pathlib import Path


class EvalFrameworkTest(unittest.TestCase):
    def test_selected_fails_closed_before_install(self) -> None:
        module = self._load_fresh()
        with self.assertRaisesRegex(RuntimeError, "not installed"):
            module.selected()

    def test_invalid_framework_fails_closed(self) -> None:
        module = self._load_fresh()
        with self.assertRaisesRegex(RuntimeError, "harbor or pier"):
            module.install("other")
        with self.assertRaisesRegex(RuntimeError, "not installed"):
            module.selected()

    def test_install_selects_harbor_and_pier(self) -> None:
        module = self._load_fresh()
        module.install("harbor")
        self.assertEqual(module.selected(), "harbor")
        module.install("pier")
        self.assertEqual(module.selected(), "pier")

    @staticmethod
    def _load_fresh():
        path = Path(__file__).with_name("eval_framework.py")
        spec = importlib.util.spec_from_file_location("maka_eval_framework_under_test", path)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


if __name__ == "__main__":
    unittest.main()
