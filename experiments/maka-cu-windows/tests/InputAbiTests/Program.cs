/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

using System.Runtime.InteropServices;

var pointerSize = IntPtr.Size;
var expectedInput = pointerSize == 8 ? 40 : 28;
var expectedUnion = pointerSize == 8 ? 32 : 24;
var expectedMouse = pointerSize == 8 ? 32 : 24;
var expectedKeyboard = pointerSize == 8 ? 24 : 16;

Assert(InputAbi.InputSize == expectedInput,
    $"INPUT size: expected {expectedInput}, got {InputAbi.InputSize}");
Assert(InputAbi.UnionSize == expectedUnion,
    $"INPUT union size: expected {expectedUnion}, got {InputAbi.UnionSize}");
Assert(InputAbi.MouseInputSize == expectedMouse,
    $"MOUSEINPUT size: expected {expectedMouse}, got {InputAbi.MouseInputSize}");
Assert(InputAbi.KeyboardInputSize == expectedKeyboard,
    $"KEYBDINPUT size: expected {expectedKeyboard}, got {InputAbi.KeyboardInputSize}");
Assert(InputAbi.HardwareInputSize == 8,
    $"HARDWAREINPUT size: expected 8, got {InputAbi.HardwareInputSize}");
Assert(InputAbi.TypeOffset == 0, $"INPUT.type offset: {InputAbi.TypeOffset}");
Assert(InputAbi.UnionOffset == (pointerSize == 8 ? 8 : 4),
    $"INPUT union offset: {InputAbi.UnionOffset}");
Assert(InputAbi.SendInputCbSize == InputAbi.InputSize,
    "SendInput cbSize must equal Marshal.SizeOf<INPUT>()");
Console.WriteLine($"PASS INPUT ABI: pointerSize={pointerSize}, input={InputAbi.InputSize}, union={InputAbi.UnionSize}, cbSize={InputAbi.SendInputCbSize}");

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
