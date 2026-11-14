# audio-beat-grid-analyzer

纯 Node.js 的**离线**节拍网格分析库。输入 mono PCM（float32 采样 + 采样率），
在本地完成短时能量与起音强度包络计算、BPM/周期估计、相位对齐和变速分段，
输出可直接用于动画对齐的节拍时间。库本身不播放、不解码音频，也没有任何第三方依赖。

## 快速开始

```js
import { analyzeBeatGrid } from 'audio-beat-grid-analyzer';

const result = analyzeBeatGrid(float32Samples, 44100);
if (!result.ok) {
  // result.error.code：empty-input / sample-rate-too-low / invalid-float / ...
  throw new Error(result.error.message);
}
if (!result.detected) {
  // result.reason：no-detectable-beat / no-periodic-beat / segments-too-short
  console.log('未检测到稳定节拍', result.reason);
} else {
  for (const beat of result.beats) {
    animationTimeline.addMarker(beat.time, beat.sample);
  }
}
```

也支持普通 `Array<number>` 与 `Float32Array`；可选第三参数 `{ minBpm, maxBpm }`，
默认搜索范围为 60–200 BPM（内部允许 20–400 BPM）。

## 处理流水线

1. **输入校验**：空输入、低于 `MIN_SAMPLE_RATE`（2000 Hz）的采样率、
   `NaN`/`Infinity` 等非法浮点直接返回结构化错误，不抛异常。
2. **分帧能量**：帧长约 25 ms、帧移约 10 ms（最低采样率下限为 64 采样），
   用滑动平方和计算每帧均方能量。
3. **起音强度包络（flux）**：取相邻帧能量差的正向部分，得到只在能量上升沿
   响应的起音强度序列，天然抑制持续音和释放段。
4. **静音跳过**：按能量/flux 自适应阈值标记 active 帧，合并间距小于 2 s 的
   活跃区间，前后静音不参与分析，处理区间只覆盖有声部分。
5. **周期估计**：在 BPM 范围对应的 lag 区间计算归一化自相关（Pearson 系数），
   峰值做抛物线插值得到亚帧精度的周期；再用**起音峰值命中率**做 1/2、1/3 倍频
   裁决并迭代收敛，解决强弱交替导致的 BPM 腰斩问题。
6. **变速分段**：8 s 窗口、4 s 步长滑动估计局部 BPM，用中位数迟滞（阈值 15%）
   聚类，要求连续两个窗口偏离才确认变速点，单个错拍不会产生虚假分段；
   段 BPM 取窗口中位数，并在其 ±15% 邻域内重估亚帧 lag。
7. **相位与网格**：在每个速度段内枚举起音峰值帧作为相位候选，按命中率优先、
   平分取最早的规则确定全局相位，然后按 `phase + k * period` 发射完整网格；
   每个 beat 吸附到 ±2 帧内最近的 flux 峰值。
8. **漏拍标记**：网格位置附近（±2 帧）没有 active 起音时仍保留该 beat，
   但 `detected: false`，并计入段级 `missingBeatCount`，不会因单个漏拍判废整段。

## 输出结构

检测成功时（`ok: true, detected: true`）：

```ts
{
  ok: true,
  detected: true,
  bpm: number,                 // 第一个速度段的 BPM（多段时看 segments）
  confidence: number,          // 0..1，按各段 beat 数加权
  sampleRate: number,
  inputSamples: number,
  durationSeconds: number,
  processingRange: {
    startSample: number, endSample: number,
    startSeconds: number, endSeconds: number, durationSeconds: number,
  },
  frame: { size: number, hop: number, hopSeconds: number },
  beats: Array<{
    index: number,
    frame: number,            // 吸附后的帧位置
    sample: number,           // 采样位置（整数）
    time: number,             // 秒
    strength: number,         // 归一化起音强度 0..1
    detected: boolean,        // false 表示网格位置缺少真实起音（疑似漏拍）
    segmentId: number,
  }>,
  segments: Array<{
    id: number,
    bpm: number,
    confidence: number,       // 0.55 * 周期性 + 0.45 * 相位置信度
    periodicity: number,      // 自相关峰值 0..1
    phaseConfidence: number,  // 正拍/反拍起音对比 0..1
    phaseFrames: number,
    startSeconds: number, endSeconds: number,
    beatCount: number, detectedBeatCount: number, missingBeatCount: number,
  }>,
  reason: null,
}
```

无可检测节拍时返回 `ok: true, detected: false, bpm: null, beats: []`，
并通过 `reason` 区分原因；输入非法时返回 `ok: false` 与 `error.code`：
`invalid-samples`、`invalid-sample-rate`、`sample-rate-too-low`、
`empty-input`、`invalid-float`（附带 `index`）。

## 算法假设与允许误差

下列假设来自当前基于能量起音 + 自相关的设计，合成数据测试（见 `test/`）在此范围内成立：

- 信号为**单声道** PCM，节拍表现为能量上升沿；采样率 ≥ 2000 Hz。
- 真实速度落在配置的 BPM 范围内（默认 60–200），一首曲目内**至多一次明显变速**，
  且每个速度段至少包含约 4 个节拍、持续约 3 s 以上。
- 允许弱拍、个别漏拍和前后静音；漏拍通过 `detected: false` 标记而非删除网格点。
- 连续渐变（ritardando/accelerando）、摇摆/shuffle 等非等距网格不在当前模型内。
- 允许误差（合成 click 测试断言）：
  - BPM 相对误差 ≤ 2%（变速段放宽到 3%）。
  - 单个 beat 时间误差 ≤ 50 ms；采样率 ≥ 4 kHz 时实测多为 20–30 ms（约 2–3 个帧移），
    最低采样率 2000 Hz 时帧移 32 ms，误差上限约 60 ms。
  - 期望节拍覆盖率 ≥ 95%，相同输入多次运行结果完全一致（无随机环节）。

## 测试

测试使用合成信号（确定性 LCG 噪声，无外部音频文件），覆盖：纯净 click、
带噪声 click、强弱交替、缺失节拍、静音前后缀、一次变速、无节拍噪声/静音/直流、
确定性以及全部非法输入分支。

```bash
npm test        # 等价于 node --test
```
