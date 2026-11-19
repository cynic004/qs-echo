[CmdletBinding()]
param([string] $Destination)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $Destination) {
    $Destination = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime'
}

$version = '24.22.3'
$archiveName = "node-v$version-win-x64"
$archiveHash = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
$nodeHash = '86fc4785327db5f5c7558dc6156c543b433c313e813a222e088086222ab4afa6'
$licenseHash = 'ed34dd8e3f0a78dbaf00d0444ce8e285b015b765379c2e17880455f70370f8e9'
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
$nodePath = Join-Path $destinationPath 'node.exe'
$licensePath = Join-Path $destinationPath 'LICENSE.txt'

function Test-Sha256([string] $Path, [string] $Expected) {
    return (Test-Path -LiteralPath $Path -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Expected)
}

if ((Test-Sha256 $nodePath $nodeHash) -and (Test-Sha256 $licensePath $licenseHash)) {
    Write-Host "Verified existing Windows x64 Node.js $version runtime."
    return
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('qs-echo-node-' + [Guid]::NewGuid().ToString('N'))
$download = Join-Path $stage "$archiveName.zip"
$stagedNode = Join-Path $stage 'node.exe'
$stagedLicense = Join-Path $stage 'LICENSE.txt'
[void] [System.IO.Directory]::CreateDirectory($stage)

try {
    $url = "https://nodejs.org/dist/v$version/$archiveName.zip"
    Write-Host "Downloading Windows x64 Node.js $version from nodejs.org."
    Invoke-WebRequest -Uri $url -OutFile $download -UseBasicParsing -TimeoutSec 180
    if (-not (Test-Sha256 $download $archiveHash)) {
        throw 'The Node.js archive did not match the pinned SHA-256 checksum.'
    }

    $archive = [System.IO.Compression.ZipFile]::OpenRead($download)
    try {
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry("$archiveName/node.exe"), $stagedNode)
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($archive.GetEntry("$archiveName/LICENSE"), $stagedLicense)
    } finally {
        $archive.Dispose()
    }

    if (-not ((Test-Sha256 $stagedNode $nodeHash) -and (Test-Sha256 $stagedLicense $licenseHash))) {
        throw 'The extracted Node.js files did not match their pinned SHA-256 checksums.'
    }
    [void] [System.IO.Directory]::CreateDirectory($destinationPath)
    Move-Item -LiteralPath $stagedNode -Destination $nodePath -Force
    Move-Item -LiteralPath $stagedLicense -Destination $licensePath -Force
    Write-Host "Prepared verified Windows x64 Node.js $version runtime."
} finally {
    foreach ($file in @($download, $stagedNode, $stagedLicense)) {
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            Remove-Item -LiteralPath $file -Force
        }
    }
    Remove-Item -LiteralPath $stage -Force
}
