/**
 * 本地校对会话：快照数据结构、结构校验与音频指纹。
 *
 * 会话快照保存在 IndexedDB（见 sessionDb.ts），包含字幕内容、完整撤销/重做
 * 历史、约束与视图设置；音频文件本身不落盘，只记录名称 / 大小 / SHA-256，
 * 恢复后必须重新选择同一文件（指纹匹配）才重新启用播放。
 *
 * 每次成功写入携带单调递增的 revision；IndexedDB 写事务内做 CAS，
 * 旧 revision 不得覆盖新状态（多标签页并发时直接拒绝）。
 */

import { sha256Bytes } from './sha256';

/** 持久化结构版本号：不兼容旧结构时递增 */
export const SESSION_SCHEMA_VERSION = 1;

/** 音频指纹：只记录元数据与哈希，文件内容不落盘 */
export interface AudioFingerprint {
  /** 文件名（仅展示用，匹配以大小 + SHA-256 为准） */
  name: string;
  /** 文件大小（字节） */
  size: number;
  /** 文件内容 SHA-256（小写 hex） */
  sha256: string;
}

/** 视图与可恢复的偏好设置（播放头等临时态不持久化） */
export interface SessionViewState {
  constraints: { minDuration: number; minGap: number };
  pps: number;
  snapEnabled: boolean;
  silenceThresholdDb: number;
  loopEnabled: boolean;
  loopMargins: { pre: number; post: number };
  selectedId: string | null;
}

/**
 * 一条完整会话快照。past / present / future 与 cues.ts 的 HistoryState 同构，
 * 这里独立声明为持久化类型（id 集合必须一致，恢复后撤销栈仍可逐步回放）。
 */
export interface SessionSnapshot {
  past: CueSnapshot[][];
  present: CueSnapshot[];
  future: CueSnapshot[][];
}

export interface CueSnapshot {
  id: string;
  start: number;
  end: number;
  text: string;
}

/** IndexedDB 中的会话记录（一条对应一个 SRT 工作区） */
export interface SessionRecord {
  /** 会话 id（随机生成，主键） */
  id: string;
  /** 结构版本，必须为 SESSION_SCHEMA_VERSION */
  schemaVersion: number;
  /** 单调递增修订号；旧 revision 在写事务内被拒绝覆盖新状态 */
  revision: number;
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 最近一次快照时间（epoch ms） */
  updatedAt: number;
  /** 导入的 SRT 文件名 */
  srtName: string;
  /** 字幕与撤销/重做历史 */
  snapshot: SessionSnapshot;
  /** 视图与偏好设置 */
  view: SessionViewState;
  /** 上次关联的音频指纹；未导入过音频为 null */
  audio: AudioFingerprint | null;
}

/** 校验失败说明（恢复时原样展示，不允许恢复） */
export interface InvalidSession {
  kind: 'invalid';
  /** IndexedDB 里的主键；损坏记录仍允许删除 */
  id: string;
  updatedAt: number;
  srtName: string;
  reason: string;
}

/** 可恢复的会话条目（结构已通过完整校验） */
export interface SessionSummary {
  kind: 'ok';
  record: SessionRecord;
}

export type SessionEntry = SessionSummary | InvalidSession;

/** 自动保存状态机（工具栏展示用） */
export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number }
  | { kind: 'error'; message: string };

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isText(v: unknown): v is string {
  return typeof v === 'string';
}

/** 校验单条字幕快照；返回规范后的副本或错误原因 */
function readCue(v: unknown): { ok: true; value: CueSnapshot } | { ok: false; reason: string } {
  if (!isRecord(v)) return { ok: false, reason: '字幕不是对象' };
  if (!isText(v.id) || v.id.length === 0 || v.id.length > 200) {
    return { ok: false, reason: '字幕 id 缺失或非法' };
  }
  if (!isFiniteNumber(v.start) || v.start < 0) {
    return { ok: false, reason: `字幕 ${v.id} 起始时间非法` };
  }
  if (!isFiniteNumber(v.end) || v.end <= v.start) {
    return { ok: false, reason: `字幕 ${v.id} 结束时间不晚于起始时间` };
  }
  if (!isText(v.text)) {
    return { ok: false, reason: `字幕 ${v.id} 文本不是字符串` };
  }
  return {
    ok: true,
    value: { id: v.id, start: v.start, end: v.end, text: v.text }
  };
}

