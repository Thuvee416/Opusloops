// All command buttons delegate to the existing, guarded project/account actions.
const commands = [...document.querySelectorAll('[data-desktop-command]')];
function syncDesktopCommands() {
  for (const button of commands) {
    const target = document.getElementById(button.dataset.desktopCommand);
    const disabled = document.body.hidden || !target || target.disabled;
    if (button.disabled !== disabled) button.disabled = disabled;
  }
  const label = document.querySelector('#desktop-project-name');
  const title = document.querySelector('#persistent-player-title')?.textContent?.trim();
  const next = !document.querySelector('#persistent-player')?.hidden && title ? title : 'Workspace';
  if (label && label.textContent !== next) label.textContent = next;
}
commands.forEach(button => button.addEventListener('click', () => {
  if (document.body.hidden) return;
  const target = document.getElementById(button.dataset.desktopCommand);
  if (target && !target.disabled) target.click();
  syncDesktopCommands();
}));
const commandObserver = new MutationObserver(syncDesktopCommands);
// Observe source state only, avoiding feedback from the mirrored toolbar.
for (const target of [...commands.map(button => document.getElementById(button.dataset.desktopCommand)), document.querySelector('#persistent-player')]) {
  if (target) commandObserver.observe(target, {attributes: true, childList: true, subtree: true});
}
commandObserver.observe(document.body, {attributes: true, attributeFilter: ['hidden']});
syncDesktopCommands();

document.addEventListener('keydown', event => {
  if (!matchMedia('(min-width: 1024px)').matches || document.body.hidden || event.repeat) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    const save = document.getElementById('save-project-button');
    if (save && !save.disabled) save.click();
    return;
  }
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
    } else if (document.querySelector('#view-studio.is-active') && document.querySelector('#studio-empty')?.hidden) {
      event.preventDefault();
      document.querySelector('#play-button')?.click();
    }
  }
});
