#!/usr/bin/env python3
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
"""Independent, task-owned X11 geometry and button observer.

The fixture creates and configures only its two windows. It never synthesizes
pointer, keyboard, accessibility, or clipboard input. Its private Unix control
socket is available only inside the caller's disposable desktop container.
"""
import argparse
import ctypes as c
import json
from pathlib import Path
import select
import socket
import time
import os


Pointer, ULong, Int = c.c_void_p, c.c_ulong, c.c_int


class ButtonEvent(c.Structure):
    _fields_ = [
        ("type", Int), ("serial", ULong), ("send_event", Int),
        ("display", Pointer), ("window", ULong), ("root", ULong),
        ("subwindow", ULong), ("time", ULong), ("x", Int), ("y", Int),
        ("x_root", Int), ("y_root", Int), ("state", c.c_uint),
        ("button", c.c_uint), ("same_screen", Int),
    ]


class ConfigureEvent(c.Structure):
    _fields_ = [
        ("type", Int), ("serial", ULong), ("send_event", Int),
        ("display", Pointer), ("event", ULong), ("window", ULong),
        ("x", Int), ("y", Int), ("width", Int), ("height", Int),
        ("border_width", Int), ("above", ULong), ("override_redirect", Int),
    ]


class Event(c.Union):
    _fields_ = [("type", Int), ("button", ButtonEvent),
                ("configure", ConfigureEvent), ("padding", c.c_long * 24)]


class WindowAttributes(c.Structure):
    _fields_ = [
        ("x", Int), ("y", Int), ("width", Int), ("height", Int),
        ("border_width", Int), ("depth", Int), ("visual", Pointer),
        ("root", ULong), ("window_class", Int), ("bit_gravity", Int),
        ("win_gravity", Int), ("backing_store", Int),
        ("backing_planes", ULong), ("backing_pixel", ULong),
        ("save_under", Int), ("colormap", ULong), ("map_installed", Int),
        ("map_state", Int), ("all_event_masks", c.c_long),
        ("your_event_mask", c.c_long), ("do_not_propagate_mask", c.c_long),
        ("override_redirect", Int), ("screen", Pointer),
    ]


