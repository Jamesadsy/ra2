[CmdletBinding()]
param(
    [string]$Source = 'C:\Program Files\EA Games\Command and Conquer Red Alert II',
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'SecondSunPrivate\RA2-M1\Data'),
    [ValidateSet('Installation', 'ValidatedStage')]
    [string]$SourceMode = 'Installation',
    [string]$ExpectedManifestSHA256 = '',
    [string]$ManifestPath = (Join-Path (Join-Path $env:LOCALAPPDATA 'SecondSunPrivate\RA2-M1') 'device-data-manifest.json')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedExeSha256 = '6FC4B410F8841BA3AD6C57B59FCCAE65F58A8871D86750AF3C1E2D5A7C5AD39D'
$deviceDataFiles = @(
    'game.exe',
    'ra2.mix',
    'language.mix',
    'BINKW32.DLL',
    'Blowfish.dll',
    'Maps01.mix',
    'movies01.mix',
    'movies02.mix',
    'Multi.mix',
    'Theme.mix'
)

function Get-NormalizedPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-PathWithin([string]$Path, [string]$Root) {
    $normalizedPath = Get-NormalizedPath $Path
    $normalizedRoot = Get-NormalizedPath $Root
    return $normalizedPath.Equals($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -or
        $normalizedPath.StartsWith($normalizedRoot + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-Inventory([string]$Root, [bool]$RequireExactAllowlist) {
    $rootValues = Get-Item -LiteralPath $Root -Force
    if (-not $rootValues.PSIsContainer -or ($rootValues.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Owner-data source/stage root must be a real directory.'
    }

    $entries = @(Get-ChildItem -LiteralPath $Root -Force)
    if ($RequireExactAllowlist -and ($entries | Where-Object { $_.PSIsContainer }).Count -gt 0) {
        throw 'Validated Data stage must be flat and contain no subdirectories.'
    }
    if ($RequireExactAllowlist -and $entries.Count -ne $deviceDataFiles.Count) {
        throw 'Validated Data stage does not contain exactly the approved file count.'
    }

    $inventory = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $deviceDataFiles) {
        $matches = @($entries | Where-Object { -not $_.PSIsContainer -and $_.Name.Equals($name, [StringComparison]::OrdinalIgnoreCase) })
        if ($matches.Count -ne 1) { throw "Required EA RA2 1.08 owner file is missing or ambiguous: $name" }
        $file = $matches[0]
        if (-not $seen.Add($file.Name)) { throw 'Source contains case-insensitive duplicate owner-data names.' }
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Required owner-data source contains a reparse point.'
        }
        if ($file.Length -le 0) { throw "Required EA RA2 1.08 owner file is empty: $name" }
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $inventory.Add([pscustomobject]@{
            path   = $file.Name.ToLowerInvariant()
            bytes  = [int64]$file.Length
            sha256 = $hash
        })
    }

    if ($RequireExactAllowlist) {
        foreach ($entry in $entries) {
            if ($entry.PSIsContainer -or -not $seen.Contains($entry.Name)) {
                throw 'Validated Data stage contains an entry outside the approved allowlist.'
            }
        }
    }

    $exe = $inventory | Where-Object { $_.path -ceq 'game.exe' } | Select-Object -First 1
    if ($null -eq $exe -or $exe.sha256 -cne $expectedExeSha256.ToLowerInvariant()) {
        throw 'EA RA2 game.exe SHA-256 does not match the accepted 1.08 executable.'
    }
    return @($inventory | Sort-Object -Property path)
}

function Get-ManifestDigest($Inventory) {
    $lines = @(
        foreach ($record in $Inventory) {
            [string]::Concat(
                $record.path,
                [char]9,
                ([int64]$record.bytes).ToString([Globalization.CultureInfo]::InvariantCulture),
                [char]9,
                $record.sha256
            )
        }
    )
    $body = [string]::Join([char]10, [string[]]$lines) + [string][char]10
    $encoding = [Text.UTF8Encoding]::new($false)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return [Convert]::ToHexString($sha.ComputeHash($encoding.GetBytes($body))).ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

$sourcePath = Get-NormalizedPath $Source
$destinationPath = Get-NormalizedPath $Destination
$manifestPathFull = [IO.Path]::GetFullPath($ManifestPath)
$repositoryPath = Get-NormalizedPath (Join-Path $PSScriptRoot '../..')
$canonicalGData = 'G:\My Drive\data-master-ra2\Data'

if ($sourcePath.StartsWith('\\')) { throw 'Source must be a local XPS filesystem path.' }
if ($destinationPath.StartsWith('\\')) { throw 'Destination must be a mounted XPS filesystem path, not a UNC path.' }
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw 'Selected private owner-data source directory was not found.' }
if ((Test-PathWithin $destinationPath $repositoryPath) -or (Test-PathWithin $manifestPathFull $repositoryPath)) {
    throw 'Private owner data and manifests must remain outside the source repository.'
}
if ((Test-PathWithin $destinationPath $sourcePath) -or (Test-PathWithin $sourcePath $destinationPath)) {
    throw 'Source and Data destination must be separate, non-nested directories.'
}
if ((Test-PathWithin $manifestPathFull $destinationPath) -or $manifestPathFull.Equals($destinationPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The complete local manifest must remain outside the device Data folder.'
}

$cloudRoots = @(
    $env:OneDrive,
    $env:OneDriveCommercial,
    $env:OneDriveConsumer,
    (Join-Path $env:USERPROFILE 'Dropbox'),
    (Join-Path $env:USERPROFILE 'Google Drive'),
    (Join-Path $env:USERPROFILE 'iCloudDrive'),
    (Join-Path $env:USERPROFILE 'iCloud Drive')
) | Where-Object { $_ } | ForEach-Object { Get-NormalizedPath $_ }
foreach ($cloudRoot in $cloudRoots) {
    if ((Test-PathWithin $destinationPath $cloudRoot) -and
        -not $destinationPath.Equals($canonicalGData, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Destination must be a local private stage, except for the explicitly authorized mounted G: transfer surface.'
    }
    if (Test-PathWithin $manifestPathFull $cloudRoot) {
        throw 'The full owner-data manifest must not be written to a cloud-synced folder.'
    }
}

$destinationDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($destinationPath))
if ($destinationDrive.DriveType -eq [IO.DriveType]::Network -and
    -not $destinationPath.Equals($canonicalGData, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Destination must be on the local XPS filesystem or the explicitly authorized mounted G: transfer surface.'
}
if ($SourceMode -eq 'Installation' -and
    -not $sourcePath.Equals('C:\Program Files\EA Games\Command and Conquer Red Alert II', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Installation mode accepts only the Chairman-owned official EA RA2 installation path.'
}
if ($SourceMode -eq 'ValidatedStage' -and $ExpectedManifestSHA256 -notmatch '(?i)^[0-9a-f]{64}$') {
    throw 'ValidatedStage mode requires the manifest SHA-256 proven by the private regression.'
}
if (Test-Path -LiteralPath $destinationPath) { throw 'Destination Data folder already exists; refusing to merge or overwrite it.' }
if (Test-Path -LiteralPath $manifestPathFull) { throw 'Manifest output already exists; choose a fresh private evidence path.' }

$sourceInventory = @(Get-Inventory $sourcePath ($SourceMode -eq 'ValidatedStage'))
$sourceManifestDigest = Get-ManifestDigest $sourceInventory
if ($SourceMode -eq 'ValidatedStage' -and
    $sourceManifestDigest -cne $ExpectedManifestSHA256.ToLowerInvariant()) {
    throw 'Validated Data stage manifest does not match the private regression result.'
}

$destinationParent = Split-Path -Parent $destinationPath
if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
}
$staging = Join-Path $destinationParent ('.RA2-Data-stage-' + [Guid]::NewGuid().ToString('N'))
$manifestParent = Split-Path -Parent $manifestPathFull
if (-not (Test-Path -LiteralPath $manifestParent -PathType Container)) {
    New-Item -ItemType Directory -Path $manifestParent -Force | Out-Null
}
$manifestTemp = Join-Path $manifestParent ('.RA2-Data-manifest-' + [Guid]::NewGuid().ToString('N') + '.tmp')
$promoted = $false
$manifestPromoted = $false

try {
    New-Item -ItemType Directory -Path $staging -Force:$false | Out-Null
    foreach ($name in $deviceDataFiles) {
        $file = Get-ChildItem -LiteralPath $sourcePath -File -Force |
            Where-Object { $_.Name.Equals($name, [StringComparison]::OrdinalIgnoreCase) } |
            Select-Object -First 1
        Copy-Item -LiteralPath $file.FullName -Destination (Join-Path $staging $file.Name)
    }

    $stagedInventory = @(Get-Inventory $staging $true)
    $stagedManifestDigest = Get-ManifestDigest $stagedInventory
    if ($stagedManifestDigest -cne $sourceManifestDigest) {
        throw 'Staged Data count, bytes or SHA-256 inventory differs from the validated source.'
    }

    $totalBytes = [int64](($stagedInventory | Measure-Object -Property bytes -Sum).Sum)
    $manifest = [ordered]@{
        schemaVersion = 1
        purpose = 'RA2 M1 private device Data custody manifest'
        fileCount = $stagedInventory.Count
        totalBytes = $totalBytes
        manifestSHA256 = $stagedManifestDigest
        gameExeSHA256 = $expectedExeSha256
        files = @($stagedInventory)
    }
    $manifestJson = ConvertTo-Json -InputObject $manifest -Depth 5
    [IO.File]::WriteAllText($manifestTemp, $manifestJson + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $manifestTemp -Destination $manifestPathFull
    $manifestPromoted = $true
    Move-Item -LiteralPath $staging -Destination $destinationPath
    $promoted = $true

    Write-Host 'RA2_DEVICE_DATA_STAGE=verified'
    Write-Host "RA2_DEVICE_DATA_MODE=$SourceMode"
    Write-Host "RA2_DEVICE_DATA_FILE_COUNT=$($stagedInventory.Count)"
    Write-Host "RA2_DEVICE_DATA_TOTAL_BYTES=$totalBytes"
    Write-Host "RA2_DEVICE_DATA_MANIFEST_SHA256=$stagedManifestDigest"
    Write-Host "EA108_GAME_EXE_SHA256=$expectedExeSha256"
} catch {
    if (-not $promoted -and (Test-Path -LiteralPath $staging -PathType Container)) {
        $resolvedStage = Get-NormalizedPath $staging
        $resolvedParent = Get-NormalizedPath $destinationParent
        if ($resolvedStage.StartsWith($resolvedParent + '\', [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
    if (-not $promoted -and $manifestPromoted -and (Test-Path -LiteralPath $manifestPathFull -PathType Leaf)) {
        Remove-Item -LiteralPath $manifestPathFull -Force
    }
    if (Test-Path -LiteralPath $manifestTemp -PathType Leaf) { Remove-Item -LiteralPath $manifestTemp -Force }
    throw
}
