import { icon } from './icons.js';
import { ODESA_MODEL } from './odesa.js';

const welcome = document.createElement('dialog');
welcome.id = 'opus-welcome';
welcome.setAttribute('aria-labelledby', 'welcome-title');
welcome.innerHTML = `
  <div class="welcome-scene" aria-hidden="true"></div><div class="welcome-ascii" aria-hidden="true"></div>
  <div class="welcome-top"><div class="welcome-brand"><img class="opus-logo" src="assets/opus-mark.svg" alt="" width="27" height="20"><span>OPUS LOOPS</span></div><button class="welcome-close" aria-label="Close welcome" autofocus>${icon('close')}</button></div>
  <div class="welcome-scroll" tabindex="0" aria-label="About OPUS LOOPS And Odesa">
    <section class="welcome-hero" aria-labelledby="welcome-title">
      <div class="welcome-hero-copy"><p class="welcome-eyebrow">AI NATIVE DAW</p><h1 id="welcome-title">Natural Language.<br><span>Real Control.</span></h1><p class="welcome-description">Your ideas, in your own words.<br>An editable music studio that keeps you in control.</p></div>
    </section>
    <section class="welcome-tempo" aria-labelledby="welcome-tempo-title">
      <div class="welcome-tempo-copy"><div class="welcome-available"><span></span>Available Today <span class="welcome-version">${ODESA_MODEL.version}</span></div><p class="welcome-eyebrow">MEET YOUR EVERYDAY CO-PRODUCER</p><h2 id="welcome-tempo-title">Odesa <span>Tempo</span></h2><p>Move from an idea to the next edit. Ask Tempo to shape clips, arrange sections, adjust your mix, or prepare an export — inside your session.</p><p class="welcome-account-note">Available with an OPUS account. You review the results; project edits support Undo.</p></div>
      <div class="welcome-directions"><p class="welcome-eyebrow">A FEW WORDS. A NEW DIRECTION.</p><button class="welcome-prompt" data-prompt="Set the tempo to 124 BPM."><span>Set The Tempo To 124 BPM.</span>${icon('right')}</button><button class="welcome-prompt" data-prompt="Add a warm bass track."><span>Add A Warm Bass Track.</span>${icon('right')}</button><button class="welcome-prompt" data-prompt="Export the selected tracks as stems."><span>Export The Selected Tracks As Stems.</span>${icon('right')}</button><p class="welcome-prompt-note">Choose a direction to draft your first request.</p></div>
    </section>
    <div class="welcome-workflows" aria-label="Studio Workflows"><span>${icon('session')}Session & Arrangement</span><span>${icon('notes')}Audio & MIDI</span><span>${icon('settings')}Instruments & Effects</span><span>${icon('download')}Projects & Export</span></div>
    <details class="welcome-roadmap"><summary><span>Next In Odesa</span><small>Forte & Prelude</small>${icon('chevron-down')}</summary><div class="welcome-upcoming"><div><h3>Odesa Forte <span>In Development</span></h3><p>Deeper production, mixing, and multi-step creative decisions.</p></div><div><h3>Odesa Prelude <span>Planned</span></h3><p>Experimental previews of what comes next.</p></div><p class="welcome-future-note">Upcoming configurations. Tempo is the model available today.</p></div></details>
  </div>
  <footer class="welcome-footer"><p>Work With AI. Stay The Artist.<span>Projects save in this browser. Export a copy to keep.</span></p><button class="welcome-enter">Enter Studio ${icon('right')}</button></footer>`;
document.body.append(welcome);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const field = welcome.querySelector('.welcome-ascii');
let previousFocus, disposeField, motionGeneration = 0, closeTimer, artFrame;
function stopMotion() {
  motionGeneration++;
  cancelAnimationFrame(artFrame);
  disposeField?.();
  disposeField = undefined;
  field.replaceChildren();
}
async function startMotion() {
  const generation = ++motionGeneration;
  if (!welcome.open) return;
  try {
    const { mountGradientASCII } = await import('./gradient-ascii.js');
    if (generation !== motionGeneration || !welcome.open) return;
    disposeField = mountGradientASCII(field, {
      colors:['#456875','#88bfc7','#c4d1ec','#edf3ff'], shape:'horizon',
      characters:' =+xX0S8#@', cellSize:18, density:.72, lightMode:true,
      glyphOpacity:.85, gradientOpacity:.35, glow:.12, depthOfField:.04,
      flicker:.08, softness:.8, flow:.35, speed:reduceMotion.matches?0:.35,
      grain:.015, dpr:1.25, mouseInteraction:true, clickEffect:'none',
      intro:!reduceMotion.matches
    });
  } catch {
    // The text-free landscape and neutral surface remain when optional WebGL artwork is unavailable.
    field.replaceChildren();
  }
}
function openWelcome() {
  if (welcome.open) return;
  clearTimeout(closeTimer);
  welcome.classList.remove('welcome-closing');
  previousFocus = document.activeElement;
  welcome.querySelector('.welcome-scroll').scrollTop = 0;
  welcome.showModal();
  // Keep optional artwork out of the critical workspace startup transaction.
  artFrame = requestAnimationFrame(() => { artFrame = requestAnimationFrame(() => { if (welcome.open) startMotion(); }); });
}
function closeWelcome(afterClose) {
  if (!welcome.open || welcome.classList.contains('welcome-closing')) return;
  stopMotion();
  const finish = () => { welcome.close(); welcome.classList.remove('welcome-closing'); afterClose?.(); };
  if (reduceMotion.matches) finish();
  else { welcome.classList.add('welcome-closing'); closeTimer = setTimeout(finish, 160); }
}
welcome.querySelector('.welcome-close').addEventListener('click', () => closeWelcome());
welcome.querySelector('.welcome-enter').addEventListener('click', () => closeWelcome());
welcome.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => closeWelcome(() => {
  const toggle = document.getElementById('agent-open');
  if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click();
  const prompt = document.getElementById('agent-prompt');
  if (prompt) { prompt.value = button.dataset.prompt; prompt.dispatchEvent(new Event('input', {bubbles:true})); prompt.focus({preventScroll:true}); }
})));
// Native dialog focus trapping remains in place, and DAW keys never reach the session.
welcome.addEventListener('keydown', event => event.stopPropagation());
welcome.addEventListener('cancel', event => { event.preventDefault(); closeWelcome(); });
welcome.addEventListener('close', () => {
  clearTimeout(closeTimer);
  welcome.classList.remove('welcome-closing');
  stopMotion();
  if (document.activeElement !== document.body && !welcome.contains(document.activeElement)) return;
  if (previousFocus instanceof HTMLElement && previousFocus !== document.body) previousFocus.focus();
  else document.getElementById('play')?.focus();
});
reduceMotion.addEventListener('change', () => { stopMotion(); if (welcome.open) startMotion(); });
window.addEventListener('pageshow', event => { if (event.persisted) openWelcome(); });
window.addEventListener('pagehide', () => { clearTimeout(closeTimer); stopMotion(); if (welcome.open) welcome.close(); });
openWelcome();
