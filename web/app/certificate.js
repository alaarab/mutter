export function confirmCertificate(info, signal) {
  if (signal.aborted) return Promise.resolve(false);
  const dialog = document.getElementById('certificateDialog');
  const changed = !!info.expectedFingerprint;
  document.getElementById('certificateTitle').textContent = changed ? 'Server certificate changed' : 'Trust this server?';
  document.getElementById('certificateMessage').textContent = changed
    ? `The certificate for ${info.host}:${info.port} differs from the one you trusted. Check the new fingerprint with the server owner before continuing.`
    : `The identity of ${info.host}:${info.port} could not be verified automatically. Check this fingerprint with the server owner before trusting it.`;
  document.getElementById('certificateFingerprint').textContent = info.fingerprint.match(/.{2}/g).join(':');
  document.getElementById('certificatePrevious').hidden = !changed;
  document.getElementById('certificatePreviousFingerprint').textContent = info.expectedFingerprint?.match(/.{2}/g).join(':') ?? '';
  dialog.returnValue = 'cancel';
  return new Promise((resolve) => {
    const finish = () => {

      if (dialog.open) return;
      signal.removeEventListener('abort', abort);
      dialog.removeEventListener('close', finish);
      resolve(!signal.aborted && dialog.returnValue === 'trust');
    };
    const abort = () => { dialog.close('cancel'); finish(); };
    dialog.addEventListener('close', finish);
    signal.addEventListener('abort', abort, { once: true });
    dialog.showModal();
  });
}
