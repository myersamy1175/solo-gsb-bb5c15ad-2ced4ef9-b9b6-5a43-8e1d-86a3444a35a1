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
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_PREF_KEY,
  buildSessionState,
  validateSessionState,
  type AudioFingerprint,
  type SessionRecord,
  type SessionState,
  type SessionViewSettings
} from './lib/session';
import {
  deleteSession,
  getSession,
  isSessionStoreAvailable,
  listRecoverableSessions,
  putSession,
  randomSessionId,
  type CasWriteResult,
  type RecoverableEntry
} from './lib/sessionStore';
import {
  computeAudioSha256,
  fingerprintsMatch,
  isFingerprintSupported
} from './lib/fingerprint';
import RecoverDialog from './components/RecoverDialog';

interface Toast {
  id: number;
  kind: 'warn' | 'info' | 'error';
  text: string;
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

  // 本地会话恢复：音频指纹（恢复后等待重新选择同一文件；匹配前禁用播放）、
  // 指纹计算状态、自动保存开关与会话恢复对话框
  const [audioPending, setAudioPending] = useState<AudioFingerprint | null>(null);
  // 当前已加载并通过指纹校验的音频指纹（随会话快照保存，供下次恢复校验）
  const [audioFingerprint, setAudioFingerprint] = useState<AudioFingerprint | null>(null);
  const [audioHashing, setAudioHashing] = useState(false);
  const [autosaveEnabled, setAutosaveEnabled] = useState<boolean>(
    () => localStorage.getItem(AUTOSAVE_PREF_KEY) !== '0'
  );
  const [recoverOpen, setRecoverOpen] = useState(false);
  const [recoverSessions, setRecoverSessions] = useState<RecoverableEntry[]>([]);
  const [recoverLoading, setRecoverLoading] = useState(true);
  const [recoverError, setRecoverError] = useState<string | null>(null);
  const [recoverBusyId, setRecoverBusyId] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const toastId = useRef(0);
  // 当前音频分析的取消令牌；更换音频时取消旧分析并阻止旧结果回写
  const analysisTokenRef = useRef<AbortToken | null>(null);
  // 当前 SHA-256 计算的序号：更换 / 重新选择音频时令旧结果失效
  const hashSeqRef = useRef(0);
  // 最新循环计划的镜像，供音频事件 / rAF 回调读取，避免闭包过期；
  // 暂停、导入新音频或关闭循环时同步置为失效，旧回调读到 inactive 即落空
  const loopPlanRef = useRef<{ active: boolean; range: LoopRange | null }>({
    active: false,
    range: null
  });
  // 跟读录音忙碌态的 ref 镜像，供音频事件 / 键盘回调读取最新值
  const shadowBusyRef = useRef(false);

  /* ---------------- 本地会话：持久化编排 ---------------- */

  // 当前会话主键与库内最新 revision（单调递增；putSession 事务内裁决）
  const sessionIdRef = useRef<string>(randomSessionId());
  const sessionRevisionRef = useRef(0);
  // 等待重新选择音频时的指纹镜像（供异步哈希回调读取最新期望值）
  const audioPendingRef = useRef<AudioFingerprint | null>(null);
  // 自动保存开关镜像：pagehide 同步落盘路径读取
  const autosaveEnabledRef = useRef(autosaveEnabled);
  autosaveEnabledRef.current = autosaveEnabled;
  // 即将生成的最新快照（防抖等待期间也保持最新）
  const pendingSnapshotRef = useRef<SessionState | null>(null);
  // 串行化写入：只允许一个落盘 Promise；stale 时按最新快照重试一次
  const writeChainRef = useRef<Promise<boolean | null>>(Promise.resolve(null));
  // 防抖定时器
  const flushTimerRef = useRef<number | null>(null);
  // 跳过下一次自动保存（恢复会话 / 导入 SRT 后 React 批量提交导致的首次变化不入库）
  const skipNextFlushRef = useRef(true);
  // IndexedDB 不可用 / 打开失败：不再重复尝试并提示
  const storeBrokenRef = useRef(!isSessionStoreAvailable());
  const [savePhase, setSavePhase] = useState<'idle' | 'saving' | 'error' | 'unavailable'>(
    isSessionStoreAvailable() ? 'idle' : 'unavailable'
  );

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

