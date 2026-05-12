import { describe, expect, it } from "vitest";
import { applySkillBoostToAwardPure, computeSpeedScoredBase } from "./teamRoundScore";

describe("computeSpeedScoredBase", () => {
  it("يعطي ~100 عند الإجابة فوراً", () => {
    const t0 = 1000;
    const deadline = 11_000;
    expect(computeSpeedScoredBase(t0, deadline, t0)).toBe(100);
  });

  it("ينخفض عند التأخر (نهاية النافذة)", () => {
    const t0 = 0;
    const deadline = 10_000;
    expect(computeSpeedScoredBase(t0, deadline, deadline)).toBe(1);
  });

  it("answeredAt قبل البداية يُقصّ إلى نفس أعلى نقاط السرعة", () => {
    const t0 = 5000;
    const deadline = 15_000;
    expect(computeSpeedScoredBase(t0, deadline, t0 - 5000)).toBe(100);
  });

  it("answeredAt بعد deadline يُقصّ إلى أدنى نقاط السرعة", () => {
    const t0 = 0;
    const deadline = 10_000;
    expect(computeSpeedScoredBase(t0, deadline, deadline + 9999)).toBe(1);
  });

  it("نافذة صغيرة جداً (totalWindow=1) لا تنقسم على صفر", () => {
    const t0 = 100;
    const deadline = 101;
    expect(computeSpeedScoredBase(t0, deadline, 100)).toBe(100);
    expect(computeSpeedScoredBase(t0, deadline, 101)).toBe(1);
  });

  it("منتصف النافذة يعطي تقريباً وسط النطاق", () => {
    const t0 = 0;
    const deadline = 10_000;
    const mid = 5000;
    expect(computeSpeedScoredBase(t0, deadline, mid)).toBe(51);
  });
});

describe("applySkillBoostToAwardPure", () => {
  it("بدون stacks يعيد base", () => {
    expect(applySkillBoostToAwardPure(80, 0, { maxMultiplier: 3, percent: 30 })).toBe(80);
  });

  it("يطبّق مضاعفاً محدوداً", () => {
    const out = applySkillBoostToAwardPure(100, 2, { maxMultiplier: 3, percent: 30 });
    expect(out).toBeGreaterThan(100);
    expect(out).toBe(Math.round(100 * (1 + Math.min(3, 4 * 0.3))));
  });
});
