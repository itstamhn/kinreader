import { test, expect } from 'bun:test';
import { concatBytes, mp3DurationSeconds } from './mp3Duration';

// MPEG-1 Layer III, 128 kbps, 44.1 kHz, no padding: header FF FB 90 00,
// frame length floor(144 * 128000 / 44100) = 417 bytes, 1152 samples.
function mpeg1Frame(padding = 0): Uint8Array {
  const frame = new Uint8Array(417 + padding);
  frame.set([0xff, 0xfb, 0x90 | (padding << 1), 0x00]);
  return frame;
}

// MPEG-2 Layer III, 64 kbps, 24 kHz: header FF F3 80 04 -> version bits 10,
// bitrate index 8 (64 kbps), sample rate index 1 (24 kHz), 576 samples,
// frame length floor(72 * 64000 / 24000) = 192 bytes.
function mpeg2Frame(): Uint8Array {
  const frame = new Uint8Array(192);
  frame.set([0xff, 0xf3, 0x84, 0x00]);
  return frame;
}

test('sums whole frames across MPEG versions and padding', () => {
  const frames = [mpeg1Frame(), mpeg1Frame(1), mpeg1Frame(), mpeg1Frame(1)];
  expect(mp3DurationSeconds(concatBytes(frames))).toBeCloseTo((4 * 1152) / 44100, 6);

  const mpeg2 = [mpeg2Frame(), mpeg2Frame(), mpeg2Frame()];
  expect(mp3DurationSeconds(concatBytes(mpeg2))).toBeCloseTo((3 * 576) / 24000, 6);
});

test('skips an ID3v2 tag and junk before the first sync word', () => {
  const tag = new Uint8Array(10 + 20);
  tag.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 20]);
  const junk = new Uint8Array([0x00, 0x12, 0x34]);
  const bytes = concatBytes([tag, junk, mpeg1Frame(), mpeg1Frame()]);
  expect(mp3DurationSeconds(bytes)).toBeCloseTo((2 * 1152) / 44100, 6);
});

test('ignores a trailing partial frame and returns 0 for non-MP3 bytes', () => {
  const partial = mpeg1Frame().slice(0, 100);
  expect(mp3DurationSeconds(concatBytes([mpeg1Frame(), partial]))).toBeCloseTo(1152 / 44100, 6);
  expect(mp3DurationSeconds(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBe(0);
  expect(mp3DurationSeconds(new Uint8Array())).toBe(0);
});

test('chunk boundaries do not matter once the segment is concatenated', () => {
  const whole = concatBytes([mpeg1Frame(), mpeg1Frame(), mpeg1Frame()]);
  const chunks = [whole.slice(0, 300), whole.slice(300, 900), whole.slice(900)];
  expect(mp3DurationSeconds(concatBytes(chunks))).toBe(mp3DurationSeconds(whole));
});
