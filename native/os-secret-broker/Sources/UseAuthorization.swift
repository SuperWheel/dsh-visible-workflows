import Foundation
import CryptoKit

enum AutomaticUseAuthorization: String {
    case authorized, required
}

// These inputs are native constants, never fields accepted from the caller.
// Including transport/output policy invalidates an old grant if those change.
struct UseTarget: Equatable {
    let operation: String
    let method: String
    let endpoint: String
    let authentication: String
    let result: String

    static let fixed = UseTarget(operation: fixedOperation, method: "GET", endpoint: fixedEndpoint,
                                authentication: "bearer", result: "status-code-only")

    var fingerprint: String {
        let bytes = try! JSONSerialization.data(withJSONObject: ["schema": 1, "operation": operation,
            "method": method, "endpoint": endpoint, "authentication": authentication, "result": result], options: [.sortedKeys])
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}

struct AutomaticUseGrant: Codable, Equatable {
    let schema: Int
    let scope: [String: String]
    let binding: String
    let credentialEpoch: UUID
    let targetFingerprint: String

    init(scope: Scope, credentialEpoch: UUID, target: UseTarget = .fixed) {
        schema = 1
        self.scope = scope.storageScope
        binding = scope.account
        self.credentialEpoch = credentialEpoch
        targetFingerprint = target.fingerprint
    }

    func authorizes(scope: Scope, credentialEpoch: UUID, target: UseTarget = .fixed) -> Bool {
        schema == 1 && self.scope == scope.storageScope && binding == scope.account &&
        self.credentialEpoch == credentialEpoch && targetFingerprint == target.fingerprint
    }
}

struct CredentialStatus {
    let configured: Bool
    let authorization: AutomaticUseAuthorization

    var response: [String: Any] {
        ["ok": true, "state": configured ? "configured" : "missing", "authorization": authorization.rawValue]
    }
}

// Keep authorization ordering independently testable without using Keychain,
// LocalAuthentication, UI or a real request. Re-check after loading the native
// value so a concurrent revoke/edit cannot pass the dispatch check unnoticed.
enum AutomaticUseGate {
    static func require(scope: Scope, epoch: UUID?, grant: AutomaticUseGrant?) throws -> UUID {
        guard let epoch, grant?.authorizes(scope: scope, credentialEpoch: epoch) == true else { throw BrokerFailure.authorizationRequired }
        return epoch
    }

    static func load<Value>(scope: Scope, currentEpoch: () throws -> UUID?, currentGrant: () throws -> AutomaticUseGrant?,
                            readValue: () throws -> (epoch: UUID, value: Value)) throws -> Value {
        let epoch = try require(scope: scope, epoch: currentEpoch(), grant: currentGrant())
        let loaded = try readValue()
        guard loaded.epoch == epoch else { throw BrokerFailure.authorizationRequired }
        let checked = try require(scope: scope, epoch: currentEpoch(), grant: currentGrant())
        guard checked == epoch else { throw BrokerFailure.authorizationRequired }
        return loaded.value
    }
}
