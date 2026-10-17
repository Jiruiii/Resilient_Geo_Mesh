import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { locatorToneWav } from '../../tools/audio/generate-locator-tone.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('Android and Web ship the same generated tone', async () => {
  const generated = locatorToneWav();
  const android = await readFile(path.join(ROOT, 'android/app/src/main/res/raw/locator_siren.wav'));
  const web = await readFile(path.join(ROOT, 'flutter/web/audio/locator_siren.wav'));
  assert.equal(sha(android), sha(generated));
  assert.equal(sha(web), sha(generated));
});

test('the tone is three short 3 kHz beeps then a pause, never a sweep', () => {
  const wav = locatorToneWav();
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(22), 1); // mono
  assert.equal(wav.readUInt32LE(24), 22050);
  assert.equal(wav.readUInt16LE(34), 16);
  const samples = (wav.length - 44) / 2;
  assert.equal(samples, Math.round(3.3 * 22050));
  const at = (seconds) => wav.readInt16LE(44 + 2 * Math.round(seconds * 22050));
  const peak = (from, to) => {
    let max = 0;
    for (let s = from; s < to; s += 1 / 22050) max = Math.max(max, Math.abs(at(s)));
    return max;
  };
  for (const start of [0, 0.7, 1.4]) assert.ok(peak(start + 0.05, start + 0.35) > 20000, `beep at ${start}`);
  for (const gap of [0.45, 1.15, 1.9, 2.5, 3.2]) assert.equal(Math.abs(at(gap)), 0, `silence at ${gap}`);
  // A quantized sample occasionally lands on exactly 0 at a true zero
  // crossing; treat it as continuing the prior sign so it is not counted
  // as two crossings instead of one.
  let crossings = 0;
  let prevSign = 1;
  for (let s = 0.05; s < 0.35; s += 1 / 22050) {
    const sign = at(s) === 0 ? prevSign : Math.sign(at(s));
    const nextRaw = at(s + 1 / 22050);
    const nextSign = nextRaw === 0 ? sign : Math.sign(nextRaw);
    if (sign !== nextSign) crossings += 1;
    prevSign = sign;
  }
  const frequency = crossings / 2 / 0.3;
  assert.ok(Math.abs(frequency - 3000) < 60, `${frequency} Hz`);
});
