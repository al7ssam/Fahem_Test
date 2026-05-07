type ReleaseVersionListener = (releaseVersion: string) => void;

let listener: ReleaseVersionListener | null = null;

export function setReleaseVersionListener(next: ReleaseVersionListener | null): void {
  listener = next;
}

export function emitReleaseVersionUpdated(releaseVersion: string): void {
  try {
    listener?.(releaseVersion);
  } catch (error) {
    console.error("[release_version_bus] emit_failed", error);
  }
}
