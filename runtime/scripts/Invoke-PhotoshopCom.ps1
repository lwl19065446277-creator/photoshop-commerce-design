#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $RequestPath,
    [Parameter(Mandatory = $true)][string] $ResultPath
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$requestFile = [System.IO.Path]::GetFullPath($RequestPath)
$resultFile = [System.IO.Path]::GetFullPath($ResultPath)
$dispatcherFile = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\src\legacy\photoshop-com.jsx'))
if ($requestFile -eq $resultFile -or $dispatcherFile -eq $resultFile) { throw 'ResultPath must be a new file distinct from input and dispatcher.' }
# Reserve the result before any COM call. An existing result never causes a replay.
$resultStream = [System.IO.File]::Open($resultFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
$psApp = $null
$operation = ''
try {
    if ([System.Threading.Thread]::CurrentThread.GetApartmentState() -ne 'STA') { throw 'Run Windows PowerShell with -STA for Photoshop COM.' }
    $request = [System.IO.File]::ReadAllText($requestFile, $utf8) | ConvertFrom-Json
    $operation = [string]$request.operation
    $allowedOperations = @('ping', 'font_catalog', 'close_created_probe', 'render_design', 'discard_failed_render', 'open_working_copy', 'inspect_document', 'audit_document', 'set_text', 'save_psd', 'export_preview', 'close_document')
    $allowedOperations += @('layer_descriptor','render_native_catalog','purge_idle_history','export_native_slices','render_native_variant')
    if ($allowedOperations -cnotcontains $operation) { throw 'Operation is not in the static Photoshop COM allowlist.' }
    $argsData = $request.args
    if ($null -eq $argsData -or $argsData -is [array] -or $argsData -is [string]) { throw 'args must be an object.' }
    $allowedFields = @('documentId', 'path', 'sourceWorkingPath', 'layerId', 'expectedText', 'text', 'format', 'save')
    foreach ($property in $argsData.PSObject.Properties) {
        if ($allowedFields -cnotcontains $property.Name) { throw ('Unknown argument: ' + $property.Name) }
        if ($null -ne $property.Value -and $property.Value -isnot [string] -and $property.Value -isnot [ValueType]) { throw ('Argument must be a scalar: ' + $property.Name) }
    }
    if ($operation -eq 'set_text' -and ($null -eq $argsData.PSObject.Properties['expectedText'] -or $null -eq $argsData.PSObject.Properties['text'])) { throw 'set_text requires exact expectedText and text.' }
    if ($operation -eq 'close_document' -and $argsData.save -ne $false) { throw 'close_document requires save:false.' }
    foreach ($field in @('path','sourceWorkingPath','expectedText','text','format')) {
        if ($null -ne $argsData.$field -and $argsData.$field -isnot [string]) { throw ($field + ' must be a string.') }
        if ([string]$argsData.$field -match '\x00') { throw ($field + ' contains a null character.') }
    }
    $comArguments = [object[]]@($operation, [string]$argsData.documentId, [string]$argsData.path, [string]$argsData.sourceWorkingPath, [string]$argsData.layerId, [string]$argsData.expectedText, [string]$argsData.text, [string]$argsData.format)
    try { $psApp = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Photoshop.Application') }
    catch { $psApp = New-Object -ComObject Photoshop.Application }
    # Only this repository-owned static JSX file is executable; request data is
    # supplied as SAFEARRAY arguments, never interpolated into JavaScript code.
    $resultJson = [string]$psApp.DoJavaScriptFile($dispatcherFile, $comArguments, 1)
    $validated = $resultJson | ConvertFrom-Json
    if ($null -eq $validated -or $validated.ok -isnot [bool]) { throw 'Photoshop returned an invalid structured result.' }
    if (!$validated.ok -and ($null -eq $validated.error -or !$validated.error.code -or !$validated.error.message)) { throw 'Photoshop returned an incomplete error result.' }
    $resultBytes = $utf8.GetBytes($resultJson)
    $resultStream.Write($resultBytes, 0, $resultBytes.Length)
    $resultStream.Flush()
} catch {
    $unknown = $null -ne $psApp -and @('ping','inspect_document','audit_document','font_catalog','layer_descriptor') -cnotcontains $operation
    $failure = @{ ok = $false; error = @{ code = 'COM_AUTOMATION_FAILED'; message = $_.Exception.Message; details = @{ outcome = $(if ($unknown) { 'unknown' } else { 'not-confirmed' }); hresult = $_.Exception.HResult } } }
    $failureBytes = $utf8.GetBytes(($failure | ConvertTo-Json -Depth 8 -Compress))
    $resultStream.SetLength(0)
    $resultStream.Write($failureBytes, 0, $failureBytes.Length)
    $resultStream.Flush()
    $script:ComCallFailed = $true
} finally {
    $resultStream.Dispose()
    if ($null -ne $psApp -and [System.Runtime.InteropServices.Marshal]::IsComObject($psApp)) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($psApp) }
}
if ($script:ComCallFailed) { exit 1 }
