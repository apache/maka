## 现象

`magpie://import` 链接的 `name=` 超过 80 字节时，`ParseImport` 用裸字节切片截断（`p.Name[:80]`）。第 80 字节落在多字节字符中间时，切出来的是半个字符：providers.json 经 encoding/json 写成 U+FFFD，CLI 直接输出坏字节，Providers 页、配额卡、usage 行上名字都读坏。官方链接生成器（site/public/docs/import.html）对 name 不设限，中文名 27 个字符就到 80 字节。

## 最小复现

新测试 `TestParseImportNameCutKeepsCharactersWhole`（name 为 30 个「鱼」+ `-relay`，96 字节），在 a4b0ecbb 的产品文件上：

```
--- FAIL: TestParseImportNameCutKeepsCharactersWhole (0.00s)
    importurl_test.go:263: name cut badly: 80 bytes, valid false
FAIL
```

`utf8.ValidString` 为 false 即半个字符。消融：`git checkout a4b0ecbb -- internal/provider/importurl.go` 后重跑，同一句红（0.976s）。

## 根因

internal/provider/importurl.go:133（a4b0ecbb）：

```go
if len(p.Name) > 80 {
    p.Name = p.Name[:80]
}
```

Go 字符串切片按字节。`name=` 经 URL 解码后是原始 UTF-8 字节，80 不是字符边界时切进字符中间。

## 修法

截断点从 80 回退到 `utf8.RuneStart` 为真的字节：

```go
cut := 80
for !utf8.RuneStart(p.Name[cut]) {
    cut--
}
p.Name = p.Name[:cut]
```

上限仍是 80 字节；id 在截断前已从完整 name 派生（`Slug`），不受影响。

## 验证

| 步骤 | 结果 |
| --- | --- |
| 修前红（a4b0ecbb 产品文件 + 新测试） | FAIL：`name cut badly: 80 bytes, valid false`（0.00s） |
| 消融：`git checkout a4b0ecbb -- importurl.go` 回红 | 同句 FAIL（0.976s） |
| 修复后 `-run TestParseImport` | ok（1.202s） |
| `go test -tags nogui -count=1 ./internal/provider` | ok（70.981s） |
| `gofmt -l internal/` | 干净 |
| `go vet -tags nogui`（darwin / GOOS=linux / GOOS=windows） | 干净 |
| `go build`（darwin / GOOS=linux -tags nogui / GOOS=windows） | ok |

## 没跑什么

- 没在真实浏览器里从链接生成器构造超长中文名点导入（解析层红绿已锁行为，落盘层是同一段字节）。
- 没验证 GUI 对已损坏 U+FFFD 名字的显示（修复后不再产生半个字符，此路径不再触发）。

<details><summary>patch</summary>

```
From 8561b450ef52bb8675bc86b5d6b26a2e6f57c1de Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Thu, 15 Oct 2026 22:06:38 +0800
Subject: [PATCH] provider: an import link's name is cut to 80 bytes without
 cutting a character in half

ParseImport capped the link's name at 80 bytes with a bare slice. The
bytes of one Chinese character straddling the cut are no character at
all: the name reads back ruined (U+FFFD through encoding/json, raw
broken bytes on the command line) everywhere it shows. The site's link
builder takes any name the user types, and a Chinese one runs past 80
bytes at 27 characters.

The cut now walks back to a character boundary. The cap stays 80 bytes;
the id was already made from the whole name, so it is unchanged.

Run:
- TestParseImportNameCutKeepsCharactersWhole, new: red before ("name cut
  badly: 80 bytes, valid false"), green after; red again with
  importurl.go checked out at this commit's parent.
- go test -tags nogui -count=1 -run TestParseImport ./internal/provider:
  ok; the package: ok.
- gofmt -l internal: clean. go vet -tags nogui ./internal/provider,
  GOOS=linux -tags nogui, GOOS=windows: clean. Builds darwin, linux
  (nogui), windows: ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/importurl.go      | 10 +++++++++-
 internal/provider/importurl_test.go | 16 ++++++++++++++++
 2 files changed, 25 insertions(+), 1 deletion(-)

diff --git a/internal/provider/importurl.go b/internal/provider/importurl.go
index 3f3027db..9f6e97c8 100644
--- a/internal/provider/importurl.go
+++ b/internal/provider/importurl.go
@@ -5,6 +5,7 @@ import (
 	"net"
 	"net/url"
 	"strings"
+	"unicode/utf8"
 )
 
 // Import links let a vendor or a relay hand its users a ready-made provider:
@@ -131,7 +132,14 @@ func ParseImport(link string) (Provider, error) {
 		p.ID = freeID(p.ID)
 	}
 	if len(p.Name) > 80 {
-		p.Name = p.Name[:80]
+		// cut at 80 bytes without cutting a character in half: the cap is
+		// bytes, a name of them, and a half character would read back
+		// ruined (U+FFFD) everywhere the name shows
+		cut := 80
+		for !utf8.RuneStart(p.Name[cut]) {
+			cut--
+		}
+		p.Name = p.Name[:cut]
 	}
 
 	p.Key = get("key")
diff --git a/internal/provider/importurl_test.go b/internal/provider/importurl_test.go
index de0dbe1d..c95ab9f5 100644
--- a/internal/provider/importurl_test.go
+++ b/internal/provider/importurl_test.go
@@ -5,6 +5,7 @@ import (
 	"slices"
 	"strings"
 	"testing"
+	"unicode/utf8"
 )
 
 func TestParseImportPreset(t *testing.T) {
@@ -247,3 +248,18 @@ func TestParseImportForms(t *testing.T) {
 		}
 	}
 }
+
+// A name longer than 80 bytes is cut without cutting a character in half:
+// the site's link builder takes any name the user types, and a Chinese one
+// runs past 80 bytes at 27 characters (the cap is bytes, a name of them).
+// The name carries letters too, or the id has nothing to make itself from.
+func TestParseImportNameCutKeepsCharactersWhole(t *testing.T) {
+	name := strings.Repeat("鱼", 30) + "-relay" // 96 bytes
+	p, err := ParseImport("magpie://import?name=" + url.QueryEscape(name) + "&chat=https://x.example/v1")
+	if err != nil {
+		t.Fatal(err)
+	}
+	if !utf8.ValidString(p.Name) || len(p.Name) > 80 {
+		t.Fatalf("name cut badly: %d bytes, valid %v", len(p.Name), utf8.ValidString(p.Name))
+	}
+}
-- 
2.50.1 (Apple Git-155)


```

</details>

分支：https://github.com/ggbdpq/magpie/tree/hunt25-prov-import-name-truncate

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)
