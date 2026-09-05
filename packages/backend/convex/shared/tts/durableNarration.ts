import type { WordTiming } from './wordTimings';

export const DURABLE_NARRATION_MAX_CHARS = 150000;
export const DURABLE_NARRATION_MAX_WORDS = 30000;
export const NARRATION_SECTION_CHARS = 650;
export const NARRATION_CONCURRENCY = 2;
export const NARRATION_LEASE_MS = 180000;
export interface NarrationPage {
  status: 'none' | 'running' | 'done' | 'failed';
  total: number;
  completed: number;
  error: string | null;
  sections: { index: number; audioUrl: string; duration: number; words: WordTiming[] }[];
}