  /** 加载已通过指纹校验（或全新导入）的音频文件到播放元素并启动静音分析 */
  const attachAudioFile = useCallback(
    (file: File) => {
      // 先作废旧循环计划：换源期间已排队的播放回调不得再拉回播放头
      loopPlanRef.current = { active: false, range: null };
      clearDrift(); // 切换文件：清空区间漂移预览
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
      setIsPlaying(false);
      setLevels(null);
      // 取消旧分析（若正在进行），并以新令牌开始本次分析，阻止旧结果回写
      runSilenceAnalysis(file);
    },
    [ensureAudio, runSilenceAnalysis, clearDrift]
  );

  /**
   * 导入 / 重新选择音频：先计算文件内容 SHA-256（可取消），再决定如何加载。
   * - 恢复会话后处于「等待重新选择」状态：大小与 SHA-256 均匹配才重新启用播放，
   *   不匹配则拒绝加载（不改动当前音频状态），文件名仅展示不参与匹配；
   * - 普通导入：指纹计算成功即加载并保存指纹；计算失败也允许使用音频，
   *   仅提示该会话下次恢复将无法校验音频（字幕编辑 / 导出始终不受影响）。
   */
  const handleImportAudio = useCallback(
    (file: File) => {
      if (!isFingerprintSupported()) {
        if (audioPendingRef.current) {
          pushToast('error', '当前环境不支持 SHA-256（需安全上下文：https 或 localhost），无法校验音频，播放保持禁用');
          return;
        }
        attachAudioFile(file);
        setAudioFingerprint(null);
        pushToast('warn', '当前环境不支持 SHA-256：音频可正常使用，但会话恢复后将无法校验该音频');
        return;
      }
      const seq = hashSeqRef.current + 1;
      hashSeqRef.current = seq;
      setAudioHashing(true);
      computeAudioSha256(file)
        .then((sha256) => {
          if (seq !== hashSeqRef.current) return; // 已选择更新的文件，丢弃旧结果
          setAudioHashing(false);
          const actual: AudioFingerprint = { name: file.name, size: file.size, sha256 };
          const expected = audioPendingRef.current;
          if (expected) {
            if (!fingerprintsMatch(actual, expected)) {
              const sizeNote = actual.size !== expected.size ? '（文件大小也不一致）' : '';
              pushToast('error', `音频指纹不匹配${sizeNote}：请选择会话原文件「${expected.name}」，播放保持禁用`);
              return;
            }
            audioPendingRef.current = null;
            setAudioPending(null);
            setAudioFingerprint(actual);
            attachAudioFile(file);
            pushToast('info', `音频指纹匹配，播放已重新启用：${file.name}`);
            return;
          }
          setAudioFingerprint(actual);
          attachAudioFile(file);
          pushToast('info', `已加载音频：${file.name}`);
        })
        .catch((err: unknown) => {
          if (seq !== hashSeqRef.current) return;
          setAudioHashing(false);
          if (audioPendingRef.current) {
            // 重新校验路径读不出哈希就不能放行播放：保持等待状态
            pushToast('error', `音频指纹计算失败：${err instanceof Error ? err.message : '文件无法读取'}，播放保持禁用`);
            return;
          }
          setAudioFingerprint(null);
          attachAudioFile(file);
          pushToast('warn', `音频指纹计算失败（${err instanceof Error ? err.message : '文件无法读取'}）：音频可使用，但该会话恢复时无法校验音频`);
        });
    },
    [attachAudioFile, pushToast]
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
      if (audioPendingRef.current && play) {
        // 会话恢复后音频指纹尚未重新匹配：允许移动播放头检查字幕，但不播放
        pushToast('warn', `请先重新选择音频「${audioPendingRef.current.name}」并通过指纹校验`);
        setCurrentTime(Math.max(0, t));
        return;
      }
      if (!el || !audioUrlRef.current) {
        // 未导入音频时仍允许播放头移动，便于纯字幕检查
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
    [pushToast]
  );

  const seekAndPlay = useCallback((t: number) => seek(t, true), [seek]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (shadowBusyRef.current) {
      // 跟读倒计时 / 录音中主导航让位于录音轨，避免与原音轨叠加播放
      pushToast('warn', '跟读录音进行中，请使用跟读面板控制');
      return;
    }
    if (audioPendingRef.current) {
      pushToast('warn', `等待重新选择音频「${audioPendingRef.current.name}」：SHA-256 指纹匹配后才能播放`);
      return;
    }
    if (!el || !audioUrlRef.current) {
      pushToast('warn', '请先导入浏览器可播放的音频文件');
      return;
    }
    if (el.paused) void el.play();
    else el.pause();
  }, [pushToast]);

  /* ---------------- A-B 循环试听 ---------------- */

  const selectedCue = useMemo(() => cues.find((c) => c.id === selectedId) ?? null, [cues, selectedId]);
  const hasAudio = audioName !== null;
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

