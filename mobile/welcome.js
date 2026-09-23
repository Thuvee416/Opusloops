(() => {
  const cloud = window.OpusloopsCloud;
  const modal = document.querySelector('#account-modal');
  const close = document.querySelector('#account-close');
  const link = document.querySelector('#account-link');
  const form = document.querySelector('#login-form');
  const actions = document.querySelector('#session-actions');
  const title = document.querySelector('#account-title');
  const description = document.querySelector('#account-description');
  const status = document.querySelector('#account-status');
  const error = document.querySelector('#account-error');
  const submit = document.querySelector('#login-submit');
  const logout = document.querySelector('#logout-submit');
  const toggle = document.querySelector('#registration-toggle');
  const registrationFields = document.querySelector('#registration-fields');
  let registering = false;
  let busy = false;
  let signedOut = new URLSearchParams(location.search).has('signedout');

  function openAccount(event) {
    event?.preventDefault();
    render();
    if (!modal.open) modal.showModal();
  }
  link?.addEventListener('click', openAccount);
  document.querySelectorAll('[data-open-studio]').forEach(button => button.addEventListener('click', event => {
    if (!cloud?.getSession()?.user) openAccount(event);
  }));
  close?.addEventListener('click', () => { if (!busy) modal.close(); });
  modal?.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  modal?.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const controls = [...modal.querySelectorAll('button, input, a[href], [tabindex]')]
      .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  modal?.addEventListener('click', event => {
    const rect = modal.getBoundingClientRect();
    if (!busy && event.target === modal && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) modal.close();
  });
  modal?.addEventListener('close', () => {
    form.password.value = '';
    form.invite.value = '';
    error.hidden = true;
  });

  function render() {
    const session = cloud?.getSession();
    if (link) {
      link.textContent = session ? 'Your account ↗' : 'Sign in ↗';
    }
    if (!form) return;
    form.hidden = Boolean(session);
    actions.hidden = !session;
    toggle.hidden = Boolean(session);
    registrationFields.hidden = !registering;
    form.invite.disabled = !registering;
    form.invite.required = registering;
    form.password.minLength = registering ? 8 : 1;
    form.password.autocomplete = registering ? 'new-password' : 'current-password';
    toggle.textContent = registering ? 'Already registered? Sign in' : 'Create an account';
    submit.querySelector('span').textContent = registering ? 'Create account ↗' : 'Sign in ↗';
    title.textContent = session ? 'Your space.' : signedOut ? 'Signed out.' : 'Sign in.';
    description.textContent = session ? (session.user?.email || 'You’re signed in.') : signedOut ? 'See you at the next session.' : 'Pick up where you left off.';
    status.textContent = '';
    if (!session && registering) { title.textContent = 'Create account.'; description.textContent = 'Your private music workspace.'; }
    else if (!session && new URLSearchParams(location.search).has('access')) status.textContent = 'Sign in to open the studio. An internet connection is required to verify access.';
    if (session && new URLSearchParams(location.search).get('access') === 'verify') status.textContent = 'Could not verify your session. Check your connection and try opening the studio again, or sign out and sign in again.';
  }

  toggle?.addEventListener('click', () => {
    if (busy) return;
    registering = !registering;
    error.hidden = true;
    render();
  });

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
  }

  form?.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true;
    error.hidden = true;
    submit.disabled = true;
    submit.querySelector('span').textContent = registering ? 'Creating account…' : 'Signing in…';
    status.textContent = 'Connecting to your workspace…';
    try {
      if (!cloud?.configured()) throw new Error('Sign-in is unavailable. Please try again later.');
      const session = registering
        ? (await cloud.signUp(form.email.value.trim(), form.password.value, form.invite.value.trim())).session
        : await cloud.signIn(form.email.value.trim(), form.password.value);
      if (!session?.user) throw new Error('Sign-in was not completed. Please try again.');
      form.password.value = '';
      window.location.assign('./studio.html');
    } catch (failure) {
      showError(failure.message || 'Could not sign in. Please try again.');
      status.textContent = '';
    } finally {
      busy = false;
      submit.disabled = false;
      submit.querySelector('span').textContent = registering ? 'Create account ↗' : 'Sign in ↗';
    }
  });

  logout?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    error.hidden = true;
    logout.disabled = true;
    status.textContent = 'Signing out…';
    try {
      await cloud.signOut();
      signedOut = true;
      render();
      form.reset();
      document.querySelector('#email').focus();
    } catch {
      showError('Could not sign out. Please try again.');
    } finally {
      busy = false;
      logout.disabled = false;
    }
  });

  window.addEventListener('opusloops:auth-session-change', render);
  window.addEventListener('pageshow', render);
  if (document.body.hasAttribute('data-account-entry')) openAccount();
  Promise.resolve(cloud?.restoreSession()).then(() => {
    render();
  }).catch(() => { render(); if (error) showError('Could not check your session. Please try signing in.'); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./service-worker.js').catch(() => {});
})();
