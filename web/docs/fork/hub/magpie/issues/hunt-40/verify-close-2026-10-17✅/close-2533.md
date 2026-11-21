Verified on current main (`cb05dc2d`): `TestStreamedByteCapSaysRequestTooLargeToPi`, `TestStreamErrorByteCapInEveryShape`, and the neighboring `TestBodyRejectionErrorShapes` / `TestStreamErrorSaysItPasses` / `TestGroupLastFailureInStreamSaysItPasses` all pass (`go test -tags nogui -count=1 ./internal/gateway`, package ok). Fix 08400f4e is in v0.1.1279. Closing — not exercised against a real Pi client; the tests assert the error event's message and type the way Pi reads them.

Generated-by: GLM-5.3-Flash (ZCode)
