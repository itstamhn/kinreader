export interface WordTiming {
  text: string;
  start: number;
  end: number;
}

export interface ArticleData {
  recordingId?: string;
  stage?: 'finding' | 'needsReview' | 'preparing' | 'partial' | 'complete' | 'extractFailed' | 'audioFailed' | 'cancelled';
  narrationText?: string;
  error?: string;
  truncated?: boolean;
  title: string;
  author?: string;
  authorHandle?: string;
  authorAvatar?: string;
  content: string;
  image?: string;
  sourceUrl?: string;
  sourceType?: 'x' | 'article' | 'text';
}

export interface ReaderSettings {
  ttsProvider: 'browser' | 'soniox' | 'elevenlabs';
  sonioxApiKey?: string;
  sonioxVoice?: string;
  groqApiKey?: string;
  elevenApiKey?: string;
  elevenVoiceId?: string;
  defaultRate: number;
  browserVoiceURI?: string;
  fontSize?: 'sm' | 'md' | 'lg';
  readerTheme?: 'dark' | 'light';
  voiceEnabled?: boolean;
  rampEnabled?: boolean;
}

export interface TTSResponse {
  audioBase64?: string;
  words: WordTiming[];
  duration?: number;
  provider: 'browser' | 'soniox' | 'elevenlabs';
}
