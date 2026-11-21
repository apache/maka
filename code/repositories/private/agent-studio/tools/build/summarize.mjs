import {readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const analyses=[];
for(const [label,file] of [['管理页','rea-business-analysis.json'],['核心工作流编辑器','rea-workflow-analysis.json'],['完整导航和各模式编辑器','rea-navigation-analysis.json']]) {
 const evidence=JSON.parse(await readFile(join(root,'evidence',file),'utf8'));
 const result=evidence.normalized_result;
 const counts=result.graph.nodes.reduce((total,node)=>(total[node.kind]=(total[node.kind]??0)+1,total),{});
 analyses.push({label,evidenceId:evidence.evidence_id,operation:evidence.operation,provider:evidence.provider,statistics:result.statistics,applicationNodes:counts,semanticNodes:result.semantic_graph.nodes.length,semanticRelations:result.semantic_graph.relations.length,semanticCoverage:{status:result.semantic_graph.coverage.status,truncated:result.semantic_graph.coverage.truncated},limitations:evidence.limitations});
}
const summary={reaVersion:'6.4.0',analyses,sourceMaps:'已采集脚本未声明 sourceMappingURL；未猜测扫描 .map',recovery:'真实发布模块复用；可读源码由 Prettier 排版；原始 TS/TSX 和后端无法保证恢复'};
await writeFile(join(root,'evidence/rea-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary,null,2));
