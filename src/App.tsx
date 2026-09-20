import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Toolbar from './components/Toolbar';
import Timeline from './components/Timeline';
import CueList from './components/CueList';
import ShadowPanel from './components/ShadowPanel';
import DriftPanel from './components/DriftPanel';
import type { Constraints, Cue, DriftPreview, SilenceStatus } from './types';
import { formatClock, parseSrt, serializeSrt } from './lib/srt';
import {
  buildDriftPlan,
  parseTimeInput,
  resolveDriftRange,
  secondsToInputTime
} from './lib/drift';
import {
  computeLoopRange,
  DEFAULT_LOOP_MARGINS,
  loopDisableReason,
  loopDisableText,
  loopEntryTarget,
  loopWrapTarget,
  type LoopMargins,
  type LoopRange
} from './lib/abLoop';
import {
  commitHistory,
  initHistory,
  redoHistory,
  replaceHistory,
  undoHistory
} from './lib/cues';
import { detectSilences, type WindowLevels } from './lib/silence';
import {
  AbortToken,
  analyzeAudioFile,
  isAbortError
} from './lib/audioAnalysis';
import {
  matchAudioFingerprint,
  newSessionId,
  sha256File,
  SESSION_SCHEMA_VERSION,
  validateSession,
  type AudioFingerprint,
  type SaveStatus,
  type SessionEntry,
  type SessionRecord,
  type SessionSnapshot
} from './lib/session';
import {
  deleteSession,
  getRawSession,
  isSessionStorageAvailable,
  listSessions,
  putSession,
  SessionStorageError
} from './lib/sessionDb';
import RecoveryDialog from './components/RecoveryDialog';

interface Toast {
  id: number;
  kind: 'warn' | 'info' | 'error';
  text: string;
}

/** 自动保存开关的 localStorage 键（停用偏好本身不放进 IndexedDB） */
const AUTOSAVE_KEY = 'subtitle-deck.autosave';
/** 自动保存去抖间隔（ms） */
const SAVE_DEBOUNCE_MS = 400;

function loadAutoSavePref(): boolean {
  try {
    return localStorage.getItem(AUTOSAVE_KEY) !== '0';
  } catch {
    return true;
  }
}

function persistAutoSavePref(on: boolean): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, on ? '1' : '0');
  } catch {
    /* 隐私模式等：忽略，本次会话内仍生效 */
  }
}

/** dBFS 风格阈值转线性振幅：-60dB≈0.001, -40dB=0.01, -20dB=0.1 */
function dbToAmplitude(db: number): number {
  return Math.min(1, Math.pow(10, db / 20));
}

