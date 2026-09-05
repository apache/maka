# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

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
