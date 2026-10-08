// Copy buttons only. The page works without this script.
(() => {
  for (const block of document.querySelectorAll('[data-copy-block]')) {
    const button = block.querySelector('button.copy');
    const code = block.querySelector('pre code');
    if (!button || !code) continue;
    button.hidden = false;
    let timer;

    const selectCode = () => {
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };
    const flash = (text) => {
      button.textContent = text;
      clearTimeout(timer);
      timer = setTimeout(() => { button.textContent = 'Copy'; }, 2000);
    };

    button.addEventListener('click', async () => {
      const text = code.textContent;
      try {
        await navigator.clipboard.writeText(text);
        flash('Copied');
        return;
      } catch {
        // Fall through to the selection fallback.
      }
      selectCode();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      flash(ok ? 'Copied' : 'Press Ctrl+C');
    });
  }
})();
