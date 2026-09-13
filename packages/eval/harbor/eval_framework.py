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

"""Authoritative Eval harness framework selection.

`run_trial.py` validates the argv framework and installs it here before Harbor,
Pier, or the shared relay can import. The relay must not read the environment.
"""

from __future__ import annotations

_FRAMEWORKS = frozenset({"harbor", "pier"})
_framework: str | None = None


def install(framework: str) -> None:
    if framework not in _FRAMEWORKS:
        raise RuntimeError("framework must be harbor or pier")
    global _framework
    _framework = framework


def selected() -> str:
    if _framework not in _FRAMEWORKS:
        raise RuntimeError("Eval framework selection is not installed")
    return _framework
