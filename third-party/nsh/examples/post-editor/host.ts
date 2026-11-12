// What the host app answers (fake data: the real one asks Longbridge's
// search APIs). Each search resolves after a short pause, as a request does.

/** One candidate of a search: `id` is what the server stores (a stock's `counter_id`, as the search API returns it: `ST/MARKET/CODE`). */
export interface Candidate {
  id: string;
  name: string;
  detail: string;
}

const SECURITIES: Candidate[] = [
  { id: "ST/US/TSLA", name: "Tesla", detail: "TSLA.US" },
  { id: "ST/US/NVDA", name: "NVIDIA", detail: "NVDA.US" },
  { id: "ST/US/AAPL", name: "Apple", detail: "AAPL.US" },
  { id: "ST/HK/700", name: "腾讯控股", detail: "700.HK" },
  { id: "ST/HK/9988", name: "阿里巴巴-W", detail: "9988.HK" },
  { id: "ST/HK/1810", name: "小米集团-W", detail: "1810.HK" },
  { id: "ST/SH/600519", name: "贵州茅台", detail: "600519.SH" },
];

const MEMBERS: Candidate[] = [
  { id: "1001", name: "Alice", detail: "分析师" },
  { id: "1002", name: "Bob", detail: "基金经理" },
  { id: "1003", name: "老王", detail: "港股老兵" },
  { id: "1004", name: "小陈", detail: "美股研究" },
  { id: "1005", name: "Grace", detail: "宏观" },
];

const TOPICS: Candidate[] = [
  { id: "t1", name: "财报季", detail: "12.3 万讨论" },
  { id: "t2", name: "Earnings", detail: "8.1 万讨论" },
  { id: "t3", name: "AI 算力", detail: "6.4 万讨论" },
  { id: "t4", name: "降息", detail: "5.2 万讨论" },
  { id: "t5", name: "新能源车", detail: "3.9 万讨论" },
];

/** The candidates of `pool` whose label, detail or id holds `query`; all of them for an empty one. */
function search(pool: Candidate[], query: string): Promise<Candidate[]> {
  const q = query.trim().toLowerCase();
  const found = pool.filter((c) => !q || `${c.name} ${c.detail} ${c.id}`.toLowerCase().includes(q));
  return new Promise((resolve) => setTimeout(() => resolve(found), 40));
}

/** The host's interface to the editor. */
export const host = {
  searchSecurities: (query: string) => search(SECURITIES, query),
  searchMembers: (query: string) => search(MEMBERS, query),
  searchTopics: (query: string) => search(TOPICS, query),
};
