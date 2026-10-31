using System.Security.Cryptography;
using System.Text;

namespace WorkflowSecretBroker;

internal static class SecretValue
{
    public const int MaxUtf8Bytes = 2048;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly byte[] Prefix = "DSH_OS_SECRET_V1\0"u8.ToArray();

    public static byte[] Encode(string value)
    {
        try
        {
            if (value.Contains('\0')) throw new BrokerFailure("item_invalid");
            int length = Utf8.GetByteCount(value);
            if (length is < 1 or > MaxUtf8Bytes) throw new BrokerFailure("item_invalid");
            byte[] blob = new byte[Prefix.Length + length];
            Prefix.CopyTo(blob, 0);
            Utf8.GetBytes(value, blob.AsSpan(Prefix.Length));
            return blob;
        }
        catch (EncoderFallbackException) { throw new BrokerFailure("item_invalid"); }
    }

    public static string Decode(ReadOnlySpan<byte> blob)
    {
        try
        {
            if (blob.Length <= Prefix.Length || blob.Length > Prefix.Length + MaxUtf8Bytes ||
                !blob[..Prefix.Length].SequenceEqual(Prefix)) throw new BrokerFailure("item_invalid");
            string value = Utf8.GetString(blob[Prefix.Length..]);
            if (value.Contains('\0')) throw new BrokerFailure("item_invalid");
            return value;
        }
        catch (DecoderFallbackException) { throw new BrokerFailure("item_invalid"); }
    }

    // Consumer-specific validation; ordinary password storage accepts Unicode, punctuation and whitespace.
    public static bool IsDeepSeekToken(string value)
    {
        if (value.Length is < 1 or > MaxUtf8Bytes) return false;
        bool padding = false;
        int body = 0;
        foreach (char c in value)
        {
            if (c == '=') { padding = true; continue; }
            if (padding || !(char.IsAsciiLetterOrDigit(c) || "-._~+/".Contains(c))) return false;
            body++;
        }
        return body > 0;
    }

    public static void Validate(string value)
    {
        byte[] blob = Encode(value);
        CryptographicOperations.ZeroMemory(blob);
    }
}
