import { randomUUID } from "crypto";
import type { LessonPlaybackPayload } from "./db/lessons";

type SessionEntry = {
  playback: LessonPlaybackPayload;
  expiresAt: number;
};

/** مدة صلاحية الجلسة (مللي) — غرفة خاصة + وقت التحضير */
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

const sessions = new Map<string, SessionEntry>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (v.expiresAt < now) sessions.delete(k);
  }
}

/**
 * يخزّن حمولة تشغيل درس مخصص مؤقتاً ويعيد رمزاً يُمرَّر إلى Socket (غرفة خاصة / فردي عبر السيرفر).
 */
export function putCustomLessonPlayback(
  playback: LessonPlaybackPayload,
  ttlMs: number = DEFAULT_TTL_MS,
): string {
  pruneExpired();
  const token = randomUUID();
  sessions.set(token, { playback, expiresAt: Date.now() + ttlMs });
  return token;
}

export function getCustomLessonPlayback(token: string | null | undefined): LessonPlaybackPayload | null {
  if (!token) return null;
  const t = token.trim();
  pruneExpired();
  const e = sessions.get(t);
  if (!e || e.expiresAt < Date.now()) {
    sessions.delete(t);
    return null;
  }
  return e.playback;
}

export function touchCustomLessonSession(token: string | null | undefined, ttlMs: number = DEFAULT_TTL_MS): void {
  const t = token?.trim();
  if (!t) return;
  const e = sessions.get(t);
  if (e) e.expiresAt = Date.now() + ttlMs;
}

export function deleteCustomLessonSession(token: string | null | undefined): void {
  const t = token?.trim();
  if (t) sessions.delete(t);
}
