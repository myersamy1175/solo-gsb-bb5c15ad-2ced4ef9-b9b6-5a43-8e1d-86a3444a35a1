import type { KeyboardEvent } from 'react';
import type { DriftPlan } from '../lib/drift';
import { formatClock } from '../lib/srt';

interface DriftPanelProps {
  /** 区间内字幕条数 */
  rangeCount: number;
  /** 区间首条在列表中的序号（1-based，时间序） */
  firstIndex: number;
  /** 区间末条在列表中的序号（1-based，时间序） */
  lastIndex: number;
  /** 原始锚点：首条起点 / 末条终点 */
  oldStart: number;
  oldEnd: number;
  /** 目标锚点输入框文本 */
  startInput: string;
  endInput: string;
  /** 输入是否可解析为时间 */
  startValid: boolean;
  endValid: boolean;
  /** 映射计划（含首个冲突）；输入不可解析时为 null */
  plan: DriftPlan | null;
  onStartInput: (v: string) => void;
  onEndInput: (v: string) => void;
  /** 合法结果作为一次历史记录提交 */
  onApply: () => void;
  /** 放弃本次校准并清空预览 */
  onCancel: () => void;
  /** 定位首个冲突字幕 */
  onLocateConflict: () => void;
}

export default function DriftPanel(p: DriftPanelProps) {
  const conflict = p.plan?.conflict ?? null;
  const canApply = p.plan !== null && conflict === null;
  const inputInvalid = !p.startValid || !p.endValid;
  const shift = p.plan ? p.plan.newStart - p.plan.oldStart : 0;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      p.onCancel();
    } else if (e.key === 'Enter' && canApply) {
      e.stopPropagation();
      p.onApply();
    }
  };

  return (
    <section className={['drift-panel', conflict && 'has-conflict'].filter(Boolean).join(' ')}>
      <div className="drift-head">
        <span className="drift-title">⟷ 区间漂移校准</span>
        <span className="drift-range">
          第 {p.firstIndex}–{p.lastIndex} 条 · 共 {p.rangeCount} 条
        </span>
        <span className="drift-anchors">
          原始锚点 {formatClock(p.oldStart)} → {formatClock(p.oldEnd)}
        </span>
        {p.plan && (
          <span className={`drift-scale ${conflict ? 'bad' : ''}`}>
            缩放 ×{p.plan.scale.toFixed(3)} · 起点平移 {shift >= 0 ? '+' : ''}
            {shift.toFixed(3)}s
          </span>
        )}
        <div className="drift-actions">
          <button
            className="btn primary mini"
            onClick={p.onApply}
            disabled={!canApply}
            title={conflict ? '存在冲突，禁止提交' : '将映射结果作为一次历史记录提交（Enter）'}
          >
            应用映射
          </button>
          <button className="btn mini" onClick={p.onCancel} title="放弃本次区间漂移并清空预览（Esc）">
            取消
          </button>
        </div>
      </div>
      <div className="drift-body">
        <label title="区间首条起点要移动到的时间：支持 83.5 / 01:23.500 / 00:01:23,500">
          目标起点
          <input
            type="text"
            className={p.startValid ? '' : 'invalid'}
            value={p.startInput}
            placeholder="如 01:23.500"
            spellCheck={false}
            onChange={(e) => p.onStartInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
        <label title="区间末条终点要移动到的时间：支持 83.5 / 01:23.500 / 00:01:23,500">
          目标终点
          <input
            type="text"
            className={p.endValid ? '' : 'invalid'}
            value={p.endInput}
            placeholder="如 02:05.000"
            spellCheck={false}
            onChange={(e) => p.onEndInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>
        {inputInvalid && (
          <span className="drift-hint">时间格式无法识别：支持 83.5、01:23.500、00:01:23,500</span>
        )}
        {conflict && (
          <span className="drift-conflict">
            ⚠ {conflict.message}
            {conflict.cueId && (
              <button className="btn mini danger" onClick={p.onLocateConflict} title="在列表与时间轴中定位首个冲突字幕">
                定位
              </button>
            )}
          </span>
        )}
        {p.plan && !conflict && (
          <span className="drift-ok">✓ 映射合法：时间轴绿色虚影为新位置，提交后整体可撤销/重做</span>
        )}
      </div>
    </section>
  );
}
