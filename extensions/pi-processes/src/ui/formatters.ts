/** Format a duration in compact minutes and seconds. */
export function formatDuration(milliseconds: number): string {
   const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
   const minutes = Math.floor(totalSeconds / 60);
   const seconds = totalSeconds % 60;
   return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}
