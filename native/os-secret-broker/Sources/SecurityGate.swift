import Foundation
import Security
import LocalAuthentication

struct SecurityIdentity {
    let builtInRoots: [SecCertificate]
}

func checkOSSecretRuntime(requireOwnerAuthentication: Bool = true) throws -> SecurityIdentity {
    // No settings are inherited from a CLI login profile or Agent environment.
    let allowed = Set(["PATH", "LANG", "__CF_USER_TEXT_ENCODING"])
    guard Set(ProcessInfo.processInfo.environment.keys).isSubset(of: allowed) else { throw BrokerFailure.runtimeUnsafe }
    var code: SecCode?
    var staticCode: SecStaticCode?
    var info: CFDictionary?
    guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code,
          SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode,
          SecCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess,
          SecStaticCodeCheckValidity(staticCode, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures), nil) == errSecSuccess,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let values = info as? [String: Any],
          values[kSecCodeInfoIdentifier as String] as? String == brokerIdentifier else { throw BrokerFailure.runtimeUnsafe }
    let flags = (values[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    let entitlements = values[kSecCodeInfoEntitlementsDict as String] as? [String: Any] ?? [:]
    // Ad-hoc hardened signing checks this artifact, not publisher identity or
    // protection against same-user arbitrary code. Host verifies pinned files.
    guard flags & 0x10000 != 0, entitlements.isEmpty else { throw BrokerFailure.runtimeUnsafe }
    var roots: CFArray?
    guard SecTrustSettingsCopyCertificates(.system, &roots) == errSecSuccess,
          let certificates = roots as? [SecCertificate], !certificates.isEmpty else { throw BrokerFailure.runtimeUnsafe }
    if requireOwnerAuthentication {
        let context = LAContext()
        defer { context.invalidate() }
        var error: NSError?
        // Probe checks availability only; background status/execute do not need
        // an interactive authentication session and never evaluate LA policy.
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { throw BrokerFailure.authenticationFailed }
    }
    return SecurityIdentity(builtInRoots: certificates)
}
