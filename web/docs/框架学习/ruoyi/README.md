# RuoYi 本地运行与依赖安装（mac）

项目：[yangzongzhuan/RuoYi](https://github.com/yangzongzhuan/RuoYi)（即 y_project/RuoYi 改名后的官方仓），本地 clone 在 `/Users/ggbdpq/cc/github/other/yangzongzhuan/RuoYi`（2026-10-11 fork 收编后新址；原 `interview/code/RuoYi` 的 ggbdpq fork 克隆已删，远程 fork 同日删除）。本地化改动 `logback.xml`（`log.path` 改为 `${RUOYI_LOG_PATH:-/home/ruoyi/logs}` 可环境变量覆盖）与 `go.mod`（genout 空模块）存档于本目录。**注意：这是现代化分支——Java 17 + Spring Boot 4.1.0 多模块 Maven**（ruoyi-admin/common/framework/generator/quartz/system），不是老 JDK8 经典版；**4.8.3 已移除 Redis 依赖**（ehcache 替代，全仓 grep 零 redis 引用），只需 Java + Maven + MySQL。

> 本地核对：2026-10-05，mac arm64（Darwin 24.6.0）。按本文从零装完依赖后 `Started RuoYiApplication in 2.497 seconds`，`GET /login` 返回若依登录页。

## 1. 依赖清单与本机现状

| 依赖 | 要求 | 本机现状 | 缺时装法 |
| --- | --- | --- | --- |
| JDK | 17+（pom `java.version=17`；Java 21 实测可编译运行） | ✅ Corretto 21.0.9（sdkman） | `sdk install java 21.0.9-amzn` 或 `brew install --cask temurin@21` |
| Maven | 3.9.x | ✅ 3.9.12（sdkman） | `sdk install maven` 或 `brew install maven` |
| MySQL | 8.x（配置默认 `localhost:3306`，root/password，库名 `ry`） | ❌ → Docker 容器补 | 见 §2 |
| Redis | **不需要**（此 fork 已移除） | — | — |
| Docker Desktop | 用于跑 MySQL（本机已恢复可用） | ✅ | 官网 dmg |

## 2. MySQL（Docker 容器，参数与仓库默认配置对齐）

```bash
docker run -d --name ruoyi-mysql -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=password -e MYSQL_DATABASE=ry mysql:8
# 等就绪（首次初始化约 20-30 秒）
for i in $(seq 1 30); do
  docker exec ruoyi-mysql mysqladmin ping -uroot -ppassword --silent >/dev/null 2>&1 && break; sleep 2;
done
```

导入仓库自带的两份 SQL（先业务库后 quartz 表，共 32 张表）：

```bash
cd /Users/ggbdpq/cc/github/other/yangzongzhuan/RuoYi  # 本机若缺克隆，先 git clone https://github.com/yangzongzhuan/RuoYi 到此
docker exec -i ruoyi-mysql mysql -uroot -ppassword --default-character-set=utf8mb4 ry < sql/ry_20260319.sql
docker exec -i ruoyi-mysql mysql -uroot -ppassword --default-character-set=utf8mb4 ry < sql/quartz.sql
# 验证
docker exec ruoyi-mysql mysql -uroot -ppassword ry -e "SHOW TABLES;" | wc -l   # 33 = 表数+表头
```

`docker exec -i`（无 -t）导入大量语句才不会卡；`Warning: Using a password on the command line` 是噪音可忽略。**`--default-character-set=utf8mb4` 不能省**：容器内 mysql 客户端的连接字符集若落到 latin1，UTF-8 的 SQL 会被逐字节误读再存储，页面侧栏菜单变成 `ç³»ç»Ÿç®¡ç†` 这类双重编码乱码（静态模板文字正常、只有库里的数据乱，是它的识别特征；表注释同样会乱）。修复=drop 库重建后带此参数重导。

## 3. 构建

```bash
mvn -B -DskipTests clean package     # 首次拉全量依赖约 1-3 分钟，BUILD SUCCESS 后产物在 ruoyi-admin/target/ruoyi-admin.jar
```

## 4. mac 三个本地化坑（Linux 默认值不改会启动失败）

1. **logback 日志路径写死 `/home/ruoyi/logs`**（`ruoyi-admin/src/main/resources/logback.xml` 第 4 行）——mac 上 `/home` 不可写，logback 1.5 的配置错误会让 Spring 启动直接失败（`Application run failed`）。改法（已在本仓工作树应用，未提交）：

   ```xml
   <property name="log.path" value="${RUOYI_LOG_PATH:-/home/ruoyi/logs}" />
   ```

   默认值语法保持 Linux 行为不变；mac 用 `-DRUOYI_LOG_PATH=...` 覆盖，改完需重新 `mvn package`。注意 `-Dlogging.config`（Spring 的旋钮）和 `-Dlogback.configurationFile`（logback 自家的旋钮）都压不过打进 jar 的 classpath logback.xml——**改文件重建是唯一确定解**。
2. **`server.port: 80`**——mac 上绑 80 要 root；用 `--server.port=18080` 覆盖（8080 在本机已被别的 Docker 容器占用，选端口前 `lsof -nP -iTCP:端口 -sTCP:LISTEN` 查一下）。
3. **`ruoyi.profile: D:/ruoyi/uploadPath`**——Windows 上传路径，用 `--ruoyi.profile=/tmp/ruoyi/uploadPath` 覆盖，否则文件上传功能会写不了盘。

## 5. 启动与验证

```bash
java -DRUOYI_LOG_PATH=/tmp/ruoyi/logs \
  -jar ruoyi-admin/target/ruoyi-admin.jar \
  --server.port=18080 \
  --ruoyi.profile=/tmp/ruoyi/uploadPath
# 日志出现 "Started RuoYiApplication in N seconds" 即成功
```

验证：

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:18080/        # 302（跳登录页）
curl -s http://localhost:18080/login | grep -oE "<title>[^<]*</title>"       # <title>登录若依系统</title>
```

浏览器开 `http://localhost:18080`，默认管理员 `admin / admin123`。

## 6. 停止与清理

```bash
pkill -f ruoyi-admin.jar                 # 停应用
docker stop ruoyi-mysql && docker rm ruoyi-mysql   # 不再玩就删容器（数据在容器里，删=清库）
```

4. **导入 SQL 忘了 `--default-character-set=utf8mb4`**——见 §2 的说明；症状是登录后侧栏/下拉里库里的中文全乱而页面骨架正常。

## 7. 已知残留

- 工作树有一处未提交修改：`ruoyi-admin/src/main/resources/logback.xml`（§4.1 的 `RUOYI_LOG_PATH` 默认值语法），是 mac 可运行的前提，保留。
- `sql/` 里的 `ry_20260319.sql` 文件名带日期，上游更新后以 `sql/` 目录实际文件名为准。
