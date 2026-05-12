/**
 * أدوات تصحيح الأخطاء — لا تؤثر على الإنتاج.
 * للاستخدام أثناء التطوير فقط.
 */

import { NavState, ReleaseWatchState, SavedLessonsState } from "./state";

export function debugAppStateSnapshot(): Record<string, unknown> {
  return {
    nav: { ...NavState },
    releaseWatch: {
      handle: ReleaseWatchState.handle,
      lastKnownVersion: ReleaseWatchState.lastKnownVersion,
      lastKnownEtag: ReleaseWatchState.lastKnownEtag,
      inFlight: ReleaseWatchState.inFlight,
      failureCount: ReleaseWatchState.failureCount,
      deferredVersion: ReleaseWatchState.deferredVersion,
      deferredReason: ReleaseWatchState.deferredReason,
      metrics: { ...ReleaseWatchState.metrics },
    },
    savedLessons: { ...SavedLessonsState },
  };
}
