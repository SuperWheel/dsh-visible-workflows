import Foundation

enum SecretValue {
    // Values are general UTF-8 secrets; consumer syntax must not constrain storage.
    static func isValid(_ value: String) -> Bool { (1...2048).contains(value.utf8.count) && !value.utf8.contains(0) }

    static func isBearerToken(_ value: String) -> Bool {
        guard (1...2048).contains(value.utf8.count) else { return false }
        // RFC 6750 b64token. Reject header controls/non-ASCII at this sink only.
        var padding = false
        for scalar in value.unicodeScalars {
            if scalar == "=" { padding = true; continue }
            if padding || !CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~+/").contains(scalar) { return false }
        }
        return value.first != "="
    }
}
