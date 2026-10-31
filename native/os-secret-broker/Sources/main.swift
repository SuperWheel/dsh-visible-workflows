import AppKit
import Foundation
import Darwin

func scopeDescription(_ scope: Scope) -> String {
    "存储：macOS 系统钥匙串\n工作区：\(scope.workspaceId)\n流程：\(scope.workflowId)\n变量：\(scope.variableId)\n\n密钥值只在本原生窗口和原生请求内使用，不返回工作流、聊天或 Agent 接口。这些公开标识不证明调用方身份。"
}

func prepareApp() {
    _ = NSApplication.shared
    NSApp.setActivationPolicy(.regular)
    if NSApp.mainMenu == nil {
        let menu = NSMenu(), editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let edit = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("剪切", "cut:", "x"), ("复制", "copy:", "c"), ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: NSSelectorFromString(action), keyEquivalent: key)
        }
        editItem.submenu = edit; menu.addItem(editItem); NSApp.mainMenu = menu
    }
    NSApp.activate(ignoringOtherApps: true)
}

func alert(title: String, body: String, buttons: [String]) -> NSAlert {
    let panel = NSAlert()
    panel.messageText = title
    panel.informativeText = body
    panel.alertStyle = .informational
    buttons.forEach { panel.addButton(withTitle: $0) }
    panel.window.isRestorable = false
    return panel
}

final class SecretEditor: NSObject {
    let view = NSView(frame: NSRect(x: 0, y: 0, width: 460, height: 78))
    let hidden = NSSecureTextField(frame: NSRect(x: 0, y: 42, width: 460, height: 28))
    let visible = NSTextField(frame: NSRect(x: 0, y: 42, width: 460, height: 28))
    let toggle = NSButton(checkboxWithTitle: "显示密码", target: nil, action: nil)
    private var revealed = false

    init(value: String) {
        super.init()
        hidden.stringValue = value
        hidden.placeholderString = "输入或粘贴 Secret（1–2048 UTF-8 字节）"
        visible.placeholderString = hidden.placeholderString
        visible.isHidden = true
        toggle.frame = NSRect(x: 0, y: 4, width: 140, height: 28)
        toggle.target = self
        toggle.action = #selector(changeVisibility(_:))
        view.addSubview(hidden); view.addSubview(visible); view.addSubview(toggle)
        // Standard native editing and paste remain available; no global keyboard,
        // clipboard, accessibility or other-application restrictions are installed.
    }

    @objc func changeVisibility(_ sender: NSButton) {
        view.window?.makeFirstResponder(nil)
        let next = sender.state == .on
        if next { visible.stringValue = hidden.stringValue; hidden.stringValue = "" }
        else { hidden.stringValue = visible.stringValue; visible.stringValue = "" }
        revealed = next
        hidden.isHidden = next; visible.isHidden = !next
        view.window?.makeFirstResponder(next ? visible : hidden)
    }

    var value: String {
        view.window?.makeFirstResponder(nil)
        return revealed ? visible.stringValue : hidden.stringValue
    }

    func clear() {
        view.window?.makeFirstResponder(nil)
        hidden.stringValue = ""; visible.stringValue = ""
        hidden.undoManager?.removeAllActions(); visible.undoManager?.removeAllActions()
    }
}

