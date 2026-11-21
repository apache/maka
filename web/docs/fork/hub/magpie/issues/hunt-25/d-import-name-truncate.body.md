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
PLACEHOLDER_PATCH
```

</details>

分支：https://github.com/ggbdpq/magpie/tree/hunt25-prov-import-name-truncate

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Generated-by: GLM-5.3-Flash (ZCode)
