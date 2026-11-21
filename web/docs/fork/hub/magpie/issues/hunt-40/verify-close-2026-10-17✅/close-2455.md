Verified on current main (`cb05dc2d`): `TestStreamlessMemberIsAskedOnce` (whole and stream) and `TestStreamlessMemberHandsOnToTheNextMember` pass (`go test -tags nogui -count=1 ./internal/gateway`, package ok). Fix df341e76 is in v0.1.1279. Closing — not exercised against a real non-streaming relay; the deterministic did-not-stream case is covered by the tests.

Generated-by: GLM-5.3-Flash (ZCode)
