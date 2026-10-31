import Foundation
import CryptoKit

enum BrokerFailure: String, Error {
    case signingUntrusted = "signing_untrusted", runtimeUnsafe = "runtime_unsafe"
    case profileInvalid = "profile_invalid", accessGroupInvalid = "access_group_invalid"
    case biometricUnavailable = "biometric_unavailable", invalidRequest = "invalid_request"
    case cancelled, authenticationFailed = "authentication_failed", itemMissing = "item_missing"
    case itemInvalid = "item_invalid", keychainFailed = "keychain_failed"
    case networkDenied = "network_denied", networkFailed = "network_failed", busy
    case authorizationRequired = "authorization_required"
    case internalError = "internal_error"
}

let brokerIdentifier = "com.deepseekharness.workflow.os-secret-broker"
let fixedOperation = "deepseek.account-status.v1"
let fixedEndpoint = "https://api.deepseek.com/user/balance"

struct Scope: Codable, Equatable {
    let workspaceId: String
    let workflowId: String
    let variableId: String
    let nodeId: String

    var storageScope: [String: String] {
        ["workspaceId": workspaceId, "workflowId": workflowId, "variableId": variableId]
    }
    var account: String {
        // Variable ownership is independent of its consumers. Node and operation
        // are not part of the identity; these public identifiers are not grants.
        let data = try! JSONSerialization.data(withJSONObject: ["namespace": brokerIdentifier, "schema": 2, "scope": storageScope], options: [.sortedKeys])
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

struct Request {
    let command: String
    let scope: Scope?

    static func parse(_ bytes: Data) throws -> Request {
        guard !bytes.isEmpty, bytes.count <= 8192,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let version = object["version"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let command = object["command"] as? String else { throw BrokerFailure.invalidRequest }
        if command == "probe" {
            guard Set(object.keys) == ["version", "command"] else { throw BrokerFailure.invalidRequest }
            return Request(command: command, scope: nil)
        }
        guard ["manage", "execute", "status"].contains(command),
              Set(object.keys) == ["version", "command", "operation", "scope"],
              object["operation"] as? String == fixedOperation,
              let scope = object["scope"] as? [String: Any],
              Set(scope.keys) == ["workspaceId", "workflowId", "variableId", "nodeId"] else { throw BrokerFailure.invalidRequest }
        func id(_ key: String) throws -> String {
            guard let value = scope[key] as? String, value.utf8.count >= 1, value.utf8.count <= 128,
                  value.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:-").contains($0) })
            else { throw BrokerFailure.invalidRequest }
            return value
        }
        return try Request(command: command, scope: Scope(workspaceId: id("workspaceId"), workflowId: id("workflowId"), variableId: id("variableId"), nodeId: id("nodeId")))
    }
}

func emit(_ response: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])) ?? Data("{\"ok\":false,\"code\":\"internal_error\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(0)
}