func manage(_ scope: Scope, store: CredentialStore) throws -> [String: Any] {
    prepareApp()
    let session = try OwnerSession.authenticate(scope: scope)
    defer { session.invalidate() }
    let previous: StoredCredential?
    if try store.exists() { previous = try store.readForManagement(session: session) }
    else { previous = nil }
    let current = try store.status()
    let editor = SecretEditor(value: previous?.value ?? "")
    defer { editor.clear() }
    let permission = current.authorization == .authorized ? "已授权自动使用" : "尚未授权自动使用"
    let target = "\n\n自动使用：\(permission)\n固定目标：GET \(fixedEndpoint)\n仅为此工作流的此变量添加 Bearer 请求头，只返回 HTTP 状态码。授权持续到手动撤销；修改凭据或目标后需重新授权。撤销不能取消已经发出的请求。\n\n“仅保存”会撤销旧授权；“保存并授权自动使用”会保存新值，并明确授权上述后台请求，不再逐次弹窗。"
    let panel = alert(title: "管理工作流 Secret", body: scopeDescription(scope) + target,
                      buttons: ["仅保存", "保存并授权自动使用", "撤销自动使用", "删除", "关闭"])
    panel.accessoryView = editor.view
    panel.window.initialFirstResponder = editor.hidden
    panel.buttons[2].isEnabled = current.authorization == .authorized
    panel.buttons[3].isEnabled = previous != nil
    let choice = panel.runModal()
    func response(_ state: String) throws -> [String: Any] {
        ["ok": true, "state": state, "authorization": try store.status().authorization.rawValue]
    }
    if choice.rawValue == NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + 4 { return try response("unchanged") }
    let isDelete = choice.rawValue == NSApplication.ModalResponse.alertFirstButtonReturn.rawValue + 3
    guard choice == .alertFirstButtonReturn || choice == .alertSecondButtonReturn || choice == .alertThirdButtonReturn || isDelete else { throw BrokerFailure.cancelled }
    if isDelete {
        let confirm = alert(title: "删除此 Secret？", body: "将从系统钥匙串删除此变量的值及自动使用授权；变量声明和其他变量保持不变。", buttons: ["删除", "取消"])
        guard confirm.runModal() == .alertFirstButtonReturn else { throw BrokerFailure.cancelled }
    }
    let mutation = try store.beginMutation(session: session)
    defer { mutation.release() }
    if choice == .alertThirdButtonReturn {
        try store.revokeAutomaticUse(session: session, mutation: mutation)
        return try response("revoked")
    }
    if isDelete {
        guard let previous else { throw BrokerFailure.itemMissing }
        try store.delete(expectedEpoch: previous.epoch, session: session, mutation: mutation)
        return try response("deleted")
    }
    guard choice == .alertFirstButtonReturn || choice == .alertSecondButtonReturn else { throw BrokerFailure.cancelled }
    if choice == .alertSecondButtonReturn && !SecretValue.isBearerToken(editor.value) { throw BrokerFailure.invalidRequest }
    let item = try store.save(editor.value, expectedEpoch: previous?.epoch, session: session, mutation: mutation)
    if choice == .alertSecondButtonReturn {
        try store.authorizeAutomaticUse(expectedEpoch: item.epoch, session: session, mutation: mutation)
        return try response("authorized")
    }
    return try response("saved")
}

var coreLimit = rlimit(rlim_cur: 0, rlim_max: 0)
guard setrlimit(RLIMIT_CORE, &coreLimit) == 0 else { emit(["ok": false, "code": "runtime_unsafe"]) }
let nullFD = open("/dev/null", O_WRONLY)
if nullFD >= 0 { _ = dup2(nullFD, STDERR_FILENO); close(nullFD) }
alarm(180)

do {
    guard CommandLine.arguments.count == 1 else { throw BrokerFailure.invalidRequest }
    var bytes = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: min(1024, 8193 - bytes.count)), !chunk.isEmpty {
        bytes.append(chunk)
        guard bytes.count <= 8192 else { throw BrokerFailure.invalidRequest }
    }
    let request = try Request.parse(bytes)
    let authorization = try HostAuthorization(request: bytes)
    let identity: SecurityIdentity
    do { identity = try checkOSSecretRuntime(requireOwnerAuthentication: request.command == "probe" || request.command == "manage") }
    catch let error as BrokerFailure {
        if request.command == "probe" { emit(["ok": true, "available": false, "code": error.rawValue]) }
        throw error
    }
    if request.command == "probe" { emit(["ok": true, "available": true, "code": "available"]) }
    guard let scope = request.scope else { throw BrokerFailure.invalidRequest }
    let store = CredentialStore(scope: scope, authorization: authorization)
    switch request.command {
    case "status": emit(try store.status().response)
    case "manage": emit(try manage(scope, store: store))
    case "execute":
        let item = try store.readForAutomaticUse()
        guard SecretValue.isBearerToken(item.value) else { throw BrokerFailure.invalidRequest }
        try authorization.assertLive()
        try store.assertAutomaticUseAuthorized(expectedEpoch: item.epoch)
        let status = try ControlledRequest(roots: identity.builtInRoots).perform(token: item.value)
        try authorization.assertLive()
        emit(["ok": true, "status_code": status])
    default: throw BrokerFailure.invalidRequest
    }
} catch let error as BrokerFailure {
    emit(["ok": false, "code": error.rawValue])
} catch {
    emit(["ok": false, "code": "internal_error"])
}
