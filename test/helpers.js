import { createHash } from 'node:crypto';

export const SAMPLE_RATE = 8000;
export const CLICK_SECONDS = 0.02;

export function deterministicNoiseGenerator(seed = 1234567) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

export function addClick(samples, sampleRate, timeSeconds, amplitude = 1) {
  const center = Math.round(timeSeconds * sampleRate);
  const width = Math.max(2, Math.round(CLICK_SECONDS * sampleRate));
  for (let offset = -width; offset <= width; offset++) {
    const index = center + offset;
    if (index < 0 || index >= samples.length) {
      continue;
    }
    const envelope = Math.exp(-Math.abs(offset) / (width / 2));
    samples[index] += amplitude * envelope;
  }
}

export function beatTimes(bpm, startSeconds, endSeconds, omitted = new Set()) {
  const period = 60 / bpm;
  const times = [];
  let index = 0;
  for (let time = startSeconds; time <= endSeconds + 1e-9; time = startSeconds + period * (++index)) {
    if (!omitted.has(index)) {
      times.push(time);
    }
  }
  return times;
}

export function createClickTrack({
  sampleRate = SAMPLE_RATE,
  bpm = 120,
  startSeconds = 1,
  durationSeconds = 10,
  omitted = new Set(),
  weakFactor = 0.45,
  weakBeatIndexes = new Set(),
  noiseLevel = 0,
  seed = 1234567,
}) {
  const samples = new Float32Array(Math.round(durationSeconds * sampleRate));
  const random = deterministicNoiseGenerator(seed);
  if (noiseLevel > 0) {
    for (let i = 0; i < samples.length; i++) {
      samples[i] = (random() * 2 - 1) * noiseLevel;
    }
  }

  const expected = beatTimes(bpm, startSeconds, durationSeconds - 0.05, omitted);
  const period = 60 / bpm;
  for (let index = 0; ; index++) {
    const time = startSeconds + period * index;
    if (time > durationSeconds - 0.05) {
      break;
    }
    if (omitted.has(index)) {
      continue;
    }
    const amplitude = weakBeatIndexes.has(index) ? weakFactor : 1;
    addClick(samples, sampleRate, time, amplitude);
  }
  return {
    samples,
    expected,
    sampleRate,
    bpm,
    period,
    startSeconds,
    durationSeconds,
  };
}

export function createTwoTempoTrack({
  sampleRate = SAMPLE_RATE,
  firstBpm = 90,
  secondBpm = 150,
  startSeconds = 1,
  changeSeconds = 9,
  endSeconds = 17,
}) {
  const samples = new Float32Array(Math.round(endSeconds * sampleRate));
  const expected = [];
  let time = startSeconds;
  while (time < changeSeconds - 0.02) {
    addClick(samples, sampleRate, time, 1);
    expected.push({ time, bpm: firstBpm });
    time += 60 / firstBpm;
  }
  time = changeSeconds;
  while (time <= endSeconds - 0.05) {
    addClick(samples, sampleRate, time, 1);
    expected.push({ time, bpm: secondBpm });
    time += 60 / secondBpm;
  }
  return {
    samples,
    expected,
    sampleRate,
    firstBpm,
    secondBpm,
    changeSeconds,
  };
}

export function createNoiseTrack({
  sampleRate = SAMPLE_RATE,
  durationSeconds = 8,
  level = 0.2,
  seed = 777,
}) {
  const samples = new Float32Array(durationSeconds * sampleRate);
  const random = deterministicNoiseGenerator(seed);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (random() * 2 - 1) * level;
  }
  return samples;
}

export function nearestBeatError(beats, expectedTime) {
  let error = Infinity;
  for (const beat of beats) {
    error = Math.min(error, Math.abs(beat.time - expectedTime));
  }
  return error;
}

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
