using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace WorkflowSecretBroker;

internal static class CredentialStore
{
    private const uint Generic = 1;
    // LOCAL_MACHINE here means subsequent logons of THIS user on THIS computer, not access by every user.
    private const uint PersistLocalComputer = 2;
    private const int NotFound = 1168;
    private const int MaxBlob = 2560;

    public static bool Exists(Scope scope)
    {
        if (!CredReadW(scope.Target, Generic, 0, out IntPtr pointer))
        {
            if (Marshal.GetLastWin32Error() == NotFound) return false;
            throw new BrokerFailure("keychain_failed");
        }
        // CredRead has no metadata-only flag. Do not convert the blob to a managed value during status.
        try { return true; }
        finally { ClearAndFree(pointer); }
    }

    public static string Read(Scope scope)
    {
        if (!CredReadW(scope.Target, Generic, 0, out IntPtr pointer))
            throw new BrokerFailure(Marshal.GetLastWin32Error() == NotFound ? "item_missing" : "keychain_failed");
        byte[]? blob = null;
        try
        {
            Credential credential = Marshal.PtrToStructure<Credential>(pointer);
            if (credential.Type != Generic || credential.CredentialBlob == IntPtr.Zero ||
                credential.CredentialBlobSize is 0 or > MaxBlob) throw new BrokerFailure("item_invalid");
            blob = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
            return SecretValue.Decode(blob);
        }
        finally
        {
            if (blob is not null) CryptographicOperations.ZeroMemory(blob);
            ClearAndFree(pointer);
        }
    }

    public static void Save(Scope scope, string value)
    {
        byte[] blob = SecretValue.Encode(value);
        IntPtr pointer = IntPtr.Zero;
        try
        {
            pointer = Marshal.AllocHGlobal(blob.Length);
            Marshal.Copy(blob, 0, pointer, blob.Length);
            var credential = new Credential
            {
                Type = Generic, TargetName = scope.Target, UserName = "DeepSeekHarness.Workflow",
                Comment = "Workflow Secret; manage through the workflow native credential window",
                CredentialBlobSize = (uint)blob.Length, CredentialBlob = pointer, Persist = PersistLocalComputer,
            };
            if (!CredWriteW(ref credential, 0)) throw new BrokerFailure("keychain_failed");
        }
        finally
        {
            if (pointer != IntPtr.Zero) { Clear(pointer, blob.Length); Marshal.FreeHGlobal(pointer); }
            CryptographicOperations.ZeroMemory(blob);
        }
    }

    public static void Delete(Scope scope)
    {
        if (!CredDeleteW(scope.Target, Generic, 0) && Marshal.GetLastWin32Error() != NotFound)
            throw new BrokerFailure("keychain_failed");
    }

    private static void ClearAndFree(IntPtr pointer)
    {
        if (pointer == IntPtr.Zero) return;
        try
        {
            Credential credential = Marshal.PtrToStructure<Credential>(pointer);
            if (credential.CredentialBlob != IntPtr.Zero && credential.CredentialBlobSize <= MaxBlob)
                Clear(credential.CredentialBlob, (int)credential.CredentialBlobSize);
        }
        finally { CredFree(pointer); }
    }

    private static unsafe void Clear(IntPtr pointer, int size) =>
        CryptographicOperations.ZeroMemory(new Span<byte>(pointer.ToPointer(), size));

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string? TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string? TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string? UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);
}
