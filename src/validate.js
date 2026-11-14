import {
  MIN_SAMPLE_RATE,
  DEFAULT_MIN_BPM,
  DEFAULT_MAX_BPM,
} from './constants.js';

function failure(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}

function isPositiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function validateInput(samples, sampleRate, options = {}) {
  if (
    samples === null ||
    samples === undefined ||
    typeof samples !== 'object' ||
    typeof samples.length !== 'number' ||
    !Number.isInteger(samples.length) ||
    samples.length < 0
  ) {
    return failure('invalid-samples', 'samples 必须是数组或类型化数组，且带有整数 length');
  }

  if (!isPositiveFiniteNumber(sampleRate)) {
    return failure('invalid-sample-rate', 'sampleRate 必须是正的有限数值');
  }
  if (sampleRate < MIN_SAMPLE_RATE) {
    return failure(
      'sample-rate-too-low',
      `sampleRate 不能低于 ${MIN_SAMPLE_RATE} Hz`,
      { sampleRate, minimumSampleRate: MIN_SAMPLE_RATE },
    );
  }
  if (samples.length === 0) {
    return failure('empty-input', 'samples 为空，无法分析节拍');
  }

  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return failure(
        'invalid-float',
        `第 ${i} 个采样不是有限浮点数（NaN/Infinity 均非法）`,
        { index: i, value },
      );
    }
  }

  let minBpm = isPositiveFiniteNumber(options.minBpm) ? options.minBpm : DEFAULT_MIN_BPM;
  let maxBpm = isPositiveFiniteNumber(options.maxBpm) ? options.maxBpm : DEFAULT_MAX_BPM;
  minBpm = Math.min(Math.max(minBpm, 20), 300);
  maxBpm = Math.min(Math.max(maxBpm, 20), 400);
  if (minBpm > maxBpm) {
    const swapped = minBpm;
    minBpm = maxBpm;
    maxBpm = swapped;
  }

  const normalized = samples instanceof Float32Array
    ? samples
    : Float32Array.from(samples);

  return { ok: true, samples: normalized, options: { minBpm, maxBpm } };
}
