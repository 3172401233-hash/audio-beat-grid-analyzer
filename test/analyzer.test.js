import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBeatGrid } from '../src/index.js';
import { MIN_SAMPLE_RATE } from '../src/constants.js';
import {
  SAMPLE_RATE,
  createClickTrack,
  createTwoTempoTrack,
  createNoiseTrack,
  deterministicNoiseGenerator,
  nearestBeatError,
  stableHash,
} from './helpers.js';

const BPM_TOLERANCE_RATIO = 0.02;
const TIMING_TOLERANCE_SECONDS = 0.05;

function assertExpectedBeatsCovered(result, expectedTimes, tolerance = TIMING_TOLERANCE_SECONDS) {
  assert.equal(result.detected, true);
  const matched = expectedTimes.filter(
    (time) => nearestBeatError(result.beats, time) <= tolerance,
  );
  assert.ok(
    matched.length / expectedTimes.length >= 0.95,
    `仅匹配 ${matched.length}/${expectedTimes.length} 个期望节拍`,
  );
}

test('合成 click：BPM、首个 beat 与节拍时间准确', () => {
  const track = createClickTrack({ bpm: 120, startSeconds: 1, durationSeconds: 12 });
  const result = analyzeBeatGrid(track.samples, track.sampleRate);

  assert.equal(result.ok, true);
  assert.equal(result.detected, true);
  assert.ok(Math.abs(result.bpm - 120) / 120 <= BPM_TOLERANCE_RATIO);
  assert.equal(result.beats.length > 10, true);
  assert.ok(
    Math.abs(result.beats[0].time - track.expected[0]) <= TIMING_TOLERANCE_SECONDS,
  );
  for (const expectedTime of track.expected) {
    assert.ok(nearestBeatError(result.beats, expectedTime) <= TIMING_TOLERANCE_SECONDS);
  }
  for (const beat of result.beats) {
    assert.equal(typeof beat.sample, 'number');
    assert.ok(Math.abs(beat.time - beat.sample / track.sampleRate) < 1e-9);
  }
  assert.ok(result.confidence > 0.3);
  assert.ok(result.processingRange.startSeconds >= 0.9);
});

test('带噪声 click：仍能恢复 BPM 与网格', () => {
  const track = createClickTrack({
    bpm: 100,
    startSeconds: 1.5,
    durationSeconds: 14,
    noiseLevel: 0.25,
    seed: 42,
  });
  const result = analyzeBeatGrid(track.samples, track.sampleRate);

  assert.equal(result.detected, true);
  assert.ok(Math.abs(result.bpm - 100) / 100 <= BPM_TOLERANCE_RATIO);
  assertExpectedBeatsCovered(result, track.expected);
});

test('强弱交替：弱拍不会破坏 BPM 与完整网格', () => {
  const weakBeatIndexes = new Set([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]);
  const track = createClickTrack({
    bpm: 132,
    startSeconds: 0.8,
    durationSeconds: 12,
    weakBeatIndexes,
  });
  const result = analyzeBeatGrid(track.samples, track.sampleRate);

  assert.equal(result.detected, true);
  assert.ok(Math.abs(result.bpm - 132) / 132 <= BPM_TOLERANCE_RATIO);
  assertExpectedBeatsCovered(result, track.expected);
});

test('缺失节拍：单个漏拍不会判废整段，并保留网格位置', () => {
  const omitted = new Set([6, 13]);
  const track = createClickTrack({
    bpm: 110,
    startSeconds: 1,
    durationSeconds: 14,
    omitted,
  });
  const result = analyzeBeatGrid(track.samples, track.sampleRate);

  assert.equal(result.detected, true);
  assert.ok(Math.abs(result.bpm - 110) / 110 <= BPM_TOLERANCE_RATIO);
  assertExpectedBeatsCovered(result, track.expected);
  const segment = result.segments[0];
  assert.ok(segment.missingBeatCount >= 1);
  const missingTimes = [...omitted].map(
    (index) => track.startSeconds + index * (60 / 110),
  );
  for (const missingTime of missingTimes) {
    const gridBeat = result.beats.find(
      (beat) => Math.abs(beat.time - missingTime) <= TIMING_TOLERANCE_SECONDS,
    );
    assert.ok(gridBeat, '漏拍位置仍应保留网格 beat');
    assert.equal(gridBeat.detected, false);
  }
});

test('静音前后缀：跳过静音，处理区间只覆盖有声部分', () => {
  const prefixSeconds = 3;
  const track = createClickTrack({
    bpm: 120,
    startSeconds: prefixSeconds,
    durationSeconds: 13,
  });
  const result = analyzeBeatGrid(track.samples, track.sampleRate);

  assert.equal(result.detected, true);
  assert.ok(
    Math.abs(result.processingRange.startSeconds - prefixSeconds) <= 0.1,
  );
  assert.ok(result.processingRange.endSeconds > 9);
  assert.ok(result.beats.every((beat) => beat.time >= prefixSeconds - 0.05));
  assert.ok(
    Math.abs(result.beats[0].time - track.expected[0]) <= TIMING_TOLERANCE_SECONDS,
  );
});

