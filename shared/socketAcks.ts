/** ACK شائع للوبي وإنشاء الغرفة */
export type StandardOkErrorAck = { ok: true } | { ok: false; error?: string };

/** ACK بدء التعلم الفردي — قد يتضمن رسالة عربية للمستخدم */
export type StartSoloMatchAck =
  | { ok: true }
  | { ok: false; error?: string; message?: string };

/** إجابة/جاهزية الجولة — بدون حقل error تاريخياً */
export type SimpleBooleanAck = { ok: boolean };

/** ACK القدرات — مطابق لـ `AbilityAck` في Match */
export type AbilitySocketAck =
  | { ok: true; keys: number; skillBoostStacks?: number; revealQuestions?: number }
  | { ok: false; error: string };

/** نطاق واسع لأك الغرف الخاصة حتى تُضيّق لاحقاً */
export type PrivateRoomMutationAck = {
  ok: boolean;
  error?: string;
  message?: string;
};
