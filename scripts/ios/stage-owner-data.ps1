[CmdletBinding()]
param(
    [string]$Source = 'C:\Program Files\EA Games\Command and Conquer Red Alert II',
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'SecondSunPrivate\RA2-M1')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$expectedSha256 = '6FC4B410F8841BA3AD6C57B59FCCAE65F58A8871D86750AF3C1E2D5A7C5AD39D'
$required = @('game.exe', 'ra2.mix', 'language.mix', 'BINKW32.DLL', 'Blowfish.dll', 'Maps01.mix', 'movies01.mix', 'movies02.mix', 'Multi.mix', 'Theme.mix')

function Get-Inventory([string]$Root) {
    $result = @{}
    foreach ($file in Get-ChildItem -LiteralPath $Root -File -Recurse -Force) {
        $relative = [IO.Path]::GetRelativePath($Root, $file.FullName).Replace('\', '/')
        $result[$relative.ToLowerInvariant()] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    return $result
}

function Assert-RequiredOwnerFiles([string]$Root) {
    $rootFiles = Get-ChildItem -LiteralPath $Root -File -Force
    foreach ($name in $required) {
        $match = $rootFiles | Where-Object { $_.Name -ieq $name } | Select-Object -First 1
        if ($null -eq $match) { throw "Required RA2 1.08 owner file is missing: $name" }
        if ($match.Length -le 0) { throw "Required RA2 1.08 owner file is empty: $name" }
    }
    $exe = $rootFiles | Where-Object { $_.Name -ieq 'game.exe' } | Select-Object -First 1
    $actual = (Get-FileHash -LiteralPath $exe.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actual -cne $expectedSha256) { throw "EA RA2 game.exe SHA-256 mismatch: $actual" }
}

$sourcePath = [IO.Path]::GetFullPath($Source).TrimEnd('\')
$destinationPath = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
$sourcePrefix = $sourcePath + '\'
$destinationPrefix = $destinationPath + '\'
$repositoryPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\')
if ($sourcePath.StartsWith('\\')) { throw 'Source must be a local XPS filesystem path, not a network share.' }
if ($destinationPath.StartsWith('\\')) { throw 'Destination must be a local XPS filesystem path, not a network share.' }
$sourceDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($sourcePath))
if ($sourceDrive.DriveType -eq [IO.DriveType]::Network) {
    throw 'Source must be on a local XPS filesystem, not a mapped network drive.'
}

if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) { throw "Official EA RA2 1.08 source folder not found: $sourcePath" }
if ($destinationPath.Equals($repositoryPath, [StringComparison]::OrdinalIgnoreCase) -or
    $destinationPath.StartsWith($repositoryPath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Destination cannot be inside the source repository.'
}
$destinationDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($destinationPath))
if ($destinationDrive.DriveType -ne [IO.DriveType]::Fixed) {
    throw 'Destination must be on a fixed local XPS drive.'
}
$cloudRoots = @(
    $env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer,
    (Join-Path $env:USERPROFILE 'Dropbox'), (Join-Path $env:USERPROFILE 'Google Drive'),
    (Join-Path $env:USERPROFILE 'iCloudDrive'), (Join-Path $env:USERPROFILE 'iCloud Drive')
) | Where-Object { $_ } | ForEach-Object { [IO.Path]::GetFullPath($_).TrimEnd('\') }
if ($cloudRoots | Where-Object {
    $destinationPath.Equals($_, [StringComparison]::OrdinalIgnoreCase) -or
    $destinationPath.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase)
}) {
    throw 'Destination cannot be inside a configured OneDrive, Dropbox, Google Drive, or iCloud folder.'
}
if ($sourcePath.Equals($destinationPath, [StringComparison]::OrdinalIgnoreCase) -or
    $sourcePath.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $destinationPath.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Source and destination must be separate, non-nested directories.'
}

Assert-RequiredOwnerFiles $sourcePath
$reparse = Get-ChildItem -LiteralPath $sourcePath -Recurse -Force | Where-Object {
    ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
} | Select-Object -First 1
if ($null -ne $reparse) { throw 'Source contains a reparse point; refuse to follow it.' }

New-Item -ItemType Directory -Path $destinationPath -Force | Out-Null
$existingEntries = Get-ChildItem -LiteralPath $destinationPath -Force
if ($existingEntries) { throw 'Destination must be a new or empty private folder.' }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$access = [System.Security.AccessControl.FileSystemRights]::FullControl
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$acl = Get-Acl -LiteralPath $destinationPath
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($currentSid)
foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $sid, $access, $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $destinationPath -AclObject $acl
$finalFolder = Join-Path $destinationPath 'ra2'
$zipPath = Join-Path $destinationPath 'RA2-OwnerData-1.08.zip'
if (Test-Path -LiteralPath $finalFolder) { throw 'Destination already has a ra2 folder; select a new empty destination to prevent overwrite.' }
if (Test-Path -LiteralPath $zipPath) { throw 'Destination already has the owner-data ZIP; select a new destination to prevent overwrite.' }

$staging = Join-Path $destinationPath ('.ra2-staging-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging -Force:$false | Out-Null
try {
    & robocopy $sourcePath $staging /E /COPY:DAT /DCOPY:DAT /R:0 /W:0 /XJ /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -gt 7) { throw "Owner-data copy failed with robocopy exit code $LASTEXITCODE." }

    Assert-RequiredOwnerFiles $staging
    $sourceInventory = Get-Inventory $sourcePath
    $stagedInventory = Get-Inventory $staging
    if ($sourceInventory.Count -ne $stagedInventory.Count) { throw 'Copied owner-data inventory count differs from the EA source.' }
    foreach ($path in $sourceInventory.Keys) {
        if (-not $stagedInventory.ContainsKey($path) -or $sourceInventory[$path] -cne $stagedInventory[$path]) {
            throw 'Copied owner-data SHA-256 inventory differs from the EA source.'
        }
    }

    Move-Item -LiteralPath $staging -Destination $finalFolder
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in Get-ChildItem -LiteralPath $finalFolder -File -Recurse -Force) {
            $relative = [IO.Path]::GetRelativePath($finalFolder, $file.FullName).Replace('\', '/')
            $entry = $archive.CreateEntry("ra2/$relative", [System.IO.Compression.CompressionLevel]::NoCompression)
            $input = [IO.File]::OpenRead($file.FullName)
            try {
                $output = $entry.Open()
                try { $input.CopyTo($output) } finally { $output.Dispose() }
            } finally { $input.Dispose() }
        }
    } finally {
        $archive.Dispose()
    }

    $finalExe = Get-ChildItem -LiteralPath $finalFolder -File | Where-Object { $_.Name -ieq 'game.exe' } | Select-Object -First 1
    $finalHash = (Get-FileHash -LiteralPath $finalExe.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($finalHash -cne $expectedSha256) { throw 'Final owner-data executable identity verification failed.' }
    Write-Host "RA2_OWNER_DATA_STAGED=$finalFolder"
    Write-Host "RA2_OWNER_DATA_ZIP=$zipPath"
    Write-Host "EA108_GAME_EXE_SHA256=$finalHash"
    Write-Host 'SOURCE_COPY_HASH_INVENTORY=verified'
    Write-Host 'ZIP_COMPRESSION=none'
} catch {
    if (Test-Path -LiteralPath $staging -PathType Container) {
        # The exact GUID staging path was created by this invocation and is inside the verified destination.
        $resolvedStage = [IO.Path]::GetFullPath($staging)
        if ($resolvedStage.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
    if (Test-Path -LiteralPath $zipPath -PathType Leaf) { Remove-Item -LiteralPath $zipPath -Force }
    throw
}
