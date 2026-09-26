/**
 * 本地校对会话：快照数据结构、版本与结构校验、单调 revision 规则（纯函数，可单测）。
 *
 * 快照内容：字幕内容（含撤销 / 重做历史）、约束、视图设置，以及音频文件的
 * 名称 / 大小 / SHA-256 指纹（不保存音频本身）。IndexedDB 的读写封装见
 * sessionStore.ts，本文件不依赖任何浏览器 API。
 */
import type { Constraints, Cue } from '../types';
import type { HistoryState } from './cues';
import type { LoopMargins } from './abLoop';

/** 快照结构版本：结构发生不兼容变更时递增；恢复时版本不一致一律拒绝 */
export const SESSION_SCHEMA_VERSION = 1;

/** 自动保存偏好（localStorage）的键；仅显式 '0' 表示停用 */
export const AUTOSAVE_PREF_KEY = 'subtitle-deck:autosave';

/** 变化后自动落盘的防抖延迟（毫秒） */
export const AUTOSAVE_DEBOUNCE_MS = 400;

/** 音频指纹：只记录元信息与内容哈希，音频文件本身绝不入库 */
export interface AudioFingerprint {
  /** 选择音频时的文件名（仅展示，不作为匹配条件） */
  name: string;
  /** 文件大小（字节），匹配条件之一 */
  size: number;
  /** 文件内容的小写十六进制 SHA-256，播放重新启用的最终凭据 */
  sha256: string;
}

/** 随会话保存的视图 / 校对设置 */
export interface SessionViewSettings {
  /** 时间轴缩放（px/s） */
  pps: number;
  constraints: Constraints;
  /** 静音吸附开关 */
  snapEnabled: boolean;
  /** 静音阈值（dB） */
  silenceThresholdDb: number;
  /** A-B 循环开关 */
  loopEnabled: boolean;
  /** A-B 循环前后余量 */
  loopMargins: LoopMargins;
  /** 当前选中字幕；若指向不存在的 id，恢复时归一化为 null */
  selectedId: string | null;
}

/**
 * 一次会话快照。revision 由调用方按已知库内版本填写，
 * 写入时由 sessionStore 在事务内推进到单调递增值。
 */
export interface SessionState {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  revision: number;
  srtName: string | null;
  history: HistoryState;
  view: SessionViewSettings;
  audio: AudioFingerprint | null;
}

/** IndexedDB 内的完整记录：快照 + 主键与时间戳 */
export interface SessionRecord extends SessionState {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** history.present.length 的冗余字段，恢复时必须与实际条数一致 */
  cueCount: number;
}

/** 恢复列表所需的轻量信息 */
export interface SessionMeta {
  id: string;
  srtName: string | null;
  audioName: string | null;
  audioSize: number | null;
  cueCount: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type ValidationResult<T> = { ok: true; data: T } | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

const HEX64 = /^[0-9a-fA-F]{64}$/;

/** 校验单条字幕结构（不依赖 parseSrt，恢复路径必须自给自足） */
export function validateCueShape(value: unknown): ValidationResult<Cue> {
  if (!isRecord(value)) return { ok: false, reason: '字幕不是对象' };
  const { id, start, end, text } = value;
  if (typeof id !== 'string' || id.length === 0) return { ok: false, reason: '字幕 id 缺失' };
  if (!isFiniteNumber(start) || start < 0) return { ok: false, reason: `字幕 ${id} 起始时间非法` };
  if (!isFiniteNumber(end) || end <= start) {
    return { ok: false, reason: `字幕 ${id} 结束时间不晚于开始时间` };
  }
  if (typeof text !== 'string') return { ok: false, reason: `字幕 ${id} 文本不是字符串` };
  return { ok: true, data: { id, start, end, text } };
}

function validateCueArray(value: unknown, field: string): ValidationResult<Cue[]> {
  if (!Array.isArray(value)) return { ok: false, reason: `${field} 不是数组` };
  const cues: Cue[] = [];
  for (const item of value) {
    const r = validateCueShape(item);
    if (!r.ok) return { ok: false, reason: r.reason };
    cues.push(r.data);
  }
  return { ok: true, data: cues };
}

/** 撤销 / 重做栈：Cue[][]，逐帧校验 */
function validateCueStack(value: unknown, field: string): ValidationResult<Cue[][]> {
  if (!Array.isArray(value)) return { ok: false, reason: `${field} 不是数组` };
  const stack: Cue[][] = [];
  for (const frame of value) {
    const r = validateCueArray(frame, field);
    if (!r.ok) return { ok: false, reason: r.reason };
    stack.push(r.data);
  }
  return { ok: true, data: stack };
}

/** 校验音频指纹；返回归一化（小写哈希）副本 */
export function validateAudioFingerprint(value: unknown): ValidationResult<AudioFingerprint> {
  if (!isRecord(value)) return { ok: false, reason: '音频指纹不是对象' };
  const { name, size, sha256 } = value;
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: '音频文件名缺失' };
  }
  if (!isNonNegativeInteger(size)) return { ok: false, reason: '音频大小不是非负整数' };
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) {
    return { ok: false, reason: '音频 SHA-256 不是 64 位十六进制' };
  }
  return { ok: true, data: { name, size, sha256: sha256.toLowerCase() } };
}

