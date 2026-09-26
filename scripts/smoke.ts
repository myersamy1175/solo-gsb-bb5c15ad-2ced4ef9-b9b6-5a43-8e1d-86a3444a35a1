import { parseSrt, serializeSrt, secondsToSrtTime, srtTimeToSeconds } from '../src/lib/srt';
import { validateEdge, applyEdge, initHistory, commitHistory, undoHistory, redoHistory } from '../src/lib/cues';
import {
  analyzeChannels,
  computeWindowLevels,
  detectSilences,
  MERGE_GAP,
  MIN_SILENCE_DURATION,
  nearestSilenceEdge,
  resolveEdgeCandidate,
  SNAP_RADIUS,
  WINDOW_SIZE
} from '../src/lib/silence';
import {
  computeLoopRange,
  DEFAULT_LOOP_MARGINS,
  loopDisableReason,
  loopDisableText,
  loopEntryTarget,
  loopWrapTarget,
  MIN_LOOP_LENGTH
} from '../src/lib/abLoop';
import {
  SHADOW_DRIFT_LIMIT,
  clampRelative,
  describeGetUserMediaError,
  hasRecordingSupport,
  needsDriftCorrection,
  pickRecorderMimeType,
  trackDrift
} from '../src/lib/shadow';
import {
  buildDriftPlan,
  parseTimeInput,
  resolveDriftRange,
  secondsToInputTime
} from '../src/lib/drift';
import {
  SESSION_SCHEMA_VERSION,
  buildSessionState,
  resolveWriteRevision,
  validateAudioFingerprint,
  validateCueShape,
  validateSessionState,
  validateStoredRecord
} from '../src/lib/session';
import { fingerprintsMatch, formatBytes } from '../src/lib/fingerprint';
import {
  deleteSession,
  getSession,
  listRecoverableSessions,
  putSession,
  randomSessionId,
  SESSION_DB_NAME
} from '../src/lib/sessionStore';

// smoke 在 Node 下运行：用 fake-indexeddb 提供 indexedDB 全局
import 'fake-indexeddb/auto';

let fail = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) {
    fail++;
    console.error('❌', msg);
  } else {
    console.log('✅', msg);
  }
}

// 1. 时间格式往返
assert(secondsToSrtTime(0) === '00:00:00,000', '0 序列化');
assert(secondsToSrtTime(3661.5) === '01:01:01,500', '3661.5 序列化');
assert(srtTimeToSeconds('00:00:01,500') === 1.5, '逗号毫秒解析');
assert(srtTimeToSeconds('00:00:01.5') === 1.5, '点毫秒解析（容错）');

// 2. 解析含 BOM / CRLF / 缺序号的 SRT
const srt = '﻿1\r\n00:00:01,000 --> 00:00:03,000\r\n你好\r\n\r\n' +
  '00:00:04.000 --> 00:00:06,500\r\n第二行\r\n第二行续\r\n\r\n' +
  'bad block\r\n\r\n' +
  '3\r\n00:00:10,000 --> 00:00:09,000\r\n逆序应跳过\r\n';
const { cues, warnings } = parseSrt(srt);
assert(cues.length === 2, `解析出 2 条（实际 ${cues.length}）`);
assert(warnings.length === 2, `产生 2 条告警（实际 ${warnings.length}）`);
assert(cues[0].text === '你好', '第一条文本');
assert(cues[1].start === 4 && cues[1].end === 6.5, '点分隔第二块');

// 3. 导出保持时间顺序且重新连续编号
cues[0].start = 100; // 打乱顺序后导出
const out = serializeSrt(cues);
const nums = [...out.matchAll(/^(\d+)$/gm)].map((m) => Number(m[1]));
assert(JSON.stringify(nums) === '[1,2]', `导出编号连续 1,2（实际 ${JSON.stringify(nums)}）`);
assert(out.startsWith('1\n00:00:04,000'), '导出按时间升序，最早者编号 1');

// 4. 约束校验
const C = { minDuration: 0.5, minGap: 0.1 };
let r = validateEdge(cues, cues[0].id, 'start', -1, C);
assert(!r.ok && r.message.includes('00:00'), '左边界越过 0 被拒绝');
const base = [
  { id: 'a', start: 1, end: 2, text: 'a' },
  { id: 'b', start: 3, end: 4, text: 'b' }
];
r = validateEdge(base, 'a', 'end', 2.95, C);
assert(!r.ok && r.message.includes('间隔'), `间隔 0.05 < 0.1 被拒绝：${r.ok ? '' : r.message}`);
r = validateEdge(base, 'a', 'end', 3.2, C);
assert(!r.ok && r.message.includes('重叠'), `重叠被拒绝：${r.ok ? '' : r.message}`);
r = validateEdge(base, 'a', 'end', 1.4, C);
assert(!r.ok && r.message.includes('短于最短时长'), '时长不足被拒绝');
r = validateEdge(base, 'a', 'end', 2.9, C);
assert(r.ok, '间隔恰好 0.1 合法');
r = validateEdge(base, 'b', 'start', 2.1, C);
assert(r.ok, '右块左边界贴到 2.1 合法');
r = validateEdge(base, 'b', 'start', 2.05, C);
assert(!r.ok, '右块左边界间隔不足被拒绝');

