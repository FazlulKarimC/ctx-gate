param([Parameter(Mandatory=$true)][string]$EvidencePath)
$ErrorActionPreference='Stop'
$projectPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..')).TrimEnd('\')
$personalPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'
$evidenceFull=[IO.Path]::GetFullPath($EvidencePath)
if(-not $evidenceFull.StartsWith($projectPath+'\eval\',[StringComparison]::OrdinalIgnoreCase)){throw 'Cleanup evidence must stay in the project eval directory'}
$records=@()
foreach($target in @($projectPath,$personalPath)){
  $resolved=(Resolve-Path -LiteralPath $target).ProviderPath
  if(-not $resolved.Equals($target,[StringComparison]::OrdinalIgnoreCase)){throw 'Unexpected cleanup target'}
  $acl=Get-Acl -LiteralPath $resolved
  $before=$acl.Sddl
  # Restore only transient explicit denies created by this experiment's sandbox.
  $rules=@($acl.Access | Where-Object {-not $_.IsInherited -and $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Value -match '\\CodexSandboxUsers$'})
  foreach($rule in $rules){[void]$acl.RemoveAccessRuleSpecific($rule)}
  if($rules.Count -gt 0){Set-Acl -LiteralPath $resolved -AclObject $acl}
  $after=Get-Acl -LiteralPath $resolved
  $remaining=@($after.Access | Where-Object {$_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Value -match '\\CodexSandboxUsers$'}).Count
  $records += [pscustomobject]@{path=$resolved;removed=$rules.Count;remaining=$remaining;before_sddl=$before;after_sddl=$after.Sddl}
}
$result=[ordered]@{schema_version=1;operation='restore_phase8_transient_denies';recorded_at=[DateTime]::UtcNow.ToString('o');records=$records}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidenceFull -Encoding utf8NoBOM
if(@($records | Where-Object remaining -ne 0).Count -gt 0){throw 'Experiment deny restoration incomplete'}
Write-Output 'Phase 8 transient denies restored; all other ACL entries preserved.'