function validateView(value: unknown, present: Cue[]): ValidationResult<SessionViewSettings> {
  if (!isRecord(value)) return { ok: false, reason: '视图设置不是对象' };
  const v = value;
  if (!isFiniteNumber(v.pps) || v.pps < 10 || v.pps > 400) {
    return { ok: false, reason: '缩放 pps 超出 10–400 范围' };
  }
  if (!isRecord(v.constraints)) return { ok: false, reason: '约束不是对象' };
  const { minDuration, minGap } = v.constraints;
  if (!isFiniteNumber(minDuration) || minDuration < 0) {
    return { ok: false, reason: '最短时长非法' };
  }
  if (!isFiniteNumber(minGap) || minGap < 0) {
    return { ok: false, reason: '最小间隔非法' };
  }
  if (typeof v.snapEnabled !== 'boolean') return { ok: false, reason: '吸附开关不是布尔值' };
  if (!isFiniteNumber(v.silenceThresholdDb) || v.silenceThresholdDb < -60 || v.silenceThresholdDb > -20) {
    return { ok: false, reason: '静音阈值超出 -60–-20 dB 范围' };
  }
  if (typeof v.loopEnabled !== 'boolean') return { ok: false, reason: '循环开关不是布尔值' };
  if (!isRecord(v.loopMargins)) return { ok: false, reason: '循环余量不是对象' };
  const { pre, post } = v.loopMargins;
  if (!isFiniteNumber(pre) || pre < 0 || !isFiniteNumber(post) || post < 0) {
    return { ok: false, reason: '循环余量非法' };
  }
  if (v.selectedId !== null && typeof v.selectedId !== 'string') {
    return { ok: false, reason: '选中字幕 id 类型非法' };
  }
  // 引用完整性不阻断恢复：指向已不存在字幕时归一化为 null
  const selectedId =
    v.selectedId !== null && present.some((c) => c.id === v.selectedId) ? v.selectedId : null;
  return {
    ok: true,
    data: {
      pps: v.pps,
      constraints: { minDuration, minGap },
      snapEnabled: v.snapEnabled,
      silenceThresholdDb: v.silenceThresholdDb,
      loopEnabled: v.loopEnabled,
      loopMargins: { pre, post },
      selectedId
    }
  };
}

/**
 * 完整校验快照的版本与数据结构，返回一份全新引用的归一化结果。
 * 任何不合法都给出原因；调用方保证校验失败时绝不改动当前工作区。
 */
