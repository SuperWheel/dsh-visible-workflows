using Windows.Security.Credentials.UI;

namespace WorkflowSecretBroker;

internal static class SystemAuthorization
{
    public static async Task<bool> AvailableAsync()
    {
        try { return await UserConsentVerifier.CheckAvailabilityAsync() == UserConsentVerifierAvailability.Available; }
        catch { return false; }
    }

    public static async Task RequireAsync(Form owner, string message)
    {
        if (!owner.Visible || owner.IsDisposed || !owner.IsHandleCreated)
            throw new BrokerFailure("authentication_failed");
        try
        {
            // Desktop HWND interop is required; do not use the UWP-only RequestVerificationAsync.
            // Windows chooses the configured Hello/PIN device. This does not mean biometric-only.
            UserConsentVerificationResult result = await UserConsentVerifierInterop.RequestVerificationForWindowAsync(
                owner.Handle, message);
            if (owner.IsDisposed) throw new BrokerFailure("cancelled");
            if (result == UserConsentVerificationResult.Verified) return;
            throw new BrokerFailure(result switch
            {
                UserConsentVerificationResult.Canceled => "cancelled",
                UserConsentVerificationResult.DeviceBusy => "busy",
                UserConsentVerificationResult.DeviceNotPresent or
                UserConsentVerificationResult.NotConfiguredForUser or
                UserConsentVerificationResult.DisabledByPolicy => "biometric_unavailable",
                _ => "authentication_failed",
            });
        }
        catch (BrokerFailure) { throw; }
        catch { throw new BrokerFailure("authentication_failed"); }
    }
}
