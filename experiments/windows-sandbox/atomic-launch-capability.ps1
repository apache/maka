$ErrorActionPreference = 'Stop'

$privileges = whoami.exe /priv 2>$null
$hasAssign = $privileges -match 'SeAssignPrimaryTokenPrivilege\s+.*Enabled'
$hasQuota = $privileges -match 'SeIncreaseQuotaPrivilege\s+.*Enabled'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

[pscustomobject]@{
  user = $identity.Name
  isAdministrator = $isAdmin
  seAssignPrimaryToken = $hasAssign
  seIncreaseQuota = $hasQuota
  atomicCreateProcessAsUserReady = $hasAssign -and $hasQuota
  failClosedRequired = -not ($hasAssign -and $hasQuota)
} | ConvertTo-Json -Compress
