#!/usr/bin/env node
// Locator tone for the rescue "定位警報聲": three short 3 kHz beeps and a
// pause, like a rescue whistle. Deliberately not a sweeping siren so it is
// never mistaken for police, fire or ambulance vehicles.
//
//   node tools/audio/generate-locator-tone.mjs

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 22050;
const FREQUENCY = 3000;
const AMPLITUDE = 0.8;
const FADE_SECONDS = 0.01;
// [seconds, tone?] segments of one 3.3 s cycle.
const PATTERN = [[0.4, true], [0.3, false], [0.4, true], [0.3, false], [0.4, true], [1.5, false]];

export function locatorToneWav() {
  const pcm = [];
  for (const [seconds, tone] of PATTERN) {
    const count = Math.round(seconds * SAMPLE_RATE);
    const fade = Math.round(FADE_SECONDS * SAMPLE_RATE);
    for (let index = 0; index < count; index += 1) {
      if (!tone) {
        pcm.push(0);
        continue;
      }
      const envelope = Math.min(1, index / fade, (count - 1 - index) / fade);
      pcm.push(Math.round(Math.sin((2 * Math.PI * FREQUENCY * index) / SAMPLE_RATE) * envelope * AMPLITUDE * 32767));
    }
  }
  const data = Buffer.alloc(pcm.length * 2);
  pcm.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const wav = locatorToneWav();
  for (const target of ['android/app/src/main/res/raw/locator_siren.wav', 'flutter/web/audio/locator_siren.wav']) {
    const file = path.join(root, target);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, wav);
    console.log(`wrote ${target} (${wav.length} bytes)`);
  }
}
