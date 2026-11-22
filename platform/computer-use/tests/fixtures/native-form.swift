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

final class ClickCanvas: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    var dragged = false
    override func mouseDown(with event: NSEvent) {
        dragged = false
        let point = convert(event.locationInWindow, from: nil)
        let data = try! JSONSerialization.data(withJSONObject: ["click": [point.x, point.y]])
        FileHandle.standardOutput.write(data + Data([10]))
    }
    override func mouseDragged(with event: NSEvent) { dragged = true }
    override func mouseUp(with event: NSEvent) {
        if dragged {
            let point = convert(event.locationInWindow, from: nil)
            let data = try! JSONSerialization.data(withJSONObject: ["drag": [point.x, point.y]])
            FileHandle.standardOutput.write(data + Data([10]))
        }
    }
    override func scrollWheel(with event: NSEvent) {
        let data = try! JSONSerialization.data(withJSONObject: ["scroll": event.scrollingDeltaY, "scrollX": event.scrollingDeltaX, "pointY": event.cgEvent?.getIntegerValueField(.scrollWheelEventPointDeltaAxis1) ?? 0, "pointX": event.cgEvent?.getIntegerValueField(.scrollWheelEventPointDeltaAxis2) ?? 0, "precise": event.hasPreciseScrollingDeltas])
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var secondWindow: NSWindow?
    let name = NSTextField(string: "hello hello")
    let message = NSTextView()
    let output = NSTextField(labelWithString: "Not submitted")
    let canvas = ClickCanvas(frame: NSRect(x: 200, y: 85, width: 180, height: 32))
    let resume = DispatchSemaphore(value: 0)

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let application = NSMenuItem()
        application.submenu = NSMenu()
        menu.addItem(application)
        let editRoot = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editRoot.submenu = edit
        menu.addItem(editRoot)
        let testRoot = NSMenuItem(title: "Fixture", action: nil, keyEquivalent: "")
        let testMenu = NSMenu(title: "Fixture")
        let command = NSMenuItem(title: "Menu fixture command", action: #selector(menuCommand(_:)), keyEquivalent: "j")
        command.target = self
        command.keyEquivalentModifierMask = [.command]
        testMenu.addItem(command)
        testRoot.submenu = testMenu
        menu.addItem(testRoot)
        NSApp.mainMenu = menu

        window = NSWindow(contentRect: NSRect(x: 220, y: 220, width: 420, height: 250), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.title = "Maka Cua Form Fixture"
        window.isReleasedWhenClosed = false
        name.frame = NSRect(x: 24, y: 190, width: 360, height: 28)
        name.setAccessibilityLabel("Name")
        message.frame = NSRect(x: 24, y: 140, width: 360, height: 28)
        message.setAccessibilityLabel("Message")
        canvas.setAccessibilityElement(true)
        canvas.setAccessibilityRole(.group)
        canvas.setAccessibilityLabel("Event canvas")
        let button = NSButton(title: "Submit fixture", target: self, action: #selector(submit(_:)))
        button.frame = NSRect(x: 24, y: 85, width: 160, height: 32)
        let disabled = NSButton(title: "Disabled fixture", target: nil, action: nil)
        disabled.isEnabled = false
        disabled.frame = NSRect(x: 200, y: 60, width: 180, height: 22)
        output.frame = NSRect(x: 24, y: 25, width: 370, height: 40)
        for view in [name, message, button, output, canvas, disabled] { window.contentView!.addSubview(view) }
        if ProcessInfo.processInfo.arguments.contains("--background") {
            window.orderBack(nil)
        } else {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
        DispatchQueue.main.async { [self] in
            FileHandle.standardOutput.write(Data("ready \(window.windowNumber)\n".utf8))
        }
        DispatchQueue.global().async { [self] in
            while let command = readLine() {
                if command == "second" {
                    DispatchQueue.main.async { [self] in
                        if secondWindow == nil {
                            secondWindow = NSWindow(contentRect: NSRect(x: 680, y: 220, width: 220, height: 160), styleMask: [.titled, .closable], backing: .buffered, defer: false)
                        }
                        secondWindow!.title = "Maka Cua Second Fixture"
                        secondWindow!.makeKeyAndOrderFront(nil)
                        FileHandle.standardOutput.write(Data("second ready\n".utf8))
                    }
                }
                if command == "canvas" {
                    DispatchQueue.main.async { [self] in
                        let point = window.convertPoint(toScreen: canvas.convert(NSPoint(x: 50, y: 20), to: nil))
                        let end = window.convertPoint(toScreen: canvas.convert(NSPoint(x: 80, y: 25), to: nil))
                        let frame = window.frame
                        let data = try! JSONSerialization.data(withJSONObject: ["point": [(point.x - frame.minX) / frame.width, (frame.maxY - point.y) / frame.height], "end": [(end.x - frame.minX) / frame.width, (frame.maxY - end.y) / frame.height]])
                        FileHandle.standardOutput.write(data + Data([10]))
                    }
                }
                if command == "probe" {
                    DispatchQueue.main.async {
                        let point = CGEvent(source: nil)!.location
                        let data = try! JSONSerialization.data(withJSONObject: ["active": NSApp.isActive, "mouse": [point.x, point.y]])
                        FileHandle.standardOutput.write(data + Data([10]))
                    }
                }
                if command == "activity" {
                    DispatchQueue.main.async {
                        FileHandle.standardOutput.write(Data((NSApp.isActive ? "active\n" : "inactive\n").utf8))
                    }
                }
                if command == "pause" {
                    DispatchQueue.main.async { [self] in
                        FileHandle.standardOutput.write(Data("paused\n".utf8))
                        resume.wait()
                        FileHandle.standardOutput.write(Data("resumed\n".utf8))
                    }
                }
                if command == "resume" { resume.signal() }
                if command == "delay350" {
                    DispatchQueue.main.async { [self] in
                        output.stringValue = "Delay pending"
                        FileHandle.standardOutput.write(Data("delay started\n".utf8))
                        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(350)) { [self] in
                            output.stringValue = "Native delay ready"
                        }
                    }
                }
                if command == "edit" {
                    DispatchQueue.main.async { [self] in
                        name.stringValue = "externally edited"
                        FileHandle.standardOutput.write(Data("edited\n".utf8))
                    }
                }
                if command == "close" {
                    DispatchQueue.main.async { [self] in
                        window.close()
                        FileHandle.standardOutput.write(Data("closed\n".utf8))
                    }
                }
                if command == "move" {
                    DispatchQueue.main.async { [self] in
                        let before = window.frame.origin
                        window.setFrameOrigin(NSPoint(x: before.x + 80, y: before.y + 70))
                        window.displayIfNeeded()
                        FileHandle.standardOutput.write(Data("moved\n".utf8))
                    }
                }
            }
        }
    }

    @objc func submit(_ sender: Any?) {
        output.stringValue = name.stringValue + " / " + message.string
        let font = message.textStorage?.attribute(.font, at: 0, effectiveRange: nil) as? NSFont
        let bold = font.map { NSFontManager.shared.traits(of: $0).contains(.boldFontMask) } ?? false
        let result = try! JSONSerialization.data(withJSONObject: ["submitted": output.stringValue, "bold": bold, "rich": message.isRichText, "font": font?.fontName ?? "none"])
        FileHandle.standardOutput.write(result + Data([10]))
    }

    @objc func menuCommand(_ sender: Any?) {
        let result = try! JSONSerialization.data(withJSONObject: ["menuWindow": NSApp.keyWindow?.windowNumber ?? -1])
        FileHandle.standardOutput.write(result + Data([10]))
    }
}
let app = NSApplication.shared
app.setActivationPolicy(ProcessInfo.processInfo.arguments.contains("--background") ? .accessory : .regular)
let fixture = Fixture()
app.delegate = fixture
app.run()
