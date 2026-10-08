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

from importlib import util as module_util
import unittest as testing
from pathlib import Path as FilePath
FRAMEWORK_CASES = [
    ("harbor", "harbor", "harbor.agents.base"),
    ("pier", "datacurve-pier", "pier.agents.base"),
]
def fresh_authority():
    spec = module_util.spec_from_file_location(
        "isolated_eval_framework", FilePath(__file__).with_name("eval_framework.py")
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load eval framework authority")
    authority = module_util.module_from_spec(spec)
    spec.loader.exec_module(authority)
    return authority


def metadata(authority, name: str) -> tuple[str, str, str]:
    spec = authority.framework_spec(name)
    distribution = authority.framework_distribution(name)
    agent_module = authority.framework_agent_module(name)
    return spec.name, distribution, agent_module


class FrameworkAuthorityContract(testing.TestCase):
    def test_framework_metadata_is_self_consistent(self) -> None:
        authority = fresh_authority()
        for name, distribution, agent_module in FRAMEWORK_CASES:
            with self.subTest(name=name):
                expected = (name, distribution, agent_module)
                self.assertTupleEqual(metadata(authority, name), expected)
    def test_install_is_last_write_wins_without_an_implicit_default(self) -> None:
        authority = fresh_authority()
        with self.assertRaisesRegex(RuntimeError, r"not installed"):
            authority.current_framework()
        for name in ("harbor", "pier", "harbor"):
            authority.install(name)
            self.assertEqual(authority.current_framework(), name)

    def test_invalid_operations_never_mutate_selection(self) -> None:
        for initial in (None, "harbor"):
            authority = fresh_authority()
            if initial is not None:
                authority.install(initial)
            for method_name in (
                "install",
                "framework_spec",
                "framework_distribution",
                "framework_agent_module",
            ):
                with self.subTest(initial=initial, operation=method_name):
                    with self.assertRaisesRegex(RuntimeError, r"harbor or pier"):
                        getattr(authority, method_name)("other")
                    if initial is None:
                        with self.assertRaisesRegex(RuntimeError, r"not installed"):
                            authority.current_framework()
                    else:
                        self.assertEqual(authority.current_framework(), initial)
testing.main(exit=False) if __name__ == "__main__" else None
