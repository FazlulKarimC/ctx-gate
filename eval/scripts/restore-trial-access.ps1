param(
  [Parameter(Mandatory=$true)][string]$TrialSlot,
  [Parameter(Mandatory=$true)][string]$EvidencePath
)
$ErrorActionPreference = 'Stop'
$trialBase = [System.IO.Path]::GetFullPath((Join-Path ([System.IO.Path]::GetTempPath()) 'ctxgate-phase5-trials')).TrimEnd('\') + '\'
$slotPath = (Resolve-Path -LiteralPath $TrialSlot).ProviderPath
if (-not $slotPath.StartsWith($trialBase, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Only this experiment-owned temporary trial directory is allowed' }
if ((Split-Path -Leaf $slotPath) -notmatch '^picomatch-d0[1-5]-r[12]-[AB]$') { throw 'Not a registered trial slot' }
if (-not (Test-Path -LiteralPath (Join-Path $slotPath 'workspace/.ctxgate-eval-root') -PathType Leaf)) { throw 'Owned workspace marker missing' }
$acl = Get-Acl -LiteralPath $slotPath
$before = $acl.Sddl
$rules = @($acl.Access | Where-Object { -not $_.IsInherited -and $_.AccessControlType -eq 'Deny' -and $_.IdentityReference.Value -match '\\CodexSandboxUsers$' })
# Only obsolete peer-deny entries on the NEXT owned slot are removed. Other
# folders and all non-matching/inherited ACEs remain untouched. The host then
# reapplies the same sandbox policy and independently checks protected paths.
foreach ($rule in $rules) { [void]$acl.RemoveAccessRuleSpecific($rule) }
if ($rules.Count -gt 0) { Set-Acl -LiteralPath $slotPath -AclObject $acl }
$result = [ordered]@{ schema_version=1; operation='restore_inactive_trial_slot'; path=$slotPath; removed_explicit_peer_deny_rules=$rules.Count; before_sddl=$before; after_sddl=(Get-Acl -LiteralPath $slotPath).Sddl; recorded_at=[DateTime]::UtcNow.ToString('o') }
$result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $EvidencePath -Encoding utf8NoBOM
Write-Output ('Restored owned inactive trial slot; removed ' + $rules.Count + ' obsolete explicit peer-deny entries')
