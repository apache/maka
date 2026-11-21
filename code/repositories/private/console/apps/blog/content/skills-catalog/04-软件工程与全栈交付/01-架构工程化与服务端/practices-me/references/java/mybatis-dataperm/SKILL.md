---
name: mybatis-me
description: MyBatis-Plus + dataperm 数据权限的实际写法。Use this skill when working with Mapper, HmMapper, Mapper XML, PO, BaseEntity, @TableName, @TableId, IdType.ASSIGN_ID, QueryWrapper, lambdaQuery, @IgnoreDataperm, DatapermType, dataperm, org_id tenant_code filtering, PageHelper, startPage, TKPageUtil, NaviPage, Pager, @Transactional, or MapStruct PO mapping.
---

# MyBatis + 数据权限实际写法

## 使用定位

用于 `*-center-infrastructure` 层的 **Mapper/PO/Query/Repository/XML 编写**，尤其是 dataperm 数据权限豁免、分页、事务和 XML 动态 SQL 的约定写法。本专题只覆盖 infrastructure 落地细节；分层与模块结构看 `java-ddd-me`。

## 核心认知：dataperm 是「默认开 + 豁免制」

**约定只用 `@IgnoreDataperm`（豁免），没有正向 `@DataPerm` 注解。** dataperm 默认开启：框架的 MyBatis 拦截器自动给所有查询按 `org_id`/`tenant_code` 追加 `=` 条件（取值来自 `OrgIdContextHolder`/`TenantCodeContextHolder`）。业务方只在**不需要权限过滤**的方法上加 `@IgnoreDataperm` 豁免。

```java
import com.example.framework.base.dataperm.annotations.IgnoreDataperm;

// 用法一：返回全量再按类型分组
@Override
@IgnoreDataperm
public List<CheckInQueryResDTO> list(CheckInQueryReqDTO dto) { ... }

// 用法二（带参数）：全局唯一性校验类查询
@Override
@IgnoreDataperm(DatapermType.GLOBAL)   // 或 DatapermType.ALL（服务端全量豁免）
public ClientAppQueryResDTO ... { ... }
```

**注解粒度：method 级，加在最终执行查询的 infra query/repository 方法上**，可叠加 `@Transactional`。无参 = 忽略当前方法；带 `DatapermType.GLOBAL/ALL` = 明确豁免到全局/全量。**不标注 = 默认受数据权限过滤。**

## Mapper 组织

- **双保险装配**：Mapper 接口挂 `@Mapper` 注解 + `XxxMybatisPlusConfig`（空配置类只挂 `@MapperScan("com.example.xxx.center.infrastructure.*.mapper")`）。启动类 `@ComponentScan` **不负责** Mapper 扫描。
- `application.yml`：`mybatis-plus.mapper-locations: classpath:mapper/*Mapper.xml`
- Mapper 接口 `extends HmMapper<PO>`（base-mybatis 对 MP `BaseMapper` 的封装），白拿通用 CRUD。
- **条件拼接走 Java 侧**（QueryWrapper / lambdaQuery() 在 infra 的 query/repository 类），**只有定制 SQL（多表 join、复杂统计）才写 mapper 方法 + XML**。本 project 的 mapper 只声明了一个方法。

```java
@Mapper
public interface CheckInMapper extends HmMapper<CheckInPO> {
    // 只有定制 SQL 才需要在这里声明方法 + 写 XML
    List<CheckInPO> getByCustomerIdAndDayAndType(@Param("customerId") Long customerId,
            @Param("checkInDay") Date checkInDay, @Param("checkInType") String checkInType);
}
```

## PO 声明约定

```java
@Data
@EqualsAndHashCode(callSuper = true)
@TableName("tb_biz_check_in")
public class CheckInPO extends BaseEntity {        // 审计字段 created_by/created_time/... 由基类带出
    @TableId(type = IdType.ASSIGN_ID)
    private Long checkInId;        // 主键：雪花 ID
    private Long customerId;
    private String checkInJson;
    private Date checkInDay;       // java.util.Date，非 LocalDateTime
    private Integer state;         // 状态 0/1
    private Long orgId;            // 机构 ID（数据权限列）
    private String tenantCode;     // 租户编码（数据权限列）
    private Integer delFlag;       // 逻辑删除 0/1
}
```

