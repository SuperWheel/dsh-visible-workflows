using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using WorkflowSecretBroker;

// Pure protocol/codec tests: no Windows API, account, credential, network or UI access.
int checks = 0;
void Check(bool condition)
{
    checks++;
    if (!condition) throw new Exception("Protocol assertion failed at check " + checks);
}
void Reject(Action action, string expected = "invalid_request")
{
    checks++;
    try { action(); }
    catch (BrokerFailure failure) when (failure.Code == expected) { return; }
    throw new Exception("Expected bounded rejection at check " + checks);
}
BrokerRequest Parse(string json) => BrokerRequest.Parse(Encoding.UTF8.GetBytes(json));
const string scope = "{\"workspaceId\":\"w\",\"workflowId\":\"f\",\"variableId\":\"s\",\"nodeId\":\"n\"}";
string Request(string command) => $"{{\"version\":1,\"command\":\"{command}\",\"operation\":\"deepseek.account-status.v1\",\"scope\":{scope}}}";
Check(Parse("{\"version\":1,\"command\":\"probe\"}").Command == "probe");
foreach (string command in new[] { "status", "manage", "execute" }) Check(Parse(Request(command)).Command == command);
Scope ownership = Parse(Request("status")).Scope!;
Check(ownership.Target == (ownership with { NodeId = "another-node" }).Target);
Check(ownership.Target != (ownership with { WorkflowId = "another-workflow" }).Target);
Check(ownership.Target != (ownership with { WorkspaceId = "another-workspace" }).Target);
Check(ownership.Target != (ownership with { VariableId = "another-variable" }).Target);
foreach (string command in new[] { "resolve", "read", "dump", "export", "getSecret", "Execute" }) Reject(() => Parse(Request(command)));
Reject(() => Parse(Request("execute").Replace("deepseek.account-status.v1", "http.request")));
Reject(() => Parse(Request("manage").Replace("\"scope\":", "\"value\":\"synthetic-only\",\"scope\":")));
Reject(() => Parse(Request("status").Replace("\"nodeId\":", "\"unknown\":1,\"nodeId\":")));
Reject(() => Parse("{\"version\":1,\"version\":1,\"command\":\"probe\"}"));
Reject(() => Parse(Request("status").Replace("\"nodeId\":\"n\"", "\"nodeId\":\"n\",\"nodeId\":\"m\"")));
Reject(() => Parse("{\"version\":true,\"command\":\"probe\"}"));
Reject(() => Parse(Request("status").Replace("\"variableId\":\"s\"", "\"variableId\":\"密钥\"")));
Reject(() => Parse(Request("status").Replace("\"variableId\":\"s\"", "\"variableId\":4")));
Reject(() => BrokerRequest.Parse(new byte[8193]));
Reject(() => Parse("{\"version\":1,\"command\":\"probe\",}"));
Reject(() => Parse("{\"version\":1,\"command\":\"probe\"} {}"));
foreach (string synthetic in new[] { "x", "含 空格、标点! £", "line\nline", new string('a', 2048) })
{
    byte[] encoded = SecretValue.Encode(synthetic);
    Check(encoded.Length <= 2560);
    Check(SecretValue.Decode(encoded) == synthetic);
    CryptographicOperations.ZeroMemory(encoded);
}
Reject(() => SecretValue.Encode(""), "item_invalid");
Reject(() => SecretValue.Encode("a\0b"), "item_invalid");
Reject(() => SecretValue.Encode(new string('a', 2049)), "item_invalid");
Reject(() => SecretValue.Encode(new string('中', 683)), "item_invalid");
Reject(() => SecretValue.Encode("\ud800"), "item_invalid");
Reject(() => SecretValue.Decode("not-a-store-record"u8), "item_invalid");
foreach (string token in new[] { "x", "abc-._~+/==", new string('a', 2048) }) Check(SecretValue.IsDeepSeekToken(token));
foreach (string token in new[] { "", "=", "x=y", "含中文", "a b", "a\rb", "a\nb", new string('a', 2049) })
    Check(!SecretValue.IsDeepSeekToken(token));
using (JsonDocument result = JsonDocument.Parse(new BrokerResponse(true, StatusCode: 401).ToJson()))
{
    Check(result.RootElement.EnumerateObject().Count() == 2);
    Check(result.RootElement.GetProperty("status_code").GetInt32() == 401);
}
Check(new BrokerResponse(true, State: "unchanged").ToJson() == "{\"ok\":true,\"state\":\"unchanged\"}");
Console.WriteLine($"{checks} protocol checks passed; Windows credential and authentication APIs were not invoked.");
