import { useEffect, useMemo, useRef } from 'react';
import type { Cue } from '../types';
import { secondsToSrtTime } from '../lib/srt';

interface CueListProps {
  cues: Cue[];
  currentTime: number;
  selectedId: string | null;
  /** 区间漂移选中的连续区间（时间序 id）；无区间为 null */
  driftRangeIds: string[] | null;
  /** 区间漂移首个冲突字幕（红色标记）；无冲突为 null */
  driftConflictId: string | null;
  /** 变化时强制重新滚动到选中行（定位冲突时选中项可能未变） */
  focusNonce: number;
  onSelect: (id: string) => void;
  /** Shift+点击：以当前锚点为起点选择连续区间 */
  onExtendRange: (id: string) => void;
  onSeek: (t: number) => void;
}

export default function CueList({
  cues,
  currentTime,
  selectedId,
  driftRangeIds,
  driftConflictId,
  focusNonce,
  onSelect,
  onExtendRange,
  onSeek
}: CueListProps) {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const driftSet = useMemo(() => new Set(driftRangeIds ?? []), [driftRangeIds]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId, focusNonce]);

  return (
    <aside className="cue-list">
      <div className="cue-list-head">
        字幕列表（{sorted.length}）
        <span className="hint">
          {driftRangeIds ? `漂移区间 ${driftRangeIds.length} 条 · Shift+点击调整` : '点击时间码定位 · Shift+点击选区间'}
        </span>
      </div>
      <div className="cue-list-body">
        {sorted.length === 0 && <div className="empty">尚未导入 SRT 文件</div>}
        {sorted.map((cue, i) => {
          const active = currentTime >= cue.start && currentTime < cue.end;
          return (
            <div
              key={cue.id}
              ref={cue.id === selectedId ? selectedRef : null}
              className={[
                'cue-row',
                cue.id === selectedId && 'selected',
                active && 'playing',
                driftSet.has(cue.id) && 'in-drift-range',
                cue.id === driftConflictId && 'drift-conflict'
              ].filter(Boolean).join(' ')}
              onClick={(e) => {
                if (e.shiftKey) onExtendRange(cue.id);
                else onSelect(cue.id);
              }}
            >
              <div className="cue-row-index">{i + 1}</div>
              <button
                className="cue-row-time"
                title="定位到该字幕"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(cue.id);
                  onSeek(cue.start);
                }}
              >
                {secondsToSrtTime(cue.start)}
                <br />
                {secondsToSrtTime(cue.end)}
              </button>
              <div className="cue-row-text">{cue.text}</div>
              <div className="cue-row-dur">{(cue.end - cue.start).toFixed(2)}s</div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