/** 校验一帧字幕列表（past / future 的元素或 present 自身） */
function readCueStack(v: unknown): { ok: true; value: CueSnapshot[] } | { ok: false; reason: string } {
  if (!Array.isArray(v) || v.length === 0) {
    return { ok: false, reason: '字幕快照为空' };
  }
  const out: CueSnapshot[] = [];
  const ids = new Set<string>();
  for (const item of v) {
    const r = readCue(item);
    if (!r.ok) return r;
    if (ids.has(r.value.id)) return { ok: false, reason: `字幕 id 重复：${r.value.id}` };
    ids.add(r.value.id);
    out.push(r.value);
  }
  return { ok: true, value: out };
}

/** 要求两帧字幕的 id 集合完全一致（历史栈只允许时间码差异） */
function sameCueIds(a: CueSnapshot[], b: CueSnapshot[]): boolean {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map((c) => c.id));
  return b.every((c) => ids.has(c.id));
}

function readAudio(v: unknown): { ok: true; value: AudioFingerprint | null } | { ok: false; reason: string } {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (!isRecord(v)) return { ok: false, reason: '音频指纹不是对象' };
  if (!isText(v.name) || v.name.length === 0) {
    return { ok: false, reason: '音频文件名缺失' };
  }
  if (!isNonNegInt(v.size)) {
    return { ok: false, reason: '音频文件大小非法' };
  }
  if (!isText(v.sha256) || !/^[0-9a-f]{64}$/.test(v.sha256)) {
    return { ok: false, reason: '音频 SHA-256 非法' };
  }
  return { ok: true, value: { name: v.name, size: v.size, sha256: v.sha256 } };
}

function readView(v: unknown, cueIds: Set<string>): { ok: true; value: SessionViewState } | { ok: false; reason: string } {
  if (!isRecord(v)) return { ok: false, reason: '视图设置不是对象' };
  const c = v.constraints;
  if (
    !isRecord(c) ||
    !isFiniteNumber(c.minDuration) ||
    c.minDuration < 0 ||
    !isFiniteNumber(c.minGap) ||
    c.minGap < 0
  ) {
    return { ok: false, reason: '约束设置非法' };
  }
  if (!isFiniteNumber(v.pps) || v.pps < 10 || v.pps > 400) {
    return { ok: false, reason: '缩放设置超出范围' };
  }
  if (typeof v.snapEnabled !== 'boolean') {
    return { ok: false, reason: '吸附开关非法' };
  }
  if (!isFiniteNumber(v.silenceThresholdDb) || v.silenceThresholdDb < -60 || v.silenceThresholdDb > -20) {
    return { ok: false, reason: '静音阈值超出范围' };
  }
  if (typeof v.loopEnabled !== 'boolean') {
    return { ok: false, reason: 'A-B 循环开关非法' };
  }
  const m = v.loopMargins;
  if (
    !isRecord(m) ||
    !isFiniteNumber(m.pre) ||
    m.pre < 0 ||
    m.pre > 10 ||
    !isFiniteNumber(m.post) ||
    m.post < 0 ||
    m.post > 10
  ) {
    return { ok: false, reason: 'A-B 循环余量非法' };
  }
  if (v.selectedId !== null && (typeof v.selectedId !== 'string' || !cueIds.has(v.selectedId))) {
    return { ok: false, reason: '选中字幕不属于该会话' };
  }
  return {
    ok: true,
    value: {
      constraints: { minDuration: c.minDuration, minGap: c.minGap },
      pps: v.pps,
      snapEnabled: v.snapEnabled,
      silenceThresholdDb: v.silenceThresholdDb,
      loopEnabled: v.loopEnabled,
      loopMargins: { pre: m.pre, post: m.post },
      selectedId: v.selectedId
    }
  };
}

/**
 * 完整校验一条会话记录（版本 + 数据结构）。
 * 只有返回 ok 才允许恢复；失败时调用方不得改动当前工作区。
 */