// 5. 应用变更 & 撤销重做
let h = initHistory(base);
const next = applyEdge(base, 'a', 'end', 2.5);
h = commitHistory(h, next);
assert(h.present[0].end === 2.5 && h.past.length === 1, '提交边界调整');
h = undoHistory(h);
assert(h.present[0].end === 2 && h.future.length === 1, '撤销恢复');
h = redoHistory(h);
assert(h.present[0].end === 2.5, '重做再次应用');
h = commitHistory(h, applyEdge(h.present, 'a', 'end', 2.8));
assert(h.future.length === 0, '新提交清空 redo 栈');

// 6. 静音检测：窗口 RMS（各声道取最大）
function tone(samples: number, v: number): Float32Array {
  return new Float32Array(samples).fill(v);
}
// 1s 单声道：0~0.3s 有声(0.5)，0.3~0.6s 静音，0.6~1.0s 有声(0.3)
{
  const sr = 1000;
  const ch = new Float32Array(sr);
  ch.fill(0.3, 0, sr);
  ch.fill(0.5, 0, 300);
  ch.fill(0, 300, 600);
  const win = computeWindowLevels([ch], sr);
  assert(win.windowSize === WINDOW_SIZE, `窗口为 ${WINDOW_SIZE}s`);
  assert(win.levels.length === 50, `1s / 20ms = 50 窗口（实际 ${win.levels.length}）`);
  assert(win.levels[0] === 0.5, '有声窗口 RMS=0.5');
  assert(win.levels[20] === 0, '静音窗口 RMS=0');
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 1, `检测出 1 段静音（实际 ${segs.length}）`);
  assert(segs[0].start === 0.3 && segs[0].end === 0.6, `静音段 0.3~0.6（实际 ${segs[0].start}~${segs[0].end}）`);
}

// 7. 各声道取最大值：一声道静音、另一声道有声 => 窗口不判静音
{
  const sr = 1000;
  const silent = new Float32Array(sr); // 全 0
  const loud = new Float32Array(sr).fill(0.2);
  const win = computeWindowLevels([silent, loud], sr);
  assert(Math.abs(win.levels[10] - 0.2) < 1e-6, '双声道取 RMS 最大值 0.2');
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 0, '任一非静音声道则整窗口非静音');
}

// 8. 短于 200ms 的静音不成段；恰好 200ms 合法
{
  const sr = 1000;
  const ch = new Float32Array(sr).fill(0.2);
  ch.fill(0, 100, 250); // 150ms 静音
  ch.fill(0, 400, 600); // 200ms 静音
  const win = computeWindowLevels([ch], sr);
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 1, `仅 200ms 段保留（实际 ${segs.length} 段）`);
  assert(segs[0].start === 0.4 && segs[0].end === 0.6, `保留 0.4~0.6 段（实际 ${segs[0].start}~${segs[0].end}）`);
  assert(MIN_SILENCE_DURATION === 0.2, '最短静音默认 200ms');
}

// 9. 间隔不足 80ms 的两段先合并；恰好 80ms 不合并
{
  const sr = 1000;
  const ch = new Float32Array(sr).fill(0.2);
  ch.fill(0, 0, 200); // 200ms
  ch.fill(0, 260, 460); // 间隔 60ms，应合并
  ch.fill(0, 540, 740); // 与上段间隔恰好 80ms，不合并
  const win = computeWindowLevels([ch], sr);
  const segs = detectSilences(win, { threshold: 0.01 });
  assert(segs.length === 2, `合并后 2 段（实际 ${segs.length}）`);
  assert(segs[0].start === 0 && segs[0].end === 0.46, `60ms 间隔被合并为 0~0.46（实际 0~${segs[0].end}）`);
  assert(segs[1].start === 0.54 && segs[1].end === 0.74, '80ms 间隔不合并');
  assert(MERGE_GAP === 0.08, '合并间隔默认 80ms');
}

// 10. 阈值严格小于判定：RMS 恰好等于阈值不算静音
{
  const sr = 1000;
  const ch = new Float32Array(sr).fill(0.01);
  const win = computeWindowLevels([ch], sr);
  assert(detectSilences(win, { threshold: 0.01 }).length === 0, 'RMS 等于阈值不判静音');
  const ch2 = new Float32Array(sr).fill(0.009);
  const win2 = computeWindowLevels([ch2], sr);
  assert(detectSilences(win2, { threshold: 0.01 }).length === 1, 'RMS 低于阈值判静音');
}

// 11. analyzeChannels 端到端 + 可调阈值重新分段
{
  const sr = 1000;
  const ch = new Float32Array(sr);
  ch.fill(0.05, 0, 400);
  ch.fill(0, 400, 800);
  ch.fill(0.05, 800, 1000);
  const low = analyzeChannels([ch], sr, { threshold: 0.01 });
  assert(low.segments.length === 1 && low.segments[0].start === 0.4, '低阈值：只检出真静音');
  const high = detectSilences(low, { threshold: 0.06 });
  // 首尾 0.05 弱信号段（0~0.4 与 0.8~1.0）也低于阈值，与真静音合并为整段
  assert(high.length === 1 && high[0].start === 0 && high[0].end === 1, `调高阈值：弱信号段也算静音并合并（实际 ${high[0]?.start}~${high[0]?.end}）`);
}

