// Exact duration of an MP3 byte stream, from its frame headers. Used to offset
// the word timestamps of one Soniox segment onto the end of the previous one
// when an article is synthesised as several concurrent streams
// (parallelSoniox.ts): the last spoken character's end time is *not* the
// audio's end (there is trailing silence), and misjudging that gap by even
// 100ms would put every later word out of step with the voice.

const BITRATES_KBPS: Record<'v1l3' | 'v2l3', number[]> = {
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<'v1' | 'v2' | 'v25', number[]> = {
  v1: [44100, 48000, 32000],
  v2: [22050, 24000, 16000],
  v25: [11025, 12000, 8000],
};

function skipId3v2(bytes: Uint8Array): number {
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const size =
    ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  const footer = (bytes[5]! & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface Mp3Scan {
  /** Seconds of audio in the complete frames found. */
  seconds: number;
  /** Byte offset just past the last complete frame (a safe place to cut). */
  consumedBytes: number;
}

/** Seconds of audio in an MPEG Layer III stream; 0 when no frame can be read. */
export function mp3DurationSeconds(bytes: Uint8Array): number {
  return scanMp3Frames(bytes).seconds;
}

/**
 * Walks complete MPEG Layer III frames. Used both to measure a stream's
 * duration and to find where a byte stream can be cut so that each piece
 * starts on a frame header and decodes on its own.
 */
export function scanMp3Frames(bytes: Uint8Array): Mp3Scan {
  let index = skipId3v2(bytes);
  let seconds = 0;
  let consumedBytes = index;

  while (index + 4 <= bytes.length) {
    const b1 = bytes[index]!;
    const b2 = bytes[index + 1]!;
    const b3 = bytes[index + 2]!;
    if (b1 !== 0xff || (b2 & 0xe0) !== 0xe0) {
      index += 1;
      continue;
    }

    const versionBits = (b2 >> 3) & 0x3; // 0 = MPEG 2.5, 2 = MPEG 2, 3 = MPEG 1
    const layerBits = (b2 >> 1) & 0x3; // 1 = Layer III
    const bitrateIndex = (b3 >> 4) & 0xf;
    const sampleRateIndex = (b3 >> 2) & 0x3;
    const padding = (b3 >> 1) & 0x1;

    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
      index += 1;
      continue;
    }

    const isMpeg1 = versionBits === 3;
    const bitrate = (isMpeg1 ? BITRATES_KBPS.v1l3 : BITRATES_KBPS.v2l3)[bitrateIndex]! * 1000;
    const sampleRate = (isMpeg1 ? SAMPLE_RATES.v1 : versionBits === 2 ? SAMPLE_RATES.v2 : SAMPLE_RATES.v25)[
      sampleRateIndex
    ]!;
    const samplesPerFrame = isMpeg1 ? 1152 : 576;
    const frameLength = Math.floor(((samplesPerFrame / 8) * bitrate) / sampleRate) + padding;
    if (frameLength <= 4) {
      index += 1;
      continue;
    }
    // A frame cut off by the end of the buffer still played for its full
    // length upstream only if it is complete; count only whole frames.
    if (index + frameLength > bytes.length) break;

    seconds += samplesPerFrame / sampleRate;
    index += frameLength;
    consumedBytes = index;
  }

  return { seconds, consumedBytes };
}
