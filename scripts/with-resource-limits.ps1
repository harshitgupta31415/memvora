param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$TaskCommand,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$TaskArguments
)

$ErrorActionPreference = 'Stop'
$taskProcess = [System.Diagnostics.Process]::GetCurrentProcess()
if ($IsWindows -or $env:OS -eq 'Windows_NT') {
  $taskProcess.ProcessorAffinity = [IntPtr]3
  $taskProcess.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::BelowNormal
}
$env:UV_THREADPOOL_SIZE = '2'
$env:RAYON_NUM_THREADS = '2'
$env:NODE_OPTIONS = "$env:NODE_OPTIONS --max-old-space-size=2048 --v8-pool-size=1".Trim()

Write-Host 'Resource profile: two logical processors on Windows, low priority, bounded worker pools.'
& $TaskCommand @TaskArguments
exit $LASTEXITCODE
