// Native feedback graphs incur a render quantum on each recirculation.
// Keep all repeats above -60 dB relative to the first wet impulse.
export function feedbackTailSeconds(delay,feedback,sampleRate=44100){const amount=Math.abs(feedback);if(!Number.isFinite(delay)||delay<0||!Number.isFinite(amount)||amount>=1||!Number.isFinite(sampleRate)||sampleRate<=0)throw new Error('Invalid feedback tail settings.');const repeats=amount>0?Math.max(1,Math.ceil(Math.log(.001)/Math.log(amount))):1;return delay*repeats+(repeats-1)*128/sampleRate;}
