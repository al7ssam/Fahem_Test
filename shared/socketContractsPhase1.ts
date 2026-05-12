/**
 * عقد مقبس Phase 1 — أنواع مشتركة بين العميل والخادم (بدون استيراد zod من العميل).
 */

export type ServerDrainingPayload = {
  serverNow: number;
  messageAr: string;
};

/** أخطاء ACK شائعة — توسيع تدريجي. */
export const SOCKET_ACK_SERVER_DRAINING = "server_draining" as const;

export type GameOverAbortOutcome = "server_aborted" | "server_shutdown";