class Fixture:
    def __init__(self, cases, output):
        self.output = output
        self.log = (output / "observer.jsonl").open("x", buffering=1)
        self.x = c.CDLL("libX11.so.6")
        self.methods = {}
        self.display = self.fn("XOpenDisplay", [c.c_char_p], Pointer)(None)
        if not self.display:
            raise RuntimeError("disposable X11 DISPLAY is required")
        self.screen = self.fn("XDefaultScreen", [Pointer], Int)(self.display)
        self.root = self.fn("XRootWindow", [Pointer, Int], ULong)(self.display, self.screen)
        self.xfd = self.fn("XConnectionNumber", [Pointer], Int)(self.display)
        self.sequence = 0
        self.events = []
        self.windows = {}
        self.configure = {}
        self.initial = {
            "target": cases["fixture"]["initial_target"],
            "sibling": cases["fixture"]["sibling"],
        }
        self.requested = {role: dict(geometry) for role, geometry in self.initial.items()}
        for role, geometry in self.initial.items():
            self.create(role, geometry)
        self.sync()

    def fn(self, name, args, result):
        if name not in self.methods:
            method = getattr(self.x, name)
            method.argtypes = args
            method.restype = result
            self.methods[name] = method
        return self.methods[name]

    def row(self, kind, **value):
        self.log.write(json.dumps({"kind": kind, "monotonic_ns": time.monotonic_ns(),
                                   **value}, sort_keys=True) + "\n")

    def atom(self, name):
        return self.fn("XInternAtom", [Pointer, c.c_char_p, Int], ULong)(
            self.display, name.encode(), 0)

    def create(self, role, geometry):
        window = self.fn("XCreateSimpleWindow", [
            Pointer, ULong, Int, Int, c.c_uint, c.c_uint,
            c.c_uint, ULong, ULong,
        ], ULong)(self.display, self.root, geometry["x"], geometry["y"],
                  geometry["width"], geometry["height"], 0, 0,
                  0x234567 if role == "target" else 0x93BA57)
        if not window:
            raise RuntimeError("fixture XCreateSimpleWindow failed")
        title = f"Maka shared native geometry {role}"
        self.windows[role] = {"window_id": window, "pid": os.getpid(), "title": title}
        self.fn("XStoreName", [Pointer, ULong, c.c_char_p], Int)(
            self.display, window, title.encode())
        change = self.fn("XChangeProperty", [
            Pointer, ULong, ULong, ULong, Int, Int, Pointer, Int,
        ], Int)
        pid = ULong(os.getpid())
        change(self.display, window, self.atom("_NET_WM_PID"), self.atom("CARDINAL"),
               32, 0, c.byref(pid), 1)
        for key, value, kind in (
            ("_NET_WM_NAME", title.encode(), "UTF8_STRING"),
            ("WM_CLASS", b"maka-geometry-fixture\0MakaGeometryFixture\0", "STRING"),
        ):
            data = c.create_string_buffer(value)
            change(self.display, window, self.atom(key), self.atom(kind),
                   8, 0, data, len(value))
        self.fn("XSelectInput", [Pointer, ULong, c.c_long], Int)(
            self.display, window, (1 << 2) | (1 << 3) | (1 << 17))
        self.fn("XMapWindow", [Pointer, ULong], Int)(self.display, window)
        self.row("created", role=role, **self.windows[role], requested_geometry=geometry)

    def drain(self):
        event = Event()
        pending = self.fn("XPending", [Pointer], Int)
        next_event = self.fn("XNextEvent", [Pointer, c.POINTER(Event)], Int)
        while pending(self.display):
            next_event(self.display, c.byref(event))
            if event.type in (4, 5):
                button = event.button
                role = next((name for name, item in self.windows.items()
                             if item["window_id"] == button.window), None)
                if role is None:
                    raise RuntimeError(f"event on a window not created by fixture: {button.window}")
                self.sequence += 1
                row = {"sequence": self.sequence, "window_role": role,
                       "window_id": button.window, "type": "press" if button.type == 4 else "release",
                       "button": button.button, "event_x": button.x, "event_y": button.y,
                       "send_event": bool(button.send_event), "x_timestamp_ms": button.time,
                       "monotonic_ns": time.monotonic_ns()}
                self.events.append(row)
                self.row("button", event=row)
            elif event.type == 22:
                configure = event.configure
                role = next((name for name, item in self.windows.items()
                             if item["window_id"] == configure.window), None)
                if role is not None:
                    self.configure[role] = self.configure.get(role, 0) + 1
                    self.row("configure", window_role=role, window_id=configure.window,
                             x=configure.x, y=configure.y, width=configure.width,
                             height=configure.height, send_event=bool(configure.send_event))

    def sync(self):
        self.fn("XSync", [Pointer, Int], Int)(self.display, 0)
        self.drain()

    def geometry(self, role):
        window = self.windows[role]["window_id"]
        root, child = ULong(), ULong()
        x, y, root_x, root_y = Int(), Int(), Int(), Int()
        width, height, border, depth = c.c_uint(), c.c_uint(), c.c_uint(), c.c_uint()
        if not self.fn("XGetGeometry", [
            Pointer, ULong, c.POINTER(ULong), c.POINTER(Int), c.POINTER(Int),
            c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint), c.POINTER(c.c_uint),
        ], Int)(self.display, window, c.byref(root), c.byref(x), c.byref(y),
                c.byref(width), c.byref(height), c.byref(border), c.byref(depth)):
            raise RuntimeError("fixture window geometry unavailable")
        if not self.fn("XTranslateCoordinates", [
            Pointer, ULong, ULong, Int, Int, c.POINTER(Int), c.POINTER(Int), c.POINTER(ULong),
        ], Int)(self.display, window, self.root, 0, 0,
                c.byref(root_x), c.byref(root_y), c.byref(child)):
            raise RuntimeError("fixture window root coordinates unavailable")
        attributes = WindowAttributes()
        if not self.fn("XGetWindowAttributes", [Pointer, ULong, c.POINTER(WindowAttributes)], Int)(
                self.display, window, c.byref(attributes)):
            raise RuntimeError("fixture window attributes unavailable")
        return {**self.windows[role], "window_role": role,
                "geometry": {"x": root_x.value, "y": root_y.value,
                             "width": width.value, "height": height.value,
                             "border": border.value, "depth": depth.value},
                "mapped": attributes.map_state == 2}

    def wait_geometry(self, role, desired, moved_from=None):
        deadline = time.monotonic() + 10
        while True:
            self.sync()
            observed = self.geometry(role)
            actual = observed["geometry"]
            sized = (actual["width"], actual["height"]) == (desired["width"], desired["height"])
            moved = moved_from is None or (actual["x"], actual["y"]) != moved_from
            if observed["mapped"] and sized and moved:
                return observed
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"WM did not acknowledge fixture geometry: {desired}; {observed}")
            select.select([self.xfd], [], [], min(remaining, 0.01))

    def move_resize(self, role, desired):
        if role not in self.windows:
            raise ValueError("only the fixture's target/sibling windows can be configured")
        previous = self.geometry(role)["geometry"]
        self.fn("XMoveResizeWindow", [Pointer, ULong, Int, Int, c.c_uint, c.c_uint], Int)(
            self.display, self.windows[role]["window_id"], desired["x"], desired["y"],
            desired["width"], desired["height"])
        self.fn("XFlush", [Pointer], Int)(self.display)
        # A real WM can offset client origins by its decorations. Require the
        # actual change and requested size, then record that native geometry.
        moved_from = None
        last = self.requested[role]
        if (desired["x"], desired["y"]) != (last["x"], last["y"]):
            moved_from = previous["x"], previous["y"]
        result = self.wait_geometry(role, desired, moved_from)
        self.requested[role] = dict(desired)
        self.row("geometry_ack", window_role=role, requested=desired, actual=result)
        return result

    def snapshot(self, after=0):
        self.sync()
        root, child, focus = ULong(), ULong(), ULong()
        root_x, root_y, win_x, win_y, revert = Int(), Int(), Int(), Int(), Int()
        mask = c.c_uint()
        same_screen = self.fn("XQueryPointer", [
            Pointer, ULong, c.POINTER(ULong), c.POINTER(ULong),
            c.POINTER(Int), c.POINTER(Int), c.POINTER(Int), c.POINTER(Int), c.POINTER(c.c_uint),
        ], Int)(self.display, self.root, c.byref(root), c.byref(child), c.byref(root_x),
                c.byref(root_y), c.byref(win_x), c.byref(win_y), c.byref(mask))
        self.fn("XGetInputFocus", [Pointer, c.POINTER(ULong), c.POINTER(Int)], Int)(
            self.display, c.byref(focus), c.byref(revert))
        return {"pid": os.getpid(), "sequence": self.sequence,
                "display": {"width": self.fn("XDisplayWidth", [Pointer, Int], Int)(self.display, self.screen),
                            "height": self.fn("XDisplayHeight", [Pointer, Int], Int)(self.display, self.screen),
                            "depth": self.fn("XDefaultDepth", [Pointer, Int], Int)(self.display, self.screen)},
                "windows": {name: self.geometry(name) for name in self.windows},
                "events": [event for event in self.events if event["sequence"] > after],
                "pointer": {"same_screen": bool(same_screen), "root_x": root_x.value,
                            "root_y": root_y.value, "child": child.value, "mask": mask.value},
                "focus": {"window": focus.value, "revert_to": revert.value}}

    def command(self, request):
        command = request["command"]
        if command == "ready":
            for role, desired in self.initial.items():
                self.wait_geometry(role, desired)
        elif command == "reset":
            for role, desired in self.initial.items():
                self.move_resize(role, desired)
        elif command == "move_resize":
            self.move_resize(request["role"], {key: request[key]
                                              for key in ("x", "y", "width", "height")})
        elif command not in ("snapshot", "barrier", "shutdown"):
            raise ValueError(f"unknown fixture command: {command}")
        return self.snapshot(request.get("after_sequence", 0))

    def serve(self, path):
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(path))
            listener.listen(1)
            self.row("control_ready", socket=str(path), pid=os.getpid())
            while True:
                readable, _, _ = select.select([listener, self.xfd], [], [], 10)
                if self.xfd in readable:
                    self.drain()
                if listener in readable:
                    connection, _ = listener.accept()
                    break
            with connection, connection.makefile("rwb", buffering=0) as stream:
                for line in stream:
                    request = json.loads(line)
                    self.row("control_request", request=request)
                    try:
                        response = {"id": request["id"], "ok": True,
                                    "value": self.command(request)}
                    except Exception as error:
                        response = {"id": request.get("id"), "ok": False,
                                    "error": f"{type(error).__name__}: {error}"}
                    stream.write(json.dumps(response).encode() + b"\n")
                    self.row("control_reply", response=response)
                    if request["command"] == "shutdown" or not response["ok"]:
                        break

    def close(self):
        for item in self.windows.values():
            self.fn("XDestroyWindow", [Pointer, ULong], Int)(self.display, item["window_id"])
        self.fn("XSync", [Pointer, Int], Int)(self.display, 0)
        self.fn("XCloseDisplay", [Pointer], Int)(self.display)
        self.row("closed", pid=os.getpid())
        self.log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--cases", required=True, type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    fixture = Fixture(json.loads(args.cases.read_text()), args.output)
    try:
        fixture.serve(args.socket)
    finally:
        fixture.close()


if __name__ == "__main__":
    main()
