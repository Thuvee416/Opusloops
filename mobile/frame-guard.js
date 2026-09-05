(() => {
  "use strict";

  if (window.self === window.top) {
    document.documentElement.classList.remove("frame-check-pending");
    return;
  }

  document.documentElement.setAttribute("aria-hidden", "true");
  try {
    window.top.location.replace(window.self.location.href);
  } catch {
    // Keep the framed document hidden when the embedding page blocks top navigation.
  }
})();
