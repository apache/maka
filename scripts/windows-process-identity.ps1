function Get-WindowsProcessIdentityKey {
  param(
    [Parameter(Mandatory = $true)]
    [object]$Process
  )

  $creationDate = [DateTimeOffset]$Process.CreationDate
  $creationDateUtc = $creationDate.ToUniversalTime().ToString('o')
  return "$($Process.ProcessId)|$creationDateUtc"
}