// 12. 最近静音边缘：150ms 半径、等距取更早者
const sil = [
  { start: 1.0, end: 2.0 },
  { start: 3.0, end: 4.0 }
];
assert(SNAP_RADIUS === 0.15, '吸附半径默认 150ms');
let e = nearestSilenceEdge(sil, 1.1);
assert(e?.time === 1.0, '靠近 1.0 起点吸附');
e = nearestSilenceEdge(sil, 1.9);
assert(e?.time === 2.0 && e.side === 'end', '靠近 2.0 终点吸附');
e = nearestSilenceEdge(sil, 2.5);
assert(e === null, '超出 150ms 无吸附');
e = nearestSilenceEdge(sil, 1.15);
assert(e === null, '恰好 150ms 边界外不吸附（严格小于半径）');
// 相邻两段 [1,2]、[3,4]：2.5 距两个边缘都是 0.5，取更早者 2.0
e = nearestSilenceEdge(sil, 2.5, 0.6);
assert(e?.time === 2.0, '等距时取更早边缘（2.0 而非 3.0）');

// 13. resolveEdgeCandidate：吸附合法 / 吸附不合法回退 / 开关关闭
const dragCues = [
  { id: 'a', start: 0.2, end: 1.0, text: 'a' },
  { id: 'b', start: 2.3, end: 3.0, text: 'b' }
];
const DC = { minDuration: 0.5, minGap: 0.1 };
// 右边界拖到 1.91（距 2.0 终点 90ms），吸附到 2.0：与 b(2.3) 间隔 0.3 合法
let rr = resolveEdgeCandidate(dragCues, 'a', 'end', 1.91, DC, sil, true);
assert(rr.snapped && rr.time === 2.0 && rr.valid, `吸附到合法静音边缘 2.0（snapped=${rr.snapped}）`);
// 吸附点违反最短时长：a 时长要求 1.0s；从 0.91 吸附到 1.0 时时长恰 0.8s
// 改用 minDuration 0.95 且原始候选 0.91（时长 0.71，本身也非法，验证回退原因）
const DC2 = { minDuration: 0.95, minGap: 0.1 };
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 0.91, DC2, sil, true);
assert(!rr.snapped && rr.time === 0.91 && !!rr.snapRejected, '吸附点违反最短时长 -> 回退未吸附候选并带原因');
assert(rr.snapRejected?.includes('短于最短时长'), `回退原因指明时长：${rr.snapRejected ?? ''}`);
assert(rr.valid === false, '回退后的候选（时长 0.71<0.95）本身仍非法');
// 吸附点合法但另一约束不合法时不影响：吸附到 1.0 在 DC 下时长 0.8、与邻居无冲突
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 0.91, DC, sil, true);
assert(rr.snapped && rr.time === 1.0 && rr.valid, '吸附到 1.0（时长 0.8 ≥ 0.5）合法');
// 吸附点违反最小间隔：拖 a 右边界到 2.91 附近，吸附到 3.0 会与 b 重叠
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 2.91, DC, sil, true);
assert(!rr.snapped && (rr.snapRejected?.includes('重叠') || rr.snapRejected?.includes('间隔')), `吸附点重叠/间隔不足回退：${rr.snapRejected ?? ''}`);
// 回退后未吸附候选仍合法的情形：静音段 [1.5,2.16] 终点 2.16 距 b(2.3) 仅 0.14
// （间隔不足 0.1 否……改为段终点 2.25）；拖动 a 右边界到 2.12（合法，间隔 0.18），
// 距 2.25 为 0.13 会吸附，但 2.25 与 b 间隔仅 0.05 -> 吸附非法，回退保留 2.12
const sil2 = [{ start: 1.5, end: 2.25 }];
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 2.12, DC, sil2, true);
assert(!rr.snapped && rr.time === 2.12 && rr.valid && !!rr.snapRejected, '吸附非法但原候选合法：回退保留 2.12 并提示');
assert(rr.snapRejected?.includes('间隔'), `回退原因为间隔不足：${rr.snapRejected ?? ''}`);
// 开关关闭：即使在半径内也不吸附
rr = resolveEdgeCandidate(dragCues, 'a', 'end', 1.91, DC, sil, false);
assert(!rr.snapped && rr.time === 1.91, '吸附关闭时保留原始候选');
// 原始候选非法但吸附点合法：短块 b(2.3~2.6) 左边界拖到 2.14（时长 0.46 不足），
// 距静音边缘 2.0 为 0.14，吸附后时长 0.6 合法
const dragCues2 = [
  { id: 'a', start: 0.2, end: 1.0, text: 'a' },
  { id: 'b', start: 2.3, end: 2.6, text: 'b' }
];
rr = resolveEdgeCandidate(dragCues2, 'b', 'start', 2.14, DC, sil, true);
assert(rr.snapped && rr.time === 2.0 && rr.valid, '原候选时长不足但吸附到 2.0 合法');

