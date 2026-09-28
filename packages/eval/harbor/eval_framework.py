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

"""Process-local framework authority shared by the trial runner and relay."""

from __future__ import annotations

from typing import NamedTuple


class FrameworkSpec(NamedTuple):
    name: str
    distribution: str
    agent_module: str


_FRAMEWORKS = {
    "harbor": FrameworkSpec("harbor", "harbor", "harbor.agents.base"),
    "pier": FrameworkSpec("pier", "datacurve-pier", "pier.agents.base"),
}
_active: FrameworkSpec | None = None


def framework_spec(name: str) -> FrameworkSpec:
    try:
        return _FRAMEWORKS[name]
    except KeyError:
        raise RuntimeError("framework must be harbor or pier")


def install(name: str) -> None:
    """Select the framework before importing its process-wide relay module."""

    global _active
    _active = framework_spec(name)


def current_framework() -> str:
    if _active is None:
        raise RuntimeError("Eval framework selection is not installed")
    return _active.name


def framework_distribution(name: str) -> str:
    return framework_spec(name).distribution


def framework_agent_module(name: str) -> str:
    return framework_spec(name).agent_module
