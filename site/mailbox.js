// Mailbox preview: contact selection, the two dialogs and the "preview only" note. Nothing is sent anywhere.
(() => {
  const rows = document.querySelectorAll('.contact-row');
  const details = document.querySelectorAll('.detail');
  for (const row of rows) {
    row.addEventListener('click', () => {
      for (const other of rows) other.setAttribute('aria-pressed', String(other === row));
      for (const detail of details) detail.hidden = detail.id !== row.dataset.target;
    });
  }

  for (const button of document.querySelectorAll('[data-open]')) {
    button.addEventListener('click', () => {
      const dialog = document.getElementById(button.dataset.open);
      if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    });
  }
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  for (const dialog of document.querySelectorAll('dialog')) {
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  }

  const toast = document.getElementById('toast');
  let timer;
  for (const button of document.querySelectorAll('[data-preview]')) {
    button.addEventListener('click', () => {
      toast.textContent = 'Preview only: this does nothing here.';
      toast.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => { toast.hidden = true; }, 2400);
    });
  }
})();
