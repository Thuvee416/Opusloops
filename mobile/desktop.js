// Keyboard controls complement existing mouse/touch handlers; no audio-path changes.
document.addEventListener('keydown', event => {
  if (!matchMedia('(min-width: 1024px)').matches || document.body.hidden || event.repeat) return;
  if (document.querySelector('dialog[open]') || event.target.closest('input, textarea, select, [contenteditable="true"], [role="slider"]')) return;
  if (event.altKey && !event.ctrlKey && !event.metaKey && /^[1-4]$/.test(event.key)) {
    event.preventDefault();
    const views = ['create', 'studio', 'mix', 'projects'];
    document.querySelector(`.nav-item[data-view-target="${views[Number(event.key)-1]}"]`)?.click();
  } else if (event.code === 'Space' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.target.closest('button, a')) {
    const player = document.querySelector('#persistent-player');
    if (player && !player.hidden) {
      event.preventDefault();
      document.querySelector('#persistent-play-button')?.click();
    }
  }
});
