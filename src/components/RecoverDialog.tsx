import type { RecoverableEntry } from '../lib/sessionStore';
import { formatBytes } from '../lib/fingerprint';

interface RecoverDialogProps {
  sessions: RecoverableEntry[];
  loading: boolean;
  loadError: string | null;
  busyId: string | null;
  /** 恢复前确认（当前工作区有字幕时提示会覆盖） */
  restoreConfirm: boolean;
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onStartBlank: () => void;
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '时间未知';
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return String(ms);
  }
}

/**
 * 重新打开页面时列出可恢复会话。恢复动作由 App 侧先完整校验版本与
 * 数据结构，校验失败不会改动当前工作区；损坏的会话只可删除。
 */
export default function RecoverDialog(p: RecoverDialogProps) {
  return (
    <div
      className="recover-overlay"
      onMouseDown={(e) => {
        // 仅点击遮罩本身关闭；点击面板不响应
        if (e.target === e.currentTarget && !p.busyId) p.onStartBlank();
      }}
    >
      <div className="recover-dialog" role="dialog" aria-modal="true" aria-label="恢复校对会话">
        <div className="recover-head">
          <h2>恢复本地校对会话</h2>
          <button className="btn icon" onClick={p.onStartBlank} disabled={!!p.busyId} title="不恢复，使用空白工作区">
            ✕
          </button>
        </div>
        <p className="recover-tip">
          字幕内容、撤销 / 重做历史、约束与视图设置均保存在本机浏览器的 IndexedDB 中，不会上传。
          恢复后需<b>重新选择同一音频文件</b>（文件名与大小、SHA-256 指纹一致才会启用播放）；
          等待音频期间字幕编辑、导出与自动保存不受影响。
        </p>

        {p.loading ? (
          <div className="recover-status">正在读取本地会话…</div>
        ) : p.loadError ? (
          <div className="recover-status failed">无法读取本地会话：{p.loadError}</div>
        ) : p.sessions.length === 0 ? (
          <div className="recover-status">没有可恢复的会话。</div>
        ) : (
          <ul className="recover-list">
            {p.sessions.map((entry) => {
              const m = entry.meta;
              return (
                <li key={m.id} className={`recover-entry ${entry.valid ? '' : 'invalid'}`}>
                  <div className="recover-entry-main">
                    <div className="recover-entry-title" title={m.srtName ?? undefined}>
                      {m.srtName ?? '未命名字幕'}
                      {!entry.valid && <span className="recover-badge failed">已损坏</span>}
                      {entry.valid && (
                        <span className="recover-badge">rev {m.revision}</span>
                      )}
                    </div>
                    <div className="recover-entry-meta">
                      <span>{m.cueCount} 条字幕</span>
                      <span title={m.audioName ?? undefined}>
                        音频：{m.audioName ? `${m.audioName}${m.audioSize !== null ? ` · ${formatBytes(m.audioSize)}` : ''}` : '未关联'}
                      </span>
                      <span>更新于 {formatTimestamp(m.updatedAt)}</span>
                    </div>
                    {!entry.valid && (
                      <div className="recover-entry-error">
                        结构校验未通过（{entry.invalidReason}），无法恢复，只能删除
                      </div>
                    )}
                  </div>
                  <div className="recover-entry-actions">
                    <button
                      className="btn primary"
                      disabled={!entry.valid || p.busyId !== null}
                      onClick={() => p.onRestore(m.id)}
                    >
                      {p.busyId === m.id ? '恢复中…' : '恢复'}
                    </button>
                    <button
                      className="btn danger"
                      disabled={p.busyId !== null}
                      onClick={() => p.onDelete(m.id)}
                      title="从本机删除该会话记录（不影响磁盘上的字幕 / 音频文件）"
                    >
                      删除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="recover-foot">
          {p.restoreConfirm && (
            <span className="recover-confirm-hint">恢复会替换当前工作区（当前字幕将被覆盖）</span>
          )}
          <button className="btn" onClick={p.onStartBlank} disabled={!!p.busyId}>
            不恢复，开始空白工作区
          </button>
        </div>
      </div>
    </div>
  );
}
