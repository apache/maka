# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.

# Run in a Visual Studio Developer PowerShell after building the executable.
# Inspect the linked resource, including manifests supplied by dependencies.
param([Parameter(Mandatory = $true)][string]$Binary)

$ErrorActionPreference = "Stop"
$manifestTool = (Get-Command mt.exe -ErrorAction Stop).Source
$binaryPath = (Resolve-Path -LiteralPath $Binary).ProviderPath
$extracted = [System.IO.Path]::GetTempFileName()
try {
    $output = & $manifestTool -nologo "-inputresource:$binaryPath;#1" "-out:$extracted" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Cannot extract the executable's RT_MANIFEST #1: $output"
    }
    $output = & $manifestTool -nologo -manifest $extracted -validate_manifest 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "The executable's embedded manifest is invalid: $output"
    }
    $manifest = [xml]([System.IO.File]::ReadAllText($extracted))
    $namespaces = [System.Xml.XmlNamespaceManager]::new($manifest.NameTable)
    $namespaces.AddNamespace("dpi", "http://schemas.microsoft.com/SMI/2016/WindowsSettings")
    $awareness = $manifest.SelectSingleNode("//dpi:dpiAwareness", $namespaces)
    if ($null -eq $awareness -or $awareness.InnerText -ne "PerMonitorV2") {
        throw "The executable must embed PerMonitorV2 DPI awareness in RT_MANIFEST #1"
    }
    [pscustomobject]@{
        binary = $binaryPath
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $binaryPath).Hash.ToLowerInvariant()
        resourceType = 24
        resourceId = 1
        dpiAwareness = $awareness.InnerText
    } | ConvertTo-Json -Compress
} finally {
    Remove-Item -LiteralPath $extracted -Force
}
