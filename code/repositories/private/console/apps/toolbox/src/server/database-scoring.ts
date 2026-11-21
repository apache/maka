import { CAPABILITY_DIMENSIONS } from '@/data/capability-dimensions';

export interface ScoreNormalizer {
  mean: number;
  stdDev: number;
  min: number;
  max: number;
}

export function computeNormalizer(values: number[]): ScoreNormalizer {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return {
    mean: +mean.toFixed(2),
    stdDev: +Math.sqrt(variance).toFixed(2),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function zScore(value: number, normalizer: ScoreNormalizer): number {
  return normalizer.stdDev === 0 ? 0 : +((value - normalizer.mean) / normalizer.stdDev).toFixed(2);
}

export function rankDatabases<T>(
  items: T[],
  scoreFn: (item: T) => number,
  direction: 'asc' | 'desc' = 'desc'
): Array<T & { rank: number; score: number }> {
  const sorted = [...items]
    .map((item) => ({ ...item, score: scoreFn(item) } as T & { rank: number; score: number }))
    .sort((a, b) => (direction === 'desc' ? b.score - a.score : a.score - b.score));
  sorted.forEach((item, idx) => { item.rank = idx + 1; });
  return sorted;
}

export function gapAnalysis(
  scores: Record<string, number>,
  targetScores: Record<string, number>
): Array<{ dimension: string; current: number; target: number; gap: number; priority: string }> {
  return Object.keys(scores).map((key) => {
    const current = scores[key] ?? 0;
    const target = targetScores[key] ?? 0;
    const gap = target - current;
    let priority = 'low';
    if (gap >= 3) priority = 'critical';
    else if (gap >= 1.5) priority = 'high';
    else if (gap >= 0.5) priority = 'medium';
    return { dimension: key, current, target, gap: +gap.toFixed(1), priority };
  });
}

export function scoreToGrade(score: number): string {
  if (score >= 9) return 'A+';
  if (score >= 8) return 'A';
  if (score >= 7) return 'A-';
  if (score >= 6) return 'B+';
  if (score >= 5) return 'B';
  if (score >= 4) return 'B-';
  if (score >= 3) return 'C+';
  if (score >= 2) return 'C';
  return 'D';
}

export function scoreDistribution(scores: number[]): Array<{ range: string; count: number; label: string }> {
  const ranges = [
    { min: 9, max: 10, label: 'A+' }, { min: 8, max: 9, label: 'A' }, { min: 7, max: 8, label: 'A-' },
    { min: 6, max: 7, label: 'B+' }, { min: 5, max: 6, label: 'B' }, { min: 4, max: 5, label: 'B-' },
    { min: 3, max: 4, label: 'C+' }, { min: 2, max: 3, label: 'C' }, { min: 0, max: 2, label: 'D' },
  ];
  return ranges.map((r) => ({
    range: r.min + '-' + r.max,
    count: scores.filter((s) => s >= r.min && s < r.max).length,
    label: r.label,
  }));
}
