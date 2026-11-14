import { validateInput } from './validate.js';
import { buildEnvelope } from './envelope.js';
import { findTempoSegments } from './segmentation.js';
import { buildSegmentBeats, deduplicateBeats } from './beats.js';
import {
  MIN_PERIODICITY,
  MIN_ACTIVE_FRAMES,
  MIN_BEATS_PER_SEGMENT,
} from './constants.js';

function processingRange(samples, envelope, sampleRate) {
  const { activeRegions, hopSize } = envelope;
  if (activeRegions.length === 0) {
    return {
      startSample: 0,
      endSample: 0,
      startSeconds: 0,
      endSeconds: 0,
      durationSeconds: 0,
    };
  }
  const first = activeRegions[0];
  const last = activeRegions[activeRegions.length - 1];
  const startSample = first[0] * hopSize;
  const endSample = Math.min(samples.length, (last[1] + 1) * hopSize);
  return {
    startSample,
    endSample,
    startSeconds: startSample / sampleRate,
    endSeconds: endSample / sampleRate,
    durationSeconds: (endSample - startSample) / sampleRate,
  };
}

export function analyzeBeatGrid(samples, sampleRate, options = {}) {
  const validation = validateInput(samples, sampleRate, options);
  if (!validation.ok) {
    return {
      ok: false,
      beats: [],
      segments: [],
      confidence: 0,
      error: validation.error,
    };
  }

  const { samples: pcm, options: bounds } = validation;
  const envelope = buildEnvelope(pcm, sampleRate);
  const range = processingRange(pcm, envelope, sampleRate);
  const baseResult = {
    ok: true,
    sampleRate,
    inputSamples: pcm.length,
    durationSeconds: pcm.length / sampleRate,
    processingRange: range,
    frame: {
      size: envelope.frameSize,
      hop: envelope.hopSize,
      hopSeconds: envelope.hopSeconds,
    },
  };

  if (
    envelope.activeFrameCount < MIN_ACTIVE_FRAMES ||
    envelope.activeRegions.length === 0
  ) {
    return {
      ...baseResult,
      detected: false,
      bpm: null,
      confidence: 0,
      beats: [],
      segments: [],
      reason: 'no-detectable-beat',
    };
  }

  const tempoSegments = findTempoSegments(
    envelope, bounds.minBpm, bounds.maxBpm,
  ).filter((segment) => segment.periodicity >= MIN_PERIODICITY);

  if (tempoSegments.length === 0) {
    return {
      ...baseResult,
      detected: false,
      bpm: null,
      confidence: 0,
      beats: [],
      segments: [],
      reason: 'no-periodic-beat',
    };
  }

  const detailedSegments = [];
  let allBeats = [];
  tempoSegments.forEach((segment) => {
    const { beats, phaseConfidence, phaseFrames } = buildSegmentBeats(
      { ...segment, id: detailedSegments.length }, envelope,
    );
    if (beats.length < MIN_BEATS_PER_SEGMENT) {
      return;
    }
    const detectedCount = beats.filter((beat) => beat.detected).length;
    const segmentId = detailedSegments.length;
    detailedSegments.push({
      id: segmentId,
      bpm: segment.bpm,
      confidence: Math.max(
        0,
        Math.min(
          1,
          0.55 * segment.periodicity + 0.45 * phaseConfidence,
        ),
      ),
      periodicity: segment.periodicity,
      phaseConfidence,
      phaseFrames,
      frameStart: segment.frameStart,
      frameEnd: segment.frameEnd,
      startSeconds: segment.frameStart * envelope.hopSeconds,
      endSeconds: segment.frameEnd * envelope.hopSeconds,
      beatCount: beats.length,
      detectedBeatCount: detectedCount,
      missingBeatCount: beats.length - detectedCount,
    });
    allBeats = allBeats.concat(
      beats.map((beat) => ({ ...beat, segmentId })),
    );
  });

  if (detailedSegments.length === 0) {
    return {
      ...baseResult,
      detected: false,
      bpm: null,
      confidence: 0,
      beats: [],
      segments: [],
      reason: 'segments-too-short',
    };
  }

  const minimumGap = 0.5 * (60 / Math.max(...detailedSegments.map((item) => item.bpm)));
  const beats = deduplicateBeats(allBeats, minimumGap);
  const totalWeight = detailedSegments.reduce(
    (sum, segment) => sum + segment.beatCount, 0,
  );
  const confidence = detailedSegments.reduce(
    (sum, segment) => sum + segment.confidence * segment.beatCount, 0,
  ) / totalWeight;

  return {
    ...baseResult,
    detected: true,
    bpm: detailedSegments[0].bpm,
    confidence,
    beats,
    segments: detailedSegments,
    reason: null,
  };
}
