using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorkflowSecretBroker;

internal sealed class BrokerFailure(string code) : Exception
{
    public string Code { get; } = code;
}

internal sealed record Scope(string WorkspaceId, string WorkflowId, string VariableId, string NodeId)
{
    // The node and consumer operation never become credential ownership.
    public string Target
    {
        get
        {
            byte[] canonical = JsonSerializer.SerializeToUtf8Bytes(new
            {
                workspaceId = WorkspaceId,
                workflowId = WorkflowId,
                variableId = VariableId,
            });
            return "DeepSeekHarness.Workflow.Secret/v1/" + Convert.ToHexString(SHA256.HashData(canonical)).ToLowerInvariant();
        }
    }
}

internal sealed record BrokerRequest(string Command, Scope? Scope)
{
    public const string Operation = "deepseek.account-status.v1";
    public const int MaxRequestBytes = 8192;

    public static BrokerRequest Parse(ReadOnlyMemory<byte> bytes)
    {
        if (bytes.Length is < 1 or > MaxRequestBytes) throw new BrokerFailure("invalid_request");
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes, new JsonDocumentOptions
            {
                AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow, MaxDepth = 8,
            });
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object ||
                !root.TryGetProperty("version", out JsonElement version) ||
                version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out int v) || v != 1 ||
                !root.TryGetProperty("command", out JsonElement command) || command.ValueKind != JsonValueKind.String)
                throw new BrokerFailure("invalid_request");
            string name = command.GetString()!;
            if (name == "probe")
            {
                ExactKeys(root, "version", "command");
                return new BrokerRequest(name, null);
            }
            if (name is not ("status" or "manage" or "execute")) throw new BrokerFailure("invalid_request");
            ExactKeys(root, "version", "command", "operation", "scope");
            if (root.GetProperty("operation").ValueKind != JsonValueKind.String ||
                root.GetProperty("operation").GetString() != Operation) throw new BrokerFailure("invalid_request");
            JsonElement scope = root.GetProperty("scope");
            ExactKeys(scope, "workspaceId", "workflowId", "variableId", "nodeId");
            return new BrokerRequest(name, new Scope(Id(scope, "workspaceId"), Id(scope, "workflowId"),
                Id(scope, "variableId"), Id(scope, "nodeId")));
        }
        catch (JsonException) { throw new BrokerFailure("invalid_request"); }
        catch (InvalidOperationException) { throw new BrokerFailure("invalid_request"); }
        catch (DecoderFallbackException) { throw new BrokerFailure("invalid_request"); }
    }

    private static void ExactKeys(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new BrokerFailure("invalid_request");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
            if (!seen.Add(property.Name) || !keys.Contains(property.Name, StringComparer.Ordinal))
                throw new BrokerFailure("invalid_request");
        if (seen.Count != keys.Length) throw new BrokerFailure("invalid_request");
    }

    private static string Id(JsonElement parent, string key)
    {
        JsonElement value = parent.GetProperty(key);
        if (value.ValueKind != JsonValueKind.String) throw new BrokerFailure("invalid_request");
        string text = value.GetString()!;
        if (text.Length is < 1 or > 128 || text.Any(c => !(char.IsAsciiLetterOrDigit(c) || "_.:-".Contains(c))))
            throw new BrokerFailure("invalid_request");
        return text;
    }
}

// No response type has a credential/value/token/header/body field. Errors never serialize Exception.Message.
internal sealed record BrokerResponse(
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("code")] string? Code = null,
    [property: JsonPropertyName("available")] bool? Available = null,
    [property: JsonPropertyName("state")] string? State = null,
    [property: JsonPropertyName("status_code")] int? StatusCode = null)
{
    public string ToJson() => JsonSerializer.Serialize(this, new JsonSerializerOptions
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    });
    public static BrokerResponse Failure(string code) => new(false, code);
}
