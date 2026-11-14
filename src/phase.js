function findOnsetFrames(flux, frameStart, frameEnd, maxFlux) {
  const threshold = Math.max(maxFlux * 0.03, 1e-12);
  const frames = [];
  for (let frame = Math.max(1, frameStart); frame < Math.min(flux.length - 1, frameEnd); frame++) {
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

function circularDistance(frame, phase, lag) {
  const distance = Math.abs(((frame - phase) % lag + lag) % lag);
  return Math.min(distance, lag - distance);
}

export function estimatePhase(flux, frameStart, frameEnd, lagFrames) {
  const lag = Math.max(1, Math.round(lagFrames));
  let localMaxFlux = 0;
  for (let frame = frameStart; frame < frameEnd; frame++) {
    if (flux[frame] > localMaxFlux) {
      localMaxFlux = flux[frame];
    }
  }
  const onsets = findOnsetFrames(flux, frameStart, frameEnd, localMaxFlux);
  if (onsets.length === 0) {
    return { phaseFrames: frameStart, phaseScore: 0 };
  }

  const tolerance = Math.max(2, Math.round(lag * 0.1));
  let bestPhase = onsets[0];
  let bestHits = 0;
  let bestWeighted = 0;

  for (const candidate of onsets) {
    let weightedHits = 0;
    let hits = 0;
    for (const onset of onsets) {
      const distance = circularDistance(onset, candidate, lag);
      if (distance <= tolerance) {
        weightedHits += flux[onset] * (1 - distance / (tolerance + 1));
        hits++;
      }
    }
    // 同相候选覆盖的起音集合相同（命中率一致），加权能量只会偏向
    // 段中部候选（边界网格位置天然命中更少），因此命中率相同时
    // 一律取最早候选，避免相位漂到曲目中部导致首拍被吞。
    const betterCoverage =
      hits > bestHits ||
      (hits === bestHits && candidate < bestPhase);
    if (betterCoverage) {
      bestPhase = candidate;
      bestHits = hits;
      bestWeighted = weightedHits;
    }
  }

  return {
    phaseFrames: bestPhase,
    phaseScore: bestWeighted,
    onsetCount: onsets.length,
    hitCount: bestHits,
  };
}

export function beatStrengthConfidence(flux, frameStart, frameEnd, lagFrames, phaseFrames) {
  const baseLag = Math.max(1, Math.round(lagFrames));
  let onBeat = 0;
  let offBeat = 0;
  let onCount = 0;
  let offCount = 0;
  const relativePhase = ((phaseFrames - frameStart) % baseLag + baseLag) % baseLag;
  const opposite = (relativePhase + baseLag / 2) % baseLag;

  for (let frame = frameStart; frame < frameEnd; frame++) {
    const position = (frame - frameStart) % baseLag;
    if (position === Math.round(relativePhase)) {
      onBeat += flux[frame];
      onCount++;
    } else if (position === Math.round(opposite)) {
      offBeat += flux[frame];
      offCount++;
    }
  }

  const onAverage = onCount ? onBeat / onCount : 0;
  const offAverage = offCount ? offBeat / offCount : 0;
  const ratio = onAverage + offAverage > 0
    ? (onAverage - offAverage) / (onAverage + offAverage)
    : 0;
  return Math.max(0, Math.min(1, ratio));
}
