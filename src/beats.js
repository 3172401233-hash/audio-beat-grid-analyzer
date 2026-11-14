import { estimatePhase, beatStrengthConfidence } from './phase.js';

function snapToLocalOnset(flux, frame, frameStart, frameEnd) {
  const radius = 2;
  const lower = Math.max(0, frame - radius);
  const upper = Math.min(flux.length - 1, frame + radius);
  let bestFrame = frame;
  let bestFlux = -Infinity;
  for (let candidate = lower; candidate <= upper; candidate++) {
    if (flux[candidate] > bestFlux) {
      bestFlux = flux[candidate];
      bestFrame = candidate;
    }
  }
  return bestFrame;
}

function hasLocalOnset(active, frame, radius = 2) {
  const lower = Math.max(0, frame - radius);
  const upper = Math.min(active.length - 1, frame + radius);
  for (let candidate = lower; candidate <= upper; candidate++) {
    if (active[candidate] === 1) {
      return true;
    }
  }
  return false;
}

export function buildSegmentBeats(segment, envelope) {
  const { flux, hopSize, hopSeconds, active, maxFlux } = envelope;
  const { frameStart, frameEnd, lagFrames } = segment;
  const { phaseFrames, phaseScore } = estimatePhase(
    flux, frameStart, frameEnd, lagFrames,
  );

  // 相位来自段内起音，可能对应第二个甚至更后的节拍；把网格锚点回退到
  // 段内第 0 个网格位置，确保段首附近的第一个节拍也被发射
  // （静音/漏拍由 detected 标记区分）。
  const gridIndexOfPhase = Math.floor((phaseFrames - frameStart) / lagFrames);
  const firstBeatFrame = phaseFrames - gridIndexOfPhase * lagFrames;
  let firstIndex = Math.ceil((frameStart - firstBeatFrame) / lagFrames);
  if (!Number.isFinite(firstIndex)) {
    firstIndex = 0;
  }

  const beats = [];
  for (let index = firstIndex; ; index++) {
    const fractionalFrame = firstBeatFrame + index * lagFrames;
    if (fractionalFrame < frameStart) {
      continue;
    }
    // 向段后延伸一个周期，覆盖落在最后一个分析窗口之后的尾拍；
    // 超出实际音频长度的位置仍会被 nominalFrame 钳制并由上层区间裁剪。
    if (fractionalFrame >= frameEnd + lagFrames) {
      break;
    }
    const nominalFrame = Math.max(
      frameStart,
      Math.min(flux.length - 1, Math.round(fractionalFrame)),
    );
    const snappedFrame = snapToLocalOnset(
      flux, nominalFrame, frameStart, frameEnd,
    );
    const frame = snappedFrame;
    const samplePosition = Math.round(frame * hopSize);
    beats.push({
      index: beats.length,
      frame,
      sample: samplePosition,
      time: frame * hopSeconds,
      strength: maxFlux > 0 ? flux[snappedFrame] / maxFlux : 0,
      detected: hasLocalOnset(active, snappedFrame),
      segmentId: segment.id,
    });
  }

  const phaseConfidence = beatStrengthConfidence(
    flux, frameStart, frameEnd, lagFrames, phaseFrames,
  );

  return {
    beats,
    phaseConfidence,
    phaseScore,
    phaseFrames,
  };
}

export function deduplicateBeats(beats, minimumGapSeconds) {
  const sorted = [...beats].sort((a, b) => a.time - b.time);
  const result = [];
  for (const beat of sorted) {
    const previous = result[result.length - 1];
    if (previous && beat.time - previous.time < minimumGapSeconds) {
      if (beat.strength > previous.strength) {
        result[result.length - 1] = beat;
      }
      continue;
    }
    result.push(beat);
  }
  return result.map((beat, index) => ({ ...beat, index }));
}
