import Foundation
import Security
import LocalAuthentication

struct StoredCredential: Codable {
    let schema: Int
    let scope: [String: String]
    let binding: String
    let epoch: UUID
    let value: String
}

// Only native system authentication can construct this capability. One manage
// window reuses it; caller Booleans, identifiers or files cannot grant authority.
final class OwnerSession {
    private let context: LAContext
    private let binding: String
    private var active = true
    private init(context: LAContext, scope: Scope) { self.context = context; binding = scope.account }

    static func authenticate(scope: Scope) throws -> OwnerSession {
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = 0
        var result: Result<Void, BrokerFailure>?
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "管理此工作流 Secret：查看、保存、授权自动使用或撤销授权") { passed, error in
            let cancelled = (error as? LAError).map { [.userCancel, .appCancel, .systemCancel].contains($0.code) } ?? false
            DispatchQueue.main.async { result = passed ? .success(()) : .failure(cancelled ? .cancelled : .authenticationFailed) }
        }
        while result == nil { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
        do { try result!.get() } catch { context.invalidate(); throw error }
        return OwnerSession(context: context, scope: scope)
    }
    func require(_ scope: Scope) throws {
        guard active, binding == scope.account else { throw BrokerFailure.authenticationFailed }
    }
    func invalidate() { active = false; context.invalidate() }
    deinit { context.invalidate() }
}

private func withoutKeychainUI<T>(_ operation: () throws -> T) rethrows -> T {
    SecKeychainSetUserInteractionAllowed(false)
    defer { SecKeychainSetUserInteractionAllowed(true) }
    return try operation()
}

// Both credential and grant are OS Keychain items with this native app's ACL.
// This is the workflow interface boundary, not isolation from arbitrary same-user
// code or an already-compromised Host. No global Host/plugin policy is changed.
struct CredentialStore {
    let scope: Scope
    let authorization: HostAuthorization
    private let grantService = brokerIdentifier + ".automatic-use-authorization"

