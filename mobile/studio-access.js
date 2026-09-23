// Fail closed before the application initializes. Server APIs still enforce ownership.
(() => {
  const cloud = window.OpusloopsCloud;
  const root = document.documentElement;
  function lock() {
    root.classList.add('studio-locked');
    document.body.inert = true;
    document.body.hidden = true;
  }
  function redirect(reason = 'required') {
    lock();
    location.replace(`./account.html?access=${reason}`);
    return false;
  }
  async function verify() {
    lock();
    try {
      if (!cloud?.configured()) return redirect('unavailable');
      const session = await cloud.restoreSession({ requireOnline: true });
      if (!session?.user || !cloud.getSession()?.user) return redirect();
      root.classList.remove('studio-locked');
      document.body.inert = false;
      document.body.hidden = false;
      return true;
    } catch { return redirect('verify'); }
  }
  window.addEventListener('opusloops:auth-session-change', () => {
    if (!cloud?.getSession()?.user) redirect();
  });
  window.addEventListener('pagehide', lock);
  window.addEventListener('pageshow', event => { if (event.persisted) verify(); });
  window.OpusloopsStudioAccess = verify();
})();
