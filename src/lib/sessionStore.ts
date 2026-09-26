/**
 * 会话的 IndexedDB 持久化：列表 / 读取 / 删除 / 带单调 revision 保护的写入。
 *
 * 写入采用「读-改-写同一事务」：putSession 在事务内先读库内 revision，
 * 若库内 revision 严格大于调用方基准（说明有更新的状态已落盘），立即
 * abort 事务并返回 { kind: 'stale' }——旧 revision 的异步写入永远
 * 无法覆盖新状态。成功路径把 revision 推进到 max(库内, 基准) + 1。
 */
import {
  fallbackMeta,
  resolveWriteRevision,
  toSessionMeta,
  validateStoredRecord,
  type SessionMeta,
  type SessionRecord,
  type SessionState
} from './session';

export const SESSION_DB_NAME = 'subtitle-rhythm-deck';
export const SESSION_DB_VERSION = 1;
export const SESSION_STORE = 'sessions';

export interface RecoverableEntry {
  meta: SessionMeta;
  /** 完整记录预校验结果；false 的条目禁止恢复，但仍可删除 */
  valid: boolean;
  invalidReason: string | null;
}

export type CasWriteResult =
  | { kind: 'ok'; revision: number }
  | { kind: 'stale'; existingRevision: number }
  | { kind: 'error'; message: string };

export function isSessionStoreAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openSessionDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(SESSION_DB_NAME, SESSION_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // 未来版本升级时丢弃旧连接，避免 onblocked 卡死
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('无法打开会话数据库'));
    req.onblocked = () => reject(new Error('会话数据库被其他页面占用，请关闭多余标签页'));
  });
  dbPromise.catch(() => {
    // 打开失败后允许下次重试
    dbPromise = null;
  });
  return dbPromise;
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('会话数据库请求失败'));
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'QuotaExceededError') {
    return '浏览器存储空间不足，无法保存会话';
  }
  return err instanceof Error ? err.message : String(err);
}

/** 列出全部会话会话（含结构损坏的条目，便于用户删除）；按更新时间倒序 */
export async function listRecoverableSessions(): Promise<RecoverableEntry[]> {
  const db = await openSessionDb();
  const tx = db.transaction(SESSION_STORE, 'readonly');
  const raw = await requestToPromise(tx.objectStore(SESSION_STORE).getAll() as IDBRequest<unknown[]>);
  const entries = raw.map((value, index) => {
    const checked = validateStoredRecord(value);
    if (checked.ok) {
      return { meta: toSessionMeta(checked.data), valid: true, invalidReason: null };
    }
    return { meta: fallbackMeta(value, index), valid: false, invalidReason: checked.reason };
  });
  entries.sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
  return entries;
}

/** 读取单条会话并完整校验；结构损坏返回 null（由调用方提示并阻止恢复） */
export async function getSession(id: string): Promise<SessionRecord | null> {
  const db = await openSessionDb();
  const tx = db.transaction(SESSION_STORE, 'readonly');
  const raw = await requestToPromise(tx.objectStore(SESSION_STORE).get(id) as IDBRequest<unknown>);
  if (raw === undefined || raw === null) return null;
  const checked = validateStoredRecord(raw);
  return checked.ok ? checked.data : null;
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openSessionDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    tx.objectStore(SESSION_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('删除会话失败'));
    tx.onabort = () => reject(tx.error ?? new Error('删除会话被中止'));
  });
}

/**
 * 写入会话快照（带单调 revision 保护）。
 *
 * @param state  待保存快照；state.revision 是调用方已知的库内基准版本
 * @param id     会话主键（调用方持有，跨防抖保持稳定）
 * @param now    时间戳来源（默认 Date.now，便于测试）
 */
export async function putSession(
  state: SessionState,
  id: string,
  now: () => number = Date.now
): Promise<CasWriteResult> {
  const db = await openSessionDb();
  return new Promise<CasWriteResult>((resolve) => {
    let nextRev: number | null = null;
    let staleExisting: number | null = null;
    const tx = db.transaction(SESSION_STORE, 'readwrite');
    const store = tx.objectStore(SESSION_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      try {
        const existing = getReq.result as { revision?: unknown; createdAt?: unknown } | undefined;
        const existingRev =
          existing && typeof existing.revision === 'number' && Number.isSafeInteger(existing.revision)
            ? existing.revision
            : null;
        const resolved = resolveWriteRevision(existingRev, state.revision);
        if (resolved === null) {
          // 库内已是更新的 revision：中止事务，拒绝旧快照覆盖新状态
          staleExisting = existingRev ?? 0;
          tx.abort();
          return;
        }
        nextRev = resolved;
        const record: SessionRecord = {
          ...state,
          revision: resolved,
          id,
          createdAt:
            existing && typeof existing.createdAt === 'number' && Number.isSafeInteger(existing.createdAt)
              ? existing.createdAt
              : now(),
          updatedAt: now(),
          cueCount: state.history.present.length
        };
        store.put(record);
      } catch (err) {
        try {
          tx.abort();
        } catch {
          /* 事务可能已结束 */
        }
        resolve({ kind: 'error', message: errorMessage(err) });
      }
    };
    getReq.onerror = () => {
      try {
        tx.abort();
      } catch {
        /* 忽略 */
      }
      resolve({ kind: 'error', message: errorMessage(getReq.error) });
    };
    tx.oncomplete = () => {
      if (nextRev !== null) resolve({ kind: 'ok', revision: nextRev });
    };
    tx.onabort = () => {
      if (staleExisting !== null) resolve({ kind: 'stale', existingRevision: staleExisting });
      else resolve({ kind: 'error', message: errorMessage(tx.error ?? new Error('写入会话被中止')) });
    };
    tx.onerror = () => {
      resolve({ kind: 'error', message: errorMessage(tx.error) });
    };
  });
}

/** 生成会话主键；优先使用加密安全的 randomUUID */
export function randomSessionId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
