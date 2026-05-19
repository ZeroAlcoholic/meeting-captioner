/**
 * Trigger a browser download for an in-memory blob. Standard Blob + anchor +
 * click + revoke pattern. The anchor is appended to document.body before the
 * click — some browsers ignore clicks on detached anchors.
 */
export function triggerDownload(body: string, filename: string, mime: string): void {
  if (typeof document === 'undefined') return; // SSR / test environment guard
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Release the object URL on the next tick so the click has time to be
  // dispatched. Some browsers revoke too eagerly otherwise.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
