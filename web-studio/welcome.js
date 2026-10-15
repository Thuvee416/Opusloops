import { mountSoftAurora } from './soft-aurora.js';

const welcome = document.createElement('dialog');
welcome.id = 'opus-welcome';
welcome.setAttribute('aria-labelledby', 'welcome-title');
welcome.innerHTML = `
  <div class="welcome-top"><div class="welcome-brand"><img class="opus-logo" src="assets/opus-symbol-teal.png" alt="OPUS LOOPS" width="64" height="32"><span>OPUS LOOPS</span></div><button class="welcome-close" aria-label="Close welcome" autofocus><svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button></div>
  <div class="welcome-scroll">
    <header class="welcome-hero"><div class="welcome-art" aria-hidden="true"></div><div class="welcome-hero-content"><p class="welcome-eyebrow"><i></i> AN EXPERIMENTAL BROWSER STUDIO</p><h1 id="welcome-title">Less between you<br>and the music.</h1><p class="welcome-intro">Desktop-inspired workflows. A lightweight canvas.<br>A new space to follow your sound.</p><div class="welcome-aurora" aria-hidden="true"></div></div></header>
    <div class="welcome-body"><div class="welcome-features"><section aria-labelledby="welcome-built"><p class="welcome-section-label">01 / AVAILABLE NOW</p><h2 id="welcome-built">Start with an idea.</h2><ul><li>Session clips & arrangement</li><li>Audio & MIDI recording</li><li>Instruments, effects & automation</li><li>Mixing, project files & stem export</li></ul></section><section aria-labelledby="welcome-next"><p class="welcome-section-label">02 / ON THE HORIZON</p><h2 id="welcome-next">Create in conversation.</h2><p>Agents that compose, arrange and mix through natural language. More expressive tools. A connected creative studio.</p><span class="welcome-status">In development</span></section></div><aside class="welcome-dream"><span>JUST IMAGINE</span><p>“Warmer bass. More space.<br>Make the chorus lift.”</p></aside></div>
  </div>
  <footer class="welcome-footer"><p>Your ideas stay yours.<span>Saved in this browser. Export a copy to keep.</span></p><button class="welcome-enter">Enter Studio <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h16m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></footer>`;
document.body.append(welcome);
let previousFocus;
let disposeAurora;
function openWelcome() {
  if (welcome.open) return;
  previousFocus = document.activeElement;
  welcome.showModal();
  disposeAurora = mountSoftAurora(welcome.querySelector('.welcome-aurora'), { speed: 0.4, brightness: 0.85, noiseAmplitude: 1.2, bandSpread: 0.8, scale: 1.2 });

}
welcome.querySelector('.welcome-close').addEventListener('click', () => welcome.close());
welcome.querySelector('.welcome-enter').addEventListener('click', () => welcome.close());
// Keep DAW keyboard commands from acting on the session behind the dialog.
welcome.addEventListener('keydown', event => event.stopPropagation());
welcome.addEventListener('close', () => {
  disposeAurora?.();
  disposeAurora = undefined;
  welcome.querySelectorAll('canvas').forEach(canvas => canvas.remove());
  if (previousFocus instanceof HTMLElement && previousFocus !== document.body) previousFocus.focus();
  else document.getElementById('play')?.focus();
});
window.addEventListener('pageshow', event => { if (event.persisted) openWelcome(); });
window.addEventListener('pagehide', () => { if (welcome.open) welcome.close(); });
openWelcome();
