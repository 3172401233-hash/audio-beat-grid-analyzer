function periodicityAt(flux, start, end, lag, mean) {
  let numerator = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let frame = start; frame < end - lag; frame++) {
    const a = flux[frame] - mean;
    const b = flux[frame + lag] - mean;
    numerator += a * b;
    varianceA += a * a;
    varianceB += b * b;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 0 ? numerator / denominator : 0;
}

function onsetFrames(flux, start, end, maxFlux) {
  const threshold = Math.max(maxFlux * 0.03, 1e-12);
  const frames = [];
  for (let frame = Math.max(start + 1, 1); frame < end - 1; frame++) {
    if (
      flux[frame] >= threshold &&
      flux[frame] > flux[frame - 1] &&
      flux[frame] >= flux[frame + 1]
    ) {
      frames.push(frame);
    }
  }
  return frames;
}

function bestOnsetHitRate(onsets, start, lag) {
  if (onsets.length === 0) {
    return 0;
  }
  let best = 0;
  const tolerance = Math.max(2, Math.round(lag * 0.08));
  for (let offset = 0; offset < lag; offset++) {
    let hits = 0;
    for (const frame of onsets) {
      const distance = Math.abs(((frame - start - offset) % lag + lag) % lag);
      const wrapped = Math.min(distance, lag - distance);
      if (wrapped <= tolerance) {
        hits++;
      }
    }
    best = Math.max(best, hits / onsets.length);
  }
  return best;
}

function subFramePeak(flux, start, end, lag, mean, minLag, maxLag) {
  const left = lag > minLag ? periodicityAt(flux, start, end, lag - 1, mean) : 0;
  const center = periodicityAt(flux, start, end, lag, mean);
  const right = lag < maxLag ? periodicityAt(flux, start, end, lag + 1, mean) : 0;
  const denominator = left - 2 * center + right;
  const offset = denominator !== 0 ? 0.5 * (left - right) / denominator : 0;
  const clamped = Math.max(-1, Math.min(1, offset));
  return {
    lagFrames: lag + clamped,
    score: center,
  };
}

export function estimateLag(flux, frameStart, frameEnd, hopSeconds, minBpm, maxBpm) {
  const span = frameEnd - frameStart;
  const minLag = Math.max(2, Math.floor(60 / (maxBpm * hopSeconds)));
  const maxLag = Math.min(span - 2, Math.ceil(60 / (minBpm * hopSeconds)));
  if (maxLag < minLag) {
    return null;
  }

  let sum = 0;
  for (let frame = frameStart; frame < frameEnd; frame++) {
    sum += flux[frame];
  }
  const mean = sum / span;

  const scores = new Float64Array(maxLag - minLag + 1);
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const score = periodicityAt(flux, frameStart, frameEnd, lag, mean);
    scores[lag - minLag] = score;
    if (score > bestScore + 0.01) {
      bestScore = score;
      bestLag = lag;
    } else if (score > bestScore && lag < bestLag) {
      bestLag = lag;
    }
  }

  // 强弱交替会让二倍/三倍周期的 Pearson 自相关得分更高，导致 BPM 被腰斩。
  // 自相关衡量“相似”，而节拍网格只要求该位置有起音；因此用起音峰值命中率
  // 在 1/2、1/3 倍 lag 之间做归一化的倍频裁决。
  let localMaxFlux = 0;
  for (let frame = frameStart; frame < frameEnd; frame++) {
    if (flux[frame] > localMaxFlux) {
      localMaxFlux = flux[frame];
    }
  }
  const onsets = onsetFrames(flux, frameStart, frameEnd, localMaxFlux);
  // 迭代收敛：强弱交替可能把真实周期放大 2 倍甚至 3 倍（91→45→30）。
  let changed = true;
  while (changed) {
    changed = false;
    const bestHitRate = bestOnsetHitRate(onsets, frameStart, bestLag);
    for (const divisor of [2, 3]) {
      const shorterLag = Math.round(bestLag / divisor);
      if (shorterLag >= minLag && shorterLag < bestLag) {
        const shorterHitRate = bestOnsetHitRate(onsets, frameStart, shorterLag);
        if (shorterHitRate >= bestHitRate + 0.05) {
          bestLag = shorterLag;
          bestScore = scores[bestLag - minLag];
          changed = true;
          break;
        }
      }
    }
  }

  const peak = subFramePeak(
    flux, frameStart, frameEnd, bestLag, mean, minLag, maxLag,
  );
  const bpm = 60 / (peak.lagFrames * hopSeconds);
  return {
    bpm,
    lagFrames: peak.lagFrames,
    periodicity: Math.max(0, Math.min(1, peak.score)),
  };
}
