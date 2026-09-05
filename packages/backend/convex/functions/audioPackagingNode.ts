'use node';

import { internalAction, env } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import ffmpeg from 'ffmpeg-static';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, copyFile, chmod, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NarrationPage } from '../shared/tts/durableNarration';
import type { WordTiming } from '../shared/tts/wordTimings';

const exec = promisify(execFile);
const RATE = 48000;
const AAC_DELAY = 1024;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const convert = internalAction({
  args: { key: v.string(), generation: v.string(), input: v.object({ contentDigest: v.string(), voice: v.string(), recordingId: v.optional(v.string()), ownerToken: v.optional(v.string()) }) },
  handler: async (ctx, args) => {
    if (!(await ctx.runMutation(internal.audioPackaging.claim, { key: args.key, generation: args.generation }))) return;
    const origin = env.AUDIO_PACKAGER_ORIGIN;
    const secret = env.AUDIO_PACKAGER_SECRET;
    if (!ffmpeg || !origin || !secret) throw new Error('Audio packaging is not configured');
    const directory = await mkdtemp(join(tmpdir(), 'continuous-audio-'));
    const path = `${args.key}/${args.generation}/`;
    const began = Date.now();
    const metrics = { downloadMs: 0, decodeMs: 0, encodeMs: 0, publishMs: 0, batchDecodes: 0 };
    const deadline = began + 8 * 60000;
    let encoder: ChildProcessWithoutNullStreams | undefined;
    let processResult: Promise<number | null> | undefined;
    const checkDeadline = () => { if (Date.now() > deadline) throw new Error('Audio packaging deadline reached'); };
    const upload = async (file: string, data: Uint8Array | string, contentType: string) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        checkDeadline();
        try {
          const response = await fetch(`${origin}/internal/objects/${file}`, { method: 'PUT', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': contentType }, body: data as BodyInit, signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw new Error('Could not save continuous audio');
          return;
        } catch (error) { if (attempt === 2) throw error; await delay(500 * (attempt + 1)); }
      }
    };
    const timeline: { complete: boolean; duration: number; total: number; words: WordTiming[]; sections: { index: number; start: number; duration: number; wordCount: number }[] } = { complete: false, duration: 0, total: 0, words: [], sections: [] };
    const uploaded = new Set<string>();
    const publish = async () => {
      const files = (await readdir(directory)).filter(file => (file.endsWith('.m4s') || file === 'init.mp4') && !uploaded.has(file));
      for (let i = 0; i < files.length; i += 12) {
        await Promise.all(files.slice(i, i + 12).map(async file => {
          await upload(path + file, await readFile(join(directory, file)), 'audio/mp4');
          uploaded.add(file);
        }));
      }
      let playlist: string;
      try { playlist = await readFile(join(directory, 'index.m3u8'), 'utf8'); } catch { return; }
      const required = playlist.split('\n').filter(line => line && !line.startsWith('#'));
      if (!uploaded.has('init.mp4') || required.some(file => !uploaded.has(file))) return;
      playlist = playlist.replace('#EXTM3U\n', '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n');
      await upload(path + 'index.m3u8', playlist, 'application/vnd.apple.mpegurl');
      await upload(path + 'timeline.json', JSON.stringify(timeline), 'application/json');
    };
    try {
      // External package archives do not retain executable permissions in
      // Convex. Run a private executable copy in the action's working folder.
      const binary = join(directory, 'ffmpeg');
      await copyFile(ffmpeg, binary);
      await chmod(binary, 0o755);
      encoder = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', 'pipe:0',
        '-c:a', 'aac', '-threads', '1', '-b:a', '96k', '-f', 'hls', '-hls_time', '6', '-hls_segment_type', 'fmp4',
        '-hls_playlist_type', 'event', '-hls_list_size', '0', '-hls_flags', 'temp_file', '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', join(directory, 'segment-%05d.m4s'), join(directory, 'index.m3u8')]);
      let processError: Error | undefined;
      encoder.stderr.resume();
      encoder.stdout.resume();
      encoder.stdin.on('error', error => { processError = error; });
      processResult = new Promise(resolve => {
        encoder!.on('error', error => { processError = error; resolve(-1); });
        encoder!.on('close', resolve);
      });
      let index = 0, samples = 0, lastProgress = Date.now();
      while (true) {
        checkDeadline();
        if (processError) throw processError;
        const page: NarrationPage = await ctx.runQuery(internal.audioPackaging.page, { input: args.input, from: index });
        timeline.total = page.total;
        let phase = Date.now();
        const downloaded = await Promise.all(page.sections.map(async section => {
          const response = await fetch(section.audioUrl, { signal: AbortSignal.timeout(20000) });
          if (!response.ok) throw new Error('Saved audio unavailable');
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.length > 16 * 1024 * 1024) throw new Error('Saved section is too large');
          return { section, bytes };
        }));
        // Decode a small batch in one process. Validate its exact sample count
        // against the saved MP3 durations before using those section offsets.
        // This avoids launching a new native process for every short section.
        metrics.downloadMs += Date.now() - phase;
        phase = Date.now();
        let batchPcm: Buffer | undefined;
        const expectedSamples = downloaded.map(({ section }) => Math.round(section.duration * RATE));
        if (downloaded.length > 1 && expectedSamples.reduce((a, b) => a + b, 0) * 4 <= 48 * 1024 * 1024) {
          const inputs: string[] = [];
          for (const [i, { bytes }] of downloaded.entries()) {
            const file = join(directory, `batch-${i}.mp3`);
            await writeFile(file, bytes);
            inputs.push('-i', file);
          }
          const filter = downloaded.map((_, i) => `[${i}:a]aresample=${RATE},aformat=channel_layouts=mono[a${i}]`).join(';') + ';' +
            downloaded.map((_, i) => `[a${i}]`).join('') + `concat=n=${downloaded.length}:v=0:a=1[out]`;
          const result = await exec(binary, ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[out]', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
          if (result.stdout.length === expectedSamples.reduce((a, b) => a + b, 0) * 4) { batchPcm = result.stdout; metrics.batchDecodes++; }
        }
        metrics.decodeMs += Date.now() - phase;
        let batchOffset = 0;
        for (const [batchIndex, { section, bytes }] of downloaded.entries()) {
          checkDeadline();
          if (section.index !== index) throw new Error('Saved sections are out of order');
          let stdout: Buffer;
          if (batchPcm) {
            const length = expectedSamples[batchIndex]! * 4;
            stdout = batchPcm.subarray(batchOffset, batchOffset + length);
            batchOffset += length;
          } else {
            const input = join(directory, 'source.mp3');
            await writeFile(input, bytes);
            stdout = (await exec(binary, ['-hide_banner', '-loglevel', 'error', '-i', input, '-f', 'f32le', '-ar', String(RATE), '-ac', '1', 'pipe:1'], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30000 })).stdout;
          }
          if (!stdout.length || stdout.length % 4) throw new Error('Invalid decoded audio');
          const count = stdout.length / 4;
          const duration = count / RATE;
          const start = (samples + AAC_DELAY) / RATE;
          let previous = 0;
          const words = section.words.map(word => {
            if (!(0 <= word.start && word.start < word.end && word.end <= duration + 1 / RATE) || word.start < previous) throw new Error('Saved timings do not match decoded audio');
            previous = word.end;
            return { text: word.text, start: start + word.start, end: start + Math.min(duration, word.end) };
          });
          phase = Date.now();
          await new Promise<void>((resolve, reject) => encoder!.stdin.write(stdout, error => error ? reject(error) : resolve()));
          metrics.encodeMs += Date.now() - phase;
          samples += count;
          timeline.duration = (samples + AAC_DELAY) / RATE;
          timeline.words.push(...words);
          timeline.sections.push({ index, start, duration, wordCount: words.length });
          index++;
          lastProgress = Date.now();
        }
        phase = Date.now();
        await publish();
        metrics.publishMs += Date.now() - phase;
        if (page.total && index === page.total) break;
        if (page.status === 'failed' || page.error || Date.now() - lastProgress > 210000) throw new Error('Audio preparation interrupted');
        if (!page.sections.length) { await publish(); await delay(1500); }
      }
      encoder.stdin.end();
      if (await processResult) throw new Error('Audio encoder failed');
      timeline.complete = true;
      await publish();
      console.log('Audio packaging completed', { ...metrics, totalMs: Date.now() - began, sections: index });
      await upload(`${args.key}/complete.json`, JSON.stringify({ generation: args.generation }), 'application/json');
      await ctx.runMutation(internal.audioPackaging.finish, { key: args.key, generation: args.generation, ok: true });
    } catch (error) {
      encoder?.kill('SIGKILL');
      await processResult;
      try { await fetch(`${origin}/internal/objects/${path}error.json`, { method: 'PUT', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Continuous audio could not be prepared. Please retry.' }), signal: AbortSignal.timeout(5000) }); } catch {}
      await ctx.runMutation(internal.audioPackaging.finish, { key: args.key, generation: args.generation, ok: false });
      console.error('Audio packaging failed', error instanceof Error ? error.message : 'Unknown error');
    } finally { await rm(directory, { recursive: true, force: true }); }
  },
});