// 14. A-B 循环：区间计算（余量、裁剪、空区间）
{
  const cue = { start: 2, end: 4 };
  let lr = computeLoopRange(cue, { pre: 0.5, post: 0.25 }, 10);
  assert(lr?.a === 1.5 && lr?.b === 4.25, `循环区间加余量（实际 ${lr?.a}~${lr?.b}）`);
  lr = computeLoopRange({ start: 0.2, end: 1 }, { pre: 0.5, post: 0 }, 10);
  assert(lr?.a === 0, 'A 点不越过 0s');
  lr = computeLoopRange({ start: 8, end: 9.8 }, { pre: 0, post: 0.5 }, 10);
  assert(lr?.b === 10, 'B 点裁剪到音频时长');
  lr = computeLoopRange({ start: 12, end: 13 }, { pre: 0.3, post: 0.3 }, 10);
  assert(lr === null, '区间整体超出音频时长 -> 空');
  lr = computeLoopRange({ start: 9.98, end: 10.5 }, { pre: 0, post: 0 }, 10);
  assert(lr === null, `裁剪后不足 ${MIN_LOOP_LENGTH}s -> 空`);
  lr = computeLoopRange(null, { pre: 0.3, post: 0.3 }, 10);
  assert(lr === null, '无选中字幕 -> 无区间');
  lr = computeLoopRange(cue, { pre: -1, post: -1 }, 10);
  assert(lr?.a === 2 && lr?.b === 4, '负余量按 0 处理');
  lr = computeLoopRange({ start: 8, end: 9 }, { pre: 0, post: 0.5 }, 0);
  assert(lr?.b === 9.5, '时长未知（0）时不裁剪 B');
  assert(DEFAULT_LOOP_MARGINS.pre >= 0 && DEFAULT_LOOP_MARGINS.post >= 0, '默认余量非负');
}

// 15. A-B 循环：禁用原因优先级与文案
{
  const cue = { start: 2, end: 4 };
  const range = { a: 1.5, b: 4.25 };
  assert(loopDisableReason(false, cue, range) === 'no-audio', '无音频禁用');
  assert(loopDisableReason(true, null, null) === 'no-selection', '未选字幕禁用');
  assert(loopDisableReason(true, cue, null) === 'empty-range', '区间为空禁用');
  assert(loopDisableReason(true, cue, range) === null, '条件满足可开启');
  assert(loopDisableReason(false, null, null) === 'no-audio', '无音频优先于未选字幕');
  assert(loopDisableText('empty-range').includes('裁剪'), '空区间原因说明裁剪');
}

// 16. A-B 循环：播放状态转换（越过 B 回 A / 进入新区间校正）
{
  const range = { a: 1, b: 4 };
  assert(loopWrapTarget(3.9, range) === null, '未越过 B 不干预');
  assert(loopWrapTarget(4, range) === 1, '恰好到 B 回 A');
  assert(loopWrapTarget(4.2, range) === 1, '越过 B 回 A');
  assert(loopWrapTarget(5, null) === null, '无区间不干预');
  assert(loopEntryTarget(0.5, range) === 1, '落在新区间之前 -> 跳到新 A');
  assert(loopEntryTarget(5, range) === 1, '落在新区间之后 -> 跳到新 A');
  assert(loopEntryTarget(2, range) === null, '区间内不动播放头');
  assert(loopEntryTarget(1, range) === null, '恰在 A 不动');
  assert(loopEntryTarget(4, range) === null, '恰在 B 不动（播放推进由回卷处理）');
  assert(loopEntryTarget(0.5, null) === null, '无区间不校正');
}

// 17. 单句跟读：能力检测、时钟偏差与纠偏阈值
{
  assert(!hasRecordingSupport(undefined, undefined), '无 mediaDevices / MediaRecorder -> 不支持');
  assert(
    !hasRecordingSupport({ getUserMedia: 1 }, function MediaRecorder() {}),
    'getUserMedia 非函数 -> 不支持'
  );
  assert(
    hasRecordingSupport({ getUserMedia: () => undefined }, function MediaRecorder() {}),
    '两者皆为函数 -> 支持录音'
  );
  assert(SHADOW_DRIFT_LIMIT === 0.08, '偏差阈值 80ms');

  assert(Math.abs(trackDrift(1, 0.9) - 0.1) < 1e-9, '录音滞后 100ms -> 偏差 +0.1');
  assert(Math.abs(trackDrift(0.9, 1) - -0.1) < 1e-9, '录音超前 100ms -> 偏差 -0.1');
  assert(!needsDriftCorrection(0.08), '恰好 80ms 不纠偏（严格大于）');
  assert(needsDriftCorrection(0.081), '超过 80ms 触发纠偏');
  assert(needsDriftCorrection(-0.09), '超前超过 80ms 同样纠偏');
  assert(!needsDriftCorrection(0.02), '20ms 不干预');

  assert(clampRelative(-1, 2) === 0, '相对时间负值夹到 0');
  assert(clampRelative(3, 2) === 2, '相对时间超出时长夹到时长');
  assert(clampRelative(1.5, 2) === 1.5, '区间内保持');
  assert(clampRelative(NaN, 2) === 0, 'NaN 按 0 处理');
  assert(clampRelative(1, NaN) === 0, '时长非法按 0 处理');
}

