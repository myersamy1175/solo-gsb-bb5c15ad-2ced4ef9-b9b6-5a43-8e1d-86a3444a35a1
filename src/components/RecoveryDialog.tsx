import { useEffect, useState } from 'react';
import type { SessionEntry } from '../lib/session';

interface RecoveryDialogProps {
  /** 可恢复 / 已损坏的会话列表（最近更新在前） */
  entries: SessionEntry[];
  /** 列表是否正在加载 */
  loading: boolean;
  /** 当前工作区已绑定的会话 id（恢复它等于放弃当前修改，需二次确认） */
  activeSessionId: string | null;
  /** 自动保存开关（停用后不再写入快照） */
  autoSave: boolean;
  onAutoSaveChange: (on: boolean) => void;
  /** 校验通过后请求恢复；恢复失败由 App 提示，本弹窗不关闭 */
  onRestore: (id: string) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onClose: () => void;
}

function formatTime(ms: number): string {
  if (!ms) return '时间未知';
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(
    d.getMinutes()
  )}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function RecoveryDialog(p: RecoveryDialogProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);

  const run = async (id: string, fn: (id: string) => Promise<void> | void) => {
    setBusyId(id);
    setError(null);
    try {
      await fn(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <section className="recovery-dialog" role="dialog" aria-modal="true" aria-label="恢复校对会话">
        <div className="recovery-head">
          <span className="recovery-title">🗂 恢复校对会话</span>
          <button className="btn icon" onClick={p.onClose} title="关闭（Esc）" disabled={busyId !== null}>
            ✕
          </button>
        </div>
        <p className="recovery-note">
          字幕内容、撤销/重做历史、约束与视图设置自动保存在本浏览器的 IndexedDB
          中；音频文件不会被保存，恢复后需重新选择同一音频（名称 / 大小 / SHA-256 匹配）才能播放。
        </p>

        {error && <div className="recovery-error">⚠ {error}</div>}

        <div className="recovery-list">
          {p.loading ? (
            <div className="recovery-empty">正在读取本地会话…</div>
          ) : p.entries.length === 0 ? (
            <div className="recovery-empty">暂无已保存的会话（仅在自动保存开启时产生）</div>
          ) : (
            p.entries.map((e) => {
              if (e.kind === 'invalid') {
                return (
                  <div key={e.id || e.srtName} className="recovery-item invalid" title={e.reason}>
                    <div className="recovery-item-main">
                      <div className="recovery-item-name">{e.srtName}</div>
                      <div className="recovery-item-meta">
                        保存于 {formatTime(e.updatedAt)} · <span className="bad">无法恢复：{e.reason}</span>
                      </div>
                    </div>
                    <div className="recovery-item-actions">
                      <button
                        className="btn mini danger"
                        disabled={busyId !== null}
                        onClick={() => void run(e.id, p.onDelete)}
                      >
                        删除记录
                      </button>
                    </div>
                  </div>
                );
              }
              const r = e.record;
              const isActive = r.id === p.activeSessionId;
              return (
                <div key={r.id} className={['recovery-item', isActive && 'active'].filter(Boolean).join(' ')}>
                  <div className="recovery-item-main">
                    <div className="recovery-item-name">
                      {r.srtName}
                      {isActive && <span className="recovery-badge">当前工作区</span>}
                    </div>
                    <div className="recovery-item-meta">
                      {r.snapshot.present.length} 条字幕 · 撤销栈 {r.snapshot.past.length} 步 · 修订 r
                      {r.revision} · 更新于 {formatTime(r.updatedAt)}
                    </div>
                    <div className="recovery-item-meta">
                      {r.audio ? (
                        <>
                          音频：{r.audio.name}（{formatSize(r.audio.size)}）· SHA-256
                          <code className="sha">{r.audio.sha256.slice(0, 12)}…</code>
                          <span className="audio-pending-tag">恢复后需重选</span>
                        </>
                      ) : (
                        '音频：未导入'
                      )}
                    </div>
                  </div>
                  <div className="recovery-item-actions">
                    <button
                      className="btn mini primary"
                      disabled={busyId !== null || isActive}
                      title={isActive ? '该会话已在当前工作区打开' : '完整校验通过后恢复；校验失败不会改动当前工作区'}
                      onClick={() => void run(r.id, p.onRestore)}
                    >
                      {busyId === r.id ? '恢复中…' : '恢复'}
                    </button>
                    <button
                      className="btn mini danger"
                      disabled={busyId !== null || isActive}
                      title={isActive ? '请先关闭或切换当前工作区' : '删除该会话快照'}
                      onClick={() => void run(r.id, p.onDelete)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="recovery-foot">
          <label className="switch" title="关闭后不再自动保存任何会话快照；已保存的会话保留">
            <input
              type="checkbox"
              checked={p.autoSave}
              onChange={(ev) => p.onAutoSaveChange(ev.target.checked)}
            />
            自动保存到本地
          </label>
          <button className="btn" onClick={p.onClose} disabled={busyId !== null}>
            开始空白工作区
          </button>
        </div>
      </section>
    </div>
  );
}