test('一次明显变速：识别两个速度段及各自 BPM', () => {
  const track = createTwoTempoTrack({
    firstBpm: 84,
    secondBpm: 156,
    startSeconds: 1,
    changeSeconds: 9,
    endSeconds: 17,
  });
  const result = analyzeBeatGrid(track.samples, track.sampleRate);

  assert.equal(result.detected, true);
  assert.ok(result.segments.length >= 2);
  const first = result.segments.find((segment) => segment.bpm < 110);
  const second = result.segments.find((segment) => segment.bpm > 130);
  assert.ok(first);
  assert.ok(second);
  assert.ok(Math.abs(first.bpm - 84) / 84 <= 0.03);
  assert.ok(Math.abs(second.bpm - 156) / 156 <= 0.03);
  assertExpectedBeatsCovered(result, track.expected.map((item) => item.time));
});

test('无节拍噪声与纯静音：返回明确的未检测结果', () => {
  const noise = analyzeBeatGrid(createNoiseTrack({}), SAMPLE_RATE);
  assert.equal(noise.ok, true);
  assert.equal(noise.detected, false);
  assert.equal(noise.bpm, null);
  assert.deepEqual(noise.beats, []);
  assert.ok(['no-detectable-beat', 'no-periodic-beat'].includes(noise.reason));

  const silence = analyzeBeatGrid(new Float32Array(SAMPLE_RATE * 6), SAMPLE_RATE);
  assert.equal(silence.ok, true);
  assert.equal(silence.detected, false);
  assert.equal(silence.reason, 'no-detectable-beat');
  assert.deepEqual(silence.beats, []);
});

test('确定性：相同输入多次分析结果完全一致', () => {
  const track = createClickTrack({
    bpm: 128,
    durationSeconds: 12,
    noiseLevel: 0.1,
    seed: 99,
  });
  const first = analyzeBeatGrid(track.samples, track.sampleRate);
  const second = analyzeBeatGrid(track.samples, track.sampleRate);
  assert.equal(stableHash(first), stableHash(second));
});

test('非法输入：空数据、低采样率和非法浮点均有明确错误', () => {
  const empty = analyzeBeatGrid(new Float32Array(0), SAMPLE_RATE);
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'empty-input');

  const lowRate = analyzeBeatGrid(new Float32Array(1000), MIN_SAMPLE_RATE - 1);
  assert.equal(lowRate.ok, false);
  assert.equal(lowRate.error.code, 'sample-rate-too-low');

  const invalidSamples = new Float32Array(2000);
  invalidSamples[500] = Number.NaN;
  const nanResult = analyzeBeatGrid(invalidSamples, SAMPLE_RATE);
  assert.equal(nanResult.ok, false);
  assert.equal(nanResult.error.code, 'invalid-float');
  assert.equal(nanResult.error.index, 500);

  const infiniteSamples = new Float32Array(2000);
  infiniteSamples[10] = Number.POSITIVE_INFINITY;
  const infinityResult = analyzeBeatGrid(infiniteSamples, SAMPLE_RATE);
  assert.equal(infinityResult.ok, false);
  assert.equal(infinityResult.error.code, 'invalid-float');

  const badRate = analyzeBeatGrid(new Float32Array(100), -8000);
  assert.equal(badRate.ok, false);
  assert.equal(badRate.error.code, 'invalid-sample-rate');

  const badSamples = analyzeBeatGrid(null, SAMPLE_RATE);
  assert.equal(badSamples.ok, false);
  assert.equal(badSamples.error.code, 'invalid-samples');
});

test('无任何起音的平稳直流信号不会误报节拍', () => {
  const samples = new Float32Array(SAMPLE_RATE * 6).fill(0.5);
  const result = analyzeBeatGrid(samples, SAMPLE_RATE);
  assert.equal(result.detected, false);
  assert.deepEqual(result.beats, []);
});

test('内部使用确定性随机源，合成数据本身可复现', () => {
  const randomA = deterministicNoiseGenerator(7);
  const randomB = deterministicNoiseGenerator(7);
  const valuesA = Array.from({ length: 10 }, randomA);
  const valuesB = Array.from({ length: 10 }, randomB);
  assert.deepEqual(valuesA, valuesB);
});

test('普通 JS 数组与自定义 BPM 范围同样可分析', () => {
  const track = createClickTrack({ bpm: 120, durationSeconds: 8 });
  const fromArray = analyzeBeatGrid(Array.from(track.samples), track.sampleRate);
  assert.equal(fromArray.detected, true);
  assert.ok(Math.abs(fromArray.bpm - 120) / 120 <= BPM_TOLERANCE_RATIO);

  const bounded = analyzeBeatGrid(track.samples, track.sampleRate, {
    minBpm: 100,
    maxBpm: 140,
  });
  assert.equal(bounded.detected, true);
  assert.ok(Math.abs(bounded.bpm - 120) / 120 <= BPM_TOLERANCE_RATIO);

  const processing = bounded.processingRange;
  assert.equal(
    Math.abs(processing.endSeconds - processing.startSeconds - processing.durationSeconds) < 1e-9,
    true,
  );
  assert.ok(processing.startSample >= 0);
  assert.ok(processing.endSample <= track.samples.length);
});

test('每个结果 beat 同时给出采样位置、秒数、强度与检测标记', () => {
  const track = createClickTrack({ bpm: 120, durationSeconds: 8 });
  const result = analyzeBeatGrid(track.samples, track.sampleRate);
  for (const beat of result.beats) {
    assert.equal(Number.isInteger(beat.sample), true);
    assert.equal(typeof beat.time, 'number');
    assert.equal(typeof beat.strength, 'number');
    assert.equal(typeof beat.detected, 'boolean');
    assert.equal(typeof beat.segmentId, 'number');
    assert.ok(beat.sample >= 0 && beat.sample < track.samples.length);
  }
});
