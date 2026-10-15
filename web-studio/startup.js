// Reveal only the completed workspace, restored project, and welcome dialog.
const root = document.documentElement;
const message = document.getElementById('startup-message');
const retry = document.getElementById('startup-retry');
const slow = setTimeout(() => {
  message.textContent = 'Taking a little longer. Check your connection or reload.';
  retry.hidden = false;
}, 20000);
try {
  await import('./workspace.js');
  await import('./app.js');
  await import('./welcome.js');
  await Promise.all([...document.querySelectorAll('.opus-logo')].map(image => image.decode().catch(() => {})));
  // Layout must remain measurable during initialization; visibility gating avoids display:none.
  await new Promise(resolve => requestAnimationFrame(resolve));
  root.removeAttribute('data-startup');
  document.getElementById('studio-startup').remove();
  document.querySelector('#opus-welcome .welcome-close')?.focus({preventScroll:true});
} catch (error) {
  root.dataset.startup = 'error';
  message.textContent = 'The studio could not load. Please try again.';
  retry.hidden = false;
  console.error('Studio startup failed:', error);
} finally {
  clearTimeout(slow);
}
