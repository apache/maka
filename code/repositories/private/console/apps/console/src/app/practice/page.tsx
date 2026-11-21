import type { Metadata } from 'next';
import { PracticeApp } from '@/components/practice/PracticeApp';

export const metadata: Metadata = {
  title: '实践台 | Console',
  description: '数联天下项目开发实践复盘：git 提交看板与智能分析',
};

export default function PracticePage() {
  return <PracticeApp />;
}
