# 5558 s3 备份 3.8GB 疑重复备份 → S3 请求归档无上限

- 判定：非重复备份（备份=单对象条件写）。根因：request archive 进 S3（每次 gateway 调用一对象 archive/<date>/<id>.json）无 cap 无清理；本地版有 RequestArchiveLocalMB 1GiB cap 最旧先删，S3 版不对称缺同款。
- 证据：issue 截图 bucket magpie 7,262 对象 3.6 GiB（20 天）；~0.5MB/对象符合归档形状。
- 修：davsync.Bucket.Put 后 trimmed()——ListObjectsV2(prefix archive/ 带 Size 分页)+DELETE 最旧至 goal=cap-cap/10，kept 跳过，list 失败留待下次；cap 复用 RequestArchiveLocalMB；GUI tooltip S3 分支补 cap 文案+4 语言 i18n。
- RED：archive_cap_test.go 4 测试（cap 内/kept 保护/分页/list 失败保 Put）。消融=kept 保护行。fakeS3 扩展 DELETE+listing（曾丢 HEAD 分支致 3 个既有测试红，已修复核绿）。
- 矩阵：davsync nogui 全包绿 37s；gateway 绿 814s；gui 唯一红 TestProxyCheckSaysAProxyPassedBy=预存红（父提交 0fc3455e2 对照同红 502 proxy asked 0）；davsync -race 绿 163s；gofmt/vet×3/build nogui×3 净；前端 node --test NOT-RUNNABLE 无 playwright（断言面 rg 0 命中）。
- head 15dda3c1ad5dd724ac3db4414073b8f6a3e5504d（rebase 0fc3455e2）；patch sha256 前16 7c543b07cc22e975（21KB）
- take: https://github.com/yetone/magpie/issues/5558#issuecomment-6715732962
- PATCH 帖: https://github.com/yetone/magpie/issues/5558#issuecomment-6716408354
- 回读: author=ggbdpq, 围栏成对, patch 字节一致, sha/head/attribution/尾注全在（7/7 PASS）
