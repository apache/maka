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

// Prints "<windowNumber> <x> <y> <w> <h>" for the frontmost on-screen window
// owned by the application named in argv[1]. Used by scripts/screenshot.sh.
import CoreGraphics
import Foundation

// argv[1] is an application name, or a numeric process id (preferred when
// several instances of the same app are running).
let owner = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "maka-gpui"
let ownerPid = Int(owner)
let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("no window list\n".data(using: .utf8)!)
    exit(2)
}
for window in list {
    let name = window[kCGWindowOwnerName as String] as? String ?? ""
    let pid = window[kCGWindowOwnerPID as String] as? Int ?? -1
    let matches = ownerPid.map { $0 == pid } ?? (name == owner)
    guard matches,
          let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
          let number = window[kCGWindowNumber as String] as? Int,
          let bounds = window[kCGWindowBounds as String] as? [String: Any],
          let w = bounds["Width"] as? Double, let h = bounds["Height"] as? Double,
          let x = bounds["X"] as? Double, let y = bounds["Y"] as? Double, w > 200, h > 200
    else { continue }
    print("\(number) \(Int(x)) \(Int(y)) \(Int(w)) \(Int(h))")
    exit(0)
}
FileHandle.standardError.write("no on-screen window owned by \(owner)\n".data(using: .utf8)!)
exit(1)
