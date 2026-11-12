"""Activate the test process's button through the public AT-SPI interface."""

import ctypes
import os
import sys
import time

atspi = ctypes.CDLL("libatspi.so.0")
gobject = ctypes.CDLL("libgobject-2.0.so.0")
glib = ctypes.CDLL("libglib-2.0.so.0")
pointer = ctypes.c_void_p
integer = ctypes.c_int


def bind(library, name, result, arguments):
    function = getattr(library, name)
    function.restype = result
    function.argtypes = arguments
    return function


initialize = bind(atspi, "atspi_init", integer, [])
desktop = bind(atspi, "atspi_get_desktop", pointer, [integer])
child_count = bind(atspi, "atspi_accessible_get_child_count", integer, [pointer, pointer])
child_at = bind(atspi, "atspi_accessible_get_child_at_index", pointer, [pointer, integer, pointer])
process_id = bind(atspi, "atspi_accessible_get_process_id", ctypes.c_uint, [pointer, pointer])
get_name = bind(atspi, "atspi_accessible_get_name", pointer, [pointer, pointer])
get_action = bind(atspi, "atspi_accessible_get_action_iface", pointer, [pointer])
action_count = bind(atspi, "atspi_action_get_n_actions", integer, [pointer, pointer])
action_name = bind(atspi, "atspi_action_get_action_name", pointer, [pointer, integer, pointer])
do_action = bind(atspi, "atspi_action_do_action", integer, [pointer, integer, pointer])
reference = bind(gobject, "g_object_ref", pointer, [pointer])
unref = bind(gobject, "g_object_unref", None, [pointer])
free = bind(glib, "g_free", None, [pointer])


def string(function, *arguments):
    value = function(*arguments, None)
    assert value, "AT-SPI string query failed"
    try:
        return ctypes.string_at(value).decode()
    finally:
        free(value)


def find_button(node):
    if string(get_name, node) == "Activate":
        return reference(node)
    count = child_count(node, None)
    assert count >= 0, "AT-SPI child query failed"
    for index in range(count):
        child = child_at(node, index, None)
        assert child, "AT-SPI child disappeared"
        try:
            found = find_button(child)
            if found:
                return found
        finally:
            unref(child)
    return None


assert initialize() == 0, "AT-SPI initialization failed"
root = desktop(0)
assert root, "AT-SPI desktop is missing"
button = None
try:
    deadline = time.monotonic() + 3
    while not button and time.monotonic() < deadline:
        count = child_count(root, None)
        assert count >= 0, "AT-SPI desktop query failed"
        for index in range(count):
            application = child_at(root, index, None)
            assert application, "AT-SPI application disappeared"
            try:
                if process_id(application, None) == os.getppid():
                    button = find_button(application)
                    if button:
                        break
            finally:
                unref(application)
        if not button:
            time.sleep(0.02)
    assert button, "test process's accessible button is missing"
    action = get_action(button)
    assert action, "button has no AT-SPI Action interface"
    try:
        def attempt(expected):
            count = action_count(action, None)
            assert count == expected, f"expected {expected} AT-SPI actions, got {count}"
            if expected:
                assert string(action_name, action, 0) == "nsh.activate"
            # Retain index 0 even when it is no longer advertised. A stale
            # client must not get success or deliver an event in that state.
            error = pointer()
            accepted = bool(do_action(action, 0, ctypes.byref(error)))
            failed = bool(error.value)
            if failed:
                bind(glib, "g_error_free", None, [pointer])(error)
            assert accepted == bool(expected), "AT-SPI activation availability differs"
            print(f"AT-SPI target_pid={os.getppid()} actions={count} accepted={accepted} error={failed}", flush=True)

        if "--interactive" in sys.argv:
            for line in sys.stdin:
                attempt(int(line))
        else:
            attempt(0 if "--blocked" in sys.argv else 1)
    finally:
        unref(action)
finally:
    if button:
        unref(button)
    unref(root)
