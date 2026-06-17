/**
 * qrcode.js — QR generation and camera scanning.
 *
 * Depends on CDN globals loaded by the host page:
 *   - QRCode (qrcode@1)  for generateQR
 *   - jsQR   (jsqr@1)    for startQrScanner
 *
 * Exposes:
 *   generateQR(canvas, text)                        — render QR onto a canvas element
 *   startQrScanner(videoEl, canvasEl, onDetected)   — open rear camera + scan loop; returns Promise
 *   stopQrScanner()                                 — stop stream and cancel loop
 */

let _animFrame = null;
let _stream    = null;
let _videoEl   = null;

function generateQR(canvas, text) {
  QRCode.toCanvas(canvas, text, { width: 220, margin: 2 }, (err) => {
    if (err) console.error('[qr generate]', err);
  });
}

async function startQrScanner(videoEl, canvasEl, onDetected) {
  _stream  = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
  });
  _videoEl          = videoEl;
  videoEl.srcObject = _stream;
  _animFrame = requestAnimationFrame(() => _scanLoop(videoEl, canvasEl, onDetected));
}

function _scanLoop(videoEl, canvasEl, onDetected) {
  if (videoEl.readyState >= videoEl.HAVE_ENOUGH_DATA) {
    canvasEl.width  = videoEl.videoWidth;
    canvasEl.height = videoEl.videoHeight;
    const ctx  = canvasEl.getContext('2d');
    ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
    const img  = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    if (code) {
      stopQrScanner();
      onDetected(code.data);
      return;
    }
  }
  _animFrame = requestAnimationFrame(() => _scanLoop(videoEl, canvasEl, onDetected));
}

function stopQrScanner() {
  cancelAnimationFrame(_animFrame);
  _animFrame = null;
  _stream?.getTracks().forEach(t => t.stop());
  _stream = null;
  if (_videoEl) { _videoEl.srcObject = null; _videoEl = null; }
}
