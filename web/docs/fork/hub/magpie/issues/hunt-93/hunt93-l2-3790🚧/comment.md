TokenHub serves each console site at its own hosts, and Magpie's pay-as-you-go regions were both China-site hosts: an international-console key (the reporter's, made at console.tencentcloud.com) had no working region to sit on. "Pay as you go · China" asks its key at tokenhub.tencentmaas.com, the China console's Guangzhou host, which answers `401 Unauthorized: The API Key does not exist or signature verification failed.` — a site is not to be called across (Tencent's docs: "Select the corresponding API address based on the region where the service is activated. Cross-region and cross-site service calls are not supported.", [1300/82049](https://intl.cloud.tencent.com/ind/document/product/1300/82049)). "Pay as you go · Global" was no way out either: its host tokenhub-intl.tencentmaas.com is the China console's Singapore address ([1823/130078](https://cloud.tencent.com/document/product/1823/130078)), while its Get-a-key page and docs link named the international console — the region promised one site and served the other's endpoints. Minimal reproduction: a TokenHub key made at the international console for Guangzhou, the Tencent Cloud preset at either pay-as-you-go region, Fetch models. Deterministically: two local fake TokenHub sites, each accepting only its own site's key and answering the issue's 401 body to the other's — an international key at both China-site hosts 401s with exactly that body, an international key at the international console's own hosts 200s, a China-site key stays 200 throughout.

Root cause: the preset's regions encode console *region* (Guangzhou/Singapore) but not console *site*. The two console sites keep separate host families — the China site's `tokenhub.tencentmaas.com` and `tokenhub-intl.tencentmaas.com` (1823/130078), the international site's `tokenhub.tencentcloudmaas.com` — Guangzhou, the console's own generated example — and `tokenhub-intl.tencentcloudmaas.com` — Singapore ([1300/78939](https://www.tencentcloud.com/document/product/1300/78939), the page the region already linked as its docs). The `intl` region had the site's identity (its key page and docs) with the China family's URLs.

The fix gives pay as you go the four regions its two consoles sell, named site · region as the reporter asked: "Pay as you go · China · Guangzhou" (`cn`, URL untouched), "Pay as you go · China · Singapore" (`intl`, URL untouched, its key page and docs now the China console's, which 130078 is), "Pay as you go · International · Guangzhou" (`intl-gz`, new) and "Pay as you go · International · Singapore" (`intl-sg`, new) at the international console's hosts, key page and docs. Saved providers keep their endpoints whatever the preset does; only their key page and docs links re-derive from their region on load (`normalize` → `regionOf`, provider.go), and that derivation now lands on the links their region's endpoints are documented at. The regions' names have their zh, zh-TW, ja and de words in i18n.js.

Verification (macOS 15.6, go1.26.8 darwin/arm64, at head `c841bbd9`, baseline `eee57199`):

| Check | Result |
| --- | --- |
| `go test ./internal/provider/ -run TestTencentCloudInternational` (new: the four regions' endpoints, key pages, docs; an entry imported at any of the four hosts; a `magpie://import` link at each; the editor's move taking the region's links) | ok 1.2s, exit 0 |
| the same with only `presets.go` restored (fix reverted, test kept) | red at the `intl` row (its links still the international console's), then `no region intl-gz` |
| `go test ./internal/gateway/ -run TestTencentTokenHubRoutes` (now also builds a provider at `intl-gz` and at `intl-sg` and routes chat completions, Responses and messages through a fake TokenHub, key as Bearer on the OpenAI APIs and x-api-key on Anthropic's) | ok 0.36s, exit 0, all 24 subtests |
| the same with only `presets.go` restored | red: `preset tencent-cloud has no region intl-gz` and `… intl-sg` |
| `TestTencentCloud`, `TestTencentCloudEnterprisePlan`, `TestTencentCloudOldPresetsKeepWorking`, `TestTencentTokenHubList`, `TestTencentPlanRegion`, `TestTencentPlanWindow` | ok |
| fake-site reproduction (two local TokenHubs, one per console site; throwaway, not in the patch) | international key at `cn` and `intl` hosts: 401 with the issue's exact body; at `intl-gz` and `intl-sg` hosts: 200 with a model list; China-site key at its own host: 200 |
| `go test -tags nogui ./internal/provider/` | ok 75.4s, exit 0, minus `TestUnreadLoginsWriteErrorsKeepCredentials` — red alone on the clean baseline too (`fatal error: close of synctest channel from outside bubble`, this machine's go1.26.8; pre-existing, not this patch's) |
| `go test -tags nogui ./internal/gateway/` | ok 403.7s, exit 0 |
| `go test -tags nogui ./...` full tree | 71 packages ok; `agent` (`TestMothX`), `gui` (`TestProxyCheckSaysAProxyPassedBy`, a 502 from this sandbox's refused proxy dial) and `provider` (the synctest fatal above) red — each red alone on the clean baseline `eee57199` the same way, none of them this patch's |
| `gofmt -l` on the three changed Go files | clean |
| `go vet ./...` darwin, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | exit 0 each |
| `go build` darwin, `GOOS=linux go build -tags nogui`, `GOOS=windows go build` | ok each |
| a real international-console key against `tokenhub.tencentcloudmaas.com/v1/models` | Not verified — no international account here; the host is the international console's own generated example and 78939's sibling, and the fake above takes the 401 body from the issue verbatim |

## Source

#3790 by skyArony, with the 401 body and the international console's generated example (`POST https://tokenhub.tencentcloudmaas.com/v1/chat/completions`, Bearer auth). Host families and the no-cross-site rule from Tencent's own docs: [1823/130078](https://cloud.tencent.com/document/product/1823/130078) (China console: 广州 `tokenhub.tencentmaas.com`, 新加坡 `tokenhub-intl.tencentmaas.com`, `Authorization: Bearer`, `/v1/models` the list), [1300/78939](https://www.tencentcloud.com/document/product/1300/78939) (international console: `tokenhub-intl.tencentcloudmaas.com/v1`, Singapore sample), [1300/82049](https://intl.cloud.tencent.com/ind/document/product/1300/82049) (international console's Guangzhou `tokenhub.tencentcloudmaas.com` and Singapore `tokenhub-intl.tencentcloudmaas.com`, plan paths, with the cross-region/cross-site sentence).

## Red without the fix

```
--- FAIL: TestTencentCloud (0.00s)
    tencent_test.go:63: regions: [{ID:plan …} {ID:cn Name:Pay as you go · China …} {ID:intl Name:Pay as you go · Global …
        KeysURL:https://console.tencentcloud.com/tokenhub/apikey Website:https://www.tencentcloud.com/document/product/1300/78939 …} …]
--- FAIL: TestTencentCloudInternational (0.00s)
    tencent_test.go:242: intl: &{ID:intl Name:Pay as you go · Global Chat:https://tokenhub-intl.tencentmaas.com/v1 …
        KeysURL:https://console.tencentcloud.com/tokenhub/apikey Website:https://www.tencentcloud.com/document/product/1300/78939 …}
--- FAIL: TestTencentTokenHubRoutes/tencent-cloud@tencent-cloud@intl-gz (0.00s)
    tokenhub_test.go:117: preset tencent-cloud has no region intl-gz
--- FAIL: TestTencentTokenHubRoutes/tencent-cloud@tencent-cloud@intl-sg (0.00s)
    tokenhub_test.go:117: preset tencent-cloud has no region intl-sg
```

With only the product files restored (`presets.go`, `i18n.js` back to `eee57199`, tests kept) all three hold, each at the line the fix answers; restoring the fix turns them green.

## Siblings

`rg -i 'tencent|tokenhub|maas'` over the tree, every hit weighed: `tencent_usage.go`'s `tencentPlanRegion` maps *plan* hosts (`tokenhub.tencentmaas.com/plan`, `tokenhub-intl.tencentmaas.com/plan`) to cloud-API regions for the enterprise plan's usage cards and answers false for pay-as-you-go `/v1` hosts — untouched, still right; the new hosts are pay as you go and take no Tencent access key, so `presetAccessKey`'s regions stay `["enterprise", "enterprise-intl"]` (`TestProviderListTellsTencentAccessKey` green). The enterprise plan's own two regions sit at the China family's `/plan` hosts too, and 82049 documents the international console's plan at `tokenhub[-intl].tencentcloudmaas.com/plan` — the same site-family question as this issue, but no one has reported it, its usage path is keyed on the tencentmaas hosts, and I have no way to verify a plan key against either family, so they stand as they are rather than move on an inference. Everything else (`keep_secrets`, `decide`, `importurl`, `models.go`'s catalog lookup, the gateway's region-independent routing) carries no TokenHub host knowledge and needed nothing.

## Not verified

A real request with a real international-console key — the issue's reporter notes the same of their console example. Also untestable from here: whether Tencent still honours an international key at the old `tencentmaas.com` hosts (the docs say cross-site calls are refused, and the preset now follows the docs; a saved provider's endpoints are never rewritten, so anyone who does get through today keeps getting through). The enterprise plan's regions on the international console (Siblings) are flagged, not moved.

Branch with the commit: [hunt93-l2-3790-tokenhub](https://github.com/ggbdpq/magpie/tree/hunt93-l2-3790-tokenhub) (head `c841bbd9`) (branch not pushed yet — will push on approval).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>.`

**Patch**: <details><summary>patch: providers: Tencent Cloud's international console gets its own pay as you go regions (#3790) — git am applies it as is; SHA-256 first 16: 5618a8d69eed3983</summary>

```patch
From c841bbd98995b165329da76e85ba627052ecc048 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 27 Oct 2026 07:11:08 +0800
Subject: [PATCH] providers: Tencent Cloud's international console gets its own
 pay as you go regions
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

skyArony (#3790) put an international-console key on "Pay as you go ·
China" and Fetch models answered 401, "The API Key does not exist or
signature verification failed.": TokenHub serves each console site at
its own hosts, and a key asked at the other site's hosts answers just
that (1300/82049: "Cross-region and cross-site service calls are not
supported."). The China console's pay as you go lives at
tokenhub.tencentmaas.com — Guangzhou — and tokenhub-intl.tencentmaas.com
— Singapore (1823/130078); the international console's lives at
tokenhub.tencentcloudmaas.com — Guangzhou (its console's own example) —
and tokenhub-intl.tencentcloudmaas.com — Singapore (1300/78939). No
region offered either, and "Pay as you go · Global" pointed
international-console users at the China site's Singapore host while its
key page and docs named the international console's.

Tencent Cloud's pay as you go is now the four regions its two consoles
sell: · China · Guangzhou and · China · Singapore (cn, intl, URLs
untouched) at the China console's, and · International · Guangzhou and ·
International · Singapore (intl-gz, intl-sg) at the international
console's, with its key page and docs. The global region's key page and
docs follow its endpoints to the China console's: a saved provider's
links re-derive from its region on load, its endpoints never move.

Run:
- provider TestTencentCloudInternational (new): the four regions'
  endpoints, key pages and docs, an entry imported at any of the four
  hosts, a magpie://import link at each, and the editor's move taking
  the region's links. Red on the old code (no intl-gz, the global
  region's links at the international console), green on this.
- gateway TestTencentTokenHubRoutes: a provider built at intl-gz and at
  intl-sg routes chat completions, Responses and messages as the China
  pair's do. Red on the old code (no such regions), green here.
- provider TestTencentCloud, TestTencentCloudEnterprisePlan,
  TestTencentCloudOldPresetsKeepWorking, TestTencentTokenHubList,
  TestTencentPlanRegion, TestTencentPlanWindow: green.
- go test -tags nogui ./internal/provider ./internal/gateway: ok, minus
  TestUnreadLoginsWriteErrorsKeepCredentials, red alone on eee57199 too
  (its synctest bubble closes a channel from outside, this machine's).
- gui tests tencent-cloud.test.cjs and tencent-access-key.test.cjs: the
  seven regions' fixtures, their segmented-control and i18n checks, and
  the four names in zh, zh-TW, ja and de in i18n.js.
Not tried: a real international-console key (none here).

Fixes #3790
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/tokenhub_test.go             | 30 ++++++-
 internal/gui/assets/i18n.js                   | 24 ++++--
 .../gui/tests/tencent-access-key.test.cjs     | 10 ++-
 internal/gui/tests/tencent-cloud.test.cjs     | 45 +++++++----
 internal/provider/presets.go                  | 19 +++--
 internal/provider/tencent_test.go             | 78 ++++++++++++++++++-
 6 files changed, 171 insertions(+), 35 deletions(-)

diff --git a/internal/gateway/tokenhub_test.go b/internal/gateway/tokenhub_test.go
index 6d7a0341..a96da7b3 100644
--- a/internal/gateway/tokenhub_test.go
+++ b/internal/gateway/tokenhub_test.go
@@ -79,12 +79,19 @@ func (q *tokenhub) last() tokenhubCall {
 // preset as an older magpie stored it, routes as before, and one added as
 // Tencent Cloud at either region alike.
 func TestTencentTokenHubRoutes(t *testing.T) {
-	for _, c := range []struct{ id, preset string }{
-		{"tencent-tokenhub-cn", "tencent-tokenhub-cn"}, {"tencent-tokenhub", "tencent-tokenhub"},
-		{"tencent-cloud", "tencent-tokenhub-cn"}, {"tencent-cloud", "tencent-tokenhub"},
+	for _, c := range []struct{ id, preset, region string }{
+		{"tencent-tokenhub-cn", "tencent-tokenhub-cn", ""}, {"tencent-tokenhub", "tencent-tokenhub", ""},
+		{"tencent-cloud", "tencent-tokenhub-cn", ""}, {"tencent-cloud", "tencent-tokenhub", ""},
+		// the international console's regions (#3790), built at the
+		// preset's region as the editor does
+		{"tencent-cloud", "tencent-cloud", "intl-gz"}, {"tencent-cloud", "tencent-cloud", "intl-sg"},
 	} {
 		id := c.id
-		t.Run(id+"@"+c.preset, func(t *testing.T) {
+		name := id + "@" + c.preset
+		if c.region != "" {
+			name += "@" + c.region
+		}
+		t.Run(name, func(t *testing.T) {
 			fresh(t)
 			up := &tokenhub{}
 			srv := httptest.NewServer(up)
@@ -96,6 +103,21 @@ func TestTencentTokenHubRoutes(t *testing.T) {
 			if id != "tencent-cloud" {
 				p.ID, p.Preset = id, c.preset
 			}
+			if c.region != "" {
+				pr := provider.Preset(c.preset)
+				var r *provider.Region
+				if pr != nil {
+					for i := range pr.Regions {
+						if pr.Regions[i].ID == c.region {
+							r = &pr.Regions[i]
+						}
+					}
+				}
+				if r == nil {
+					t.Fatalf("preset %s has no region %s", c.preset, c.region)
+				}
+				p.Chat, p.Responses, p.Anthropic = r.Chat, r.Responses, r.Anthropic
+			}
 			// the preset's paths kept, its host swapped for the fake's
 			host := strings.TrimSuffix(p.Chat, "/v1")
 			if p.Responses != host+"/v1" || p.Anthropic != host {
diff --git a/internal/gui/assets/i18n.js b/internal/gui/assets/i18n.js
index daed4393..490e3b73 100644
--- a/internal/gui/assets/i18n.js
+++ b/internal/gui/assets/i18n.js
@@ -2525,8 +2525,10 @@ const I18N = {
     "Token Plan · pay as you go": "Token Plan · 按量付费",
     "TokenHub · subscription": "TokenHub · 订阅",
     "Plan · China": "套餐 · 中国",
-    "Pay as you go · China": "按量 · 中国",
-    "Pay as you go · Global": "按量 · 国际",
+    "Pay as you go · China · Guangzhou": "按量 · 中国 · 广州",
+    "Pay as you go · China · Singapore": "按量 · 中国 · 新加坡",
+    "Pay as you go · International · Guangzhou": "按量 · 国际 · 广州",
+    "Pay as you go · International · Singapore": "按量 · 国际 · 新加坡",
     "Enterprise plan · China": "企业版套餐 · 中国",
     "Enterprise plan · Global": "企业版套餐 · 国际",
     "Plan · Singapore": "套餐 · 新加坡",
@@ -6512,8 +6514,10 @@ const I18N = {
     "Token Plan · pay as you go": "Token Plan · 按量付費",
     "TokenHub · subscription": "TokenHub · 訂閱",
     "Plan · China": "套餐 · 中國",
-    "Pay as you go · China": "按量 · 中國",
-    "Pay as you go · Global": "按量 · 國際",
+    "Pay as you go · China · Guangzhou": "按量 · 中國 · 廣州",
+    "Pay as you go · China · Singapore": "按量 · 中國 · 新加坡",
+    "Pay as you go · International · Guangzhou": "按量 · 國際 · 廣州",
+    "Pay as you go · International · Singapore": "按量 · 國際 · 新加坡",
     "Enterprise plan · China": "企業版套餐 · 中國",
     "Enterprise plan · Global": "企業版套餐 · 國際",
     "Plan · Singapore": "套餐 · 新加坡",
@@ -10497,8 +10501,10 @@ const I18N = {
     "Token Plan · pay as you go": "Token Plan · 従量課金",
     "TokenHub · subscription": "TokenHub · サブスクリプション",
     "Plan · China": "プラン · 中国",
-    "Pay as you go · China": "従量課金 · 中国",
-    "Pay as you go · Global": "従量課金 · グローバル",
+    "Pay as you go · China · Guangzhou": "従量課金 · 中国 · 広州",
+    "Pay as you go · China · Singapore": "従量課金 · 中国 · シンガポール",
+    "Pay as you go · International · Guangzhou": "従量課金 · 国際 · 広州",
+    "Pay as you go · International · Singapore": "従量課金 · 国際 · シンガポール",
     "Enterprise plan · China": "Enterprise プラン · 中国",
     "Enterprise plan · Global": "Enterprise プラン · グローバル",
     "Plan · Singapore": "プラン · シンガポール",
@@ -14492,8 +14498,10 @@ const I18N = {
     "Token Plan · pay as you go": "Token Plan · nutzungsbasiert",
     "TokenHub · subscription": "TokenHub · Abo",
     "Plan · China": "Tarif · China",
-    "Pay as you go · China": "Nutzungsbasiert · China",
-    "Pay as you go · Global": "Nutzungsbasiert · Global",
+    "Pay as you go · China · Guangzhou": "Nutzungsbasiert · China · Guangzhou",
+    "Pay as you go · China · Singapore": "Nutzungsbasiert · China · Singapur",
+    "Pay as you go · International · Guangzhou": "Nutzungsbasiert · International · Guangzhou",
+    "Pay as you go · International · Singapore": "Nutzungsbasiert · International · Singapur",
     "Enterprise plan · China": "Enterprise-Tarif · China",
     "Enterprise plan · Global": "Enterprise-Tarif · Global",
     "Plan · Singapore": "Tarif · Singapur",
diff --git a/internal/gui/tests/tencent-access-key.test.cjs b/internal/gui/tests/tencent-access-key.test.cjs
index a5ee9de7..4e5f472f 100644
--- a/internal/gui/tests/tencent-access-key.test.cjs
+++ b/internal/gui/tests/tencent-access-key.test.cjs
@@ -18,6 +18,9 @@ const assets = path.resolve(__dirname, "../assets");
 const plan = { chat: "https://api.lkeap.cloud.tencent.com/plan/v3", anthropic: "https://api.lkeap.cloud.tencent.com/plan/anthropic" };
 const cn = { chat: "https://tokenhub.tencentmaas.com/v1", responses: "https://tokenhub.tencentmaas.com/v1", anthropic: "https://tokenhub.tencentmaas.com" };
 const intl = { chat: "https://tokenhub-intl.tencentmaas.com/v1", responses: "https://tokenhub-intl.tencentmaas.com/v1", anthropic: "https://tokenhub-intl.tencentmaas.com" };
+// the international console's own (#3790)
+const intlGz = { chat: "https://tokenhub.tencentcloudmaas.com/v1", responses: "https://tokenhub.tencentcloudmaas.com/v1", anthropic: "https://tokenhub.tencentcloudmaas.com" };
+const intlSg = { chat: "https://tokenhub-intl.tencentcloudmaas.com/v1", responses: "https://tokenhub-intl.tencentcloudmaas.com/v1", anthropic: "https://tokenhub-intl.tencentcloudmaas.com" };
 const ent = { chat: "https://tokenhub.tencentmaas.com/plan/v3", responses: "https://tokenhub.tencentmaas.com/plan/v3", anthropic: "https://tokenhub.tencentmaas.com/plan/anthropic" };
 const entIntl = { chat: "https://tokenhub-intl.tencentmaas.com/plan/v3", responses: "https://tokenhub-intl.tencentmaas.com/plan/v3", anthropic: "https://tokenhub-intl.tencentmaas.com/plan/anthropic" };
 // as /api/providers serves the preset: an access key at the two
@@ -25,7 +28,10 @@ const entIntl = { chat: "https://tokenhub-intl.tencentmaas.com/plan/v3", respons
 const tencent = (added) => ({
   id: "tencent-cloud", name: "Tencent Cloud", icon: "tencentcloud-color", kind: "vendor", hosts: true, added, chat: plan.chat, anthropic: plan.anthropic,
   accessKey: true, accessKeyVendor: "tencent", accessKeyRegions: ["enterprise", "enterprise-intl"],
-  regions: [{ id: "plan", name: "Plan · China", ...plan }, { id: "cn", name: "Pay as you go · China", ...cn }, { id: "intl", name: "Pay as you go · Global", ...intl },
+  regions: [{ id: "plan", name: "Plan · China", ...plan }, { id: "cn", name: "Pay as you go · China · Guangzhou", ...cn },
+    { id: "intl", name: "Pay as you go · China · Singapore", ...intl },
+    { id: "intl-gz", name: "Pay as you go · International · Guangzhou", ...intlGz },
+    { id: "intl-sg", name: "Pay as you go · International · Singapore", ...intlSg },
     { id: "enterprise", name: "Enterprise plan · China", ...ent }, { id: "enterprise-intl", name: "Enterprise plan · Global", ...entIntl }],
 });
 const saved = (id, name, at, accessKey) => ({
@@ -68,7 +74,7 @@ const words = {
   zh: { saved: "已保存 · 粘贴新的即可替换", remove: "移除", save: "保存", add: "添加", one: "请同时填写访问密钥的 Secret" },
 };
 // the region buttons in the preset's order
-const PLAN = 0, CN = 1, ENT = 3, ENT_INTL = 4;
+const PLAN = 0, CN = 1, ENT = 5, ENT_INTL = 6;
 
 for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
   for (const lang of ["en", "zh"]) {
diff --git a/internal/gui/tests/tencent-cloud.test.cjs b/internal/gui/tests/tencent-cloud.test.cjs
index 3261c1dd..bccc7117 100644
--- a/internal/gui/tests/tencent-cloud.test.cjs
+++ b/internal/gui/tests/tencent-cloud.test.cjs
@@ -1,9 +1,10 @@
 // Run with Node's test runner and Playwright on the module path; see README.md.
 // Tencent Cloud as one provider (Jorben on Discord): the Token Plan and
 // TokenHub's two pay-as-you-go presets are one Tencent Cloud preset whose
-// regions are Plan · China, Pay as you go · China and Pay as you go · Global,
-// and Token Plan 企业版's Enterprise plan · China and · Global (#1574).
-// The add sheet has one Tencent Cloud tile and no TokenHub; its editor picks
+// regions are Plan · China, pay as you go at the China console's
+// Guangzhou and Singapore and at the international console's (#3790), and
+// Token Plan 企业版's Enterprise plan · China and · Global (#1574). The
+// add sheet has one Tencent Cloud tile and no TokenHub; its editor picks
 // the region with the segmented control, never a <select>, and a region
 // picked takes its endpoints, its Get a key page and its docs link. A
 // provider an older magpie saved under an old preset's id (tencent-tokenhub-cn)
@@ -21,7 +22,15 @@ const plan = { chat: "https://api.lkeap.cloud.tencent.com/plan/v3", anthropic: "
   website: "https://cloud.tencent.com/document/product/1823/130060", keysUrl: "https://console.cloud.tencent.com/tokenhub/tokenplan" };
 const cn = { chat: "https://tokenhub.tencentmaas.com/v1", responses: "https://tokenhub.tencentmaas.com/v1", anthropic: "https://tokenhub.tencentmaas.com",
   website: "https://cloud.tencent.com/document/product/1823/130078", keysUrl: "https://console.cloud.tencent.com/tokenhub/apikey", catalog: "tencent-tokenhub" };
+// the China console's Singapore (the old Pay as you go · Global, its key
+// page and docs at the China console's since #3790)
 const intl = { chat: "https://tokenhub-intl.tencentmaas.com/v1", responses: "https://tokenhub-intl.tencentmaas.com/v1", anthropic: "https://tokenhub-intl.tencentmaas.com",
+  website: "https://cloud.tencent.com/document/product/1823/130078", keysUrl: "https://console.cloud.tencent.com/tokenhub/apikey", catalog: "tencent-tokenhub" };
+// the international console's own (#3790), a key of whose works at these
+// alone (1300/78939)
+const intlGz = { chat: "https://tokenhub.tencentcloudmaas.com/v1", responses: "https://tokenhub.tencentcloudmaas.com/v1", anthropic: "https://tokenhub.tencentcloudmaas.com",
+  website: "https://www.tencentcloud.com/document/product/1300/78939", keysUrl: "https://console.tencentcloud.com/tokenhub/apikey", catalog: "tencent-tokenhub" };
+const intlSg = { chat: "https://tokenhub-intl.tencentcloudmaas.com/v1", responses: "https://tokenhub-intl.tencentcloudmaas.com/v1", anthropic: "https://tokenhub-intl.tencentcloudmaas.com",
   website: "https://www.tencentcloud.com/document/product/1300/78939", keysUrl: "https://console.tencentcloud.com/tokenhub/apikey", catalog: "tencent-tokenhub" };
 // Token Plan 企业版 (#1574), China's and Singapore's
 const ent = { chat: "https://tokenhub.tencentmaas.com/plan/v3", responses: "https://tokenhub.tencentmaas.com/plan/v3", anthropic: "https://tokenhub.tencentmaas.com/plan/anthropic",
@@ -32,7 +41,10 @@ const entIntl = { chat: "https://tokenhub-intl.tencentmaas.com/plan/v3", respons
 const tencent = (added) => ({
   id: "tencent-cloud", name: "Tencent Cloud", icon: "tencentcloud-color", kind: "vendor", hosts: true, added,
   note: "Token Plan · pay as you go", chat: plan.chat, anthropic: plan.anthropic, website: plan.website, keysUrl: plan.keysUrl,
-  regions: [{ id: "plan", name: "Plan · China", ...plan }, { id: "cn", name: "Pay as you go · China", ...cn }, { id: "intl", name: "Pay as you go · Global", ...intl },
+  regions: [{ id: "plan", name: "Plan · China", ...plan }, { id: "cn", name: "Pay as you go · China · Guangzhou", ...cn },
+    { id: "intl", name: "Pay as you go · China · Singapore", ...intl },
+    { id: "intl-gz", name: "Pay as you go · International · Guangzhou", ...intlGz },
+    { id: "intl-sg", name: "Pay as you go · International · Singapore", ...intlSg },
     { id: "enterprise", name: "Enterprise plan · China", ...ent }, { id: "enterprise-intl", name: "Enterprise plan · Global", ...entIntl }],
 });
 const deepseek = { id: "deepseek", name: "DeepSeek", icon: "deepseek", kind: "vendor", chat: "https://api.deepseek.com/v1", added: false };
@@ -72,8 +84,8 @@ function serve(lang, list, posts) {
 }
 
 const words = {
-  en: { regions: ["Plan · China", "Pay as you go · China", "Pay as you go · Global", "Enterprise plan · China", "Enterprise plan · Global"], key: "Get a key ↗", add: "Add", save: "Save" },
-  zh: { regions: ["套餐 · 中国", "按量 · 中国", "按量 · 国际", "企业版套餐 · 中国", "企业版套餐 · 国际"], key: "获取密钥 ↗", add: "添加", save: "保存" },
+  en: { regions: ["Plan · China", "Pay as you go · China · Guangzhou", "Pay as you go · China · Singapore", "Pay as you go · International · Guangzhou", "Pay as you go · International · Singapore", "Enterprise plan · China", "Enterprise plan · Global"], key: "Get a key ↗", add: "Add", save: "Save" },
+  zh: { regions: ["套餐 · 中国", "按量 · 中国 · 广州", "按量 · 中国 · 新加坡", "按量 · 国际 · 广州", "按量 · 国际 · 新加坡", "企业版套餐 · 中国", "企业版套餐 · 国际"], key: "获取密钥 ↗", add: "添加", save: "保存" },
 };
 
 for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium", "webkit"])) {
@@ -125,18 +137,25 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       const getKey = ed(page).getByRole("button", { name: w.key, exact: true });
       assert.equal(await opens(page, posts, getKey), plan.keysUrl);
 
-      // Global: TokenHub's international endpoints, keys page and docs
-      await segs(page).nth(2).click();
-      assert.equal(await ed(page).locator(".segs.regions .opt.on").textContent(), w.regions[2]);
+      // the international console's Guangzhou and Singapore (#3790): its
+      // own endpoints, keys page and docs
+      await segs(page).nth(3).click();
+      assert.equal(await ed(page).locator(".segs.regions .opt.on").textContent(), w.regions[3]);
       assert.equal(await site(page).textContent(), "www.tencentcloud.com ↗");
+      assert.equal(await opens(page, posts, site(page)), intlGz.website);
+      assert.equal(await opens(page, posts, getKey), intlGz.keysUrl);
+      await segs(page).nth(4).click();
+      assert.equal(await opens(page, posts, getKey), intlSg.keysUrl);
+      // the China console's Singapore, its key page and docs
+      await segs(page).nth(2).click();
       assert.equal(await opens(page, posts, site(page)), intl.website);
       assert.equal(await opens(page, posts, getKey), intl.keysUrl);
       // the enterprise plan's, in China and Singapore
-      await segs(page).nth(3).click();
-      assert.equal(await ed(page).locator(".segs.regions .opt.on").textContent(), w.regions[3]);
+      await segs(page).nth(5).click();
+      assert.equal(await ed(page).locator(".segs.regions .opt.on").textContent(), w.regions[5]);
       assert.equal(await opens(page, posts, site(page)), ent.website);
       assert.equal(await opens(page, posts, getKey), ent.keysUrl);
-      await segs(page).nth(4).click();
+      await segs(page).nth(6).click();
       assert.equal(await opens(page, posts, getKey), entIntl.keysUrl);
       // China's pay as you go
       await segs(page).nth(1).click();
@@ -151,7 +170,7 @@ for (const engine of (process.env.BROWSER ? [process.env.BROWSER] : ["chromium",
       assert.equal(saved.body.preset, "tencent-cloud");
       assert.deepEqual([saved.body.chat, saved.body.responses, saved.body.anthropic], [cn.chat, cn.responses, cn.anthropic]);
 
-      const missing = await page.evaluate(() => ["Plan · China", "Pay as you go · China", "Pay as you go · Global", "Enterprise plan · China", "Enterprise plan · Global", "Token Plan · pay as you go"]
+      const missing = await page.evaluate(() => ["Plan · China", "Pay as you go · China · Guangzhou", "Pay as you go · China · Singapore", "Pay as you go · International · Guangzhou", "Pay as you go · International · Singapore", "Enterprise plan · China", "Enterprise plan · Global", "Token Plan · pay as you go"]
         .filter((k) => !I18N.zh[k] || !I18N["zh-TW"][k] || !I18N.ja[k] || !I18N.de[k]));
       assert.deepEqual(missing, [], "every string has its Chinese");
       assert.deepEqual(errors, []);
diff --git a/internal/provider/presets.go b/internal/provider/presets.go
index 04080ae8..dbe3bde4 100644
--- a/internal/provider/presets.go
+++ b/internal/provider/presets.go
@@ -258,9 +258,14 @@ var presets = []PresetDef{
 	// are given here, and none of its catalogs names them.
 	//
 	// TokenHub pay as you go: an API key of TokenHub's own (not the plan's
-	// sk-tp-), at tokenhub.tencentmaas.com in Guangzhou and
-	// tokenhub-intl.tencentmaas.com in Singapore. Each serves chat
-	// completions and Responses under /v1 (Responses converted from chat
+	// sk-tp-), at the hosts of the console site whose key it is (#3790),
+	// each site in Guangzhou and in Singapore: the China site's
+	// (console.cloud.tencent.com) at tokenhub.tencentmaas.com and
+	// tokenhub-intl.tencentmaas.com (1823/130078), the international
+	// site's (console.tencentcloud.com) at tokenhub.tencentcloudmaas.com
+	// and tokenhub-intl.tencentcloudmaas.com (1300/78939; 1300/82049 asks
+	// each key at its own site, the other site's hosts answer 401). Each
+	// serves chat completions and Responses under /v1 (Responses converted from chat
 	// on its side for the models that speak chat alone) and Anthropic
 	// messages at /v1/messages, with its list at /v1/models. It serves Hy
 	// and other makers' models (DeepSeek, GLM, Kimi, MiniMax, Qwen …):
@@ -279,9 +284,13 @@ var presets = []PresetDef{
 				Website: "https://cloud.tencent.com/document/product/1823/130060", KeysURL: "https://console.cloud.tencent.com/tokenhub/tokenplan",
 				Models: []string{"tc-code-latest", "glm-5.3", "glm-5.3-flash", "glm-5.2", "glm-5.1", "glm-5", "kimi-k3", "kimi-k2.7-code",
 					"deepseek-v4-pro-202606", "deepseek-v4-flash-202605", "minimax-m3", "minimax-m2.7", "hy4-preview", "hy3"}},
-			{ID: "cn", Name: "Pay as you go · China", Chat: "https://tokenhub.tencentmaas.com/v1", Responses: "https://tokenhub.tencentmaas.com/v1", Anthropic: "https://tokenhub.tencentmaas.com",
+			{ID: "cn", Name: "Pay as you go · China · Guangzhou", Chat: "https://tokenhub.tencentmaas.com/v1", Responses: "https://tokenhub.tencentmaas.com/v1", Anthropic: "https://tokenhub.tencentmaas.com",
 				Website: "https://cloud.tencent.com/document/product/1823/130078", KeysURL: "https://console.cloud.tencent.com/tokenhub/apikey", Catalog: "tencent-tokenhub"},
-			{ID: "intl", Name: "Pay as you go · Global", Chat: "https://tokenhub-intl.tencentmaas.com/v1", Responses: "https://tokenhub-intl.tencentmaas.com/v1", Anthropic: "https://tokenhub-intl.tencentmaas.com",
+			{ID: "intl", Name: "Pay as you go · China · Singapore", Chat: "https://tokenhub-intl.tencentmaas.com/v1", Responses: "https://tokenhub-intl.tencentmaas.com/v1", Anthropic: "https://tokenhub-intl.tencentmaas.com",
+				Website: "https://cloud.tencent.com/document/product/1823/130078", KeysURL: "https://console.cloud.tencent.com/tokenhub/apikey", Catalog: "tencent-tokenhub"},
+			{ID: "intl-gz", Name: "Pay as you go · International · Guangzhou", Chat: "https://tokenhub.tencentcloudmaas.com/v1", Responses: "https://tokenhub.tencentcloudmaas.com/v1", Anthropic: "https://tokenhub.tencentcloudmaas.com",
+				Website: "https://www.tencentcloud.com/document/product/1300/78939", KeysURL: "https://console.tencentcloud.com/tokenhub/apikey", Catalog: "tencent-tokenhub"},
+			{ID: "intl-sg", Name: "Pay as you go · International · Singapore", Chat: "https://tokenhub-intl.tencentcloudmaas.com/v1", Responses: "https://tokenhub-intl.tencentcloudmaas.com/v1", Anthropic: "https://tokenhub-intl.tencentcloudmaas.com",
 				Website: "https://www.tencentcloud.com/document/product/1300/78939", KeysURL: "https://console.tencentcloud.com/tokenhub/apikey", Catalog: "tencent-tokenhub"},
 			{ID: "enterprise", Name: "Enterprise plan · China", Chat: "https://tokenhub.tencentmaas.com/plan/v3", Responses: "https://tokenhub.tencentmaas.com/plan/v3", Anthropic: "https://tokenhub.tencentmaas.com/plan/anthropic",
 				Website: "https://cloud.tencent.com/document/product/1823/130659", KeysURL: "https://console.cloud.tencent.com/tokenhub/tokenplan",
diff --git a/internal/provider/tencent_test.go b/internal/provider/tencent_test.go
index 49e0cb1d..c43b3c7c 100644
--- a/internal/provider/tencent_test.go
+++ b/internal/provider/tencent_test.go
@@ -24,6 +24,10 @@ const (
 	tcIntlHost = "https://tokenhub-intl.tencentmaas.com"
 	tcIntlKeys = "https://console.tencentcloud.com/tokenhub/apikey"
 	tcIntlDocs = "https://www.tencentcloud.com/document/product/1300/78939"
+	// the international console's own hosts (#3790): its Guangzhou's and
+	// Singapore's pay as you go, beside the China site's pair above
+	tcIntGzHost = "https://tokenhub.tencentcloudmaas.com"
+	tcIntSgHost = "https://tokenhub-intl.tencentcloudmaas.com"
 )
 
 // tcRegions are Tencent Cloud's three, as the three presets they were
@@ -36,7 +40,7 @@ var tcRegions = []struct {
 }{
 	{"tencent-token-plan", "plan", tcPlanChat, "", tcPlanMsgs, "", tcPlanKeys, tcPlanDocs},
 	{"tencent-tokenhub-cn", "cn", tcCNHost + "/v1", tcCNHost + "/v1", tcCNHost, "tencent-tokenhub", tcCNKeys, tcCNDocs},
-	{"tencent-tokenhub", "intl", tcIntlHost + "/v1", tcIntlHost + "/v1", tcIntlHost, "tencent-tokenhub", tcIntlKeys, tcIntlDocs},
+	{"tencent-tokenhub", "intl", tcIntlHost + "/v1", tcIntlHost + "/v1", tcIntlHost, "tencent-tokenhub", tcCNKeys, tcCNDocs},
 }
 
 // Tencent Cloud is one preset (Jorben on Discord), its Token Plan and
@@ -55,7 +59,7 @@ func TestTencentCloud(t *testing.T) {
 		t.Fatalf("Tencent Cloud's presets: %+v", tc)
 	}
 	pr := &tc[0]
-	if len(pr.Regions) != 5 {
+	if len(pr.Regions) != 7 {
 		t.Fatalf("regions: %+v", pr.Regions)
 	}
 	for i, c := range tcRegions {
@@ -207,6 +211,62 @@ func TestTencentCloudEnterprisePlan(t *testing.T) {
 	}
 }
 
+// The international console's pay as you go (#3790): a key the
+// international console made works at its own hosts alone, Guangzhou's
+// tokenhub.tencentcloudmaas.com and Singapore's tokenhub-intl.
+// tencentcloudmaas.com (1300/78939), with the China site's pair (cn, intl)
+// at the China console's hosts and its key page and docs; asking at the
+// other site's hosts answers 401, so each pair is its own regions. All
+// four carry models.dev's tencent-tokenhub, Responses at /v1 and
+// Anthropic messages at the bare host: an entry imported at any of the
+// hosts lands on its region, and a link and the editor's move do too.
+func TestTencentCloudInternational(t *testing.T) {
+	for _, c := range []struct{ region, host, keys, website string }{
+		{"cn", tcCNHost, tcCNKeys, tcCNDocs},
+		{"intl", tcIntlHost, tcCNKeys, tcCNDocs},
+		{"intl-gz", tcIntGzHost, tcIntlKeys, tcIntlDocs},
+		{"intl-sg", tcIntSgHost, tcIntlKeys, tcIntlDocs},
+	} {
+		pr := Preset("tencent-cloud")
+		r := (*Region)(nil)
+		for i := range pr.Regions {
+			if pr.Regions[i].ID == c.region {
+				r = &pr.Regions[i]
+			}
+		}
+		if r == nil {
+			t.Fatalf("no region %s: %+v", c.region, pr.Regions)
+		}
+		if r.Chat != c.host+"/v1" || r.Responses != c.host+"/v1" || r.Anthropic != c.host ||
+			r.Catalog != "tencent-tokenhub" || r.KeysURL != c.keys || r.Website != c.website {
+			t.Fatalf("%s: %+v", c.region, r)
+		}
+		// an entry imported at its endpoints lands on it, with its links
+		for _, e := range []endpoints{{chat: c.host + "/v1/"}, {responses: c.host + "/v1"}, {anthropic: c.host}} {
+			im, _ := imported("Tencent", "sk-x", e, nil)
+			if im.Preset != "tencent-cloud" || im.Catalog != "tencent-tokenhub" || im.KeysURL != c.keys || im.Website != c.website {
+				t.Fatalf("imported from %+v: %+v", e, im)
+			}
+			if got := im.regionOf(pr); got == nil || got.ID != c.region {
+				t.Fatalf("imported from %+v at %+v", e, got)
+			}
+		}
+		// a link at it
+		p, err := ParseImport("magpie://import?preset=tencent-cloud&region=" + c.region)
+		if err != nil || p.Chat != c.host+"/v1" || p.Responses != c.host+"/v1" || p.Anthropic != c.host ||
+			p.KeysURL != c.keys || p.Website != c.website {
+			t.Fatalf("link %s: %v %+v", c.region, err, p)
+		}
+		// the editor's move there: a plan provider moved to pay as you go
+		// takes the region's endpoints, key page and docs
+		q, _ := FromPreset("tencent-cloud")
+		q.Chat, q.Responses, q.Anthropic, q.Website, q.KeysURL = c.host+"/v1", c.host+"/v1", c.host, "", ""
+		if n := normalize(q); n.Catalog != "tencent-tokenhub" || n.KeysURL != c.keys || n.Website != c.website {
+			t.Fatalf("moved to %s: %+v", c.region, n)
+		}
+	}
+}
+
 // A provider added under any of the three presets Tencent Cloud was keeps
 // working with nothing done: its id, key, endpoints, models, catalog
 // (names and prices), key page and docs as they were, the routing group
@@ -242,6 +302,10 @@ func TestTencentCloudOldPresetsKeepWorking(t *testing.T) {
 			if err != nil {
 				t.Fatalf("%s: %s: %v", when, c.old, err)
 			}
+			// the key page and docs load re-derives from the region as it
+			// is now (the file may carry what an older magpie stored: the
+			// global region's at the international console, #3790 has it
+			// at the China console's)
 			if p.ID != c.old || p.Preset != "tencent-cloud" || p.Key != keys[c.old] || !slices.Equal(p.Models, models[c.old]) ||
 				p.Chat != c.chat || p.Responses != c.responses || p.Anthropic != c.anthropic ||
 				p.Catalog != c.catalog || p.KeysURL != c.keys || p.Website != c.website || p.Icon != "tencentcloud-color" {
@@ -282,9 +346,17 @@ func TestTencentCloudOldPresetsKeepWorking(t *testing.T) {
 	// page, docs and catalog, and back again the plan's
 	p, _ := Find("tencent-token-plan")
 	p.Chat, p.Responses, p.Anthropic, p.Website, p.KeysURL = tcIntlHost+"/v1", tcIntlHost+"/v1", tcIntlHost, "", ""
-	if n := normalize(*p); n.Catalog != "tencent-tokenhub" || n.KeysURL != tcIntlKeys || n.Website != tcIntlDocs {
+	if n := normalize(*p); n.Catalog != "tencent-tokenhub" || n.KeysURL != tcCNKeys || n.Website != tcCNDocs {
 		t.Fatalf("to pay as you go: %+v", n)
 	}
+	// the international console's own hosts take its key page and docs
+	// (#3790)
+	for _, h := range []string{tcIntGzHost, tcIntSgHost} {
+		p.Chat, p.Responses, p.Anthropic, p.Website, p.KeysURL = h+"/v1", h+"/v1", h, "", ""
+		if n := normalize(*p); n.Catalog != "tencent-tokenhub" || n.KeysURL != tcIntlKeys || n.Website != tcIntlDocs {
+			t.Fatalf("to %s: %+v", h, n)
+		}
+	}
 	p, _ = Find("tencent-tokenhub-cn")
 	p.Chat, p.Responses, p.Anthropic, p.Website, p.KeysURL = tcPlanChat, "", tcPlanMsgs, "", ""
 	if n := normalize(*p); n.Catalog != "" || n.KeysURL != tcPlanKeys || n.Website != tcPlanDocs {
-- 
2.50.1 (Apple Git-155)
```
</details>
