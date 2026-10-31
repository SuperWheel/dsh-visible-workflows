import Foundation

// A separate process exercises the actual OS scope mutex, using only temporary
// synthetic state files. It never links/calls the credential store or UI.
if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "--lock-revoker" {
    let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    try! Data("waiting".utf8).write(to: directory.appendingPathComponent("waiting"))
    let mutation = try! ScopeMutationLock.acquire(account: CommandLine.arguments[3], directory: directory, waitSeconds: 3)
    try! Data("required".utf8).write(to: directory.appendingPathComponent("synthetic-state"))
    mutation.release()
    exit(0)
}

var checks = 0
func check(_ condition: @autoclosure () -> Bool) { precondition(condition()); checks += 1 }
func rejected(_ object: Any) {
    let data = try! JSONSerialization.data(withJSONObject: object)
    do { _ = try Request.parse(data); preconditionFailure("Expected invalid protocol") }
    catch BrokerFailure.invalidRequest { checks += 1 }
    catch { preconditionFailure("Unexpected protocol error") }
}
let scope = Scope(workspaceId: "workspace", workflowId: "workflow", variableId: "variable", nodeId: "node")
check(scope.account == Scope(workspaceId: "workspace", workflowId: "workflow", variableId: "variable", nodeId: "another-node").account)
check(scope.account != Scope(workspaceId: "other", workflowId: "workflow", variableId: "variable", nodeId: "node").account)
check(scope.account != Scope(workspaceId: "workspace", workflowId: "other", variableId: "variable", nodeId: "node").account)
check(scope.account != Scope(workspaceId: "workspace", workflowId: "workflow", variableId: "other", nodeId: "node").account)
check(scope.account.count == 64)
check(scope.storageScope.count == 3)
check(SecretValue.isValid("密码 with spaces & punctuation!"))
check(SecretValue.isValid(String(repeating: "a", count: 2048)))
check(!SecretValue.isValid(String(repeating: "a", count: 2049)))
check(!SecretValue.isValid(String(repeating: "密", count: 683)))
check(SecretValue.isValid(String(repeating: "密", count: 682)))
check(!SecretValue.isValid(""))
check(!SecretValue.isValid("a\0b"))
check(SecretValue.isValid("line\nbreak"))
check(SecretValue.isBearerToken("synthetic-Token._~+/=="))
check(!SecretValue.isBearerToken("a=b"))
check(!SecretValue.isBearerToken("="))
check(!SecretValue.isBearerToken("password with spaces"))
check(!SecretValue.isBearerToken("密钥"))
check(!SecretValue.isBearerToken("a\r\nHeader:value"))
check(!SecretValue.isBearerToken("a\0b"))
check(!SecretValue.isBearerToken(String(repeating: "a", count: 2049)))
let object: [String: Any] = ["version": 1, "command": "execute", "operation": fixedOperation,
    "scope": ["workspaceId": "workspace", "workflowId": "workflow", "variableId": "variable", "nodeId": "node"]]
for command in ["status", "manage", "execute"] {
    var next = object; next["command"] = command
    let request = try! Request.parse(JSONSerialization.data(withJSONObject: next))
    check(request.command == command && request.scope == scope)
}
check(try! Request.parse(Data("{\"version\":1,\"command\":\"probe\"}".utf8)).scope == nil)
for (key, value) in [("version", true as Any), ("command", "resolve" as Any), ("operation", "arbitrary.http" as Any), ("value", "synthetic" as Any), ("approved", true as Any), ("authorization", "authorized" as Any), ("grant", true as Any), ("endpoint", "https://example.com" as Any)] {
    var bad = object; bad[key] = value; rejected(bad)
}
var invalidScope = object
invalidScope["scope"] = ["workspaceId": "workspace", "workflowId": "workflow", "variableId": "variable", "nodeId": "node", "value": "synthetic"]
rejected(invalidScope)
invalidScope["scope"] = ["workspaceId": "workspace", "workflowId": "workflow", "variableId": String(repeating: "x", count: 129), "nodeId": "node"]
rejected(invalidScope)
rejected(["version": 1, "command": "probe", "scope": [:]])
do { _ = try Request.parse(Data(repeating: 65, count: 8193)); preconditionFailure("Expected byte bound") } catch BrokerFailure.invalidRequest { checks += 1 }

