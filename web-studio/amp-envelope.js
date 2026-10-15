export function envelopeAt(s,t){if(t<=0)return 0;if(t<s.attack)return t/s.attack;if(t<s.attack+s.decay)return 1-(1-s.sustain)*(t-s.attack)/s.decay;return s.sustain;}
