 import type { CapabilityDimension } from '@/schemas/database';
 
 export const CAPABILITY_DIMENSIONS: CapabilityDimension[] = [
   {
     id: 'performance',
     name: '性能',
     shortName: '性能',
     description: '数据库在吞吐量、查询延迟和并发处理方面的表现',
     category: 'performance',
     subMetrics: [
       { id: 'perf-throughput', name: '吞吐量', description: '每秒事务处理能力 (TPS/QPS)' },
       { id: 'perf-latency', name: '查询延迟', description: 'P50/P99 查询响应时间' },
       { id: 'perf-concurrency', name: '并发能力', description: '多连接并发处理性能' },
     ],
   },
   {
     id: 'reliability',
     name: '可靠性',
     shortName: '可靠',
     description: '数据持久化保障、容灾恢复能力和事务一致性',
     category: 'reliability',
     subMetrics: [
       { id: 'rel-durability', name: '数据持久化', description: 'ACID 事务与数据持久性保障' },
       { id: 'rel-backup', name: '备份恢复', description: '备份策略、PITR 恢复能力' },
       { id: 'rel-ha', name: '高可用', description: '故障转移、主从切换与集群容灾' },
     ],
   },
   {
     id: 'scalability',
     name: '扩展性',
     shortName: '扩展',
     description: '水平扩展、分片策略和弹性伸缩能力',
     category: 'scalability',
     subMetrics: [
       { id: 'scal-horizontal', name: '水平扩展', description: '分布式扩展与节点线性扩展' },
       { id: 'scal-sharding', name: '分片能力', description: '数据分片、分区策略支持' },
       { id: 'scal-elastic', name: '弹性伸缩', description: '自动扩缩容与资源动态调整' },
     ],
   },
   {
     id: 'security',
     name: '安全性',
     shortName: '安全',
     description: '数据加密、访问控制与合规审计能力',
     category: 'security',
     subMetrics: [
       { id: 'sec-encryption', name: '加密能力', description: '传输加密 (TLS) 与存储加密' },
       { id: 'sec-access', name: '访问控制', description: 'RBAC、行级安全策略' },
       { id: 'sec-audit', name: '审计日志', description: '操作审计与合规日志记录' },
     ],
   },
   {
     id: 'ecosystem',
     name: '生态成熟度',
     shortName: '生态',
     description: '驱动程序支持、工具链完整度和社区活跃度',
     category: 'ecosystem',
     subMetrics: [
       { id: 'eco-driver', name: '驱动支持', description: '主流语言驱动与 ORM 兼容性' },
       { id: 'eco-tools', name: '工具链', description: '监控、迁移、可视化工具生态' },
       { id: 'eco-community', name: '社区活跃', description: '社区贡献、文档质量与 Stack Overflow' },
     ],
   },
   {
     id: 'advanced',
     name: '高级能力',
     shortName: '高级',
     description: '全文检索、地理空间、半结构化数据等高级特性',
     category: 'advanced',
     subMetrics: [
       { id: 'adv-fulltext', name: '全文检索', description: '全文索引与搜索能力' },
       { id: 'adv-geo', name: '地理空间', description: '地理空间数据类型与索引' },
       { id: 'adv-semi', name: '半结构化', description: 'JSON、XML 等半结构化数据支持' },
     ],
   },
 ];
 
 export const DIMENSION_IDS = CAPABILITY_DIMENSIONS.map((d) => d.id);
 export const DEFAULT_WEIGHTS: Record<string, number> = Object.fromEntries(
   CAPABILITY_DIMENSIONS.map((d) => [d.id, 3])
 );
 
 export const DIMENSION_COLORS: Record<string, string> = {
   performance: '#3b82f6',
   reliability: '#22c55e',
   scalability: '#f97316',
   security: '#ef4444',
   ecosystem: '#8b5cf6',
   advanced: '#06b6d4',
 };