// 18. 单句跟读：MIME 选择与权限错误归类
{
  const supported = new Set(['audio/webm']);
  const isOk = (m: string) => supported.has(m);
  assert(pickRecorderMimeType(isOk) === 'audio/webm', 'webm 受支持时选中');
  assert(pickRecorderMimeType(() => false) === '', '全部不支持 -> 空串（用默认容器）');
  const safari = new Set(['audio/mp4']);
  assert(pickRecorderMimeType((m) => safari.has(m)) === 'audio/mp4', 'Safari 退回 mp4');
  // 抛异常的 isTypeSupported 不应击穿选择流程
  assert(
    pickRecorderMimeType((m) => {
      if (m === 'audio/webm') throw new Error('boom');
      return false;
    }) === '',
    'isTypeSupported 抛错时安全降级为空串'
  );

  const denied = describeGetUserMediaError(new DOMException('denied', 'NotAllowedError'));
  assert(denied.kind === 'permission' && denied.recoverable, '权限拒绝 -> 可恢复提示');
  const noDev = describeGetUserMediaError(new DOMException('x', 'NotFoundError'));
  assert(noDev.kind === 'device' && noDev.recoverable, '无设备 -> 可恢复提示');
  const unknown = describeGetUserMediaError(new Error('weird'));
  assert(unknown.kind === 'unknown' && unknown.text.includes('weird'), '未知错误保留原文案');
}

// 19. 区间漂移：目标时间输入解析与格式化
{
  assert(parseTimeInput('83.5') === 83.5, '纯秒数解析');
  assert(parseTimeInput('1:23.5') === 83.5, 'mm:ss.mmm 解析');
  assert(parseTimeInput('01:02:03,500') === 3723.5, 'hh:mm:ss,ms 解析');
  assert(parseTimeInput('00:01') === 1, 'mm:ss 解析');
  assert(parseTimeInput('abc') === null, '非法输入返回 null');
  assert(parseTimeInput('') === null, '空输入返回 null');
  assert(parseTimeInput('-5') === -5, '负值可解析（由映射校验拦截）');
  assert(secondsToInputTime(83.5) === '01:23.500', '输入默认值格式化');
  assert(secondsToInputTime(3723.5) === '1:02:03.500', '满 1 小时带小时位');
  assert(parseTimeInput(secondsToInputTime(3723.5)) === 3723.5, '格式化往返一致');
}

// 20. 区间漂移：连续区间解析
const driftCues = [
  { id: 'a', start: 1, end: 2, text: 'a' },
  { id: 'b', start: 3, end: 4, text: 'b' },
  { id: 'c', start: 5, end: 6, text: 'c' },
  { id: 'd', start: 7, end: 8, text: 'd' }
];
{
  assert(resolveDriftRange(driftCues, 'b', 'd').map((c) => c.id).join('') === 'bcd', '区间 b→d 连续');
  assert(resolveDriftRange(driftCues, 'd', 'b').map((c) => c.id).join('') === 'bcd', '反向锚点同样取连续区间');
  assert(resolveDriftRange(driftCues, 'b', 'b').length === 1, '单条区间');
  assert(resolveDriftRange(driftCues, 'x', 'b').length === 0, '锚点失效返回空');
}

