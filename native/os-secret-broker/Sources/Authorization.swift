import Foundation
import CryptoKit
import Security
import Darwin

// This private inherited socket binds one request to its live parent. It is not
// caller identity or a system isolation gate: another same-user program can
// launch its own child. Secret values never travel over this channel.
final class HostAuthorization {
    private let channel = FileHandle(fileDescriptor: 3, closeOnDealloc: false)
    private var monitor: DispatchSourceRead?
    private let parent: pid_t

    init(request: Data) throws {
        parent = getppid()
        guard parent > 1 else { throw BrokerFailure.runtimeUnsafe }
        var peer: pid_t = 0
        var length = socklen_t(MemoryLayout<pid_t>.size)
        // Darwin SOL_LOCAL = 0, LOCAL_PEERPID = 2. A regular file, anonymous pipe,
        // inherited terminal, or unrelated Unix peer cannot be substituted.
        guard getsockopt(3, 0, 2, &peer, &length) == 0,
              length == MemoryLayout<pid_t>.size, peer == parent else { throw BrokerFailure.runtimeUnsafe }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw BrokerFailure.runtimeUnsafe }
        let challenge = bytes.map { String(format: "%02x", $0) }.joined()
        let digest = SHA256.hash(data: request).map { String(format: "%02x", $0) }.joined()
        let hello = try JSONSerialization.data(withJSONObject: ["version": 1, "challenge": challenge])
        try channel.write(contentsOf: hello + Data([10]))
        var frame = Data()
        while frame.count <= 2048 {
            guard let next = try channel.read(upToCount: 1), !next.isEmpty else { throw BrokerFailure.runtimeUnsafe }
            if next == Data([10]) { break }
            frame.append(next)
        }
        guard frame.count <= 2048,
              let permit = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
              Set(permit.keys) == Set(["version", "challenge", "requestHash", "parentPid"]),
              let version = permit["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1,
              let pid = permit["parentPid"] as? NSNumber, CFGetTypeID(pid) != CFBooleanGetTypeID(), pid.int64Value == Int64(parent),
              permit["challenge"] as? String == challenge,
              permit["requestHash"] as? String == digest,
              getppid() == parent else { throw BrokerFailure.runtimeUnsafe }
        // FD3 stays open for the entire operation. Any data, EOF or Host death
        // cancels the operation. Never reuse a frame for another request/process.
        let source = DispatchSource.makeReadSource(fileDescriptor: 3, queue: .global(qos: .userInitiated))
        source.setEventHandler { _exit(78) }
        source.resume()
        monitor = source
    }

    func assertLive() throws {
        guard getppid() == parent else { throw BrokerFailure.runtimeUnsafe }
        var event = pollfd(fd: 3, events: Int16(POLLIN | POLLHUP | POLLERR), revents: 0)
        guard poll(&event, 1, 0) == 0 else { throw BrokerFailure.runtimeUnsafe }
    }
}
