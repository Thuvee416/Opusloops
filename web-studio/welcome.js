import { mountGradientASCII } from './gradient-ascii.js';

const welcome = document.createElement('dialog');
welcome.id = 'opus-welcome';
welcome.setAttribute('aria-labelledby', 'welcome-title');
welcome.innerHTML = `
  <button class="welcome-close" aria-label="Close welcome" autofocus>×</button>
  <div class="welcome-scroll">
    <header class="welcome-hero">
      <div class="welcome-art" aria-hidden="true"></div>
      <div class="welcome-hero-content">
        <div class="welcome-brand">OPUS LOOPS <span>EXPERIMENTAL STUDIO</span></div>
        <p class="welcome-eyebrow">A NEW FREQUENCY OF CREATION</p>
        <h1 id="welcome-title">Make what you hear<br>in your head.</h1>
        <p class="welcome-intro">An experimental AI DAW. A browser-sized doorway to a limitless studio.</p>
      </div>
    </header>
    <div class="welcome-body">
      <p class="welcome-story">We’re studying and reverse-engineering the workflows of beloved desktop DAWs to reimagine music-making on the web. Familiar creative tools today. A studio that understands your imagination tomorrow.</p>
      <div class="welcome-features">
        <section aria-labelledby="welcome-built">
          <p class="welcome-section-label"><i></i> READY TO EXPLORE</p>
          <h2 id="welcome-built">The studio is already alive.</h2>
          <ul>
            <li><strong>Find your flow</strong><span>Launch clips and scenes, then shape performances in the Arrangement.</span></li>
            <li><strong>Turn ideas into sound</strong><span>MIDI piano roll, synth, sampler, drum rack, and audio & MIDI recording.</span></li>
            <li><strong>Shape every detail</strong><span>Audio editing and warping, automation, mixer sends, EQ, compression, delay and reverb.</span></li>
            <li><strong>Keep what you create</strong><span>Local autosave, project files, undo & redo, WAV mixes and stems, and MIDI export.</span></li>
          </ul>
        </section>
        <section aria-labelledby="welcome-next">
          <p class="welcome-section-label upcoming">THE NEXT HORIZON · UPCOMING</p>
          <h2 id="welcome-next">From intention to expression.</h2>
          <ul>
            <li><strong>A producer you can talk to</strong><span>Describe a feeling. Imagine agents composing, arranging and evolving a track with you.</span></li>
            <li><strong>Mix at the speed of thought</strong><span>Ask for warmth, space or impact. A vision for natural-language edits across your entire session.</span></li>
            <li><strong>A deeper creative universe</strong><span>Advanced routing, take lanes, comping, expressive instruments, racks and macros.</span></li>
            <li><strong>A studio without an edge</strong><span>Connected collaborators, controller integration, plugin bridges and creative agents working together.</span></li>
          </ul>
        </section>
      </div>
      <aside class="welcome-dream"><span>IMAGINE SAYING</span><p>“Make it feel like driving through a city at 2 AM.<br>Give the drums a heartbeat. Let the chorus take off.”</p><small>The agentic studio is our north star. These capabilities are in development.</small></aside>
      <footer class="welcome-footer"><p>Early. Evolving. Yours to explore.<span>Projects save in this browser. Download a project file to keep a portable copy.</span></p><button class="welcome-enter">Enter the studio <span aria-hidden="true">↗</span></button></footer>
    </div>
  </div>`;
document.body.append(welcome);
let dispose;
let previousFocus;
function openWelcome() {
  if (welcome.open) return;
  previousFocus = document.activeElement;
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