// Persistent grants contain only scope/epoch/target binding and survive a native
// process restart via Codable; they have no elapsed-time expiry or secret value.
let epoch = UUID()
let granted = AutomaticUseGrant(scope: scope, credentialEpoch: epoch)
let restored = try! JSONDecoder().decode(AutomaticUseGrant.self, from: JSONEncoder().encode(granted))
check(restored == granted)
check(restored.authorizes(scope: scope, credentialEpoch: epoch))
check(!restored.authorizes(scope: scope, credentialEpoch: UUID()))
check(restored.authorizes(scope: Scope(workspaceId: "workspace", workflowId: "workflow", variableId: "variable", nodeId: "other-node"), credentialEpoch: epoch))
for other in [Scope(workspaceId: "other", workflowId: "workflow", variableId: "variable", nodeId: "node"),
              Scope(workspaceId: "workspace", workflowId: "other", variableId: "variable", nodeId: "node"),
              Scope(workspaceId: "workspace", workflowId: "workflow", variableId: "other", nodeId: "node")] {
    check(!restored.authorizes(scope: other, credentialEpoch: epoch))
}
for target in [UseTarget(operation: "other", method: "GET", endpoint: fixedEndpoint, authentication: "bearer", result: "status-code-only"),
               UseTarget(operation: fixedOperation, method: "POST", endpoint: fixedEndpoint, authentication: "bearer", result: "status-code-only"),
               UseTarget(operation: fixedOperation, method: "GET", endpoint: "https://example.com/user/balance", authentication: "bearer", result: "status-code-only"),
               UseTarget(operation: fixedOperation, method: "GET", endpoint: fixedEndpoint, authentication: "basic", result: "status-code-only"),
               UseTarget(operation: fixedOperation, method: "GET", endpoint: fixedEndpoint, authentication: "bearer", result: "full-body")] {
    check(!restored.authorizes(scope: scope, credentialEpoch: epoch, target: target))
}
let serialized = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(granted)) as! [String: Any]
check(Set(serialized.keys) == ["schema", "scope", "binding", "credentialEpoch", "targetFingerprint"])
for (key, value) in [("schema", 2 as Any), ("binding", String(repeating: "0", count: 64) as Any), ("targetFingerprint", String(repeating: "0", count: 64) as Any)] {
    var malformed = serialized; malformed[key] = value
    let item = try! JSONDecoder().decode(AutomaticUseGrant.self, from: JSONSerialization.data(withJSONObject: malformed))
    check(!item.authorizes(scope: scope, credentialEpoch: epoch))
}
check(CredentialStatus(configured: false, authorization: .required).response["authorization"] as? String == "required")
check(CredentialStatus(configured: true, authorization: .authorized).response["state"] as? String == "configured")

func authorizationDenied(_ action: () throws -> Void) {
    do { try action(); preconditionFailure("Expected authorization_required") }
    catch BrokerFailure.authorizationRequired { checks += 1 }
    catch { preconditionFailure("Unexpected authorization error") }
}
for tuple: (UUID?, AutomaticUseGrant?) in [(nil, nil), (epoch, nil), (UUID(), granted)] {
    var valueReads = 0
    authorizationDenied {
        let _: String = try AutomaticUseGate.load(scope: scope, currentEpoch: { tuple.0 }, currentGrant: { tuple.1 }, readValue: {
            valueReads += 1; return (epoch, "synthetic-only")
        })
    }
    check(valueReads == 0)
}
var valueReads = 0
let loaded: String = try! AutomaticUseGate.load(scope: scope, currentEpoch: { epoch }, currentGrant: { granted }, readValue: {
    valueReads += 1; return (epoch, "synthetic-only")
})
check(loaded == "synthetic-only" && valueReads == 1)
// Revocation or credential replacement during the load prevents a return to the
// dispatch caller. None of these tests invoke Keychain, LA, AppKit or HTTP.
var grantReads = 0
authorizationDenied {
    let _: String = try AutomaticUseGate.load(scope: scope, currentEpoch: { epoch }, currentGrant: {
        grantReads += 1; return grantReads == 1 ? granted : nil
    }, readValue: { (epoch, "synthetic-only") })
}
check(grantReads == 2)
authorizationDenied {
    let _: String = try AutomaticUseGate.load(scope: scope, currentEpoch: { epoch }, currentGrant: { granted }, readValue: { (UUID(), "synthetic-only") })
}
var epochReads = 0
authorizationDenied {
    let _: String = try AutomaticUseGate.load(scope: scope, currentEpoch: {
        epochReads += 1; return epochReads == 1 ? epoch : UUID()
    }, currentGrant: { granted }, readValue: { (epoch, "synthetic-only") })
}

// A complete save+authorize transaction holds the scope mutex until its grant
// write finishes. An already waiting revoke then runs last and stays effective.
let lockDirectory = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true).appendingPathComponent("workflow-grant-lock-test-" + UUID().uuidString, isDirectory: true)
try! FileManager.default.createDirectory(at: lockDirectory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
defer { try? FileManager.default.removeItem(at: lockDirectory) }
let mutation = try! ScopeMutationLock.acquire(account: scope.account, directory: lockDirectory)
try! mutation.require(scope)
do {
    _ = try ScopeMutationLock.acquire(account: scope.account, directory: lockDirectory, waitSeconds: 0.03)
    preconditionFailure("Expected scope lock contention")
} catch BrokerFailure.busy { checks += 1 } catch { preconditionFailure("Unexpected mutex error") }
let child = Process()
child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
child.arguments = ["--lock-revoker", lockDirectory.path, scope.account]
child.standardOutput = FileHandle.nullDevice
child.standardError = FileHandle.nullDevice
try! child.run()
let deadline = Date(timeIntervalSinceNow: 2)
while !FileManager.default.fileExists(atPath: lockDirectory.appendingPathComponent("waiting").path) && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
check(FileManager.default.fileExists(atPath: lockDirectory.appendingPathComponent("waiting").path))
check(child.isRunning)
check(!FileManager.default.fileExists(atPath: lockDirectory.appendingPathComponent("synthetic-state").path))
try! Data("authorized".utf8).write(to: lockDirectory.appendingPathComponent("synthetic-state"))
mutation.release()
child.waitUntilExit()
check(child.terminationStatus == 0)
check(String(data: try! Data(contentsOf: lockDirectory.appendingPathComponent("synthetic-state")), encoding: .utf8) == "required")
do { try mutation.require(scope); preconditionFailure("Released mutation capability used") }
catch BrokerFailure.runtimeUnsafe { checks += 1 } catch { preconditionFailure("Unexpected released lock error") }
print("{\"status\":\"passed\",\"checks\":\(checks),\"keychainAccess\":false,\"authenticationInvoked\":false}")
