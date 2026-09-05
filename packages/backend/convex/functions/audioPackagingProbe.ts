'use node';

import { internalAction } from './_generated/server';
import { v } from 'convex/values';
import ffmpeg from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
/** Operator-only runtime probe. Downloads saved audio; never generates speech. */
export const run = internalAction({
  args: { audioUrls: v.array(v.string()) },
  handler: async (_ctx, { audioUrls }) => {
    if (!ffmpeg) throw new Error('FFmpeg binary is unavailable');
    if (audioUrls.length > 4) throw new Error('Probe accepts at most four saved sections');
    const started = Date.now();
    const directory = await mkdtemp(join(tmpdir(), 'audio-probe-'));
    try {
      const binary = join(directory, 'ffmpeg');
      await copyFile(ffmpeg, binary);
      await chmod(binary, 0o755);
      const version = await exec(binary, ['-version'], { timeout: 10000 });
      const inputs: string[] = [];
      let inputBytes = 0;
      for (let index = 0; index < audioUrls.length; index++) {
        const url = new URL(audioUrls[index]!);
        if (url.origin !== 'https://notable-camel-807.convex.cloud' || !url.pathname.startsWith('/api/storage/')) throw new Error('Expected saved production audio');
        const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error('Saved audio download failed');
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 16 * 1024 * 1024) throw new Error('Saved section too large');
        inputBytes += bytes.length;
        const file = join(directory, `${index}.mp3`);
        await writeFile(file, bytes);
        inputs.push('-i', file);
      }
      const encodeStarted = Date.now();
      const source = inputs.length ? [...inputs, '-filter_complex', `${audioUrls.map((_, i) => `[${i}:a]`).join('')}concat=n=${audioUrls.length}:v=0:a=1[out]`, '-map', '[out]'] : ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=15'];
      await exec(binary, ['-hide_banner', '-loglevel', 'error', ...source, '-ar', '48000', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-f', 'hls', '-hls_time', '6', '-hls_segment_type', 'fmp4', '-hls_playlist_type', 'vod', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', join(directory, 'segment-%05d.m4s'), join(directory, 'index.m3u8')], { timeout: 120000 });
      const files = await readdir(directory);
      const playlist = await readFile(join(directory, 'index.m3u8'), 'utf8');
      return { ok: true, ffmpeg: version.stdout.split('\n')[0], node: process.version, architecture: process.arch,
        sourceSections: audioUrls.length, inputBytes, encodeMs: Date.now() - encodeStarted, totalMs: Date.now() - started,
        segments: files.filter(file => file.endsWith('.m4s')).length, playlist, rssBytes: process.memoryUsage().rss };
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
});
