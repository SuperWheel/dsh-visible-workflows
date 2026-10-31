import Foundation
import Darwin

// This lock carries no permission and stores no credential/grant data. Keychain
// remains the only authority. The native scope lock only serializes complete
// save-and-authorize/revoke/delete transactions across broker processes.
final class ScopeMutationLock {
    private let account: String
    private var descriptor: Int32

    private init(account: String, descriptor: Int32) {
        self.account = account
        self.descriptor = descriptor
    }

    static func acquire(account: String, directory: URL? = nil, waitSeconds: TimeInterval = 5,
                        whileWaiting: () throws -> Void = {}) throws -> ScopeMutationLock {
        guard account.count == 64, account.allSatisfy({ "0123456789abcdef".contains($0) }) else { throw BrokerFailure.runtimeUnsafe }
        let root = directory ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Caches/" + brokerIdentifier + ".mutation-locks", isDirectory: true)
        if mkdir(root.path, mode_t(0o700)) != 0 && errno != EEXIST { throw BrokerFailure.busy }
        var directoryInfo = stat()
        guard lstat(root.path, &directoryInfo) == 0, directoryInfo.st_mode & S_IFMT == S_IFDIR,
              directoryInfo.st_uid == getuid(), directoryInfo.st_mode & 0o777 == 0o700 else { throw BrokerFailure.runtimeUnsafe }
        let path = root.appendingPathComponent(account + ".lock").path
        let descriptor = open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
        guard descriptor >= 0 else { throw BrokerFailure.busy }
        var acquired = false
        defer { if !acquired { close(descriptor) } }
        var info = stat()
        guard fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
              info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o777 == 0o600 else { throw BrokerFailure.runtimeUnsafe }
        let deadline = Date(timeIntervalSinceNow: waitSeconds)
        while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            guard errno == EWOULDBLOCK || errno == EAGAIN else { throw BrokerFailure.busy }
            try whileWaiting()
            guard Date() < deadline else { throw BrokerFailure.busy }
            Thread.sleep(forTimeInterval: 0.01)
        }
        acquired = true
        return ScopeMutationLock(account: account, descriptor: descriptor)
    }

    func require(_ scope: Scope) throws {
        guard descriptor >= 0, account == scope.account else { throw BrokerFailure.runtimeUnsafe }
    }

    func release() {
        if descriptor >= 0 { flock(descriptor, LOCK_UN); close(descriptor); descriptor = -1 }
    }
    deinit { release() }
}
