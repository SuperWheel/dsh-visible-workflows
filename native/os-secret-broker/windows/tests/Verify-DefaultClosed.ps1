param([Parameter(Mandatory = $true)][string]$BrokerPath)
$ErrorActionPreference = 'Stop'

# This only verifies a DEFAULT build. It must never be pointed at an acceptance build.
# Inputs contain synthetic public IDs and no credential value.
$resolvedBroker = (Resolve-Path -LiteralPath $BrokerPath).Path
$cases = @(
    @{ request = '{"version":1,"command":"probe"}'; ok = $true; code = 'windows_unverified' },
    @{ request = '{"version":1,"command":"status","operation":"deepseek.account-status.v1","scope":{"workspaceId":"synthetic","workflowId":"synthetic","variableId":"synthetic","nodeId":"synthetic"}}'; ok = $false; code = 'windows_unverified' },
    @{ request = '{"version":1,"command":"manage","operation":"deepseek.account-status.v1","scope":{"workspaceId":"synthetic","workflowId":"synthetic","variableId":"synthetic","nodeId":"synthetic"}}'; ok = $false; code = 'windows_unverified' },
    @{ request = '{"version":1,"command":"execute","operation":"deepseek.account-status.v1","scope":{"workspaceId":"synthetic","workflowId":"synthetic","variableId":"synthetic","nodeId":"synthetic"}}'; ok = $false; code = 'windows_unverified' },
    @{ request = '{"version":1,"command":"resolve"}'; ok = $false; code = 'invalid_request' }
)
foreach ($case in $cases) {
    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $resolvedBroker
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $process = [System.Diagnostics.Process]::Start($start)
    try {
        $process.StandardInput.Write($case.request)
        $process.StandardInput.Close()
        if (-not $process.WaitForExit(10000)) {
            $process.Kill()
            throw 'Default broker failed to exit within 10 seconds.'
        }
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        if ($process.ExitCode -ne 0 -or $stderr.Length -ne 0 -or $stdout.Length -gt 4096) { throw 'Unexpected process result.' }
        $response = $stdout | ConvertFrom-Json
        if ($response.ok -ne $case.ok -or $response.code -ne $case.code) { throw 'Unexpected closed readiness response.' }
        if ($response.PSObject.Properties.Name -contains 'available' -and $response.available -ne $false) { throw 'Unverified build reported available.' }
    } finally { $process.Dispose() }
}
Write-Output '5 default-closed checks passed; this is not Windows Hello, Credential Manager, or Agent isolation acceptance.'
