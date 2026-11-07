// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements. See NOTICE. Licensed under the Apache
// License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0
import AppKit
import ApplicationServices
import Carbon
import CoreImage

let args = CommandLine.arguments
let command = args.count > 1 ? args[1] : ""
let argument = args.count > 2 ? args[2] : ""
func output(_ value: String) { print(value) }
func fail(_ message: String) -> Never { fputs(message + "\n", stderr); exit(1) }

var shortcutRefs: [EventHotKeyRef] = []
var shortcutIDs: [UInt32: String] = [:]
func emit(_ object: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: object) { FileHandle.standardOutput.write(data + Data([10])) }
}
func shortcut(_ name: String) throws -> (UInt32, UInt32) {
    var keys: [String:UInt32] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"l":37,"j":38,"k":40,"n":45,"m":46,"space":49,"enter":36,"tab":48,"escape":53,"up":126,"down":125,"left":123,"right":124]
    keys.merge(["return":36,"backspace":51,"delete":117,"home":115,"end":119,"pageup":116,"pagedown":121,"minus":27,"-":27,"plus":24,"=":24,"[":33,"]":30,"\\":42,";":41,"'":39,",":43,".":47,"/":44,"`":50]) { _, new in new }
    let functionCodes: [UInt32] = [122,120,99,118,96,97,98,100,101,109,103,111,105,107,113,106,64,79,80,90]
    for (i, code) in functionCodes.enumerated() { keys["f\(i+1)"] = code }
    let parts = name.lowercased().split(separator:"+").map(String.init)
    guard let last = parts.last, let key = keys[last], (parts.count > 1 || last.hasPrefix("f")) else { throw NSError(domain:"Invalid shortcut",code:1) }
    var mods: UInt32 = 0
    for part in parts.dropLast() {
        switch part {
        case "alt", "option": mods |= UInt32(optionKey)
        case "command", "cmd", "meta", "mod", "commandorcontrol": mods |= UInt32(cmdKey)
        case "ctrl", "control": mods |= UInt32(controlKey)
        case "shift": mods |= UInt32(shiftKey)
        default: throw NSError(domain:"Invalid shortcut modifier",code:1)
        }
    }
    return (key,mods)
}
func installShortcuts(_ bindings: [String:String]) throws {
    var next: [EventHotKeyRef] = [], ids: [UInt32:String] = [:]
    var assigned = Set<UInt64>()
    // Carbon refuses conflicting exclusive registrations. Unregister the previous set, then
    // restore it if any requested binding cannot be registered.
    for ref in shortcutRefs { UnregisterEventHotKey(ref) }; shortcutRefs = []; shortcutIDs = [:]
    do {
        for (index, binding) in bindings.sorted(by: { $0.key < $1.key }).enumerated() {
            let (key,mods) = try shortcut(binding.value)
            guard assigned.insert(UInt64(mods) << 32 | UInt64(key)).inserted else {
                throw NSError(domain:"Shortcut is already assigned: " + binding.value, code:1)
            }
            let id = UInt32(index + 1)
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(key,mods,EventHotKeyID(signature:0x4d514b54,id:id),GetApplicationEventTarget(),binding.key == "toggle" ? 0 : UInt32(kEventHotKeyExclusive),&ref)
            guard status == noErr, let registered = ref else { throw NSError(domain:"Shortcut is unavailable: " + binding.value,code:Int(status)) }
            next.append(registered); ids[id] = binding.key
        }
        shortcutRefs = next; shortcutIDs = ids
    } catch { for ref in next { UnregisterEventHotKey(ref) }; throw error }
}
struct Mark {
    let kind: String
    var start: NSPoint
    var end: NSPoint
    let color: NSColor
    let text: String
}
final class AnnotationCanvas: NSView {
    override var isFlipped: Bool { true }
    let image: NSImage
    var marks: [Mark] = []
    var pending: Mark?
    var mode = "rectangle", caption = ""
    var ink = NSColor.systemRed
    init(image: NSImage, frame: NSRect) { self.image=image;super.init(frame:frame) }
    required init?(coder: NSCoder) { fatalError("not decoded") }
    func drawContent() {
        image.draw(in:bounds,from:.zero,operation:.copy,fraction:1,respectFlipped:true,hints:nil)
        for mark in marks + (pending.map{[$0]} ?? []) {
            let rect=NSRect(x:min(mark.start.x,mark.end.x),y:min(mark.start.y,mark.end.y),width:abs(mark.end.x-mark.start.x),height:abs(mark.end.y-mark.start.y))
            mark.color.setStroke();mark.color.setFill()
            let path=NSBezierPath();path.lineWidth=3
            switch mark.kind {
            case "rectangle":path.appendRect(rect);path.stroke()
            case "ellipse":path.appendOval(in:rect);path.stroke()
            case "arrow":
                path.move(to:mark.start);path.line(to:mark.end)
                let angle=atan2(mark.end.y-mark.start.y,mark.end.x-mark.start.x)
                for delta in [-0.5,0.5] {
                    path.move(to:mark.end);path.line(to:NSPoint(x:mark.end.x-14*cos(angle+delta),y:mark.end.y-14*sin(angle+delta)))
                };path.stroke()
            case "text":(mark.text as NSString).draw(at:mark.start,withAttributes:[.font:NSFont.systemFont(ofSize:20,weight:.semibold),.foregroundColor:mark.color])
            case "mosaic":
                guard rect.width>0,rect.height>0,let original=image.cgImage(forProposedRect:nil,context:nil,hints:nil) else {continue}
                let sx=CGFloat(original.width)/bounds.width,sy=CGFloat(original.height)/bounds.height
                let crop=CGRect(x:rect.minX*sx,y:rect.minY*sy,width:rect.width*sx,height:rect.height*sy).intersection(CGRect(x:0,y:0,width:original.width,height:original.height))
                guard let part=original.cropping(to:crop),let filter=CIFilter(name:"CIPixellate") else {continue}
                let input=CIImage(cgImage:part);filter.setValue(input.clampedToExtent(),forKey:kCIInputImageKey);filter.setValue(12*sx,forKey:kCIInputScaleKey)
                if let output=filter.outputImage,let pixelated=CIContext().createCGImage(output,from:input.extent) {
                    NSImage(cgImage:pixelated,size:rect.size).draw(in:rect,from:.zero,operation:.copy,fraction:1,respectFlipped:true,hints:nil)
                }
            default:break
            }
        }
    }
    override func draw(_ dirtyRect:NSRect) {drawContent()}
    override func mouseDown(with event:NSEvent) {
        let point=convert(event.locationInWindow,from:nil)
        let mark=Mark(kind:mode,start:point,end:point,color:ink,text:caption)
        if mode=="text" {if !caption.isEmpty {marks.append(mark)}} else {pending=mark}
        needsDisplay=true
    }
    override func mouseDragged(with event:NSEvent) {
        let point=convert(event.locationInWindow,from:nil)
        pending?.end=NSPoint(x:max(0,min(bounds.width,point.x)),y:max(0,min(bounds.height,point.y)));needsDisplay=true
    }
    override func mouseUp(with event:NSEvent) {if let mark=pending {marks.append(mark)};pending=nil;needsDisplay=true}
    func png() throws -> Data {
        guard let original=image.cgImage(forProposedRect:nil,context:nil,hints:nil),let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:original.width,pixelsHigh:original.height,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0),let graphic=NSGraphicsContext(bitmapImageRep:bitmap) else {throw NSError(domain:"Image export failed",code:1)}
        let context=graphic.cgContext
        context.translateBy(x:0,y:CGFloat(original.height));context.scaleBy(x:CGFloat(original.width)/bounds.width,y:-CGFloat(original.height)/bounds.height)
        NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(cgContext:context,flipped:true)
        drawContent();NSGraphicsContext.restoreGraphicsState()
        guard let data=bitmap.representation(using:.png,properties:[:]) else {throw NSError(domain:"PNG export failed",code:1)}
        return data
    }
}
final class ImageWindow: NSObject, NSWindowDelegate {
    let window:NSWindow
    var canvas:AnnotationCanvas?
    let english:Bool
    var displayedImage:NSImage
    init(image:NSImage,pinned:Bool,english:Bool) {
        self.english=english;self.displayedImage=image
        let maxSize=NSSize(width:1000,height:650),ratio=min(1,min(maxSize.width/image.size.width,maxSize.height/image.size.height))
        let size=NSSize(width:max(320,image.size.width*ratio),height:max(160,image.size.height*ratio))
        window=NSPanel(contentRect:NSRect(origin:.zero,size:NSSize(width:size.width,height:size.height+(pinned ? 0:76))),styleMask:pinned ? [.titled,.closable,.resizable,.nonactivatingPanel]:[.titled,.closable],backing:.buffered,defer:false)
        super.init()
        window.title=english ? (pinned ? "Pinned image":"Screenshot annotation"):(pinned ? "图片置顶":"截图标注")
        window.delegate=self;window.isReleasedWhenClosed=false;window.level = .floating
        window.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary]
        if pinned {
            let view=NSImageView(frame:NSRect(origin:.zero,size:size));view.image=image;view.imageScaling = .scaleProportionallyUpOrDown;view.autoresizingMask=[.width,.height];window.contentView=view
            view.menu=imageMenu()
            window.isMovableByWindowBackground=true
        } else {
            let content=NSView(frame:NSRect(origin:.zero,size:NSSize(width:size.width,height:size.height+76)))
            let drawing=AnnotationCanvas(image:image,frame:NSRect(x:0,y:0,width:size.width,height:size.height));canvas=drawing;content.addSubview(drawing)
            let modes=NSPopUpButton(frame:NSRect(x:8,y:size.height+40,width:130,height:28))
            modes.addItems(withTitles:english ? ["Rectangle","Ellipse","Arrow","Text","Mosaic"]:["矩形","椭圆","箭头","文字","马赛克"])
            modes.target=self;modes.action=#selector(changeMode(_:));content.addSubview(modes)
            let colors=NSPopUpButton(frame:NSRect(x:146,y:size.height+40,width:100,height:28));colors.addItems(withTitles:english ? ["Red","Blue","Green","White"]:["红色","蓝色","绿色","白色"]);colors.target=self;colors.action=#selector(changeColor(_:));content.addSubview(colors)
            let text=NSTextField(frame:NSRect(x:254,y:size.height+40,width:max(50,size.width-262),height:28));text.placeholderString=english ? "Text annotation":"文字标注内容";text.target=self;text.action=#selector(changeText(_:));text.delegate=self;content.addSubview(text)
            for (index,item) in [(english ? "Undo":"撤销",#selector(undoMark)),(english ? "Copy":"复制",#selector(copyImage)),(english ? "Save…":"保存…",#selector(saveImage)),(english ? "Pin":"置顶",#selector(pinImage))].enumerated() {
                let button=NSButton(frame:NSRect(x:8+CGFloat(index)*78,y:size.height+6,width:74,height:28));button.title=item.0;button.target=self;button.action=item.1;button.bezelStyle = .rounded;content.addSubview(button)
            }
            window.contentView=content
        }
        window.center()
    }
    @objc func changeMode(_ sender:NSPopUpButton) {canvas?.mode=["rectangle","ellipse","arrow","text","mosaic"][sender.indexOfSelectedItem]}
    @objc func changeColor(_ sender:NSPopUpButton) {canvas?.ink=[.systemRed,.systemBlue,.systemGreen,.white][sender.indexOfSelectedItem]}
    @objc func changeText(_ sender:NSTextField) {canvas?.caption=String(sender.stringValue.prefix(1000))}
    @objc func undoMark() {if canvas?.marks.isEmpty==false {canvas?.marks.removeLast();canvas?.needsDisplay=true}}
    func imageMenu()->NSMenu {
        let menu=NSMenu()
        for item in [(english ? "Copy":"复制",#selector(copyImage)),(english ? "Save…":"保存…",#selector(saveImage))] {let action=NSMenuItem(title:item.0,action:item.1,keyEquivalent:"");action.target=self;menu.addItem(action)}
        return menu
    }
    func exported()->Data? {do{if let canvas=canvas{return try canvas.png()};return displayedImage.tiffRepresentation.flatMap{NSBitmapImageRep(data:$0)?.representation(using:.png,properties:[:])}}catch{let alert=NSAlert();alert.messageText=String(describing:error);alert.runModal();return nil}}
    @objc func copyImage() {guard let data=exported() else{return};NSPasteboard.general.clearContents();NSPasteboard.general.setData(data,forType:.png);if canvas != nil {window.close()}}
    @objc func saveImage() {guard let data=exported() else{return};let panel=NSSavePanel();panel.nameFieldStringValue="Screenshot.png";if panel.runModal() == .OK,let url=panel.url {do{try data.write(to:url,options:.atomic)}catch{let alert=NSAlert();alert.messageText=String(describing:error);alert.runModal()}}}
    @objc func pinImage() {guard let data=exported(),let image=NSImage(data:data) else{return};let view=NSImageView(frame:window.contentView!.bounds);view.image=image;view.imageScaling = .scaleProportionallyUpOrDown;view.autoresizingMask=[.width,.height];displayedImage=image;view.menu=imageMenu();window.contentView=view;canvas=nil;window.title=english ? "Pinned image":"图片置顶";window.isMovableByWindowBackground=true;window.styleMask.insert(.resizable)}
    func windowWillClose(_ notification:Notification) {NSApplication.shared.terminate(nil)}
}
extension ImageWindow:NSTextFieldDelegate {
    func controlTextDidChange(_ notification:Notification) {if let field=notification.object as? NSTextField {changeText(field)}}
}
func showImage(_ path:String,pinned:Bool,english:Bool) throws {
    let image:NSImage?
    if pinned {
        let value=try JSONSerialization.jsonObject(with:Data(contentsOf:URL(fileURLWithPath:path))) as? [String:Any]
        let text=(value?["image"] as? String)?.components(separatedBy:",").last ?? ""
        image=Data(base64Encoded:text).flatMap{NSImage(data:$0)}
    } else {image=NSImage(contentsOfFile:path)}
    guard let image=image else {throw NSError(domain:"Cannot open image",code:1)}
    let app=NSApplication.shared;app.setActivationPolicy(.accessory)
    let ui=ImageWindow(image:image,pinned:pinned,english:english)
    if args.count>4 {ui.window.appearance=NSAppearance(named:args[4]=="dark" ? .darkAqua:.aqua)}
    ui.window.makeKeyAndOrderFront(nil);if !pinned {app.activate(ignoringOtherApps:true)}
    emit(["type":"ready"])
    withExtendedLifetime(ui){app.run()}
}

switch command {
case "annotation-test":
    let image=NSImage(size:NSSize(width:640,height:400))
    image.lockFocus();NSColor.white.setFill();NSRect(x:0,y:0,width:640,height:400).fill();NSColor.systemBlue.setFill();NSRect(x:0,y:200,width:640,height:200).fill();image.unlockFocus()
    let canvas=AnnotationCanvas(image:image,frame:NSRect(x:0,y:0,width:320,height:200))
    canvas.marks=[Mark(kind:"rectangle",start:NSPoint(x:10,y:10),end:NSPoint(x:100,y:70),color:.systemRed,text:""),Mark(kind:"arrow",start:NSPoint(x:140,y:30),end:NSPoint(x:220,y:80),color:.systemRed,text:""),Mark(kind:"text",start:NSPoint(x:20,y:140),end:.zero,color:.black,text:"Maka 截图"),Mark(kind:"mosaic",start:NSPoint(x:220,y:60),end:NSPoint(x:280,y:130),color:.black,text:"")]
    try canvas.png().write(to:URL(fileURLWithPath:argument));output("ok")
case "edit", "pin":
    try showImage(argument,pinned:command=="pin",english:args.count>3 && args[3]=="en")
case "shortcuts":
    let shortcutApp = NSApplication.shared
    shortcutApp.setActivationPolicy(.accessory)
    var installed: [String:String] = [:]
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
        var id = EventHotKeyID()
        guard let event = event, GetEventParameter(event,EventParamName(kEventParamDirectObject),EventParamType(typeEventHotKeyID),nil,MemoryLayout<EventHotKeyID>.size,nil,&id) == noErr, let name = shortcutIDs[id.id] else { return OSStatus(eventNotHandledErr) }
        let app = NSWorkspace.shared.frontmostApplication
        emit(["type":"shortcut","id":name,"source":["pid":app?.processIdentifier ?? 0,"bundle":app?.bundleIdentifier ?? "","name":app?.localizedName ?? ""]])
        return noErr
    },1,&spec,nil,nil)
    DispatchQueue.global().async {
        while let line = readLine() {
            guard let data = line.data(using:.utf8), let request = try? JSONSerialization.jsonObject(with:data) as? [String:Any], let bindings = request["bindings"] as? [String:String] else { continue }
            DispatchQueue.main.async {
                let previous = installed
                do { try installShortcuts(bindings); installed = bindings; emit(["type":"configured","request":request["request"] ?? "","ok":true]) }
                catch { try? installShortcuts(previous); emit(["type":"configured","request":request["request"] ?? "","ok":false,"error":String(describing:error)]) }
            }
        }
        exit(0)
    }
    var previousFlags: UInt64 = 0
    let flagsTimer = Timer.scheduledTimer(withTimeInterval:0.04,repeats:true) { _ in
        let flags = CGEventSource.flagsState(.combinedSessionState).rawValue
        if flags != previousFlags { previousFlags = flags; emit(["type":"modifiers","command":(flags & CGEventFlags.maskCommand.rawValue) != 0]) }
    }
    // Carbon hotkeys require the application event pump, not just timer delivery.
    RunLoop.current.add(flagsTimer,forMode:.common)
    shortcutApp.run()

case "watch":
    // EOF on the parent's pipe also retires the observer after an app crash.
    DispatchQueue.global().async {
        _ = FileHandle.standardInput.readDataToEndOfFile()
        exit(0)
    }
    let board = NSPasteboard.general
    var previous = -1
    func emitChange() {
        guard board.changeCount != previous else { return }
        previous = board.changeCount
        let frontmost = NSWorkspace.shared.frontmostApplication
        let event: [String: Any] = ["bundle": frontmost?.bundleIdentifier ?? "", "name": frontmost?.localizedName ?? ""]
        if let data = try? JSONSerialization.data(withJSONObject: event) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
    }
    emitChange()
    let timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in emitChange() }
    RunLoop.current.add(timer, forMode: .common)
    RunLoop.current.run()
