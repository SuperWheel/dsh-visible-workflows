using System.Text;

namespace WorkflowSecretBroker;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        // The host redirects stdout; even WinExe writes only the bounded response to the inherited pipe.
        Console.SetError(TextWriter.Null);
        BrokerResponse response;
        try
        {
            if (args.Length != 0) throw new BrokerFailure("invalid_request");
            byte[] bytes = new byte[BrokerRequest.MaxRequestBytes + 1];
            using Stream input = Console.OpenStandardInput();
            int used = 0, count;
            while (used < bytes.Length && (count = input.Read(bytes, used, bytes.Length - used)) > 0) used += count;
            BrokerRequest request = BrokerRequest.Parse(bytes.AsMemory(0, used));
            response = Dispatch(request);
        }
        catch (BrokerFailure failure) { response = BrokerResponse.Failure(failure.Code); }
        catch { response = BrokerResponse.Failure("internal_error"); }
        byte[] output = Encoding.UTF8.GetBytes(response.ToJson() + "\n");
        using Stream stdout = Console.OpenStandardOutput();
        stdout.Write(output);
        return 0;
    }

    private static BrokerResponse Dispatch(BrokerRequest request)
    {
#if !WINDOWS_ACCEPTANCE_BUILD
        // Default release remains closed until native Windows build, Hello, UI and runtime acceptance exist.
        // A runtime option or environment variable cannot remove this gate.
        return request.Command == "probe"
            ? new BrokerResponse(true, "windows_unverified", Available: false)
            : BrokerResponse.Failure("windows_unverified");
#else
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
            return request.Command == "probe"
                ? new BrokerResponse(true, "unsupported_platform", Available: false)
                : BrokerResponse.Failure("unsupported_platform");
        bool available = SystemAuthorization.AvailableAsync().GetAwaiter().GetResult();
        if (request.Command == "probe")
            return new BrokerResponse(true, available ? "available" : "biometric_unavailable", Available: available);
        if (!available) return BrokerResponse.Failure("biometric_unavailable");
        if (request.Command == "status")
            return new BrokerResponse(true, State: CredentialStore.Exists(request.Scope!) ? "configured" : "missing");
        ApplicationConfiguration.Initialize();
        using var window = new SecretWindow(request);
        Application.Run(window);
        return window.Response;
#endif
    }
}