// 21. 区间漂移：线性映射、约束校验与首个冲突定位
{
  const DC3 = { minDuration: 0.5, minGap: 0.1 };

  // 恒等映射：合法且缩放为 1
  let plan = buildDriftPlan(driftCues, 'b', 'c', 3, 6, DC3);
  assert(plan !== null && plan.conflict === null && plan.scale === 1, '恒等映射合法且缩放为 1');

  // 整体平移 -0.5：合法；区间外字幕保持原引用
  plan = buildDriftPlan(driftCues, 'b', 'c', 2.5, 5.5, DC3);
  assert(plan?.conflict === null, '整体平移 -0.5 合法');
  assert(plan?.mappedAll[1].start === 2.5 && plan?.mappedAll[2].end === 5.5, '平移映射值正确');
  assert(plan?.mappedAll[0] === driftCues[0] && plan?.mappedAll[3] === driftCues[3], '区间外字幕保持原引用');

  // 平移 +1：c.end=7 与 d.start=7 间隔 0 < 0.1，定位区间内末条 c
  plan = buildDriftPlan(driftCues, 'b', 'c', 4, 7, DC3);
  assert(
    plan?.conflict?.kind === 'min-gap' && plan.conflict.cueId === 'c',
    `与区间外下一条间隔不足，定位末条（实际 ${plan?.conflict?.cueId}）`
  );

  // 压缩到恰好最短时长（0.5）与足够间隔：合法（边界值不误判）
  plan = buildDriftPlan(driftCues, 'b', 'c', 3, 4.5, DC3);
  assert(plan?.conflict === null && plan?.scale === 0.5, '压缩到恰好最短时长仍合法');
  assert(plan?.mappedAll[1].end === 3.5 && plan?.mappedAll[2].start === 4, '压缩映射值正确');

  // 过度压缩：b 时长 0.2 < 0.5，定位首条
  plan = buildDriftPlan(driftCues, 'b', 'c', 3, 3.6, DC3);
  assert(
    plan?.conflict?.kind === 'min-duration' && plan.conflict.cueId === 'b',
    '过度压缩触发最短时长冲突并定位首条'
  );

  // 目标锚点倒序 / 零长度
  plan = buildDriftPlan(driftCues, 'b', 'c', 6, 3, DC3);
  assert(plan?.conflict?.kind === 'anchors-reversed', '目标锚点倒序被拒绝');
  plan = buildDriftPlan(driftCues, 'b', 'c', 3, 3, DC3);
  assert(plan?.conflict?.kind === 'anchors-reversed', '目标锚点相等（零长度）按倒序拒绝');

  // 负目标锚点
  plan = buildDriftPlan(driftCues, 'b', 'c', -1, 2, DC3);
  assert(plan?.conflict?.kind === 'invalid-anchor', '负目标锚点被拒绝');

  // 与区间外上一条重叠：定位首条 b
  plan = buildDriftPlan(driftCues, 'b', 'c', 1.95, 4.95, DC3);
  assert(
    plan?.conflict?.kind === 'min-gap' && plan.conflict.cueId === 'b' && plan.conflict.message.includes('重叠'),
    `与上一条重叠，定位首条（实际 ${plan?.conflict?.cueId}）`
  );

  // 与上一条间隔恰好等于最小间隔：合法
  plan = buildDriftPlan(driftCues, 'b', 'c', 2.1, 5.1, DC3);
  assert(plan?.conflict === null, '间隔恰好等于最小间隔合法');

  // 区间内相邻间隔不足（时长仍合法）：定位后条 c
  const wide = [
    { id: 'a', start: 0.5, end: 1, text: 'a' },
    { id: 'b', start: 2, end: 6, text: 'b' },
    { id: 'c', start: 6.5, end: 10.5, text: 'c' },
    { id: 'd', start: 11, end: 12, text: 'd' }
  ];
  plan = buildDriftPlan(wide, 'b', 'c', 2, 3.275, DC3);
  assert(
    plan?.conflict?.kind === 'min-gap' && plan.conflict.cueId === 'c',
    `区间内相邻间隔不足，定位后条（实际 ${plan?.conflict?.cueId}）`
  );

  // 映射结果四舍五入到毫秒
  plan = buildDriftPlan(driftCues, 'b', 'b', 2.5004, 3.5004, DC3);
  assert(plan?.mappedAll[1].start === 2.5 && plan?.conflict === null, '映射值取整到毫秒');

  // 合法结果作为一次历史记录提交：整体撤销 / 重做，并可由现有 SRT 导出
  const okPlan = buildDriftPlan(driftCues, 'b', 'c', 2.5, 5.5, DC3);
  assert(okPlan !== null && okPlan.conflict === null, '漂移计划可提交');
  let h3 = initHistory(driftCues);
  h3 = commitHistory(h3, okPlan!.mappedAll);
  assert(h3.present[1].start === 2.5 && h3.past.length === 1, '漂移结果作为一次历史提交');
  h3 = undoHistory(h3);
  assert(h3.present[1].start === 3, '撤销整体还原区间');
  h3 = redoHistory(h3);
  assert(h3.present[1].start === 2.5, '重做恢复漂移结果');
  assert(
    serializeSrt(h3.present).includes('00:00:02,500 --> 00:00:03,500'),
    '漂移结果可由现有 SRT 导出'
  );
}