- 命名 `*PO`，放 `.../po/` 包；领域层另有 `*Entity`（纯 JavaBean）与 `*Root`（聚合根）。
- 字段类型：ID/机构 `Long`，编码/JSON `String`，状态 `Integer`，时间 `java.util.Date`。
- 库列名下划线，Java 驼峰，靠 MP 默认 mapUnderscoreToCamelCase 映射。
- PO ↔ Entity/Root/DTO 用 **MapStruct** Assembler（`root2PO`/`po2Entity`/`poList2RootList`）。

## 分页（PageHelper，非 MP IPage）

```java
try (com.github.pagehelper.Page<CheckInPO> ignored =
        PageHelper.startPage(dto.getPageIndex(),
            Math.min(dto.getPageRows(), Pager.getLimitedPager().getPageRows()),  // 限页
            dto.getOrderBy())) {                                                  // 排序
    List<CheckInPO> list = list(buildQueryWrapper(dto));  // 紧接着的查询被拦截
    return TKPageUtil.getNaviPage(list, CheckInAssembler.INSTANCE::poList2RootList);
}
```

- 请求 DTO `extends Pager`（自带 `pageIndex/pageRows/orderBy`），返回统一 `NaviPage<T>`（feign 接口、controller 均用它）。
- `try (Page...)` 自动关闭，避免 PageHelper 线程本地泄漏。

## 事务

`@Transactional(rollbackFor = Exception.class)`，两级位置：

| 位置 | 粒度 | 例子 |
| --- | --- | --- |
| infra `repository` 层 | 单聚合持久化 | `CheckInRepositoryImpl` 的 insert/delete/update 各挂一个 |
| application `service` 层 | 用例编排、跨表/跨聚合 | `CheckInService.addCheckIn`（同事务内"先失效旧数据、再插入新数据"） |

聚合根 `XxxRoot` 通过 `SpringUtil.getBean(XxxRepository.class)` 自取仓储（构造时 `init()`）。

## XML 典型模板

全量列 + 固定条件（条件拼接主要靠 QueryWrapper，XML 只放定制 SQL）：

```xml
<select id="getByCustomerIdAndDayAndType"
        resultType="com.example.biz.center.infrastructure.checkin.po.CheckInPO">
    SELECT check_in_id, customer_id, ... , created_by, updated_by
    FROM tb_biz_check_in
    WHERE del_flag = 0
      AND customer_id = #{customerId}
      AND DATE(check_in_day) = DATE(#{checkInDay})
      AND check_in_type = #{checkInType}
</select>
```

动态 SQL 范本（条件 + 时间范围 + 集合 + 复用片段 + 分支）：

```xml
<sql id="todoFromAndWhere">
    FROM tb_biz_todo t
    INNER JOIN tb_biz_todo_relation r ON r.todo_id = t.todo_id
    WHERE t.tenant_code = #{tenantCode}
      AND t.org_id = #{orgId}          <!-- 数据权限列也常出现在手写 SQL 中 -->
      AND t.del_flag = 0
</sql>
<!-- ... -->
WHERE t.tenant_code = #{tenantCode} AND t.org_id = #{orgId} ...
  <if test="startTime != null"> AND t.created_time &gt;= #{startTime} </if>
  <if test="endTime != null"> AND t.created_time &lt;= #{endTime} </if>
  <foreach collection="relationTypes" item="rt" open="(" separator="," close=")"> #{rt} </foreach>
ORDER BY t.created_time DESC, t.todo_id DESC
```

## 反模式

- 不要写正向 `@DataPerm`，全仓库约定是默认开 + `@IgnoreDataperm` 豁免。
- 不要把 `@IgnoreDataperm` 加在 controller/service 上，只加在**最终执行查询**的 infra query/repository 方法上。
- 不要全用 XML 拼条件，常规查询走 QueryWrapper/lambdaQuery()，XML 只写定制 SQL。
- 不要用 MP 的 `IPage`，分页统一 PageHelper + `NaviPage/Pager/TKPageUtil`。
- 不要漏 `try (Page...)`，PageHelper 不关会线程本地泄漏。
- PO 不要用 `LocalDateTime`，约定 `java.util.Date`；不要漏 `@EqualsAndHashCode(callSuper = true)`（继承 BaseEntity 必须带）。
- 手写 SQL 里不要漏 `del_flag = 0`；需要豁免的列（org_id/tenant_code）要么靠 dataperm 拦截器，要么在 XML 里显式拼。

## 输出格式

按以下结构输出：

1. 结论摘要
2. 涉及文件与层级
3. Mapper/PO/Query 定位
4. dataperm 豁免核对
5. 分页与事务
6. 验收方式
7. 未改事项
