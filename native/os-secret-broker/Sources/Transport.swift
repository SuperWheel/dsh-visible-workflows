import Foundation
import Security

// Receives no response body and exposes only the final status code. No generic
// URL, method, headers, proxy, retry or response projection is caller-controlled.
final class ControlledRequest: NSObject, URLSessionDataDelegate, URLSessionTaskDelegate, @unchecked Sendable {
    let roots: [SecCertificate]
    private let lock = NSLock()
    private var outcome: Result<Int, BrokerFailure>?
    private var session: URLSession?

    init(roots: [SecCertificate]) { self.roots = roots }

    func finish(_ result: Result<Int, BrokerFailure>) {
        lock.lock()
        if outcome == nil { outcome = result }
        lock.unlock()
    }

    func perform(token: String) throws -> Int {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.connectionProxyDictionary = [:]
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 25
        configuration.httpMaximumConnectionsPerHost = 1
        configuration.waitsForConnectivity = false
        configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
        var request = URLRequest(url: URL(string: fixedEndpoint)!)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        self.session = session
        let task = session.dataTask(with: request)
        task.resume()
        let deadline = Date(timeIntervalSinceNow: 26)
        var result: Result<Int, BrokerFailure>?
        while result == nil && Date() < deadline {
            lock.lock(); result = outcome; lock.unlock()
            if result == nil { RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05)) }
        }
        task.cancel()
        session.invalidateAndCancel()
        self.session = nil
        return try (result ?? .failure(.networkFailed)).get()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, http.url?.absoluteString == fixedEndpoint,
              (200...599).contains(http.statusCode), !(300...399).contains(http.statusCode) else {
            finish(.failure(.networkDenied)); completionHandler(.cancel); return
        }
        finish(.success(http.statusCode))
        // Refuse body delivery, so credential echoes never reach stdout, logs,
        // a response accumulator, the Host, or any Agent.
        completionHandler(.cancel)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        finish(.failure(.networkDenied)); completionHandler(nil); task.cancel()
    }

    func challenge(_ challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == "api.deepseek.com", challenge.protectionSpace.port == 443,
              !challenge.protectionSpace.isProxy(), challenge.previousFailureCount == 0,
              let trust = challenge.protectionSpace.serverTrust,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, "api.deepseek.com" as CFString)) == errSecSuccess,
              SecTrustSetAnchorCertificates(trust, roots as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil) else {
            finish(.failure(.networkDenied)); completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        self.challenge(challenge, completionHandler: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        self.challenge(challenge, completionHandler: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        finish(.failure(.networkFailed))
    }
}