export function validateSessionState(value: unknown): ValidationResult<SessionState> {
  if (!isRecord(value)) return { ok: false, reason: '会话不是对象' };
  if (value.schemaVersion !== SESSION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `会话版本不被支持（期望 ${SESSION_SCHEMA_VERSION}，实际 ${String(value.schemaVersion)}）`
    };
  }
  if (!isNonNegativeInteger(value.revision)) return { ok: false, reason: 'revision 不是非负整数' };
  const srtName =
    value.srtName === null || typeof value.srtName === 'string' ? value.srtName : undefined;
  if (srtName === undefined) return { ok: false, reason: 'SRT 文件名类型非法' };

  if (!isRecord(value.history)) return { ok: false, reason: '历史不是对象' };
  const pastR = validateCueStack(value.history.past, '撤销栈');
  if (!pastR.ok) return pastR;
  const presentR = validateCueArray(value.history.present, '当前字幕');
  if (!presentR.ok) return presentR;
  if (presentR.data.length === 0) return { ok: false, reason: '会话不包含任何字幕' };
  const futureR = validateCueStack(value.history.future, '重做栈');
  if (!futureR.ok) return futureR;
  const presentIds = new Set<string>();
  for (const cue of presentR.data) {
    if (presentIds.has(cue.id)) return { ok: false, reason: `字幕 id 重复：${cue.id}` };
    presentIds.add(cue.id);
  }

  const viewR = validateView(value.view, presentR.data);
  if (!viewR.ok) return viewR;

  let audio: AudioFingerprint | null = null;
  if (value.audio !== null) {
    const audioR = validateAudioFingerprint(value.audio);
    if (!audioR.ok) return audioR;
    audio = audioR.data;
  }

  return {
    ok: true,
    data: {
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: value.revision,
      srtName,
      history: { past: pastR.data, present: presentR.data, future: futureR.data },
      view: viewR.data,
      audio
    }
  };
}

/** 校验 IndexedDB 记录（快照 + 主键 / 时间戳 / 冗余条数） */
export function validateStoredRecord(value: unknown): ValidationResult<SessionRecord> {
  const stateR = validateSessionState(value);
  if (!stateR.ok) return stateR;
  if (!isRecord(value)) return { ok: false, reason: '记录不是对象' };
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return { ok: false, reason: '会话 id 缺失' };
  }
  if (!isNonNegativeInteger(value.createdAt)) return { ok: false, reason: 'createdAt 非法' };
  if (!isNonNegativeInteger(value.updatedAt)) return { ok: false, reason: 'updatedAt 非法' };
  if (!isNonNegativeInteger(value.cueCount) || value.cueCount !== stateR.data.history.present.length) {
    return { ok: false, reason: 'cueCount 与实际字幕条数不一致' };
  }
  return {
    ok: true,
    data: {
      ...stateR.data,
      id: value.id,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      cueCount: value.cueCount
    }
  };
}

/**
 * 事务内的 revision 裁决（纯函数）：
 * - 库内 revision 严格大于调用方基准 => 返回 null（旧 revision，拒绝覆盖）；
 * - 否则返回 max(库内, 基准) + 1，保证每次成功写入都单调递增。
 */
export function resolveWriteRevision(existingRev: number | null, baseRev: number): number | null {
  if (!isNonNegativeInteger(baseRev)) return null;
  if (existingRev !== null && existingRev > baseRev) return null;
  return Math.max(existingRev ?? 0, baseRev) + 1;
}

/** 由当前工作区状态构造快照；revision 取已知库内基准，实际入库版本由存储层推进 */
export function buildSessionState(input: {
  srtName: string | null;
  history: HistoryState;
  view: SessionViewSettings;
  audio: AudioFingerprint | null;
  baseRevision: number;
}): SessionState {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    revision: input.baseRevision,
    srtName: input.srtName,
    history: input.history,
    view: input.view,
    audio: input.audio
  };
}

/** 从（可能不合法的）记录中尽力提取列表展示信息 */
export function fallbackMeta(value: unknown, index: number): SessionMeta {
  const r = (isRecord(value) ? value : {}) as Record<string, unknown>;
  const audioR = validateAudioFingerprint(r.audio);
  return {
    id: typeof r.id === 'string' && r.id.length > 0 ? r.id : `__invalid_${index}`,
    srtName: typeof r.srtName === 'string' ? r.srtName : null,
    audioName: audioR.ok ? audioR.data.name : null,
    audioSize: audioR.ok ? audioR.data.size : null,
    cueCount: isNonNegativeInteger(r.cueCount) ? r.cueCount : 0,
    revision: isNonNegativeInteger(r.revision) ? r.revision : 0,
    createdAt: isNonNegativeInteger(r.createdAt) ? r.createdAt : 0,
    updatedAt: isNonNegativeInteger(r.updatedAt) ? r.updatedAt : 0
  };
}

export function toSessionMeta(record: SessionRecord): SessionMeta {
  return {
    id: record.id,
    srtName: record.srtName,
    audioName: record.audio?.name ?? null,
    audioSize: record.audio?.size ?? null,
    cueCount: record.cueCount,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}