// 22. 本地会话：快照结构与版本校验
{
  const validView = {
    pps: 80,
    constraints: { minDuration: 0.5, minGap: 0.08 },
    snapEnabled: true,
    silenceThresholdDb: -40,
    loopEnabled: false,
    loopMargins: { pre: 0.3, post: 0.3 },
    selectedId: 'a'
  };
  const makeState = (patch: Record<string, unknown> = {}) => ({
    schemaVersion: SESSION_SCHEMA_VERSION,
    revision: 3,
    srtName: 'a.srt',
    history: {
      past: [[{ id: 'old', start: 0, end: 1, text: 'o' }]],
      present: [
        { id: 'a', start: 1, end: 2, text: 'a' },
        { id: 'b', start: 3, end: 4, text: 'b' }
      ],
      future: []
    },
    view: validView,
    audio: { name: 'a.mp3', size: 123, sha256: 'a'.repeat(64) },
    ...patch
  });

  let vr = validateSessionState(makeState());
  assert(vr.ok, '合法快照通过校验');
  if (vr.ok) {
    assert(vr.data.revision === 3, '校验返回归一化快照');
    assert(vr.data.audio?.sha256 === 'a'.repeat(64), '保留音频指纹');
  }

  // 版本不一致：拒绝
  vr = validateSessionState(makeState({ schemaVersion: 999 }));
  assert(!vr.ok && vr.ok === false && /版本/.test(vr.reason), '未知结构版本被拒绝');

  // 关键结构损坏：逐项拒绝，且不抛异常
  assert(!validateSessionState(makeState({ revision: -1 })).ok, '负 revision 被拒绝');
  assert(!validateSessionState(makeState({ revision: 1.5 })).ok, '非整数 revision 被拒绝');
  assert(!validateSessionState(makeState({ srtName: 7 })).ok, 'SRT 名称类型错误被拒绝');
  assert(!validateSessionState(makeState({ history: null })).ok, '历史为空被拒绝');
  assert(!validateSessionState(makeState({ history: { past: [], present: [], future: [] } })).ok, '空字幕会话被拒绝');
  assert(
    !validateSessionState(
      makeState({
        history: {
          past: [],
          present: [{ id: 'a', start: 2, end: 1, text: 'a' }],
          future: []
        }
      })
    ).ok,
    '结束早于开始的字幕被拒绝'
  );
  assert(
    !validateSessionState(
      makeState({
        history: {
          past: [],
          present: [
            { id: 'a', start: 1, end: 2, text: 'a' },
            { id: 'a', start: 3, end: 4, text: 'a2' }
          ],
          future: []
        }
      })
    ).ok,
    'present 中重复 id 被拒绝'
  );
  assert(!validateSessionState(makeState({ view: { ...validView, pps: 5 } })).ok, '超范围 pps 被拒绝');
  assert(
    !validateSessionState(makeState({ view: { ...validView, silenceThresholdDb: 0 } })).ok,
    '超范围静音阈值被拒绝'
  );
  assert(
    !validateSessionState(makeState({ view: { ...validView, loopMargins: { pre: -1, post: 0 } } })).ok,
    '负循环余量被拒绝'
  );

  // 选中字幕引用缺失：不拒绝，归一化为 null
  vr = validateSessionState(makeState({ view: { ...validView, selectedId: 'ghost' } }));
  assert(vr.ok && vr.data.view.selectedId === null, '失效 selectedId 归一化为 null');

  // 音频指纹校验：哈希格式、大小写归一
  let ar = validateAudioFingerprint({ name: 'x', size: 10, sha256: 'A'.repeat(64) });
  assert(ar.ok && ar.data.sha256 === 'a'.repeat(64), '大写哈希归一化为小写');
  assert(!validateAudioFingerprint({ name: '', size: 10, sha256: 'a'.repeat(64) }).ok, '空文件名被拒绝');
  assert(!validateAudioFingerprint({ name: 'x', size: -1, sha256: 'a'.repeat(64) }).ok, '负文件大小被拒绝');
  assert(!validateAudioFingerprint({ name: 'x', size: 10, sha256: 'z'.repeat(64) }).ok, '非十六进制哈希被拒绝');
  assert(!validateAudioFingerprint({ name: 'x', size: 10, sha256: 'a'.repeat(63) }).ok, '长度不足哈希被拒绝');

  // 单条字幕结构
  assert(validateCueShape({ id: 'a', start: 0, end: 1, text: '' }).ok, '空文本字幕结构合法');
  assert(!validateCueShape({ id: '', start: 0, end: 1, text: '' }).ok, '空 id 被拒绝');

  // 撤销栈是 Cue[][]：多帧结构可校验
  vr = validateSessionState(
    makeState({
      history: {
        past: [
          [{ id: 'p1', start: 0, end: 1, text: 'p1' }],
          [{ id: 'p2', start: 2, end: 3, text: 'p2' }]
        ],
        present: [{ id: 'n', start: 4, end: 5, text: 'n' }],
        future: [[{ id: 'f', start: 6, end: 7, text: 'f' }]]
      }
    })
  );
  assert(vr.ok && vr.data.history.past.length === 2 && vr.data.history.future.length === 1, '撤销/重做栈多帧校验通过');
  assert(
    !validateSessionState(
      makeState({
        history: {
          past: [{ id: 'p1', start: 0, end: 1, text: 'p1' }], // 应为 Cue[] 的数组
          present: [{ id: 'n', start: 4, end: 5, text: 'n' }],
          future: []
        }
      })
    ).ok,
    '撤销栈帧不是数组时被拒绝'
  );

  // 完整记录：cueCount 冗余一致性
  const record = {
    ...makeState(),
    id: 'sess-1',
    createdAt: 1000,
    updatedAt: 2000,
    cueCount: 2
  };
  assert(validateStoredRecord(record).ok, '完整记录通过校验');
  assert(!validateStoredRecord({ ...record, cueCount: 3 }).ok, 'cueCount 不一致被拒绝');
  assert(!validateStoredRecord({ ...record, id: '' }).ok, '空会话 id 被拒绝');
  assert(!validateStoredRecord({ ...record, updatedAt: 'x' }).ok, '时间戳非法被拒绝');

  // buildSessionState 携带给定 revision 基准
  const built = buildSessionState({
    srtName: 'x.srt',
    history: {
      past: [],
      present: [{ id: 'n', start: 4, end: 5, text: 'n' }],
      future: []
    },
    view: validView,
    audio: null,
    baseRevision: 41
  });
  assert(built.schemaVersion === SESSION_SCHEMA_VERSION && built.revision === 41 && built.audio === null, '快照构造携带 revision 与空音频');
}

// 23. 本地会话：事务内 revision 单调递增裁决
{
  assert(resolveWriteRevision(null, 0) === 1, '新会话从 1 开始');
  assert(resolveWriteRevision(null, 9) === 10, '无库内记录时基准 +1');
  assert(resolveWriteRevision(5, 5) === 6, '基准与库内一致 -> +1');
  assert(resolveWriteRevision(5, 8) === 9, '基准领先库内 -> 基准 +1');
  assert(resolveWriteRevision(8, 5) === null, '库内严格更新 -> 拒绝旧 revision 覆盖');
  assert(resolveWriteRevision(1, 0) === null, '库内 1 / 基准 0（调用方未见过 rev 1）同样拒绝');
  assert(resolveWriteRevision(3, -1) === null, '非法基准返回 null');
  assert(resolveWriteRevision(2, 2.5) === null, '非整数基准返回 null');
}

