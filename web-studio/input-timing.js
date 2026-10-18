// Event timestamps and performance.now() share a millisecond time origin.
// Map receipt time onto the processing clock; do not subtract output latency.
// Monitoring still starts immediately, independently of recorded event time.
export function inputEventTime(context, timestamp, now = performance.now()) {
  const current = context.currentTime;
  if (!Number.isFinite(current) || current < 0) throw new Error('Invalid input audio clock.');
  if (context.state !== 'running' || !Number.isFinite(timestamp) || timestamp <= 0 ||
      !Number.isFinite(now) || now < 0 || timestamp > now) return current;
  return Math.max(0, current - (now - timestamp) / 1000);
}

export function inputTimingState(context) {
  const rate=context?.sampleRate;
  return {eventTimestamps:true,minimumNoteSeconds:Number.isFinite(rate)&&rate>=8000&&rate<=384000?1/rate:null,latencyCompensation:false};
}