export function validateSession(raw: unknown): { ok: true; record: SessionRecord } | { ok: false; reason: string } {
  if (!isRecord(raw)) return { ok: false, reason: '会话记录不是对象' };
  if (raw.schemaVersion !== SESSION_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `会话版本不受支持（v${String(raw.schemaVersion)}，需要 v${SESSION_SCHEMA_VERSION}）`
    };
  }
  if (!isText(raw.id) || raw.id.length === 0 || raw.id.length > 100) {
    return { ok: false, reason: '会话 id 非法' };
  }
  if (!isNonNegInt(raw.revision)) {
    return { ok: false, reason: 'revision 非法' };
  }
  if (!isFiniteNumber(raw.createdAt) || raw.createdAt <= 0) {
    return { ok: false, reason: '创建时间非法' };
  }
  if (!isFiniteNumber(raw.updatedAt) || raw.updatedAt < raw.createdAt) {
    return { ok: false, reason: '更新时间非法' };
  }
  if (!isText(raw.srtName) || raw.srtName.length === 0 || raw.srtName.length > 500) {
    return { ok: false, reason: 'SRT 文件名非法' };
  }
  if (!isRecord(raw.snapshot)) return { ok: false, reason: '字幕快照缺失' };

  const presentR = readCueStack(raw.snapshot.present);
  if (!presentR.ok) return { ok: false, reason: `当前字幕：${presentR.reason}` };
  const present = presentR.value;
  const cueIds = new Set(present.map((c) => c.id));

  const frames: { name: string; raw: unknown }[] = [
    ...(Array.isArray(raw.snapshot.past)
      ? (raw.snapshot.past as unknown[]).map((raw, i) => ({ name: `撤销栈第 ${i + 1} 帧`, raw }))
      : [{ name: '撤销栈', raw: raw.snapshot.past }]),
    ...(Array.isArray(raw.snapshot.future)
      ? (raw.snapshot.future as unknown[]).map((raw, i) => ({ name: `重做栈第 ${i + 1} 帧`, raw }))
      : [{ name: '重做栈', raw: raw.snapshot.future }])
  ];
  const past: CueSnapshot[][] = [];
  const future: CueSnapshot[][] = [];
  for (const f of frames) {
    const r = readCueStack(f.raw);
    if (!r.ok) return { ok: false, reason: `${f.name}：${r.reason}` };
    if (!sameCueIds(r.value, present)) {
      return { ok: false, reason: `${f.name}的字幕集合与当前不一致` };
    }
    if (f.name.startsWith('撤销')) past.push(r.value);
    else future.push(r.value);
  }

  const viewR = readView(raw.view, cueIds);
  if (!viewR.ok) return { ok: false, reason: viewR.reason };

  const audioR = readAudio(raw.audio);
  if (!audioR.ok) return { ok: false, reason: audioR.reason };

  return {
    ok: true,
    record: {
      id: raw.id,
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: raw.revision,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      srtName: raw.srtName,
      snapshot: { past, present, future },
      view: viewR.value,
      audio: audioR.value
    }
  };
}

/* ------------------------------------------------------------------ */
/* 音频指纹                                                            */
/* ------------------------------------------------------------------ */

/**
 * 计算文件 SHA-256（小写 hex）。
 * 纯 JS 实现（见 sha256.ts）：Docker 以 http://<IP>:8080 提供服务时属于非安全
 * 上下文，crypto.subtle 不可用。读取后让出一帧，避免大文件哈希阻塞界面。
 */
export async function sha256File(file: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
  const buf = await file.arrayBuffer();
  await new Promise((r) => setTimeout(r, 0));
  return sha256Bytes(new Uint8Array(buf));
}

/**
 * 重新选择音频时比对指纹：以大小 + SHA-256 为准（重名文件可能内容不同）。
 * 返回 null 表示匹配，否则返回不匹配原因。
 */
export function matchAudioFingerprint(
  fp: AudioFingerprint,
  file: { name: string; size: number; sha256: string }
): { matched: true; nameMismatch: boolean } | { matched: false; reason: string } {
  if (file.size !== fp.size) {
    return { matched: false, reason: `文件大小不一致：需要 ${fp.size} 字节，实际 ${file.size} 字节` };
  }
  if (file.sha256.toLowerCase() !== fp.sha256) {
    return { matched: false, reason: 'SHA-256 不一致，不是同一段音频' };
  }
  return { matched: true, nameMismatch: file.name !== fp.name };
}

/** 生成新的会话 id */
export function newSessionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