    private func query(service: String = brokerIdentifier) throws -> [String: Any] {
        try authorization.assertLive()
        var keychain: SecKeychain?
        guard SecKeychainCopyDefault(&keychain) == errSecSuccess, let keychain else { throw BrokerFailure.keychainFailed }
        var length: UInt32 = 4096
        var path = [CChar](repeating: 0, count: Int(length))
        guard SecKeychainGetPath(keychain, &length, &path) == errSecSuccess else { throw BrokerFailure.keychainFailed }
        let actual = URL(fileURLWithPath: String(cString: path)).resolvingSymlinksInPath().path
        let standard = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Keychains").resolvingSymlinksInPath().path + "/"
        guard actual.hasPrefix(standard) else { throw BrokerFailure.keychainFailed }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: scope.account,
                kSecUseDataProtectionKeychain as String: false,
                kSecMatchSearchList as String: [keychain]]
    }

    // Metadata only: never requests the credential value or opens Keychain UI.
    private func credentialEpoch() throws -> UUID? {
        try withoutKeychainUI {
            var request = try query()
            request[kSecReturnAttributes as String] = true
            request[kSecReturnData as String] = false
            request[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(request as CFDictionary, &result)
            if status == errSecItemNotFound { return nil }
            guard status == errSecSuccess, let attributes = result as? [String: Any],
                  let bytes = attributes[kSecAttrGeneric as String] as? Data,
                  let text = String(data: bytes, encoding: .utf8), let epoch = UUID(uuidString: text) else { throw BrokerFailure.keychainFailed }
            try authorization.assertLive()
            return epoch
        }
    }

    // The only data read by status is this non-secret authorization record.
    // Missing, inaccessible or malformed grants fail closed without UI.
    private func grant() throws -> AutomaticUseGrant? {
        try withoutKeychainUI {
            var request = try query(service: grantService)
            request[kSecReturnData as String] = true
            request[kSecReturnAttributes as String] = true
            request[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let status = SecItemCopyMatching(request as CFDictionary, &result)
            if [errSecItemNotFound, errSecInteractionNotAllowed, errSecAuthFailed].contains(status) { return nil }
            guard status == errSecSuccess, let attributes = result as? [String: Any],
                  let bytes = attributes[kSecValueData as String] as? Data,
                  let generation = attributes[kSecAttrGeneric as String] as? Data else { throw BrokerFailure.keychainFailed }
            guard bytes.count <= 8192, let item = try? JSONDecoder().decode(AutomaticUseGrant.self, from: bytes),
                  generation == Data(item.credentialEpoch.uuidString.utf8) else { return nil }
            try authorization.assertLive()
            return item
        }
    }

    func exists() throws -> Bool { try credentialEpoch() != nil }
    func beginMutation(session: OwnerSession) throws -> ScopeMutationLock {
        try session.require(scope)
        try authorization.assertLive()
        return try ScopeMutationLock.acquire(account: scope.account, whileWaiting: { try authorization.assertLive() })
    }
    func status() throws -> CredentialStatus {
        guard let epoch = try credentialEpoch() else { return CredentialStatus(configured: false, authorization: .required) }
        let permitted = try grant()?.authorizes(scope: scope, credentialEpoch: epoch) == true
        return CredentialStatus(configured: true, authorization: permitted ? .authorized : .required)
    }

    private func readPayload() throws -> StoredCredential {
        var request = try query()
        request[kSecReturnData as String] = true
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { throw BrokerFailure.itemMissing }
        if status == errSecUserCanceled { throw BrokerFailure.cancelled }
        guard status == errSecSuccess, let attributes = result as? [String: Any],
              var bytes = attributes[kSecValueData as String] as? Data,
              let generation = attributes[kSecAttrGeneric as String] as? Data else { throw BrokerFailure.keychainFailed }
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        guard bytes.count <= 32768, let item = try? JSONDecoder().decode(StoredCredential.self, from: bytes),
              item.schema == 2, item.scope == scope.storageScope, item.binding == scope.account,
              generation == Data(item.epoch.uuidString.utf8), SecretValue.isValid(item.value) else { throw BrokerFailure.itemInvalid }
        try authorization.assertLive()
        return item
    }

    func readForManagement(session: OwnerSession) throws -> StoredCredential {
        try session.require(scope)
        return try readPayload()
    }

    // No owner authentication, AppKit or Keychain interaction is permitted here.
    func readForAutomaticUse() throws -> StoredCredential {
        try AutomaticUseGate.load(scope: scope, currentEpoch: { try credentialEpoch() }, currentGrant: { try grant() }, readValue: {
            let item = try withoutKeychainUI { try readPayload() }
            return (epoch: item.epoch, value: item)
        })
    }

    func assertAutomaticUseAuthorized(expectedEpoch: UUID) throws {
        guard try credentialEpoch() == expectedEpoch,
              try grant()?.authorizes(scope: scope, credentialEpoch: expectedEpoch) == true else { throw BrokerFailure.authorizationRequired }
        try authorization.assertLive()
    }

    private func addItem(service: String, bytes: Data, epoch: UUID) throws {
        var request = try query(service: service)
        var application: SecTrustedApplication?
        var access: SecAccess?
        guard SecTrustedApplicationCreateFromPath(nil, &application) == errSecSuccess, let application,
              SecAccessCreate("DeepSeek Harness 工作流 Secret" as CFString, [application] as CFArray, &access) == errSecSuccess, let access else { throw BrokerFailure.keychainFailed }
        let list = request.removeValue(forKey: kSecMatchSearchList as String) as? [SecKeychain]
        guard let keychain = list?.first else { throw BrokerFailure.keychainFailed }
        request[kSecUseKeychain as String] = keychain
        request[kSecAttrAccess as String] = access
        request[kSecValueData as String] = bytes
        request[kSecAttrGeneric as String] = Data(epoch.uuidString.utf8)
        let status = SecItemAdd(request as CFDictionary, nil)
        if status == errSecDuplicateItem { throw BrokerFailure.busy }
        if status == errSecUserCanceled { throw BrokerFailure.cancelled }
        guard status == errSecSuccess else { throw BrokerFailure.keychainFailed }
    }

    @discardableResult
    func save(_ value: String, expectedEpoch: UUID?, session: OwnerSession, mutation: ScopeMutationLock) throws -> StoredCredential {
        try session.require(scope)
        try mutation.require(scope)
        guard SecretValue.isValid(value) else { throw BrokerFailure.invalidRequest }
        // A stale editor must not revoke a newer credential's permission before
        // discovering its CAS conflict. The scope lock covers this precondition.
        guard try credentialEpoch() == expectedEpoch else { throw BrokerFailure.busy }
        // Revoke first. Even identical text rotates the epoch; failed CAS cannot
        // leave earlier automatic-use permission active.
        try revokeAutomaticUse(session: session, mutation: mutation)
        let item = StoredCredential(schema: 2, scope: scope.storageScope, binding: scope.account, epoch: UUID(), value: value)
        var bytes = try JSONEncoder().encode(item)
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        if let expectedEpoch {
            var request = try query()
            request[kSecAttrGeneric as String] = Data(expectedEpoch.uuidString.utf8)
            let status = SecItemUpdate(request as CFDictionary, [kSecValueData as String: bytes, kSecAttrGeneric as String: Data(item.epoch.uuidString.utf8)] as CFDictionary)
            if status == errSecItemNotFound { throw BrokerFailure.busy }
            if status == errSecUserCanceled { throw BrokerFailure.cancelled }
            guard status == errSecSuccess else { throw BrokerFailure.keychainFailed }
        } else { try addItem(service: brokerIdentifier, bytes: bytes, epoch: item.epoch) }
        try authorization.assertLive()
        return item
    }

    func authorizeAutomaticUse(expectedEpoch: UUID, session: OwnerSession, mutation: ScopeMutationLock) throws {
        try session.require(scope)
        try mutation.require(scope)
        guard try credentialEpoch() == expectedEpoch else { throw BrokerFailure.busy }
        let item = AutomaticUseGrant(scope: scope, credentialEpoch: expectedEpoch)
        let bytes = try JSONEncoder().encode(item)
        let request = try query(service: grantService)
        let status = SecItemUpdate(request as CFDictionary, [kSecValueData as String: bytes, kSecAttrGeneric as String: Data(expectedEpoch.uuidString.utf8)] as CFDictionary)
        if status == errSecItemNotFound { try addItem(service: grantService, bytes: bytes, epoch: expectedEpoch) }
        else if status == errSecUserCanceled { throw BrokerFailure.cancelled }
        else if status != errSecSuccess { throw BrokerFailure.keychainFailed }
        // A concurrent edit invalidates this grant by epoch even if it happened
        // between the first check and this write.
        guard try credentialEpoch() == expectedEpoch else { throw BrokerFailure.busy }
        try authorization.assertLive()
    }

    func revokeAutomaticUse(session: OwnerSession, mutation: ScopeMutationLock) throws {
        try session.require(scope)
        try mutation.require(scope)
        let status = SecItemDelete(try query(service: grantService) as CFDictionary)
        if status == errSecUserCanceled { throw BrokerFailure.cancelled }
        guard status == errSecSuccess || status == errSecItemNotFound else { throw BrokerFailure.keychainFailed }
        try authorization.assertLive()
    }

    func delete(expectedEpoch: UUID, session: OwnerSession, mutation: ScopeMutationLock) throws {
        try session.require(scope)
        try mutation.require(scope)
        guard try credentialEpoch() == expectedEpoch else { throw BrokerFailure.busy }
        try revokeAutomaticUse(session: session, mutation: mutation)
        var request = try query()
        request[kSecAttrGeneric as String] = Data(expectedEpoch.uuidString.utf8)
        let status = SecItemDelete(request as CFDictionary)
        if status == errSecItemNotFound { throw BrokerFailure.busy }
        if status == errSecUserCanceled { throw BrokerFailure.cancelled }
        guard status == errSecSuccess else { throw BrokerFailure.keychainFailed }
        try authorization.assertLive()
    }
}
