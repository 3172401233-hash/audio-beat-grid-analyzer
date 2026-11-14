import {
  WINDOW_SECONDS,
  WINDOW_HOP_SECONDS,
  TEMPO_CHANGE_RATIO,
  MIN_ACTIVE_FRAMES,
} from './constants.js';
import { estimateLag } from './periodicity.js';

function buildWindows(envelope, minBpm, maxBpm) {
  const { activeRegions, hopSeconds, flux } = envelope;
  const windowFrames = Math.round(WINDOW_SECONDS / hopSeconds);
  const hopFrames = Math.round(WINDOW_HOP_SECONDS / hopSeconds);
  const windows = [];

  for (const [regionStart, regionEnd] of activeRegions) {
    const regionLength = regionEnd - regionStart + 1;
    if (regionLength < MIN_ACTIVE_FRAMES) {
      continue;
    }
    if (regionLength <= windowFrames) {
      windows.push({ start: regionStart, end: regionEnd + 1 });
      continue;
    }
    for (let start = regionStart; start < regionEnd; start += hopFrames) {
      const end = Math.min(start + windowFrames, regionEnd + 1);
      windows.push({ start, end });
      if (end === regionEnd + 1) {
        break;
      }
    }
  }

  return windows
    .map((window) => ({
      ...window,
      estimate: estimateLag(
        flux, window.start, window.end, hopSeconds, minBpm, maxBpm,
      ),
    }))
    .filter((window) => window.estimate);
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clusterWindows(windows) {
  const clusters = [];
  let current = [windows[0]];

  for (let index = 1; index < windows.length; index++) {
    const window = windows[index];
    const reference = median(current.map((item) => item.estimate.bpm));
    const relativeDifference = Math.abs(window.estimate.bpm - reference) / reference;
    if (relativeDifference <= TEMPO_CHANGE_RATIO) {
      current.push(window);
      continue;
    }

    // 要求连续两个窗口都偏离，避免单个错窗造成虚假变速点。
    const next = windows[index + 1];
    if (next) {
      const nextDifference = Math.abs(next.estimate.bpm - reference) / reference;
      if (nextDifference <= TEMPO_CHANGE_RATIO) {
        current.push(window);
        continue;
      }
    }
    clusters.push(current);
    current = [window];
  }
  clusters.push(current);

  return clusters;
}

export function findTempoSegments(envelope, minBpm, maxBpm) {
  const windows = buildWindows(envelope, minBpm, maxBpm);
  if (windows.length === 0) {
    return [];
  }

  const clusters = clusterWindows(windows);
  const segments = [];

  for (const cluster of clusters) {
    const start = cluster[0].start;
    const end = cluster[cluster.length - 1].end;
    const windowBpm = median(cluster.map((item) => item.estimate.bpm));
    const windowPeriodicity = median(
      cluster.map((item) => item.estimate.periodicity),
    );
    // 段边界附近的窗口横跨两种速度，直接对整段做自相关会被混合区间污染。
    // 因此以窗口 BPM 中位数锁定速度，再在该速度 ±15% 邻域内重估 lag，
    // 既保留亚帧精度，又不会被混合窗口拖回错误倍频。
    const estimate = estimateLag(
      envelope.flux,
      start,
      end,
      envelope.hopSeconds,
      windowBpm * 0.85,
      windowBpm * 1.15,
    );
    if (!estimate || estimate.periodicity <= 0) {
      continue;
    }
    segments.push({
      frameStart: start,
      frameEnd: end,
      bpm: windowBpm,
      lagFrames: estimate.lagFrames,
      periodicity: Math.max(estimate.periodicity, windowPeriodicity),
      windowBpm,
      windowCount: cluster.length,
    });
  }

  return segments;
}
