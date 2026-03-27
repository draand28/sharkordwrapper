const path = require('path');

let addon = null;

function getAddon() {
  if (addon) return addon;
  try {
    // In packaged app, native modules are unpacked from asar
    addon = require(path.join(__dirname, '..', 'native', 'audio-loopback', 'build', 'Release', 'audio_loopback.node'));
  } catch {
    try {
      addon = require(path.join(__dirname, '..', 'native', 'audio-loopback', 'build', 'Debug', 'audio_loopback.node'));
    } catch {
      return null;
    }
  }
  return addon;
}

function isSupported() {
  const a = getAddon();
  return a ? a.isSupported() : false;
}

function isCapturing() {
  const a = getAddon();
  return a ? a.isCapturing() : false;
}

function startCapture(excludeProcessId, onData) {
  const a = getAddon();
  if (!a) return false;
  return a.startCapture(excludeProcessId, onData);
}

function stopCapture() {
  const a = getAddon();
  if (!a) return;
  a.stopCapture();
}

module.exports = { isSupported, isCapturing, startCapture, stopCapture };
