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


def fresh_authority():
    source = Path(__file__).with_name("eval_framework.py")
    spec = importlib.util.spec_from_file_location("isolated_eval_framework", source)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FrameworkAuthorityTest(unittest.TestCase):
    def test_unbound_context_has_no_implicit_default(self) -> None:
        authority = fresh_authority()

        with self.assertRaisesRegex(RuntimeError, "not installed"):
            authority.current_framework()

    def test_supported_names_and_distributions_are_explicit(self) -> None:
        authority = fresh_authority()
        expected = {
            "harbor": ("harbor", "harbor", "harbor.agents.base"),
            "pier": ("pier", "datacurve-pier", "pier.agents.base"),
        }

        for name, (expected_name, distribution, agent_module) in expected.items():
            with self.subTest(name=name):
                spec = authority.framework_spec(name)
                self.assertEqual(
                    (spec.name, spec.distribution, spec.agent_module),
                    (expected_name, distribution, agent_module),
                )
                authority.install(name)
                self.assertEqual(authority.current_framework(), name)
                self.assertEqual(authority.framework_distribution(name), distribution)
                self.assertEqual(authority.framework_agent_module(name), agent_module)

    def test_invalid_names_cannot_replace_the_process_selection(self) -> None:
        authority = fresh_authority()
        invalid_operations = (
            lambda: authority.install("other"),
            lambda: authority.framework_distribution("other"),
        )

        for operation in invalid_operations:
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(RuntimeError, "harbor or pier"):
                    operation()
                with self.assertRaisesRegex(RuntimeError, "not installed"):
                    authority.current_framework()

    def test_invalid_spec_lookup_does_not_change_an_installed_framework(self) -> None:
        authority = fresh_authority()
        authority.install("harbor")
        with self.assertRaisesRegex(RuntimeError, "harbor or pier"):
            authority.framework_spec("other")
        self.assertEqual(authority.current_framework(), "harbor")

    def test_install_replaces_the_process_selection(self) -> None:
        authority = fresh_authority()
        authority.install("harbor")
        authority.install("pier")
        self.assertEqual(authority.current_framework(), "pier")


if __name__ == "__main__":
    unittest.main()
