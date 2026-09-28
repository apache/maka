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


def isolated_authority():
    module_path = Path(__file__).with_name("eval_framework.py")
    spec = importlib.util.spec_from_file_location("isolated_eval_framework", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load eval framework authority")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FrameworkAuthorityContract(unittest.TestCase):
    def test_framework_metadata_is_self_consistent(self) -> None:
        authority = isolated_authority()
        expected = {
            "harbor": ("harbor", "harbor.agents.base"),
            "pier": ("datacurve-pier", "pier.agents.base"),
        }
        for name, (distribution, agent_module) in expected.items():
            with self.subTest(name=name):
                spec = authority.framework_spec(name)
                self.assertEqual(spec.name, name)
                self.assertEqual(authority.framework_distribution(name), distribution)
                self.assertEqual(authority.framework_agent_module(name), agent_module)

    def test_install_is_last_write_wins_without_an_implicit_default(self) -> None:
        authority = isolated_authority()
        with self.assertRaisesRegex(RuntimeError, "not installed"):
            authority.current_framework()
        for name in ("harbor", "pier", "harbor"):
            authority.install(name)
            self.assertEqual(authority.current_framework(), name)

    def test_invalid_operations_never_mutate_selection(self) -> None:
        for initial in (None, "harbor"):
            authority = isolated_authority()
            if initial is not None:
                authority.install(initial)
            for operation in (
                lambda: authority.install("other"),
                lambda: authority.framework_spec("other"),
                lambda: authority.framework_distribution("other"),
                lambda: authority.framework_agent_module("other"),
            ):
                with self.subTest(initial=initial, operation=operation):
                    with self.assertRaisesRegex(RuntimeError, "harbor or pier"):
                        operation()
                    if initial is None:
                        with self.assertRaisesRegex(RuntimeError, "not installed"):
                            authority.current_framework()
                    else:
                        self.assertEqual(authority.current_framework(), initial)


if __name__ == "__main__":
    unittest.main()