  /**
   * 开启一个全新的工作区会话：撤销历史重置、清空旧会话主键与 revision，
   * 并跳过随后 React 批量提交触发的首次自动保存（避免用空 / 导入中状态
   * 覆盖旧会话）。恢复会话也复用同一套重置逻辑。
   */
  const beginNewSession = useCallback(() => {
    sessionIdRef.current = randomSessionId();
    sessionRevisionRef.current = 0;
    skipNextFlushRef.current = true;
  }, []);

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
        // 新字幕 = 新会话；旧会话记录仍保留在本机，可从「恢复会话」找回
        beginNewSession();
        setHistory((h) => replaceHistory(h, result.cues));
        setSrtName(file.name);
        setSelectedId(result.cues[0]?.id ?? null);
        pushToast('info', `已导入 ${result.cues.length} 条字幕：${file.name}`);
        result.warnings.forEach((w) => pushToast('warn', w));
      };
      reader.onerror = () => pushToast('error', `读取文件失败：${file.name}`);
      reader.readAsText(file, 'utf-8');
    },
    [pushToast, clearDrift, beginNewSession]
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

  /* ---------------- 本地会话：自动保存 / 恢复 ---------------- */

  /**
   * 执行一次落盘：始终用 pendingSnapshotRef 内的最新快照；revision 基准取
   * 已知库内版本，putSession 在同一事务内读到更高 revision 即拒绝（stale）。
   * stale 时用最新快照与事务返回的库内版本重试一次，仍失败则提示用户
   * （通常是另一个标签页在写同一会话）。force 用于停用自动保存 / 页面
   * 关闭前的「最后保存」，不受开关影响。
   */
  const flushNow = useCallback(async (force = false): Promise<boolean> => {
    if (!force && !autosaveEnabledRef.current) return false;
    const snapshot = pendingSnapshotRef.current;
    if (!snapshot || snapshot.history.present.length === 0) return false;
    if (storeBrokenRef.current) return false;

    const writeOnce = async (baseRevision: number): Promise<CasWriteResult> => {
      // 落盘内容始终以最新快照为准；baseRevision 仅用于事务内新旧裁决
      const latest = pendingSnapshotRef.current;
      if (!latest) return { kind: 'error', message: '快照已清空' };
      return putSession({ ...latest, revision: baseRevision }, sessionIdRef.current);
    };

    setSavePhase((p) => (p === 'error' || p === 'unavailable' ? p : 'saving'));
    let result: CasWriteResult;
    try {
      result = await writeOnce(sessionRevisionRef.current);
      if (result.kind === 'stale') {
        // 库内更新（多为另一标签页）：以事务返回的版本为基准重试一次
        sessionRevisionRef.current = result.existingRevision;
        result = await writeOnce(sessionRevisionRef.current);
      }
    } catch (err: unknown) {
      result = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    if (result.kind === 'ok') {
      sessionRevisionRef.current = result.revision;
      setSavePhase('idle');
      return true;
    }
    if (result.kind === 'stale') {
      setSavePhase('error');
      pushToast('error', '会话保存冲突：另一标签页似乎正在校对同一会话，本页停止自动保存');
    } else {
      storeBrokenRef.current = true;
      setSavePhase('unavailable');
      pushToast('error', `会话保存失败：${result.message}`);
    }
    return false;
  }, [pushToast]);

  /** 防抖调度：任何受跟踪状态变化后合并写入 */
  const scheduleFlush = useCallback(() => {
    if (storeBrokenRef.current) return;
    if (!autosaveEnabledRef.current) return;
    if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      writeChainRef.current = writeChainRef.current.then(() => flushNow());
    }, AUTOSAVE_DEBOUNCE_MS);
  }, [flushNow]);

  /**
   * 受跟踪状态变化：构造最新快照。恢复 / 导入后的首次变化只更新内存快照、
   * 不触发落盘（跳过标识随后清除）。
   */
  const viewSettings: SessionViewSettings = useMemo(
    () => ({
      pps,
      constraints,
      snapEnabled,
      silenceThresholdDb,
      loopEnabled,
      loopMargins,
      selectedId
    }),
    [
      pps,
      constraints,
      snapEnabled,
      silenceThresholdDb,
      loopEnabled,
      loopMargins,
      selectedId
    ]
  );

  useEffect(() => {
    if (history.present.length === 0) {
      pendingSnapshotRef.current = null;
      return;
    }
    pendingSnapshotRef.current = buildSessionState({
      srtName,
      history,
      view: viewSettings,
      audio: audioFingerprint,
      baseRevision: sessionRevisionRef.current
    });
    if (skipNextFlushRef.current) {
      skipNextFlushRef.current = false;
      return;
    }
    scheduleFlush();
  }, [history, srtName, viewSettings, audioFingerprint, scheduleFlush]);

  // 页面隐藏（刷新 / 关闭 / 切后台）：取消防抖，立即串行落盘最新快照
  useEffect(() => {
    const doFinalSave = () => {
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      if (pendingSnapshotRef.current && !storeBrokenRef.current && autosaveEnabledRef.current) {
        writeChainRef.current = writeChainRef.current.then(() => flushNow());
      }
    };
    document.addEventListener('visibilitychange', doFinalSave);
    window.addEventListener('pagehide', doFinalSave);
    return () => {
      document.removeEventListener('visibilitychange', doFinalSave);
      window.removeEventListener('pagehide', doFinalSave);
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    };
  }, [flushNow]);

  /**
   * 停用自动保存：先把当前状态最后保存一次（保证用户改动不丢），之后不再写入；
   * 重新启用时立即补存一次停用期间的最新快照，随后恢复防抖自动保存。
   */
  const handleAutosaveChange = useCallback(
    (enabled: boolean) => {
      localStorage.setItem(AUTOSAVE_PREF_KEY, enabled ? '1' : '0');
      setAutosaveEnabled(enabled);
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      writeChainRef.current = writeChainRef.current.then(() => flushNow(true));
    },
    [flushNow]
  );

  const refreshRecoverList = useCallback(async () => {
    setRecoverLoading(true);
    setRecoverError(null);
    try {
      const list = await listRecoverableSessions();
      setRecoverSessions(list);
    } catch (err: unknown) {
      setRecoverError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecoverLoading(false);
    }
  }, []);

  // 首次挂载：读取可恢复会话；存在有效记录时自动弹出恢复对话框
  useEffect(() => {
    if (storeBrokenRef.current) {
      setRecoverLoading(false);
      return;
    }
    let cancelled = false;
    listRecoverableSessions()
      .then((list) => {
        if (cancelled) return;
        setRecoverSessions(list);
        setRecoverLoading(false);
        if (list.some((e) => e.valid)) setRecoverOpen(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        storeBrokenRef.current = true;
        setSavePhase('unavailable');
        setRecoverError(err instanceof Error ? err.message : String(err));
        setRecoverLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 应用已通过完整校验的会话记录：先逐项校验（getSession 已校验），
   * 只有全部成功才替换工作区；任何失败由调用方保证不改动当前状态。
   */
  const applyRestoredRecord = useCallback(
    (record: SessionRecord) => {
      const checked = validateSessionState({
        schemaVersion: record.schemaVersion,
        revision: record.revision,
        srtName: record.srtName,
        history: record.history,
        view: record.view,
        audio: record.audio
      });
      if (!checked.ok) return false;
      const state: SessionState = checked.data;

      // 释放旧音频：恢复后音频一律处于「等待重新选择」状态
      loopPlanRef.current = { active: false, range: null };
      analysisTokenRef.current?.abort();
      hashSeqRef.current += 1;
      setAudioHashing(false);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
      setAudioObjectUrl(null);
      const el = audioRef.current;
      if (el) {
        el.pause();
        el.removeAttribute('src');
        el.load();
      }
      setAudioName(null);
      setAudioFingerprint(null);
      audioPendingRef.current = state.audio;
      setAudioPending(state.audio);
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      setLevels(null);
      setSilenceStatus('idle');
      setSilenceError(null);

      clearDrift();
      // 恢复历史（含撤销 / 重做栈）与全部校对 / 视图设置
      setHistory(state.history);
      setSrtName(state.srtName);
      setPps(state.view.pps);
      setConstraints(state.view.constraints);
      setSnapEnabled(state.view.snapEnabled);
      setSilenceThresholdDb(state.view.silenceThresholdDb);
      setLoopEnabled(state.view.loopEnabled);
      setLoopMargins(state.view.loopMargins);
      setSelectedId(state.view.selectedId);
      setFocusNonce((n) => n + 1);

      // 继续同一会话的 revision 线：后续保存以恢复版本为基准，单调递增
      sessionIdRef.current = record.id;
      sessionRevisionRef.current = state.revision;
      skipNextFlushRef.current = true;
      return true;
    },
    [clearDrift]
  );

  const handleRestoreSession = useCallback(
    async (id: string) => {
      if (recoverBusyId) return;
      setRecoverBusyId(id);
      try {
        // 恢复前再读一次并完整校验版本与数据结构；失败不改动当前工作区
        const record = await getSession(id);
        if (!record) {
          pushToast('error', '该会话校验未通过或已被删除，未改动当前工作区');
          return;
        }
        const ok = applyRestoredRecord(record);
        if (!ok) {
          pushToast('error', '会话数据结构校验失败，未改动当前工作区');
          return;
        }
        setRecoverOpen(false);
        if (record.audio) {
          pushToast(
            'warn',
            `已恢复 ${record.cueCount} 条字幕（rev ${record.revision}）。请重新选择音频「${record.audio.name}」，SHA-256 指纹匹配前播放禁用；字幕编辑与导出可正常使用`
          );
        } else {
          pushToast('info', `已恢复 ${record.cueCount} 条字幕（rev ${record.revision}）`);
        }
      } catch (err: unknown) {
        pushToast('error', `恢复会话失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setRecoverBusyId(null);
      }
    },
    [recoverBusyId, applyRestoredRecord, pushToast]
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      if (recoverBusyId) return;
      setRecoverBusyId(id);
      try {
        await deleteSession(id);
        // 删除的正是当前工作区会话：转为新的空白会话线，避免下一次保存重建旧记录
        if (sessionIdRef.current === id) beginNewSession();
        await refreshRecoverList();
        pushToast('info', '已删除该本地会话');
      } catch (err: unknown) {
        pushToast('error', `删除会话失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setRecoverBusyId(null);
      }
    },
    [recoverBusyId, beginNewSession, refreshRecoverList, pushToast]
  );

  const handleStartBlank = useCallback(() => setRecoverOpen(false), []);


  const statusText = useMemo(() => {
    const parts: string[] = [];
    parts.push(cues.length === 0 ? '等待导入：先选择 SRT，再选择音频' : `${cues.length} 条字幕`);
    if (audioPending) {
      parts.push(`待重新选择音频「${audioPending.name}」：指纹匹配前播放禁用，编辑 / 导出不受影响`);
    } else if (audioHashing) {
      parts.push('音频 SHA-256 指纹计算中…');
    }
    if (silenceStatus === 'analyzing') parts.push('静音分析中…');
    else if (silenceStatus === 'done') {
      parts.push(`${silenceSegments.length} 段静音` + (snapEnabled ? '· 吸附已开启' : '· 吸附已关闭'));
    } else if (silenceStatus === 'error') parts.push('静音分析失败');
    if (loopActive && loopRange) {
      parts.push(`A-B 循环 ${formatClock(loopRange.a)} → ${formatClock(loopRange.b)}`);
    } else if (loopSuspended) {
      parts.push('跟读录音中 · A-B 回卷已暂时暂停');
    } else if (loopEnabled && audioPending) {
      parts.push('循环待机：等待重新选择音频（指纹匹配后启用）');
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
    if (cues.length > 0) {
      if (!autosaveEnabled) {
        parts.push('自动保存已停用');
      } else if (savePhase === 'saving') {
        parts.push('正在保存会话…');
      } else if (savePhase === 'error') {
        parts.push('会话保存冲突');
      } else if (savePhase === 'unavailable') {
        parts.push('本地会话不可用（IndexedDB）');
      }
    }
    return parts.join(' · ');
  }, [
    cues.length,
    history.past.length,
    audioPending,
    audioHashing,
    autosaveEnabled,
    savePhase,
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
    driftRangeInfo
  ]);

  return (
    <div className="app">
      <Toolbar
        audioName={audioName}
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
        loopDisabledReason={
          audioPending
            ? '等待重新选择音频（指纹匹配后启用）'
            : loopDisabled
              ? loopDisableText(loopDisabled)
              : null
        }
        loopMargins={loopMargins}
        onLoopEnabledChange={handleLoopEnabledChange}
        onLoopMarginsChange={setLoopMargins}
        audioPendingName={audioPending?.name ?? null}
        audioHashing={audioHashing}
        autosaveEnabled={autosaveEnabled}
        onAutosaveChange={handleAutosaveChange}
        onOpenRecover={() => {
          void refreshRecoverList();
          setRecoverOpen(true);
        }}
      />

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

      {recoverOpen && (
        <RecoverDialog
          sessions={recoverSessions}
          loading={recoverLoading}
          loadError={recoverError}
          busyId={recoverBusyId}
          restoreConfirm={cues.length > 0}
          onRestore={(id) => void handleRestoreSession(id)}
          onDelete={(id) => void handleDeleteSession(id)}
          onStartBlank={handleStartBlank}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
