/**
 * 会话快照的 IndexedDB 存储层。
 *
 * 关键不变量：
 * - putSession 是「事务内 CAS」：在同一个 readwrite 事务里先读出已存记录，
 *   仅当 revision 严格更大时才写入；revision 相等或更旧（例如另一个标签页
 *   刚写过、或本次异步写入排队期间状态又前进并已落盘）直接回滚事务，
 *   旧 revision 永远无法覆盖新状态。
 * - 删除按主键进行；读取失败 / 结构损坏由 session.ts 的 validateSession 兜底。
 */

import {
  SESSION_SCHEMA_VERSION,
  validateSession,
  type SessionEntry,
  type SessionRecord
} from './session';

const DB_NAME = 'subtitle-rhythm-deck';
const DB_VERSION = 1;
const STORE = 'sessions';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用，请关闭旧页面后重试'));
  });
}

function txRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 请求失败'));
  });
}

/** IndexedDB 或其事务不可用（隐私模式 / 配额等） */
export class SessionStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionStorageError';
  }
}

/**
 * 写入或更新一条会话。事务内比较 revision：
 * stored.revision >= record.revision 时中止事务并返回 { written: false }。
 */
export async function putSession(record: SessionRecord): Promise<{ written: boolean; storedRevision: number }> {
  if (record.schemaVersion !== SESSION_SCHEMA_VERSION) {
    throw new SessionStorageError(`未知的会话结构版本：${record.schemaVersion}`);
  }
  const db = await openDb();
  try {
    return await new Promise<{ written: boolean; storedRevision: number }>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const getReq = store.get(record.id);
      getReq.onsuccess = () => {
        const stored = getReq.result as SessionRecord | undefined;
        const storedRevision = stored ? stored.revision : 0;
        if (stored && stored.revision >= record.revision) {
          // 旧 revision 覆盖新状态：中止事务，已做的读取无副作用
          tx.abort();
          resolve({ written: false, storedRevision });
          return;
        }
        store.put(record);
      };
      tx.oncomplete = () => resolve({ written: true, storedRevision: record.revision });
      tx.onabort = () => {
        if (getReq.error) reject(getReq.error);
        else resolve({ written: false, storedRevision: -1 });
      };
      tx.onerror = () => reject(tx.error ?? new SessionStorageError('会话写入失败'));
    });
  } finally {
    db.close();
  }
}

/** 读取单条会话的原始记录（不做结构校验；恢复时由 validateSession 权威校验） */
export async function getRawSession(id: string): Promise<unknown | null> {
  const db = await openDb();
  try {
    return await txRequest(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
  } finally {
    db.close();
  }
}

/** 列出全部会话，最近更新在前。
 * 结构损坏 / 版本不支持的记录以 InvalidSession 返回：不能恢复，但可删除。
 */
export async function listSessions(): Promise<SessionEntry[]> {
  const db = await openDb();
  try {
    const rows = (await txRequest(
      db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    )) as unknown[];
    const entries: SessionEntry[] = rows.map((raw) => {
      const r = validateSession(raw);
      if (r.ok) return { kind: 'ok', record: r.record };
      const rec = (isObj(raw) ? raw : {}) as Record<string, unknown>;
      return {
        kind: 'invalid',
        id: typeof rec.id === 'string' ? rec.id : '',
        srtName: typeof rec.srtName === 'string' ? rec.srtName : '(未知文件)',
        updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
        reason: r.reason
      };
    });
    entries.sort((a, b) => updatedAtOf(b) - updatedAtOf(a));
    return entries;
  } finally {
    db.close();
  }
}

function updatedAtOf(e: SessionEntry): number {
  return e.kind === 'ok' ? e.record.updatedAt : e.updatedAt;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 删除一条会话（按主键幂等） */
export async function deleteSession(id: string): Promise<void> {
  const db = await openDb();
  try {
    await txRequest(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}

/** 浏览器是否提供 IndexedDB（部分隐私模式会缺失） */
export function isSessionStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}
