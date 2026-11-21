---
name: artifact-sbom-publisher
description: Produces build artifacts with Software Bill of Materials (SBOM) and supply chain metadata for security and compliance. Use for "artifact publishing", "SBOM generation", "supply chain security", or "build provenance".
---

# Artifact & SBOM Publisher

Generate and publish artifacts with supply chain security metadata.

## Build Artifacts

```yaml
build:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-node@v4
      with:
        node-version: "20"

    - run: npm ci
    - run: npm run build

    - name: Upload artifacts
      uses: actions/upload-artifact@v4
      with:
        name: dist-${{ github.sha }}
        path: |
          dist/
          !dist/**/*.map
        retention-days: 30
        if-no-files-found: error
```

## SBOM Generation (CycloneDX)

```yaml
sbom:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - name: Generate SBOM
      uses: CycloneDX/gh-node-module-generatebom@master
      with:
        path: ./
        output: ./sbom.json

    - name: Upload SBOM
      uses: actions/upload-artifact@v4
      with:
        name: sbom-${{ github.sha }}
        path: sbom.json
```

## SBOM with Syft

```yaml
- name: Generate SBOM with Syft
  run: |
    curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin
    syft . -o spdx-json > sbom-spdx.json
    syft . -o cyclonedx-json > sbom-cyclonedx.json

- name: Upload SBOMs
  uses: actions/upload-artifact@v4
  with:
    name: sboms
    path: |
      sbom-spdx.json
      sbom-cyclonedx.json
```

## Docker Image SBOM

```yaml
- name: Build image
  uses: docker/build-push-action@v5
  with:
    context: .
    push: true
    tags: myapp:${{ github.sha }}
    sbom: true
    provenance: true

- name: Generate SBOM for image
  run: |
    syft myapp:${{ github.sha }} -o spdx-json > image-sbom.json

- name: Scan SBOM for vulnerabilities
  uses: anchore/scan-action@v3
  with:
    sbom: image-sbom.json
    fail-build: true
    severity-cutoff: high
```

## Build Provenance (SLSA)

```yaml
provenance:
  runs-on: ubuntu-latest
  permissions:
    actions: read
    id-token: write
    contents: write
  steps:
    - uses: actions/checkout@v4

    - name: Build
      run: npm run build

    - name: Generate provenance
      uses: actions/attest-build-provenance@v1
      with:
        subject-path: "dist/**"
```

## Artifact Metadata

```yaml
- name: Create artifact metadata
  run: |
    cat > artifact-metadata.json << EOF
    {
      "version": "${{ github.ref_name }}",
      "commit": "${{ github.sha }}",
      "branch": "${{ github.ref }}",
      "build_time": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
      "builder": "GitHub Actions",
      "workflow": "${{ github.workflow }}",
      "run_id": "${{ github.run_id }}",
      "actor": "${{ github.actor }}"
    }
    EOF

- name: Upload metadata
  uses: actions/upload-artifact@v4
  with:
    name: metadata
    path: artifact-metadata.json
```

## Package & Release

```yaml
release:
  runs-on: ubuntu-latest
  needs: [build, sbom]
  if: github.event_name == 'release'
  steps:
    - name: Download artifacts
      uses: actions/download-artifact@v4
      with:
        path: artifacts/

    - name: Create release package
      run: |
        cd artifacts
        tar -czf ../release.tar.gz dist-* sbom-* metadata/

    - name: Upload to release
      uses: actions/upload-release-asset@v1
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      with:
        upload_url: ${{ github.event.release.upload_url }}
        asset_path: ./release.tar.gz
        asset_name: release-${{ github.ref_name }}.tar.gz
        asset_content_type: application/gzip
```

## Vulnerability Scanning

```yaml
- name: Scan SBOM for vulnerabilities
  uses: aquasecurity/trivy-action@master
  with:
    scan-type: "sbom"
    format: "sarif"
    output: "trivy-results.sarif"
    sbom-sources: "sbom.json"

- name: Upload scan results
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: "trivy-results.sarif"
```

## Artifact Attestation

```yaml
- name: Attest artifact
  uses: actions/attest@v1
  with:
    subject-path: "dist/myapp.tar.gz"
    predicate-type: "https://slsa.dev/provenance/v1"
    predicate: |
      {
        "buildType": "https://github.com/actions/workflow",
        "builder": {
          "id": "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
        },
        "metadata": {
          "buildInvocationId": "${{ github.run_id }}",
          "completeness": {
            "parameters": true,
            "environment": false,
            "materials": true
          }
        }
      }
```

## Best Practices

1. **Generate SBOMs**: For all releases
2. **Multiple formats**: SPDX and CycloneDX
3. **Scan vulnerabilities**: Before release
4. **Sign artifacts**: For verification
5. **Include provenance**: SLSA attestation
6. **Retention policy**: Keep artifacts 30 days
7. **Metadata**: Version, commit, timestamp
8. **Automate**: Part of every build

## Output Checklist

- [ ] Build artifacts uploaded
- [ ] SBOM generated (SPDX or CycloneDX)
- [ ] Vulnerability scanning configured
- [ ] Build provenance generated
- [ ] Artifact metadata included
- [ ] Release packaging automated
- [ ] Attestation/signing (optional)
- [ ] Retention policy set
