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

import asyncio
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
        expected = {"harbor": "harbor", "pier": "datacurve-pier"}

        for name, distribution in expected.items():
            with self.subTest(name=name):
                authority.activate(name)
                self.assertEqual(authority.current_framework(), name)
                self.assertEqual(authority.framework_distribution(name), distribution)

    def test_invalid_names_cannot_mutate_or_enter_the_context(self) -> None:
        authority = fresh_authority()
        invalid_operations = (
            lambda: authority.activate("other"),
            lambda: authority.framework_distribution("other"),
            lambda: authority.framework_scope("other").__enter__(),
        )

        for operation in invalid_operations:
            with self.subTest(operation=operation):
                with self.assertRaisesRegex(RuntimeError, "harbor or pier"):
                    operation()
                with self.assertRaisesRegex(RuntimeError, "not installed"):
                    authority.current_framework()

    def test_scope_restores_its_caller_when_work_fails(self) -> None:
        authority = fresh_authority()
        authority.activate("harbor")

        with self.assertRaisesRegex(ValueError, "trial failed"):
            with authority.framework_scope("pier") as selected:
                self.assertEqual(selected, "pier")
                self.assertEqual(authority.current_framework(), "pier")
                raise ValueError("trial failed")

        self.assertEqual(authority.current_framework(), "harbor")

    def test_each_async_task_owns_its_selection(self) -> None:
        authority = fresh_authority()

        async def select_after_peer(name: str, own: asyncio.Event, peer: asyncio.Event) -> str:
            authority.activate(name)
            own.set()
            await peer.wait()
            return authority.current_framework()

        async def exercise() -> list[str]:
            harbor_ready = asyncio.Event()
            pier_ready = asyncio.Event()
            return await asyncio.gather(
                select_after_peer("harbor", harbor_ready, pier_ready),
                select_after_peer("pier", pier_ready, harbor_ready),
            )

        self.assertEqual(asyncio.run(exercise()), ["harbor", "pier"])


if __name__ == "__main__":
    unittest.main()
