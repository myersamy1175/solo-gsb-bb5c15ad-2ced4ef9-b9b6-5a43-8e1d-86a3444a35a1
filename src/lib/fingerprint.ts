/**
 * 音频指纹：对本地音频文件计算 SHA-256（配合文件名 / 大小）。
 *
 * 恢复会话后不会自动重放音频（浏览器拿不到文件句柄），用户需要重新
 * 选择同一文件：大小与 SHA-256 均一致才重新启用播放。哈希只在
 * 本地内存中计算，不经过任何网络（页面须为安全上下文）。
 */
import type { AudioFingerprint } from './session';

/** SHA-256 需要 Web Crypto（安全上下文：https 或 localhost） */
export function isFingerprintSupported(): boolean {
  return (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.subtle === 'object' &&
    typeof globalThis.crypto.subtle.digest === 'function'
  );
}

const HEX_CHARS = '0123456789abcdef';

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX_CHARS[bytes[i] >> 4] + HEX_CHARS[bytes[i] & 0x0f];
  }
  return out;
}

/**
 * 计算文件内容 SHA-256（小写十六进制）。为避免大文件重复读取，
 * 调用方可传入已读取的 ArrayBuffer；传入 File 时内部读取。
 */
export async function computeAudioSha256(
  source: File | ArrayBuffer
): Promise<string> {
  const buffer = source instanceof ArrayBuffer ? source : await source.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return bufferToHex(digest);
}

/**
 * 重新选择音频时的指纹匹配：大小与 SHA-256 必须同时一致。
 * 文件名不参与匹配（允许重命名），仅在不一致时供调用方提示。
 */
export function fingerprintsMatch(
  actual: AudioFingerprint,
  expected: AudioFingerprint | null
): boolean {
  if (!expected) return false;
  return actual.size === expected.size && actual.sha256 === expected.sha256;
}

/** 人性化文件大小 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
