import { mountGradientASCII } from './gradient-ascii.js';

const welcome = document.createElement('dialog');
welcome.id = 'opus-welcome';
welcome.setAttribute('aria-labelledby', 'welcome-title');
welcome.innerHTML = `
  <header class="welcome-bar"><span><i></i> opusloops / welcome</span><button class="welcome-close" aria-label="Close welcome" autofocus>×</button></header>
  <div class="welcome-scroll" tabindex="0" role="region" aria-label="About OPUS LOOPS">
    <div class="welcome-art" aria-hidden="true"></div>
    <div class="welcome-content">
      <p class="welcome-command">$ open opusloops</p>
      <h1 id="welcome-title">A real studio.<br>A lighter way to create.</h1>
      <p>OPUS LOOPS is an experimental AI DAW in your browser. Built from research into the workflows of popular desktop DAWs, with recording, arrangement, instruments, effects and export already here.</p>
      <p>The ambition: the full functionality of a desktop DAW, in a lightweight studio you can open anywhere.</p>
      <section aria-labelledby="welcome-built"><h2 id="welcome-built"><span>01</span> AVAILABLE NOW</h2>
      <ul><li>Session clips & scenes / Arrangement</li><li>Audio & MIDI recording / Piano roll</li><li>Synth / Sampler / Drum rack</li><li>Audio editing / Warping / Automation</li><li>Mixer / Sends / EQ / Dynamics / Effects</li><li>Project files / Autosave / Undo & redo</li><li>WAV mixes & stems / MIDI export</li></ul></section>
      <section aria-labelledby="welcome-next"><h2 id="welcome-next"><span>02</span> THE AGENTIC STUDIO <em>UPCOMING</em></h2>
      <p>Produce and mix through natural language. Tell the studio what you hear in your head; creative agents help turn it into sound.</p>
      <p>Our target is the depth, detail and polish of top mixing engineers—directed in your own words. Natural-language mixing and full desktop DAW parity are still ahead.</p>
      <blockquote><span>&gt;</span> “Bring the vocal forward. Warm up the bass.<br>Give the chorus more space.”</blockquote>
      <p class="welcome-muted">On the horizon: advanced routing, comping, racks & macros, plugin bridges, controllers and collaboration.</p></section>
      <p class="welcome-note">// Projects save in this browser. Download a project file for a portable copy.</p>
    </div>
  </div>
  <footer class="welcome-footer"><span>EXPERIMENTAL / ALWAYS EVOLVING</span><button class="welcome-enter">Enter the studio <span aria-hidden="true">↗</span></button></footer>`;
document.body.append(welcome);
let dispose;
let previousFocus;
function openWelcome() {
  if (welcome.open) return;
  previousFocus = document.activeElement;
  welcome.querySelector('.welcome-scroll').scrollTop = 0;
  welcome.showModal();
  try { dispose = mountGradientASCII(welcome.querySelector('.welcome-art'), { dpr: 1.5, speed: 0.55 }); }
  catch (error) { console.warn('Welcome animation unavailable; using static background.'); }
}
welcome.querySelector('.welcome-close').addEventListener('click', () => welcome.close());
welcome.querySelector('.welcome-enter').addEventListener('click', () => welcome.close());
// Keep DAW keyboard commands from acting on the session behind the dialog.
welcome.addEventListener('keydown', event => event.stopPropagation());
welcome.addEventListener('close', () => {
  dispose?.();
  dispose = undefined;
  if (previousFocus instanceof HTMLElement && previousFocus !== document.body) previousFocus.focus();
  else document.getElementById('play')?.focus();
});
window.addEventListener('pageshow', event => { if (event.persisted) openWelcome(); });
window.addEventListener('pagehide', () => { if (welcome.open) welcome.close(); });
openWelcome();
