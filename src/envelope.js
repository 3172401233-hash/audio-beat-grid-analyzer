import { TARGET_HOP_MS, FRAME_MS, REGION_GAP_MS } from './constants.js';

function computeFrameParams(sampleRate) {
  let hopSize = Math.round((TARGET_HOP_MS / 1000) * sampleRate);
  hopSize = Math.max(64, hopSize);
  let frameSize = Math.round((FRAME_MS / 1000) * sampleRate);
  frameSize = Math.max(hopSize * 2, frameSize);
  return { frameSize, hopSize };
}

function computeEnergies(samples, frameSize, hopSize) {
  const frameCount = Math.max(1, Math.floor((samples.length - frameSize) / hopSize) + 1);
  const energies = new Float64Array(frameCount);
  let sumSquares = 0;
  for (let i = 0; i < frameSize; i++) {
    sumSquares += samples[i] * samples[i];
  }
  energies[0] = sumSquares / frameSize;
  for (let frame = 1; frame < frameCount; frame++) {
    const start = frame * hopSize;
    const previousStart = start - hopSize;
    for (let i = previousStart; i < start; i++) {
      sumSquares -= samples[i] * samples[i];
    }
    for (let i = start + frameSize - hopSize; i < start + frameSize; i++) {
      sumSquares += samples[i] * samples[i];
    }
    energies[frame] = sumSquares / frameSize;
  }
  return energies;
}

function computeFlux(energies) {
  const flux = new Float64Array(energies.length);
  let maxFlux = 0;
  for (let frame = 1; frame < energies.length; frame++) {
    const value = energies[frame] - energies[frame - 1];
    if (value > 0) {
      flux[frame] = value;
      if (value > maxFlux) {
        maxFlux = value;
      }
    }
  }
  return { flux, maxFlux };
}

function findActiveRegions(energies, flux, hopSeconds, energyFloor, fluxFloor) {
  const active = new Uint8Array(flux.length);
  for (let frame = 0; frame < flux.length; frame++) {
    active[frame] = (energies[frame] > energyFloor && flux[frame] >= fluxFloor) ? 1 : 0;
  }

  const gapFrames = Math.max(1, Math.round((REGION_GAP_MS / 1000) / hopSeconds));
  const runs = [];
  let runStart = -1;
  for (let frame = 0; frame < active.length; frame++) {
    if (active[frame] && runStart < 0) {
      runStart = frame;
    } else if (!active[frame] && runStart >= 0) {
      runs.push([runStart, frame - 1]);
      runStart = -1;
    }
  }
  if (runStart >= 0) {
    runs.push([runStart, active.length - 1]);
  }

  let regions = [];
  for (const run of runs) {
    if (regions.length && run[0] - regions[regions.length - 1][1] <= gapFrames) {
      regions[regions.length - 1][1] = run[1];
    } else {
      regions.push([run[0], run[1]]);
    }
  }
  // 起音的能量爬升可能跨越帧边界，导致首个起音帧落在区域外。
  regions = regions.map(([start, end]) => [
    Math.max(0, start - 1),
    Math.min(flux.length - 1, end),
  ]);
  return { active, regions };
}

export function buildEnvelope(samples, sampleRate) {
  const { frameSize, hopSize } = computeFrameParams(sampleRate);
  const hopSeconds = hopSize / sampleRate;
  const energies = computeEnergies(samples, frameSize, hopSize);
  const { flux, maxFlux } = computeFlux(energies);

  let energySum = 0;
  for (let frame = 0; frame < energies.length; frame++) {
    energySum += energies[frame];
  }
  const meanEnergy = energySum / energies.length;

  let fluxSum = 0;
  for (let frame = 0; frame < flux.length; frame++) {
    fluxSum += flux[frame];
  }
  const meanFlux = fluxSum / flux.length;
  const energyFloor = Math.max(1e-10, meanEnergy * 0.05);
  const fluxFloor = Math.max(1e-12, maxFlux * 0.06, meanFlux * 0.15);

  const { active, regions } = findActiveRegions(
    energies, flux, hopSeconds, energyFloor, fluxFloor,
  );

  let activeFrameCount = 0;
  for (let frame = 0; frame < active.length; frame++) {
    activeFrameCount += active[frame];
  }

  return {
    frameSize,
    hopSize,
    hopSeconds,
    energies,
    flux,
    maxFlux,
    active,
    activeRegions: regions,
    activeFrameCount,
  };
}
