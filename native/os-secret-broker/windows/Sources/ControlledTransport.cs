using System.Net;
using System.Net.Http.Headers;
using System.Security.Authentication;

namespace WorkflowSecretBroker;

internal static class ControlledTransport
{
    private const string Endpoint = "https://api.deepseek.com/user/balance";

    public static async Task<int> ExecuteAsync(string token, CancellationToken cancellation)
    {
        if (!SecretValue.IsDeepSeekToken(token)) throw new BrokerFailure("invalid_request");
        using var handler = new HttpClientHandler
        {
            AllowAutoRedirect = false, UseCookies = false, UseProxy = false,
            UseDefaultCredentials = false, Credentials = null,
            AutomaticDecompression = DecompressionMethods.None,
            SslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
            CheckCertificateRevocationList = true,
        };
        // System trust validation is preserved: no accepting custom certificate callback.
        using var client = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(25) };
        using var request = new HttpRequestMessage(HttpMethod.Get, Endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        try
        {
            using HttpResponseMessage response = await client.SendAsync(request,
                HttpCompletionOption.ResponseHeadersRead, cancellation);
            int status = (int)response.StatusCode;
            if (status is < 200 or > 599 or (>= 300 and <= 399) ||
                response.RequestMessage?.RequestUri?.AbsoluteUri != Endpoint)
                throw new BrokerFailure("network_denied");
            // Never read headers/body into the workflow. Disposing cancels response body delivery.
            return status;
        }
        catch (BrokerFailure) { throw; }
        catch (OperationCanceledException) { throw new BrokerFailure(cancellation.IsCancellationRequested ? "cancelled" : "network_failed"); }
        catch (HttpRequestException) { throw new BrokerFailure("network_failed"); }
        finally { request.Headers.Authorization = null; }
    }
}