case "clipboard-read":
    let board = NSPasteboard.general
    let types = Set((board.types ?? []).map { $0.rawValue })
    let sensitive = !types.isDisjoint(with: ["org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType"])
    var value: [String: Any] = ["sensitive": sensitive]
    if !sensitive {
        if let image = NSImage(pasteboard: board), let tiff = image.tiffRepresentation,
           let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]), png.count <= 4 * 1024 * 1024 {
            value["image"] = "data:image/png;base64," + png.base64EncodedString()
        } else if let text = board.string(forType: .string), text.utf8.count <= 1024 * 1024 { value["text"] = text }
    }
    output(String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)!)
case "clipboard-write", "clipboard-write-file":
    let data = command == "clipboard-write-file" ? try Data(contentsOf: URL(fileURLWithPath: argument)) : FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 8 * 1024 * 1024 else { fail("Clipboard content is too large") }
    let value = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let board = NSPasteboard.general
    if let image = value["image"] as? String, image.hasPrefix("data:image/png;base64,"),
       let bytes = Data(base64Encoded: String(image.dropFirst(22))), let parsed = NSImage(data: bytes) {
        board.clearContents(); board.writeObjects([parsed])
    } else if let text = value["text"] as? String { board.clearContents(); board.setString(text, forType: .string) }
    else { fail("Invalid clipboard content") }
