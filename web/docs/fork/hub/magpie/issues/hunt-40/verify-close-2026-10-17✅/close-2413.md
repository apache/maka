Verified on current main (`cb05dc2d`): `TestImportCCSwitch` and `TestImportAlma` (including the gemini-format and google-type rows added in review) pass (`go test -tags nogui -count=1 ./internal/provider`, package ok). Fix 7ea0e047 is in v0.1.1279. Closing — not exercised against a real CC Switch/Alma export; the import paths are covered by the tests.

Generated-by: GLM-5.3-Flash (ZCode)
