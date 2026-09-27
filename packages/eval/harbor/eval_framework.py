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

"""Context-local framework authority shared by the trial runner and relay."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Iterator

_DISTRIBUTIONS = {"harbor": "harbor", "pier": "datacurve-pier"}
_active: ContextVar[str | None] = ContextVar("maka_eval_active_framework", default=None)


def _validate(name: str) -> str:
    if name not in _DISTRIBUTIONS:
        raise RuntimeError("framework must be harbor or pier")
    return name


def activate(name: str) -> None:
    """Set the framework for imports executed in the current context."""

    _active.set(_validate(name))


@contextmanager
def framework_scope(name: str) -> Iterator[str]:
    """Temporarily select a framework and restore the caller's selection."""

    selected_name = _validate(name)
    token = _active.set(selected_name)
    try:
        yield selected_name
    finally:
        _active.reset(token)


def current_framework() -> str:
    name = _active.get()
    if name is None:
        raise RuntimeError("Eval framework selection is not installed")
    return _validate(name)


def framework_distribution(name: str) -> str:
    return _DISTRIBUTIONS[_validate(name)]
