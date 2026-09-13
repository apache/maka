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

import AppKit
import Foundation

func printApplications(bundleIdentifiers: [String]) {
    guard bundleIdentifiers.count <= 32,
          bundleIdentifiers.allSatisfy({
              $0.utf8.count <= 256 &&
                  $0.range(
                      of: "^[A-Za-z0-9][A-Za-z0-9-]*(\\.[A-Za-z0-9][A-Za-z0-9-]*)+\\z",
                      options: .regularExpression
                  ) != nil
          })
    else {
        fputs("Invalid application identifiers.\n", stderr)
        exit(2)
    }
    var seen = Set<String>()
    let applications = bundleIdentifiers.filter { seen.insert($0).inserted }.map { identifier in
        autoreleasepool { applicationMetadata(bundleIdentifier: identifier) }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: applications, options: [.sortedKeys]),
          data.count <= 2 * 1024 * 1024,
          let output = String(data: data, encoding: .utf8)
    else {
        fputs("Application metadata could not be encoded.\n", stderr)
        exit(1)
    }
    print(output)
}

private func applicationMetadata(bundleIdentifier: String) -> [String: Any] {
    let fallback: [String: Any] = [
        "bundleIdentifier": bundleIdentifier,
        "name": bundleIdentifier,
        "iconDataUrl": NSNull(),
    ]
    let workspace = NSWorkspace.shared
    // Only resolve requested, installed local bundles. Never enumerate or launch applications.
    guard let url = workspace.urlForApplication(withBundleIdentifier: bundleIdentifier),
          url.isFileURL,
          (try? url.resourceValues(forKeys: [.volumeIsLocalKey]))?.volumeIsLocal == true,
          let bundle = Bundle(url: url),
          bundle.bundleIdentifier == bundleIdentifier
    else {
        return fallback
    }
    let names = [
        bundle.localizedInfoDictionary?["CFBundleDisplayName"],
        bundle.localizedInfoDictionary?["CFBundleName"],
        bundle.infoDictionary?["CFBundleDisplayName"],
        bundle.infoDictionary?["CFBundleName"],
    ]
    let name = names.compactMap { $0 as? String }.first {
        !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            $0.utf8.count <= 512 &&
            $0.rangeOfCharacter(from: .controlCharacters) == nil
    } ?? bundleIdentifier
    let icon = pngDataUrl(workspace.icon(forFile: url.path))
    return [
        "bundleIdentifier": bundleIdentifier,
        "name": name,
        "iconDataUrl": icon as Any? ?? NSNull(),
    ]
}

private func pngDataUrl(_ image: NSImage) -> String? {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: 48,
        pixelsHigh: 48,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 48 * 4,
        bitsPerPixel: 32
    ), let context = NSGraphicsContext(bitmapImageRep: bitmap)
    else {
        return nil
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let rect = NSRect(x: 0, y: 0, width: 48, height: 48)
    NSColor.clear.setFill()
    rect.fill(using: .copy)
    image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]),
          png.count <= 48 * 1024
    else {
        return nil
    }
    return "data:image/png;base64," + png.base64EncodedString()
}