case "frontmost":
    if let app = NSWorkspace.shared.frontmostApplication {
        let result: [String: Any] = ["pid": app.processIdentifier, "bundle": app.bundleIdentifier ?? "", "name": app.localizedName ?? ""]
        output(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    }
case "activate", "paste":
    guard let pid = Int32(argument), pid > 0, let app = NSRunningApplication(processIdentifier: pid) else { fail("原应用已退出，请手动粘贴。") }
    if command == "paste" && !AXIsProcessTrusted() { fail("内容已复制。请为 Maka 开启辅助功能权限，或手动粘贴。") }
    if command == "activate" {
        guard app.activate(options: []) else { fail("无法恢复原应用，请手动粘贴。") }
    } else {
        // The nonactivating panel keeps its source app active. If the user
        // switched applications, cancel rather than pull an old app forward.
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            fail("焦点已切换，内容已复制，请手动粘贴。")
        }
    }
    // AppKit caches running-application state until the main run loop advances.
    // Sleeping here can report the old foreground app for the entire timeout.
    let deadline = Date().addingTimeInterval(0.6)
    repeat {
        RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { break }
    } while Date() < deadline
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
        fail("原应用未获得焦点，已取消自动粘贴。")
    }
    if command == "paste" {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else {
            fail("焦点已切换，已取消自动粘贴。")
        }
        let source = CGEventSource(stateID: .combinedSessionState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else { fail("无法发送粘贴按键。") }
        down.flags = .maskCommand; up.flags = .maskCommand
        // Bind delivery to the captured process. A foreground change between
        // the check and event dispatch must not paste into an unrelated app.
        down.postToPid(pid); up.postToPid(pid)
        // Event posting is asynchronous. Keep this short-lived helper alive
        // while WindowServer dispatches the key pair to the restored app.
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
case "trusted": output(AXIsProcessTrusted() ? "true" : "false")
case "app-icons":
    let paths = try JSONSerialization.jsonObject(with: Data(argument.utf8)) as! [String]
    guard paths.count <= 40 else { fail("Too many icon requests") }
    let icons = paths.map { path -> String in
        guard path.hasSuffix(".app"), FileManager.default.fileExists(atPath: path),
              let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 64, pixelsHigh: 64, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return "" }
        let icon = NSWorkspace.shared.icon(forFile: path)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        icon.draw(in: NSRect(x: 0, y: 0, width: 64, height: 64), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return "" }
        return "data:image/png;base64," + png.base64EncodedString()
    }
    output(String(data: try JSONSerialization.data(withJSONObject: icons), encoding: .utf8)!)
case "transliterate":
    let names = try JSONSerialization.jsonObject(with: Data(argument.utf8)) as! [String]
    let result = names.map { name -> String in
        let latin = name.applyingTransform(.mandarinToLatin, reverse: false)?.applyingTransform(.stripDiacritics, reverse: false) ?? name
        let initials = latin.split(separator: " ").compactMap { $0.first }.map(String.init).joined()
        return latin + " " + latin.replacingOccurrences(of: " ", with: "") + " " + initials
    }
    output(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
default: fail("Unknown command")
}
