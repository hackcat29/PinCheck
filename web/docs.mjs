for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.parentElement.querySelector('code').textContent;
    const label = button.textContent;
    try { await navigator.clipboard.writeText(text); button.textContent = 'Copied'; }
    catch { window.prompt('Copy this:', text); }
    setTimeout(() => { button.textContent = label; }, 1600);
  });
}