// 24. 音频指纹匹配与大小格式化
{
  const expected = { name: 'a.wav', size: 100, sha256: 'a'.repeat(64) };
  assert(fingerprintsMatch({ name: 'renamed.wav', size: 100, sha256: 'a'.repeat(64) }, expected), '重命名不影响匹配（大小+哈希一致）');
  assert(!fingerprintsMatch({ name: 'a.wav', size: 101, sha256: 'a'.repeat(64) }, expected), '大小不一致不匹配');
  assert(!fingerprintsMatch({ name: 'a.wav', size: 100, sha256: 'b'.repeat(64) }, expected), '哈希不一致不匹配');
  assert(!fingerprintsMatch({ name: 'a.wav', size: 100, sha256: 'a'.repeat(64) }, null), '无期望指纹不匹配');
  assert(formatBytes(0) === '0 B', '0 B 格式化');
  assert(formatBytes(2048) === '2.0 KB', 'KB 格式化');
}

// 25. 本地会话：IndexedDB 事务内 revision 保护（旧 revision 拒绝覆盖新状态）
async function runSessionStoreTests() {
  // 干净数据库（模块内连接带缓存，故测试开始前先删掉可能存在的库）
  await new Promise<void>((resolve) => {
    const del = indexedDB.deleteDatabase(SESSION_DB_NAME);
    del.onsuccess = () => resolve();
    del.onerror = () => resolve();
    del.onblocked = () => resolve();
  });

  const id = randomSessionId();
  assert(id.length > 0, '生成会话 id');
  const frame = (idc: string, start: number) => ({ id: idc, start, end: start + 1, text: idc });
  const stateAt = (rev: number, n: number) =>
    buildSessionState({
      srtName: `${n}.srt`,
      history: { past: [], present: [frame('a', n)], future: [] },
      view: {
        pps: 80,
        constraints: { minDuration: 0.5, minGap: 0.08 },
        snapEnabled: true,
        silenceThresholdDb: -40,
        loopEnabled: false,
        loopMargins: { pre: 0.3, post: 0.3 },
        selectedId: 'a'
      },
      audio: null,
      baseRevision: rev
    });

  // 初次写入：基准 0 -> revision 1
  let w = await putSession(stateAt(0, 1), id);
  assert(w.kind === 'ok' && w.revision === 1, `初次写入 revision=1（实际 ${w.kind === 'ok' ? w.revision : w.kind}）`);
  if (w.kind !== 'ok') return;

  // 正常顺序写入：基准 1 -> 2
  w = await putSession(stateAt(1, 2), id);
  assert(w.kind === 'ok' && w.revision === 2, '顺序写入 revision 递增到 2');

  // 模拟乱序到达的旧异步写入：基准仍为 0，事务内读到库内 2 -> 拒绝
  const staleWrite = putSession(stateAt(0, 999), id);
  const freshWrite = putSession(stateAt(2, 3), id); // 与旧写入并发的正常写入
  const staleResult = await staleWrite;
  const freshResult = await freshWrite;
  assert(staleResult.kind === 'stale', '事务内拒绝旧 revision 覆盖新状态');
  assert(freshResult.kind === 'ok' || freshResult.kind === 'stale', '并发的新写入返回 ok，或串行下的可重试 stale');
  // 若新写入先被旧基准挤成 stale，则按库内版本重试一次也应成功
  if (freshResult.kind === 'stale') {
    const retry = await putSession(stateAt(freshResult.existingRevision, 3), id);
    assert(retry.kind === 'ok', 'stale 后按库内版本重试成功');
  }

  // 库内状态未被旧快照污染：srtName 永远不是 999.srt
  const stored = await getSession(id);
  assert(stored !== null, '会话可按 id 读取且经过完整校验');
  assert(stored?.revision === 3 && stored.srtName === '3.srt', `库内为最新 revision 3（实际 rev=${stored?.revision} name=${stored?.srtName}）`);
  assert(stored.cueCount === 1, 'cueCount 冗余字段正确');

  // 列表 / 删除
  const list = await listRecoverableSessions();
  assert(list.length === 1 && list[0].valid && list[0].meta.id === id, '恢复列表含 1 条有效会话');
  assert(list[0].meta.srtName === '3.srt', '列表元信息正确');
  await deleteSession(id);
  assert((await getSession(id)) === null, '删除后读取为 null');
  assert((await listRecoverableSessions()).length === 0, '删除后列表为空');

  // 损坏记录：列表标记 invalid 且禁止恢复，但可以删除
  const badId = randomSessionId();
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(SESSION_DB_NAME);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put({ id: badId, schemaVersion: 1, revision: 0, garbage: true });
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
  const badList = await listRecoverableSessions();
  assert(badList.length === 1 && !badList[0].valid, '损坏记录在列表中标记为不可恢复');
  assert((await getSession(badId)) === null, '损坏记录读取被结构校验拒绝');
  await deleteSession(badId);
  assert((await listRecoverableSessions()).length === 0, '损坏记录仍可删除');
}

async function main() {
  await runSessionStoreTests();
  process.exit(fail ? 1 : 0);
}

void main();