export default function App() {
  const [history, setHistory] = useState(() => initHistory([]));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [constraints, setConstraints] = useState<Constraints>({
    minDuration: 0.5,
    minGap: 0.08
  });
  const [pps, setPps] = useState(80);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [srtName, setSrtName] = useState<string | null>(null);
  const [audioName, setAudioName] = useState<string | null>(null);
  // 当前音频的 Object URL 镜像状态：供跟读面板创建独立播放轨（权威值仍在 audioUrlRef）
  const [audioObjectUrl, setAudioObjectUrl] = useState<string | null>(null);
  // 单句跟读忙碌态（倒计时 + 录音）：期间暂停 A-B 回卷，结束自动恢复原开关状态
  const [shadowBusy, setShadowBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // 静音分析：吸附开关、可调阈值（dB）、分析状态与窗口能量
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-40);
  const [levels, setLevels] = useState<WindowLevels | null>(null);
  const [silenceStatus, setSilenceStatus] = useState<SilenceStatus>('idle');
  const [silenceError, setSilenceError] = useState<string | null>(null);

  // A-B 循环试听：开关与前后余量（区间由选中字幕推导，见下方 loopRange）
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [loopMargins, setLoopMargins] = useState<LoopMargins>(DEFAULT_LOOP_MARGINS);

  // 区间漂移校准：锚点（最后一次普通点击的字幕）、Shift 指定的区间终点、目标锚点输入
  const [driftAnchorId, setDriftAnchorId] = useState<string | null>(null);
  const [driftEndId, setDriftEndId] = useState<string | null>(null);
  const [driftInputs, setDriftInputs] = useState<{ start: string; end: string } | null>(null);
  // 强制列表 / 时间轴重新滚动到选中字幕的信号（定位冲突时选中项可能未变）
  const [focusNonce, setFocusNonce] = useState(0);

  /* ---------------- 本地会话恢复 / 自动保存 ---------------- */
  // 当前工作区绑定的会话 id：导入 SRT 时新建；恢复会话时沿用；空白工作区为 null
  const [sessionId, setSessionId] = useState<string | null>(null);
  // 音频指纹（仅名称/大小/SHA-256，文件本身不落盘）；与 audioName 同生灭
  const [audioFingerprint, setAudioFingerprint] = useState<AudioFingerprint | null>(null);
  // 恢复会话后音频尚未重新匹配：播放 / A-B / 跟读禁用，字幕编辑与导出不受影响
  const [audioPending, setAudioPending] = useState(false);
  const [autoSave, setAutoSave] = useState(loadAutoSavePref);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryEntries, setRecoveryEntries] = useState<SessionEntry[]>([]);
  const [recoveryLoading, setRecoveryLoading] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const toastId = useRef(0);
  // 当前音频分析的取消令牌；更换音频时取消旧分析并阻止旧结果回写
  const analysisTokenRef = useRef<AbortToken | null>(null);
  // 最新循环计划的镜像，供音频事件 / rAF 回调读取，避免闭包过期；
  // 暂停、导入新音频或关闭循环时同步置为失效，旧回调读到 inactive 即落空
  const loopPlanRef = useRef<{ active: boolean; range: LoopRange | null }>({
    active: false,
    range: null
  });
  // 跟读录音忙碌态的 ref 镜像，供音频事件 / 键盘回调读取最新值
  const shadowBusyRef = useRef(false);
  // 最新一次正常导入音频的令牌：哈希返回时必须仍是当前导入，防止旧指纹回写
  const audioLoadTokenRef = useRef(0);

  // 自动保存：已落盘的 revision（单调递增，仅 CAS 写入成功后推进）、会话创建时间、
  // 去抖计时器与串行写入标志；恢复会话后的首次状态变化不应触发「旧快照」覆盖
  const savedRevisionRef = useRef(0);
  const createdAtRef = useRef<number | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const saveQueuedRef = useRef(false);
  // 在途写入的 Promise（恢复切换会话前 await，确保最后一笔快照已落盘或已被 queued 补刷）
  const inFlightPromiseRef = useRef<Promise<void> | null>(null);
  const suppressSaveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const autoSaveRef = useRef(autoSave);
  const fingerprintRef = useRef<AudioFingerprint | null>(null);
  autoSaveRef.current = autoSave;
  fingerprintRef.current = audioFingerprint;
  sessionIdRef.current = sessionId;

  const cues = history.present;

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    toastId.current += 1;
    const id = toastId.current;
    setToasts((t) => [...t, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4200);
  }, []);

  /* ---------------- 区间漂移校准：选择与清空 ---------------- */

  /** 清空区间与预览（取消、切换文件时调用） */
  const clearDrift = useCallback(() => {
    setDriftAnchorId(null);
    setDriftEndId(null);
    setDriftInputs(null);
  }, []);

  /** 普通选择：更新选中与漂移锚点并收起已选区间；点击空白处仅取消选中，不动区间预览 */
  const handleSelectCue = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id === null) return;
    setDriftAnchorId(id);
    setDriftEndId(null);
    setDriftInputs(null);
  }, []);

  /** Shift+点击：以当前锚点为起点选择连续区间，并用原始锚点初始化目标输入 */
  const handleExtendDriftRange = useCallback(
    (id: string) => {
      const anchor = driftAnchorId ?? selectedId ?? id;
      const range = resolveDriftRange(cues, anchor, id);
      if (range.length === 0) return;
      setDriftAnchorId(anchor);
      setDriftEndId(id);
      setSelectedId(id);
      setDriftInputs({
        start: secondsToInputTime(range[0].start),
        end: secondsToInputTime(range[range.length - 1].end)
      });
    },
    [cues, driftAnchorId, selectedId]
  );

  /* ---------------- 音频 ---------------- */

  const ensureAudio = useCallback(() => {
    if (!audioRef.current) {
      const el = new Audio();
      el.preload = 'auto';
      el.addEventListener('timeupdate', () => setCurrentTime(el.currentTime));
      el.addEventListener('loadedmetadata', () => setDuration(el.duration || 0));
      el.addEventListener('play', () => setIsPlaying(true));
      el.addEventListener('pause', () => setIsPlaying(false));
      el.addEventListener('ended', () => {
        // B 点被裁剪到音频结尾时，'ended' 先于「越过 B」发生：循环仍激活则回到 A 继续；
        // 读取的是最新循环计划，导入新音频 / 关闭循环后计划已失效，不会拉回播放头
        const plan = loopPlanRef.current;
        if (plan.active && plan.range) {
          el.currentTime = plan.range.a;
          setCurrentTime(plan.range.a);
          void el.play().catch(() => setIsPlaying(false));
          return;
        }
        setIsPlaying(false);
      });
      audioRef.current = el;
    }
    return audioRef.current;
  }, []);

  useEffect(() => {
    return () => {
      analysisTokenRef.current?.abort();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioRef.current?.pause();
    };
  }, []);

  /**
   * 跟读录音忙碌态变化：录音期间暂停主导航播放并抑制 A-B 回卷；
   * 用户的循环开关状态本身不改动，忙碌结束后自动按原开关恢复。
   */
  const handleShadowBusyChange = useCallback((busy: boolean) => {
    shadowBusyRef.current = busy;
    setShadowBusy(busy);
    if (busy) {
      loopPlanRef.current = { active: false, range: null };
      audioRef.current?.pause();
    }
  }, []);

  /** 用 Web Audio API 解码并分析窗口能量；token 保证旧音频结果不会回写 */
  const runSilenceAnalysis = useCallback(
    (file: File) => {
      analysisTokenRef.current?.abort();
      const token = new AbortToken();
      analysisTokenRef.current = token;
      setSilenceStatus('analyzing');
      setSilenceError(null);
      analyzeAudioFile(file, token)
        .then((result) => {
          if (token.signal) return; // 已更换音频，丢弃旧结果
          setLevels({ levels: result.levels, windowSize: result.windowSize, duration: result.duration });
          setSilenceStatus('done');
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) return; // 更换音频导致的取消，静默处理
          setSilenceStatus('error');
          setSilenceError(err instanceof Error ? err.message : String(err));
          pushToast('error', `静音分析失败：${err instanceof Error ? err.message : '音频无法解码'}`);
        });
    },
    [pushToast]
  );

  /** 把文件装载进 <audio> 元素并启动静音分析；调用方负责指纹 / 漂移清空等会话语义 */
  const loadAudioFile = useCallback(
    (file: File) => {
      // 先作废旧循环计划：换源期间已排队的播放回调不得再拉回播放头
      loopPlanRef.current = { active: false, range: null };
      audioLoadTokenRef.current += 1;
      const el = ensureAudio();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      const url = URL.createObjectURL(file);
      audioUrlRef.current = url;
      setAudioObjectUrl(url);
      el.src = url;
      el.load();
      setAudioName(file.name);
      setCurrentTime(0);
      setDuration(0);
      setLevels(null);
      // 取消旧分析（若正在进行），并以新令牌开始本次分析，阻止旧结果回写
      runSilenceAnalysis(file);
    },
    [ensureAudio, runSilenceAnalysis]
  );

  /**
   * 导入音频。
   * - audioPending（刚恢复的会话）时不直接装载：先比对大小 + SHA-256，
   *   指纹匹配才重新启用播放；不匹配保留等待状态，不改动当前工作区音频。
   * - 正常导入：计算指纹（文件不落盘）后装载；哈希失败不阻止使用，只是会话
   *   里没有可用指纹（恢复时无法校验，需重新计算）。
   */
  const handleImportAudio = useCallback(
    (file: File) => {
      if (audioPending && audioFingerprint) {
        const wanted = audioFingerprint;
        pushToast('info', `正在校验音频指纹：${file.name}`);
        sha256File(file)
          .then((sha) => {
            const m = matchAudioFingerprint(wanted, { name: file.name, size: file.size, sha256: sha });
            if (!m.matched) {
              pushToast('error', `音频与恢复记录不匹配：${m.reason}`);
              return;
            }
            clearDrift();
            loadAudioFile(file);
            setAudioFingerprint({ name: wanted.name, size: wanted.size, sha256: wanted.sha256 });
            setAudioPending(false);
            if (m.nameMismatch) {
              pushToast('warn', `内容指纹一致，但文件名与记录不同（记录为 ${wanted.name}），已启用播放`);
            } else {
              pushToast('info', '音频指纹匹配，已重新启用播放');
            }
          })
          .catch((err: unknown) => {
            pushToast('error', `音频指纹计算失败：${err instanceof Error ? err.message : String(err)}`);
          });
        return;
      }

      clearDrift(); // 切换文件：清空区间漂移预览
      loadAudioFile(file);
      const token = audioLoadTokenRef.current;
      // 指纹异步计算：完成后只做一次「指纹到位」的快照保存（内容/历史未变也无妨，
      // 该次 revision 仍严格递增）
      sha256File(file)
        .then((sha) => {
          // 与最新导入令牌对照，避免哈希期间又换了文件导致旧指纹回写
          if (token !== audioLoadTokenRef.current) return;
          setAudioFingerprint({ name: file.name, size: file.size, sha256: sha });
        })
        .catch((err: unknown) => {
          pushToast('warn', `音频指纹计算失败，该会话将无法校验音频：${err instanceof Error ? err.message : String(err)}`);
          setAudioFingerprint(null);
        });
      pushToast('info', `已加载音频：${file.name}`);
    },
    [audioPending, audioFingerprint, clearDrift, loadAudioFile, pushToast]
  );

  // 阈值调整时基于窗口能量重新分段（纯前端计算，无需重新解码）
  const silenceThreshold = useMemo(() => dbToAmplitude(silenceThresholdDb), [silenceThresholdDb]);
  const silenceSegments = useMemo(
    () => (levels ? detectSilences(levels, { threshold: silenceThreshold }) : []),
    [levels, silenceThreshold]
  );

  const seek = useCallback(
    (t: number, play = false) => {
      const el = audioRef.current;
      if (shadowBusyRef.current && play) {
        // 跟读录音中禁止主导航自动播放，避免与跟读原音轨叠加
        return;
      }
      if (!el || !audioUrlRef.current || audioPending) {
        // 未导入音频 / 等待重新匹配音频时仍允许播放头移动，便于纯字幕检查
        setCurrentTime(Math.max(0, t));
        return;
      }
      const target = Math.max(0, Math.min(t, el.duration || t));
      el.currentTime = target;
      setCurrentTime(target);
      if (play) {
        void el.play().catch(() => pushToast('error', '浏览器拒绝了自动播放，请再点一次播放'));
      }
    },
    [pushToast, audioPending]
  );

  const seekAndPlay = useCallback((t: number) => seek(t, true), [seek]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (shadowBusyRef.current) {
      // 跟读倒计时 / 录音中主导航让位于录音轨，避免与原音轨叠加播放
      pushToast('warn', '跟读录音进行中，请使用跟读面板控制');
      return;
    }
    if (!el || !audioUrlRef.current) {
      pushToast(
        'warn',
        audioPending
          ? '请先重新选择与该会话匹配的音频（大小 + SHA-256 校验通过）后再播放；字幕编辑与导出不受影响'
          : '请先导入浏览器可播放的音频文件'
      );
      return;
    }
    if (el.paused) void el.play();
    else el.pause();
  }, [pushToast, audioPending]);

  /* ---------------- A-B 循环试听 ---------------- */

  const selectedCue = useMemo(() => cues.find((c) => c.id === selectedId) ?? null, [cues, selectedId]);
  // 音频真正可播放：已导入且与恢复指纹匹配（等待重选音频期间为 false）
  const hasAudio = audioName !== null && !audioPending;
  // 区间 = 选中字幕 ± 前后余量，裁剪到音频时长；选择或余量变化时自动更新
  const loopRange = useMemo(
    () => computeLoopRange(selectedCue, loopMargins, duration),
    [selectedCue, loopMargins, duration]
  );
  const loopDisabled = loopDisableReason(hasAudio, selectedCue, loopRange);
  // 跟读录音（倒计时 + 录音）期间暂停回卷：开关状态保留，结束自动恢复
  const loopActive = loopEnabled && loopDisabled === null && loopRange !== null && !shadowBusy;
  const loopSuspended = loopEnabled && loopDisabled === null && shadowBusy;

  // 渲染期同步最新循环计划，供音频事件 / rAF 回调读取（写入幂等，StrictMode 安全）
  loopPlanRef.current = { active: loopActive, range: loopActive ? loopRange : null };

  // 帧级回卷监听：播放中越过 B 点即回到 A 点继续。
  // 依赖变化（暂停 / 关闭 / 区间失效）或卸载时取消 rAF，且 tick 内再校验最新计划，
  // 保证旧回调不会再次拉回播放头。
  const loopMonitoring = loopActive && isPlaying;
  useEffect(() => {
    if (!loopMonitoring) return;
    const el = audioRef.current;
    if (!el) return;
    let raf = 0;
    const tick = () => {
      const plan = loopPlanRef.current;
      if (plan.active && plan.range && !el.paused) {
        const target = loopWrapTarget(el.currentTime, plan.range);
        if (target !== null) {
          el.currentTime = target;
          setCurrentTime(target);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loopMonitoring]);

  // 开启循环或切换选择后：播放头落在新区间外则立即跳到新 A 点（保持当前播放/暂停状态）
  const loopEntryKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!loopActive || !loopRange) {
      loopEntryKeyRef.current = null;
      return;
    }
    const key = selectedId ?? '';
    if (loopEntryKeyRef.current === key) return; // 同一路径不重复校正（余量微调不抢播放头）
    loopEntryKeyRef.current = key;
    const el = audioRef.current;
    const now = el && audioUrlRef.current ? el.currentTime : currentTime;
    const target = loopEntryTarget(now, loopRange);
    if (target !== null) seek(target);
  }, [loopActive, loopRange, selectedId, seek, currentTime]);

  const handleLoopEnabledChange = useCallback((on: boolean) => {
    if (!on) {
      // 关闭循环：同步作废旧计划，已排队的播放回调不再拉回播放头
      loopPlanRef.current = { active: false, range: null };
    }
    setLoopEnabled(on);
  }, []);

  /* ---------------- 历史 ---------------- */

  const commit = useCallback((next: Cue[]) => {
    setHistory((h) => commitHistory(h, next));
  }, []);

  const undo = useCallback(() => setHistory((h) => undoHistory(h)), []);
  const redo = useCallback(() => setHistory((h) => redoHistory(h)), []);

  /* ---------------- 区间漂移校准 ---------------- */

  // 区间信息（与输入是否合法无关）：条数、列表序号与原始锚点
  const driftRangeInfo = useMemo(() => {
    if (!driftAnchorId || !driftEndId) return null;
    const range = resolveDriftRange(cues, driftAnchorId, driftEndId);
    if (range.length === 0) return null;
    const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
    const first = sorted.findIndex((c) => c.id === range[0].id);
    const last = sorted.findIndex((c) => c.id === range[range.length - 1].id);
    return {
      ids: range.map((c) => c.id),
      count: range.length,
      first: first + 1,
      last: last + 1,
      oldStart: range[0].start,
      oldEnd: range[range.length - 1].end
    };
  }, [cues, driftAnchorId, driftEndId]);

  const driftParsed = useMemo(() => {
    if (!driftInputs) return null;
    return { start: parseTimeInput(driftInputs.start), end: parseTimeInput(driftInputs.end) };
  }, [driftInputs]);

  // 映射计划：输入可解析时始终完成映射（供预览），并给出按时间序的首个冲突
  const driftPlan = useMemo(() => {
    if (!driftAnchorId || !driftEndId || !driftParsed) return null;
    if (driftParsed.start === null || driftParsed.end === null) return null;
    return buildDriftPlan(
      cues,
      driftAnchorId,
      driftEndId,
      driftParsed.start,
      driftParsed.end,
      constraints
    );
  }, [cues, constraints, driftAnchorId, driftEndId, driftParsed]);

  // 时间轴预览：旧位置（原块半透明）+ 新位置（虚影）+ 缩放比例
  const driftPreview = useMemo<DriftPreview | null>(() => {
    if (!driftPlan) return null;
    const inRange = new Set(driftPlan.rangeIds);
    return {
      rangeIds: driftPlan.rangeIds,
      mapped: driftPlan.mappedAll.filter((c) => inRange.has(c.id)),
      newStart: driftPlan.newStart,
      newEnd: driftPlan.newEnd,
      scale: driftPlan.scale,
      valid: driftPlan.conflict === null,
      conflictCueId: driftPlan.conflict?.cueId ?? null
    };
  }, [driftPlan]);

  const driftConflictId = driftPlan?.conflict?.cueId ?? null;
  const lastAutoLocateRef = useRef<string | null>(null);
  // 出现冲突时自动定位首个冲突字幕（同一冲突不重复抢选择；直接 setSelectedId 以保留区间）
  useEffect(() => {
    if (!driftConflictId) {
      lastAutoLocateRef.current = null;
      return;
    }
    if (lastAutoLocateRef.current === driftConflictId) return;
    lastAutoLocateRef.current = driftConflictId;
    setSelectedId(driftConflictId);
    setFocusNonce((n) => n + 1);
  }, [driftConflictId]);

  const locateDriftConflict = useCallback(() => {
    if (!driftConflictId) return;
    setSelectedId(driftConflictId);
    setFocusNonce((n) => n + 1);
  }, [driftConflictId]);

  /** 合法结果作为一次历史记录提交（整体可撤销/重做，走现有 SRT 导出） */
  const applyDrift = useCallback(() => {
    if (!driftPlan || driftPlan.conflict) return;
    commit(driftPlan.mappedAll);
    pushToast(
      'info',
      `已应用区间漂移校准：${driftPlan.rangeIds.length} 条字幕 · 缩放 ×${driftPlan.scale.toFixed(3)}`
    );
    clearDrift();
  }, [driftPlan, commit, pushToast, clearDrift]);

  /* ---------------- SRT ---------------- */

  const handleImportSrt = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = parseSrt(String(reader.result ?? ''));
        if (result.cues.length === 0) {
          pushToast('error', '未从该文件解析出任何有效字幕');
          return;
        }
        clearDrift(); // 切换字幕文件：清空区间漂移预览
        // 新 SRT = 新会话：重置修订号 / 创建时间，并丢弃上一文件的音频与等待态
        if (audioUrlRef.current) {
          URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = null;
          audioRef.current?.pause();
          audioRef.current?.removeAttribute('src');
          audioRef.current?.load();
        }
        audioLoadTokenRef.current += 1;
        setAudioObjectUrl(null);
        setAudioName(null);
        setAudioFingerprint(null);
        setAudioPending(false);
        setDuration(0);
        setCurrentTime(0);
        setLevels(null);
        setSilenceStatus('idle');
        setSilenceError(null);
        setLoopEnabled(false);
        loopPlanRef.current = { active: false, range: null };
        const id = newSessionId();
        savedRevisionRef.current = 0;
        createdAtRef.current = Date.now();
        suppressSaveRef.current = false;
        setSessionId(id);
        setHistory((h) => replaceHistory(h, result.cues));
        setSrtName(file.name);
        setSelectedId(result.cues[0]?.id ?? null);
        pushToast('info', `已导入 ${result.cues.length} 条字幕：${file.name}`);
        result.warnings.forEach((w) => pushToast('warn', w));
      };
      reader.onerror = () => pushToast('error', `读取文件失败：${file.name}`);
      reader.readAsText(file, 'utf-8');
    },
    [pushToast, clearDrift]
  );

  /* ---------------- 历史：快捷键 ---------------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, togglePlay]);

  /* ---------------- 导出 ---------------- */

  const exportSrt = useCallback(() => {
    if (cues.length === 0) {
      pushToast('warn', '没有可导出的字幕');
      return;
    }
    const blob = new Blob([serializeSrt(cues)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const base = (srtName ?? 'subtitles.srt').replace(/\.srt$/i, '');
    a.href = url;
    a.download = `${base}.fixed.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    pushToast('info', '已导出按时间顺序重新编号的 SRT');
  }, [cues, srtName, pushToast]);

  /* ---------------- 本地会话：自动保存 / 恢复 / 删除 ---------------- */

  /** 组装一次完整快照（字幕 + 撤销/重做历史 + 约束 + 视图 + 音频指纹） */
  const buildSnapshot = useCallback((): SessionSnapshot => {
    return { past: history.past, present: history.present, future: history.future };
  }, [history.past, history.present, history.future]);

  /** 立即把当前快照刷入 IndexedDB（去抖到期与页面隐藏时共用） */
  const flushSave = useCallback(async (): Promise<void> => {
    const id = sessionIdRef.current;
    if (!autoSaveRef.current || !id || suppressSaveRef.current) return;
    if (history.present.length === 0 || !srtName) return; // 空白工作区不落盘
    if (saveInFlightRef.current) {
      saveQueuedRef.current = true; // 写入进行中：标记再次排队，完成后补刷最新状态
      await inFlightPromiseRef.current; // 供调用方等待在途写入 + queued 补刷全部完成
      return;
    }
    const task = (async () => {
    saveInFlightRef.current = true;
    setSaveStatus({ kind: 'saving' });
    const revision = savedRevisionRef.current + 1;
    const now = Date.now();
    const record: SessionRecord = {
      id,
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision,
      createdAt: createdAtRef.current ?? now,
      updatedAt: now,
      srtName,
      snapshot: buildSnapshot(),
      view: {
        constraints,
        pps,
        snapEnabled,
        silenceThresholdDb,
        loopEnabled,
        loopMargins,
        selectedId
      },
      audio: fingerprintRef.current
    };
    try {
      const result = await putSession(record);
      if (result.written) {
        // 仅在事务内 CAS 通过后推进本地 revision：保证单调递增、旧快照永不覆盖新状态
        savedRevisionRef.current = revision;
        setSaveStatus({ kind: 'saved', at: Date.now() });
      } else {
        // 已存在更新的 revision（典型：另一个标签页写过同一会话）——拒绝覆盖，
        // 本标签页停止继续自动保存，避免把旧状态反复写回；用户可在会话列表处理
        saveQueuedRef.current = false;
        setAutoSave(false);
        persistAutoSavePref(false);
        setSaveStatus({
          kind: 'error',
          message: '检测到该会话在别处已更新（r' + Math.max(result.storedRevision, 0) + '），本页自动保存已停止'
        });
        pushToast('error', '会话修订冲突：另一个页面已写入更新的快照，本页已停止自动保存以防覆盖');
      }
    } catch (err) {
      const msg = err instanceof SessionStorageError ? err.message : err instanceof Error ? err.message : String(err);
      setSaveStatus({ kind: 'error', message: msg });
      pushToast('error', `会话自动保存失败：${msg}`);
    } finally {
      saveInFlightRef.current = false;
      if (saveQueuedRef.current) {
        saveQueuedRef.current = false;
        await flushSave();
      }
    }
    })();
    inFlightPromiseRef.current = task;
    try {
      await task;
    } finally {
      inFlightPromiseRef.current = null;
    }
  }, [
    buildSnapshot,
    constraints,
    loopEnabled,
    loopMargins,
    pps,
    pushToast,
    selectedId,
    silenceThresholdDb,
    snapEnabled,
    srtName,
    history.present
  ]);

  // 字幕内容 / 历史 / 约束 / 视图设置变化后去抖自动保存（每次成功写入 revision +1）
  useEffect(() => {
    if (!autoSave || !sessionId || suppressSaveRef.current || cues.length === 0) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    setSaveStatus((s) => (s.kind === 'saving' ? s : { kind: 'pending' }));
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void flushSave();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    autoSave,
    sessionId,
    cues,
    history.past,
    history.future,
    constraints,
    pps,
    snapEnabled,
    silenceThresholdDb,
    loopEnabled,
    loopMargins,
    selectedId,
    audioFingerprint,
    flushSave
  ]);

  // 页面隐藏 / 关闭前尽力刷盘（IndexedDB 事务通常仍可完成）
  useEffect(() => {
    const flush = () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      void flushSave();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushSave]);

  /** 打开会话恢复弹窗并重新读取列表 */
  const refreshRecoveryList = useCallback(async () => {
    if (!isSessionStorageAvailable()) {
      setRecoveryEntries([]);
      return;
    }
    setRecoveryLoading(true);
    try {
      setRecoveryEntries(await listSessions());
    } catch (err) {
      pushToast('error', `读取会话列表失败：${err instanceof Error ? err.message : String(err)}`);
      setRecoveryEntries([]);
    } finally {
      setRecoveryLoading(false);
    }
  }, [pushToast]);

  const openRecovery = useCallback(() => {
    setRecoveryOpen(true);
    void refreshRecoveryList();
  }, [refreshRecoveryList]);

  // 首次打开：存在可恢复会话时自动列出（不强制恢复，可直接开始空白工作区）
  useEffect(() => {
    let cancelled = false;
    if (!isSessionStorageAvailable()) return;
    listSessions()
      .then((entries) => {
        if (!cancelled && entries.length > 0) {
          setRecoveryEntries(entries);
          setRecoveryOpen(true);
        }
      })
      .catch(() => {
        /* IndexedDB 不可用：静默退化为无恢复能力的纯内存工具 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 恢复会话：先完整校验版本与数据结构，任何一项失败都直接返回原因，
   * 绝不触碰当前工作区。校验通过后所有状态在同一批次替换（失败不得留下半成品）。
   */
  const handleRestoreSession = useCallback(
    async (id: string) => {
      let raw: unknown = null;
      try {
        // 直接取原始记录，再由校验器给出权威结论（列表中的 invalid 也因此不能恢复）
        raw = await getRawSession(id);
      } catch (err) {
        pushToast('error', `读取会话失败：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (raw === null) {
        pushToast('error', '该会话已不存在（可能已被删除），列表将刷新');
        await refreshRecoveryList();
        return;
      }
      const checked = validateSession(raw);
      if (!checked.ok) {
        pushToast('error', `会话校验失败，当前工作区未改动：${checked.reason}`);
        await refreshRecoveryList();
        return;
      }
      const r = checked.record;

      // 当前工作区已有未保存内容时二次确认（自动保存停用 / 或仍是空白才静默）
      if (sessionId && sessionId !== r.id) {
        const ok = window.confirm('恢复该会话将替换当前工作区的全部内容，确定继续吗？');
        if (!ok) return;
        // 替换前先把当前会话去抖中（或在途排队）的快照落盘，避免丢掉最后几笔修改
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        await flushSave();
      }

      // --- 校验通过，以下开始原子式替换工作区 ---
      suppressSaveRef.current = true;

      // 丢弃当前音频元素（Object URL 指向的文件无法跨页面存活）
      loopPlanRef.current = { active: false, range: null };
      audioLoadTokenRef.current += 1;
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
      audioRef.current?.pause();
      audioRef.current?.removeAttribute('src');
      audioRef.current?.load();
      analysisTokenRef.current?.abort();

      setSessionId(r.id);
      savedRevisionRef.current = r.revision;
      createdAtRef.current = r.createdAt;
      setSrtName(r.srtName);
      setHistory({
        past: r.snapshot.past.map((frame) => frame.map((c) => ({ ...c }))),
        present: r.snapshot.present.map((c) => ({ ...c })),
        future: r.snapshot.future.map((frame) => frame.map((c) => ({ ...c })))
      });
      setConstraints({ ...r.view.constraints });
      setPps(r.view.pps);
      setSnapEnabled(r.view.snapEnabled);
      setSilenceThresholdDb(r.view.silenceThresholdDb);
      setLoopEnabled(r.view.loopEnabled);
      setLoopMargins({ ...r.view.loopMargins });
      setSelectedId(r.view.selectedId);
      setDriftAnchorId(null);
      setDriftEndId(null);
      setDriftInputs(null);
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      setLevels(null);
      setSilenceStatus('idle');
      setSilenceError(null);
      setAudioObjectUrl(null);
      setAudioName(r.audio?.name ?? null);
      setAudioFingerprint(r.audio ? { ...r.audio } : null);
      setAudioPending(r.audio !== null);
      setFocusNonce((n) => n + 1);
      setSaveStatus({ kind: 'idle' });

      // 同一批次后的下一个事件循环解除抑制：恢复本身不产生快照写入
      window.setTimeout(() => {
        suppressSaveRef.current = false;
      }, 0);

      setRecoveryOpen(false);
      pushToast(
        'info',
        r.audio
          ? `已恢复会话「${r.srtName}」（r${r.revision}）：请重新选择音频「${r.audio.name}」，指纹匹配后才能播放`
          : `已恢复会话「${r.srtName}」（r${r.revision}）`
      );
    },
    [pushToast, refreshRecoveryList, sessionId, flushSave]
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      if (id === sessionId) {
        pushToast('warn', '该会话就是当前工作区，请先导入其他 SRT 或关闭页面后再删除');
        return;
      }
      await deleteSession(id);
      pushToast('info', '会话记录已删除');
      await refreshRecoveryList();
    },
    [pushToast, refreshRecoveryList, sessionId]
  );

  const handleAutoSaveChange = useCallback((on: boolean) => {
    setAutoSave(on);
    persistAutoSavePref(on);
    if (!on) {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      setSaveStatus({ kind: 'idle' });
    }
  }, []);

  const statusText = useMemo(() => {
    const parts: string[] = [];
    parts.push(cues.length === 0 ? '等待导入：先选择 SRT，再选择音频' : `${cues.length} 条字幕`);
    if (silenceStatus === 'analyzing') parts.push('静音分析中…');
    else if (silenceStatus === 'done') {
      parts.push(`${silenceSegments.length} 段静音` + (snapEnabled ? '· 吸附已开启' : '· 吸附已关闭'));
    } else if (silenceStatus === 'error') parts.push('静音分析失败');
    if (loopActive && loopRange) {
      parts.push(`A-B 循环 ${formatClock(loopRange.a)} → ${formatClock(loopRange.b)}`);
    } else if (loopSuspended) {
      parts.push('跟读录音中 · A-B 回卷已暂时暂停');
    } else if (loopEnabled && loopDisabled) {
      parts.push(`循环待机：${loopDisableText(loopDisabled)}`);
    }
    if (shadowBusy) parts.push('正在跟读录音');
    if (driftPlan) {
      parts.push(
        driftPlan.conflict
          ? '区间漂移存在冲突，禁止提交'
          : `区间漂移预览 ×${driftPlan.scale.toFixed(3)}（${driftPlan.rangeIds.length} 条）`
      );
    } else if (driftRangeInfo) {
      parts.push(`区间漂移待输入目标锚点（${driftRangeInfo.count} 条）`);
    }
    if (cues.length > 0) parts.push(`已记录 ${history.past.length} 次调整`);
    if (audioPending) parts.push('等待重新选择音频（播放已停用，编辑/导出不受影响）');
    if (sessionId) {
      if (!autoSave) parts.push('自动保存已停用');
      else if (saveStatus.kind === 'saving' || saveStatus.kind === 'pending') parts.push('正在自动保存…');
      else if (saveStatus.kind === 'error') parts.push(`自动保存失败：${saveStatus.message}`);
    }
    return parts.join(' · ');
  }, [
    cues.length,
    history.past.length,
    silenceStatus,
    silenceSegments.length,
    snapEnabled,
    loopActive,
    loopSuspended,
    loopRange,
    loopEnabled,
    loopDisabled,
    shadowBusy,
    driftPlan,
    driftRangeInfo,
    audioPending,
    sessionId,
    autoSave,
    saveStatus
  ]);

  return (
    <div className="app">
      <Toolbar
        audioName={audioName}
        audioPending={audioPending}
        srtName={srtName}
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        pps={pps}
        constraints={constraints}
        onImportSrt={handleImportSrt}
        onImportAudio={handleImportAudio}
        onTogglePlay={togglePlay}
        onSeek={seekAndPlay}
        onUndo={undo}
        onRedo={redo}
        onZoom={setPps}
        onConstraintsChange={setConstraints}
        onExport={exportSrt}
        canExport={cues.length > 0}
        snapEnabled={snapEnabled}
        onSnapEnabledChange={setSnapEnabled}
        silenceThresholdDb={silenceThresholdDb}
        onSilenceThresholdChange={setSilenceThresholdDb}
        silenceStatus={silenceStatus}
        silenceSegmentCount={silenceSegments.length}
        silenceError={silenceError}
        loopEnabled={loopEnabled}
        loopRange={loopActive ? loopRange : null}
        loopSuspended={loopSuspended}
        loopDisabledReason={loopDisabled ? loopDisableText(loopDisabled) : null}
        loopMargins={loopMargins}
        onLoopEnabledChange={handleLoopEnabledChange}
        onLoopMarginsChange={setLoopMargins}
        autoSave={autoSave}
        saveStatus={saveStatus}
        onAutoSaveChange={handleAutoSaveChange}
        onOpenRecovery={openRecovery}
      />

      {audioPending && audioFingerprint && (
        <div className="audio-pending-banner">
          <span className="audio-pending-icon">🔇</span>
          <span className="audio-pending-text">
            已恢复会话：音频文件不会随会话保存。请重新选择
            <strong title={`大小 ${audioFingerprint.size} 字节 · SHA-256 ${audioFingerprint.sha256}`}>
              {' '}
              {audioFingerprint.name}{' '}
            </strong>
            （大小 {audioFingerprint.size} 字节 · SHA-256
            <code>{audioFingerprint.sha256.slice(0, 12)}…</code>
            ），指纹匹配后才重新启用播放；字幕编辑与导出不受影响。
          </span>
          <label className="btn mini primary">
            重新选择音频
            <input
              type="file"
              accept="audio/*,.m4a,.aac,.ogg,.opus,.webm"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleImportAudio(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      )}

      <main className="main">
        <section className="stage">
          <div className="status-bar">
            <span>{statusText}</span>
            <span className="status-hint">
              拖动字幕块左右边界校对 · 靠近静音带边缘 150ms 自动吸附 · 越界自动回弹并提示原因 · 点击字幕块定位播放 · 列表 Shift+点击选区间做漂移校准
            </span>
          </div>
          <Timeline
            cues={cues}
            duration={duration}
            currentTime={currentTime}
            isPlaying={isPlaying}
            pps={pps}
            constraints={constraints}
            selectedId={selectedId}
            silences={silenceSegments}
            snapEnabled={snapEnabled}
            loopRange={loopActive ? loopRange : null}
            driftPreview={driftPreview}
            focusNonce={focusNonce}
            onSelect={handleSelectCue}
            onSeek={seekAndPlay}
            onCommit={commit}
            onNotice={(text) => pushToast('warn', text)}
          />
          {driftRangeInfo && driftInputs && (
            <DriftPanel
              rangeCount={driftRangeInfo.count}
              firstIndex={driftRangeInfo.first}
              lastIndex={driftRangeInfo.last}
              oldStart={driftRangeInfo.oldStart}
              oldEnd={driftRangeInfo.oldEnd}
              startInput={driftInputs.start}
              endInput={driftInputs.end}
              startValid={driftParsed?.start !== null}
              endValid={driftParsed?.end !== null}
              plan={driftPlan}
              onStartInput={(v) => setDriftInputs((s) => (s ? { ...s, start: v } : s))}
              onEndInput={(v) => setDriftInputs((s) => (s ? { ...s, end: v } : s))}
              onApply={applyDrift}
              onCancel={clearDrift}
              onLocateConflict={locateDriftConflict}
            />
          )}
          <ShadowPanel
            cue={selectedCue}
            audioUrl={audioObjectUrl}
            duration={duration}
            onNotice={(text) => pushToast('warn', text)}
            onBusyChange={handleShadowBusyChange}
          />
        </section>
        <CueList
          cues={cues}
          currentTime={currentTime}
          selectedId={selectedId}
          driftRangeIds={driftRangeInfo?.ids ?? null}
          driftConflictId={driftConflictId}
          focusNonce={focusNonce}
          onSelect={handleSelectCue}
          onExtendRange={handleExtendDriftRange}
          onSeek={seekAndPlay}
        />
      </main>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>

      {recoveryOpen && (
        <RecoveryDialog
          entries={recoveryEntries}
          loading={recoveryLoading}
          activeSessionId={sessionId}
          autoSave={autoSave}
          onAutoSaveChange={handleAutoSaveChange}
          onRestore={handleRestoreSession}
          onDelete={handleDeleteSession}
          onClose={() => setRecoveryOpen(false)}
        />
      )}
    </div>
  );
}
