param(
  [string]$Host = $env:VPS_HOST,
  [string]$User = $env:VPS_USER,
  [string]$RemotePath = $env:VPS_PATH,
  [int]$Port = $(if ($env:VPS_PORT) { [int]$env:VPS_PORT } else { 22 }),
  [string]$LocalDir = "docs"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command '$Name'. Install it and try again."
  }
}

function Quote-ForBashSingle {
  param([string]$Value)
  if ($null -eq $Value) {
    return "''"
  }

  return "'" + ($Value -replace "'", "'\"'\"'") + "'"
}

if ([string]::IsNullOrWhiteSpace($Host)) {
  throw "Missing host. Pass -Host or set VPS_HOST."
}

if ([string]::IsNullOrWhiteSpace($User)) {
  throw "Missing user. Pass -User or set VPS_USER."
}

if ([string]::IsNullOrWhiteSpace($RemotePath)) {
  throw "Missing remote path. Pass -RemotePath or set VPS_PATH."
}

Require-Command "tar"
Require-Command "ssh"
Require-Command "scp"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$resolvedLocalDir = Resolve-Path (Join-Path $repoRoot $LocalDir)

if (-not (Test-Path $resolvedLocalDir -PathType Container)) {
  throw "Local directory '$LocalDir' does not exist under $repoRoot."
}

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$archivePath = Join-Path $env:TEMP ("viboplr-site-$stamp.tar.gz")
$remoteArchivePath = "/tmp/viboplr-site-$stamp.tar.gz"
$target = "$User@$Host"

Write-Host "Creating archive from '$resolvedLocalDir'..."
& tar -czf $archivePath -C $resolvedLocalDir .
if ($LASTEXITCODE -ne 0) {
  throw "Failed to create archive."
}

Write-Host "Uploading archive to $target:$remoteArchivePath ..."
& scp -P $Port $archivePath "$target`:$remoteArchivePath"
if ($LASTEXITCODE -ne 0) {
  throw "Failed to upload archive."
}

$quotedRemotePath = Quote-ForBashSingle $RemotePath
$quotedRemoteArchivePath = Quote-ForBashSingle $remoteArchivePath

$remoteScript = @"
set -e
mkdir -p $quotedRemotePath
if command -v rsync >/dev/null 2>&1; then
  tmpdir=\$(mktemp -d)
  tar -xzf $quotedRemoteArchivePath -C "\$tmpdir"
  rsync -a --delete "\$tmpdir"/ $quotedRemotePath/
  rm -rf "\$tmpdir"
else
  find $quotedRemotePath -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  tar -xzf $quotedRemoteArchivePath -C $quotedRemotePath
fi
rm -f $quotedRemoteArchivePath
"@

Write-Host "Deploying archive to '$RemotePath'..."
& ssh -p $Port $target $remoteScript
if ($LASTEXITCODE -ne 0) {
  throw "Remote deploy failed."
}

Remove-Item -LiteralPath $archivePath -ErrorAction SilentlyContinue
Write-Host "Deployment complete."
Write-Host "Live path: $target:$RemotePath"
