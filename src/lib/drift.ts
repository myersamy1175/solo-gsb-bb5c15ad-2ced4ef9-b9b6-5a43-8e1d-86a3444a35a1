/**
 * 区间漂移校准：连续区间的线性映射（纯函数，可单测）。
 *
 * 以区间首条起点、末条终点为原始锚点，用户给定两个目标锚点后，
 * 对区间内所有起止时间做同一线性映射：
 *   t' = newStart + (t − oldStart) × scale，scale = (newEnd − newStart) / (oldEnd − oldStart)
 * 映射结果统一四舍五入到毫秒后再做约束校验，保证「预览所见即提交所得」。
 * 合法结果由调用方作为一次历史记录提交，可整体撤销/重做。
 */

import type { Constraints, Cue } from '../types';

/**
 * 解析目标时间输入。支持：
 * - 纯秒数：`83.5`、`83,5`
 * - 分:秒：`01:23.500`、`1:23`
 * - 时:分:秒：`00:01:23,500`
 * 负值可解析（由 buildDriftPlan 判定为非法锚点）；无法识别返回 null。
 */
export function parseTimeInput(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  // 纯秒数（允许逗号小数与负值）
  if (/^-?\d+(?:[.,]\d+)?$/.test(s)) {
    const v = Number(s.replace(',', '.'));
    return Number.isFinite(v) ? v : null;
  }
  // hh:mm:ss[,.ms]
  let m = s.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
  if (m) {
    const [, hh, mm, ss, ms] = m;
    if (Number(mm) >= 60 || Number(ss) >= 60) return null;
    return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + (ms ? Number(ms.padEnd(3, '0')) / 1000 : 0);
  }
  // mm:ss[.ms]
  m = s.match(/^(\d+):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (m) {
    const [, mm, ss, ms] = m;
    if (Number(ss) >= 60) return null;
    return Number(mm) * 60 + Number(ss) + (ms ? Number(ms.padEnd(3, '0')) / 1000 : 0);
  }
  return null;
}

/** 输入框默认值格式：`mm:ss.mmm`（满 1 小时为 `h:mm:ss.mmm`），可被 parseTimeInput 解析 */
export function secondsToInputTime(t: number): string {
  const clamped = Math.max(0, t);
  let hh = Math.floor(clamped / 3600);
  let mm = Math.floor((clamped % 3600) / 60);
  let ss = Math.floor(clamped % 60);
  let ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  // 四舍五入进位（999.5ms -> 1s）
  if (ms === 1000) {
    ms = 0;
    ss += 1;
  }
  if (ss === 60) {
    ss = 0;
    mm += 1;
  }
  if (mm === 60) {
    mm = 0;
    hh += 1;
  }
  const p2 = (n: number) => String(n).padStart(2, '0');
  const core = hh > 0 ? `${hh}:${p2(mm)}:${p2(ss)}` : `${p2(mm)}:${p2(ss)}`;
  return `${core}.${String(ms).padStart(3, '0')}`;
}

/**
 * 由锚点与终点 id 取连续区间（按时间排序，含两端，与点击先后无关）；
 * 任一 id 已失效（如切换文件后）返回空数组。
 */
export function resolveDriftRange(cues: Cue[], anchorId: string, endId: string): Cue[] {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const i = sorted.findIndex((c) => c.id === anchorId);
  const j = sorted.findIndex((c) => c.id === endId);
  if (i < 0 || j < 0) return [];
  const lo = Math.min(i, j);
  const hi = Math.max(i, j);
  return sorted.slice(lo, hi + 1);
}

export type DriftConflictKind =
  /** 目标锚点非法（负值 / 非有限数）或原始区间长度为零 */
  | 'invalid-anchor'
  /** 目标锚点倒序：终点不晚于起点 */
  | 'anchors-reversed'
  /** 映射后某条字幕时长低于当前最短时长 */
  | 'min-duration'
  /** 与区间内外相邻字幕不满足最小间隔（重叠按负间隔一并报出） */
  | 'min-gap';

export interface DriftConflict {
  kind: DriftConflictKind;
  /** 首个冲突对应的区间内字幕 id（用于定位）；无定位目标时为 null */
  cueId: string | null;
  message: string;
}

export interface DriftPlan {
  /** 区间内字幕 id（时间序） */
  rangeIds: string[];
  /** 原始锚点：首条起点 / 末条终点 */
  oldStart: number;
  oldEnd: number;
  /** 目标锚点 */
  newStart: number;
  newEnd: number;
  /** 缩放比例（目标区间长 / 原区间长）；锚点倒序时为负 */
  scale: number;
  /** 全量字幕：区间内映射（毫秒取整），区间外保持原引用 */
  mappedAll: Cue[];
  /** 首个冲突（按时间序）；null 表示可提交 */
  conflict: DriftConflict | null;
}

/**
 * 构建区间漂移计划：始终完成映射（供时间轴预览），并给出按时间序的首个冲突。
 * 返回 null 仅表示区间本身已失效（锚点 id 不存在），调用方应丢弃本次选择。
 *
 * 校验顺序：锚点非法 → 锚点倒序 → 按时间序扫描「时长（仅区间内）→ 与前一条的
 * 间隔（至少一端在区间内）」。时长 / 间隔恰好等于下限合法（1e-6 吸收浮点误差，
 * 字幕时间均为毫秒精度）。
 */
export function buildDriftPlan(
  cues: Cue[],
  anchorId: string,
  endId: string,
  newStart: number,
  newEnd: number,
  constraints: Constraints
): DriftPlan | null {
  const range = resolveDriftRange(cues, anchorId, endId);
  if (range.length === 0) return null;
  const rangeIds = range.map((c) => c.id);
  const inRange = new Set(rangeIds);
  const oldStart = range[0].start;
  const oldEnd = range[range.length - 1].end;
  const base = { rangeIds, oldStart, oldEnd, newStart, newEnd };

  if (!Number.isFinite(newStart) || !Number.isFinite(newEnd) || newStart < 0 || newEnd < 0) {
    return {
      ...base,
      scale: Number.NaN,
      mappedAll: cues,
      conflict: {
        kind: 'invalid-anchor',
        cueId: null,
        message: '目标锚点须为不小于 0 的有效时间'
      }
    };
  }

  const oldLength = oldEnd - oldStart;
  if (oldLength <= 0) {
    return {
      ...base,
      scale: Number.NaN,
      mappedAll: cues,
      conflict: {
        kind: 'invalid-anchor',
        cueId: null,
        message: '原始区间长度为零，无法做线性映射'
      }
    };
  }

  const scale = (newEnd - newStart) / oldLength;
  // 映射并取整到毫秒：校验与提交使用同一份取整结果，避免「预览合法、提交非法」
  const mapTime = (t: number): number =>
    Math.round((newStart + (t - oldStart) * scale) * 1000) / 1000;
  const mappedAll = cues.map((c) =>
    inRange.has(c.id) ? { ...c, start: mapTime(c.start), end: mapTime(c.end) } : c
  );

  if (newEnd <= newStart) {
    return {
      ...base,
      scale,
      mappedAll,
      conflict: {
        kind: 'anchors-reversed',
        cueId: range[0].id,
        message: `目标锚点倒序：终点 ${secondsToInputTime(newEnd)} 必须晚于起点 ${secondsToInputTime(newStart)}`
      }
    };
  }

  // 首个冲突：按当前时间序扫描；序号与字幕列表行号一致（正缩放不改变顺序）
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const mappedById = new Map(mappedAll.map((c) => [c.id, c]));
  const eff = sorted.map((c) => mappedById.get(c.id) ?? c);
  const minDurMs = constraints.minDuration * 1000;
  const minGapMs = constraints.minGap * 1000;
  const EPS = 1e-6;

  for (let i = 0; i < eff.length; i++) {
    const cur = eff[i];
    const curIn = inRange.has(cur.id);
    if (curIn) {
      const durMs = Math.round(cur.end * 1000) - Math.round(cur.start * 1000);
      if (durMs < minDurMs - EPS) {
        return {
          ...base,
          scale,
          mappedAll,
          conflict: {
            kind: 'min-duration',
            cueId: cur.id,
            message: `第 ${i + 1} 条映射后时长 ${(durMs / 1000).toFixed(3)}s 低于最短时长 ${constraints.minDuration.toFixed(3)}s`
          }
        };
      }
    }
    if (i > 0) {
      const prev = eff[i - 1];
      const prevIn = inRange.has(prev.id);
      // 两端都在区间外的相邻对未被本次映射改动，不纳入冲突判定
      if (prevIn || curIn) {
        const gapMs = Math.round(cur.start * 1000) - Math.round(prev.end * 1000);
        if (gapMs < minGapMs - EPS) {
          const target = curIn ? cur : prev;
          const detail =
            gapMs < 0
              ? `第 ${i} 条与第 ${i + 1} 条重叠 ${(-gapMs / 1000).toFixed(3)}s`
              : `第 ${i} 条与第 ${i + 1} 条间隔 ${(gapMs / 1000).toFixed(3)}s 小于最小间隔 ${constraints.minGap.toFixed(3)}s`;
          return {
            ...base,
            scale,
            mappedAll,
            conflict: { kind: 'min-gap', cueId: target.id, message: detail }
          };
        }
      }
    }
  }

  return { ...base, scale, mappedAll, conflict: null };
}
