import { icon } from './icons.js';
import { ODESA_MODEL } from './odesa.js';

const welcome = document.createElement('dialog');
welcome.id = 'opus-welcome';
welcome.setAttribute('aria-labelledby', 'welcome-title');
welcome.innerHTML = `
  <div class="welcome-top"><div class="welcome-brand"><img class="opus-logo" src="assets/opus-symbol-teal.png" alt="" width="40" height="20"><span>OPUS LOOPS</span><span class="welcome-edition">AI Native DAW</span></div><button class="welcome-close" aria-label="Close welcome" autofocus>${icon('close')}</button></div>
  <div class="welcome-scroll" tabindex="0" aria-label="About OPUS LOOPS And Odesa">
    <figure class="welcome-banner"><img src="assets/opus-brand-landscape.jpg" width="1280" height="720" alt="OPUS LOOPS. Natural Language. Real Control. AI Native DAW." fetchpriority="high"></figure>
    <div class="welcome-body">
      <section class="welcome-introduction" aria-labelledby="welcome-title"><div><p class="welcome-eyebrow">YOUR STUDIO. YOUR DIRECTION.</p><h1 id="welcome-title">Make Music.<br>In Your Own Words.</h1><p>OPUS LOOPS is your AI-native digital audio workstation. Meet <strong>Odesa</strong>, the AI model family behind the studio: different models for different production workflows, all built around natural-language control.</p><p class="welcome-philosophy">Work with AI. Stay the artist. Shape an editable session, one creative decision at a time.</p></div><figure class="welcome-studio-art"><img src="assets/opus-brand-studio.jpg" width="1024" height="1280" loading="lazy" alt="OPUS LOOPS branding artwork featuring an arrangement, waveforms, piano roll and studio controls."><figcaption>Your Session. Still Yours.</figcaption></figure></section>
      <section class="welcome-models" aria-labelledby="welcome-models-title"><div class="welcome-section-heading"><h2 id="welcome-models-title">Meet The Odesa Models</h2><span>ONE FAMILY. THREE DIRECTIONS.</span></div>
        <details class="welcome-model welcome-tempo"><summary><span class="welcome-model-mark" aria-hidden="true">${icon('play')}</span><span class="welcome-model-name"><strong>Odesa Tempo</strong><span>Fast, Everyday Work</span></span><span class="welcome-model-state">Available · ${ODESA_MODEL.version}</span>${icon('chevron-down')}</summary><div class="welcome-model-content"><p>Responsive and lightweight, Tempo handles routine production tasks so quick changes keep pace with your creative flow.</p><p class="welcome-best">Quick Edits · Arranging · Repetitive Tasks · Everyday Production</p><div class="welcome-examples"><span>TRY SAYING</span><ul><li>“Extend this drum pattern by eight bars.”</li><li>“Reduce the hi-hat volume by 3 dB.”</li><li>“Duplicate this section and remove the bass.”</li></ul></div></div></details>
        <details class="welcome-model welcome-forte"><summary><span class="welcome-model-mark" aria-hidden="true">${icon('settings')}</span><span class="welcome-model-name"><strong>Odesa Forte</strong><span>Deeper Production And Mixing</span></span><span class="welcome-model-state">In Development</span>${icon('chevron-down')}</summary><div class="welcome-model-content"><p>Being built for complex production decisions: understanding a project, the relationships between tracks and the way individual sounds work together.</p><p class="welcome-best">Detailed Arrangement · Mixing · Sound Design · Multi-Step Decisions</p><div class="welcome-examples"><span>THE WORKFLOWS WE’RE BUILDING TOWARD</span><ul><li>“Make the kick and bass sit better together.”</li><li>“Create a more dynamic transition into the second drop.”</li><li>“Clean up the low end while preserving the warmth of the mix.”</li></ul></div></div></details>
        <details class="welcome-model welcome-prelude"><summary><span class="welcome-model-mark" aria-hidden="true">${icon('arrangement')}</span><span class="welcome-model-name"><strong>Odesa Prelude</strong><span>Experimental Previews</span></span><span class="welcome-model-state">Planned</span>${icon('chevron-down')}</summary><div class="welcome-model-content"><p>A future preview space for emerging capabilities, alternative sound-design approaches and creative workflows before they reach the standard OPUS LOOPS experience.</p><p class="welcome-best">Early Adopters · Experimental Producers · What Comes Next</p><div class="welcome-examples"><span>ON THE HORIZON</span><ul><li>Preview new AI production features.</li><li>Explore alternative sound-design approaches.</li><li>Try emerging creative workflows and model improvements.</li></ul></div></div></details>
        <p class="welcome-availability">Tempo is available today with an OPUS account. Forte and Prelude are upcoming model configurations.</p>
        <details class="welcome-comparison"><summary>How The Models Differ ${icon('chevron-down')}</summary><div class="welcome-table"><table><caption>Odesa At A Glance</caption><thead><tr><th scope="col">Focus</th><th scope="col">Tempo</th><th scope="col">Forte</th><th scope="col">Prelude</th></tr></thead><tbody><tr><th scope="row">Primary Goal</th><td>Speed</td><td>Depth</td><td>Innovation</td></tr><tr><th scope="row">Task Complexity</th><td>Everyday</td><td>Advanced</td><td>Experimental</td></tr><tr><th scope="row">Experience</th><td>Responsive</td><td>More Deliberate</td><td>Exploratory</td></tr><tr><th scope="row">Ideal User</th><td>All Producers</td><td>Advanced Producers</td><td>Early Adopters</td></tr></tbody></table></div></details>
      </section>
      <section class="welcome-workspace" aria-labelledby="welcome-built"><h2 id="welcome-built">A Real Session To Make Your Own</h2><p>Your music stays editable. Launch clips, arrange sections, record audio and MIDI, shape instruments and effects, automate the mix, and export your work.</p><div class="welcome-feature-list"><span>Session & Arrangement</span><span>Audio & MIDI Recording</span><span>Instruments & Effects</span><span>Mixing & Automation</span><span>Projects & Stem Export</span></div></section>
      <aside class="welcome-manifesto"><p>You Bring The Direction.<br>Odesa Helps You Get There.</p><span>Tempo moves fast. Forte goes deep. Prelude explores what’s next.</span></aside>
    </div>
  </div>
  <footer class="welcome-footer"><p>Your Ideas Stay Yours.<span>Saved in this browser. Export a copy to keep.</span></p><button class="welcome-enter">Enter Studio ${icon('right')}</button></footer>`;
document.body.append(welcome);
let previousFocus;
function openWelcome() {
  if (welcome.open) return;
  previousFocus = document.activeElement;
  welcome.querySelector('.welcome-scroll').scrollTop = 0;
  welcome.showModal();
}
welcome.querySelector('.welcome-close').addEventListener('click', () => welcome.close());
welcome.querySelector('.welcome-enter').addEventListener('click', () => welcome.close());
// Keep DAW keyboard commands from acting on the session behind the dialog.
welcome.addEventListener('keydown', event => event.stopPropagation());
welcome.addEventListener('close', () => {
  // A queued close event must not steal focus from a control the user has already chosen.
  if (document.activeElement !== document.body && !welcome.contains(document.activeElement)) return;
  if (previousFocus instanceof HTMLElement && previousFocus !== document.body) previousFocus.focus();
  else document.getElementById('play')?.focus();
});
window.addEventListener('pageshow', event => { if (event.persisted) openWelcome(); });
window.addEventListener('pagehide', () => { if (welcome.open) welcome.close(); });
openWelcome();
