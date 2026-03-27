const path = require('path');

let addon = null;
let loadError = null;

function getAddon() {
  if (addon) return addon;
  if (loadError) return null;

  const candidates = [
    // Normal dev path
    path.join(__dirname, '..', 'native', 'audio-loopback', 'build', 'Release', 'audio_loopback.node'),
    // Asar unpacked path (packaged app)
    path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), '..', 'native', 'audio-loopback', 'build', 'Release', 'audio_loopback.node'),
    // Debug build
    path.join(__dirname, '..', 'native', 'audio-loopback', 'build', 'Debug', 'audio_loopback.node'),
  ];

  for (const p of candidates) {
    try {
      addon = require(p);
      console.log('[AudioLoopback] Native addon loaded from:', p);
      return addon;
    } catch (e) {
      // Try next candidate
    }
  }

  loadError = 'Failed to load native addon from any path';
  console.warn('[AudioLoopback]', loadError);
  console.warn('[AudioLoopback] Tried:', candidates.join(', '));
  return null;
}

function isSupported() {
  const a = getAddon();
  if (!a) return false;
  const supported = a.isSupported();
  console.log('[AudioLoopback] isSupported:', supported);
  return supported;
}

function isCapturing() {
  const a = getAddon();
  return a ? a.isCapturing() : false;
}

function startCapture(excludeProcessId, onData) {
  const a = getAddon();
  if (!a) {
    console.warn('[AudioLoopback] Cannot start capture: addon not loaded');
    return false;
  }
  console.log('[AudioLoopback] Starting capture, excluding PID:', excludeProcessId);
  const result = a.startCapture(excludeProcessId, onData);
  console.log('[AudioLoopback] Capture started:', result);
  return result;
}

function stopCapture() {
  const a = getAddon();
  if (!a) return;
  console.log('[AudioLoopback] Stopping capture');
  a.stopCapture();
}

module.exports = { isSupported, isCapturing, startCapture, stopCapture };
