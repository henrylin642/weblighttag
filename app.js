const ui = {
  status: document.getElementById("status"),
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  processed: document.getElementById("processed"),
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnAuto: document.getElementById("btnAuto"),
  btnClear: document.getElementById("btnClear"),
  btnDecode: document.getElementById("btnDecode"),
  chkBgSub: document.getElementById("chkBgSub"),
  infoFps: document.getElementById("infoFps"),
  infoExposure: document.getElementById("infoExposure"),
  infoIso: document.getElementById("infoIso"),
  infoFocus: document.getElementById("infoFocus"),
  supportHint: document.getElementById("supportHint"),
  liveFps: document.getElementById("liveFps"),
  liveBrightness: document.getElementById("liveBrightness"),
  liveThresholds: document.getElementById("liveThresholds"),
  liveSymbol: document.getElementById("liveSymbol"),
  bar1: document.getElementById("bar1"),
  bar2: document.getElementById("bar2"),
  bar3: document.getElementById("bar3"),
  bar1Val: document.getElementById("bar1Val"),
  bar2Val: document.getElementById("bar2Val"),
  bar3Val: document.getElementById("bar3Val"),
  decodeStatus: document.getElementById("decodeStatus"),
  decodeId: document.getElementById("decodeId"),
  decodeCrc: document.getElementById("decodeCrc"),
  log: document.getElementById("log"),
  cfgFps: document.getElementById("cfgFps"),
  cfgExposure: document.getElementById("cfgExposure"),
  cfgIso: document.getElementById("cfgIso"),
  cfgFrames: document.getElementById("cfgFrames"),
  cfgBitsPerFrame: document.getElementById("cfgBitsPerFrame"),
  cfgPreamble: document.getElementById("cfgPreamble"),
  cfgCrcLen: document.getElementById("cfgCrcLen"),
  cfgCrcPoly: document.getElementById("cfgCrcPoly"),
  cfgCrcInit: document.getElementById("cfgCrcInit"),
  cfgCrcXor: document.getElementById("cfgCrcXor"),
  cfgIdStart: document.getElementById("cfgIdStart"),
  cfgIdLen: document.getElementById("cfgIdLen"),
};

const state = {
  stream: null,
  track: null,
  decoding: false,
  rois: [],
  roiSize: 18,
  lastFrameTs: 0,
  fpsSamples: [],
  brightnessBuffers: [[], [], []],
  smoothValues: [null, null, null],
  showBgSub: false,
  bgModel: null,
  symbolStream: [],
  capturing: false,
  captureSymbols: [],
  logLines: [],
};

const offscreen = document.createElement("canvas");
const offCtx = offscreen.getContext("2d", { willReadFrequently: true });
const overlayCtx = ui.overlay.getContext("2d");
const processedCtx = ui.processed.getContext("2d");
const procCanvas = document.createElement("canvas");
const procCtx = procCanvas.getContext("2d", { willReadFrequently: true });

function logLine(text) {
  const stamp = new Date().toLocaleTimeString();
  state.logLines.unshift(`[${stamp}] ${text}`);
  state.logLines = state.logLines.slice(0, 12);
  ui.log.textContent = state.logLines.join("\n");
}

function setStatus(text) {
  ui.status.textContent = text;
}

function getConfig() {
  return {
    targetFps: Number(ui.cfgFps.value),
    targetExposureUs: Number(ui.cfgExposure.value),
    targetIso: Number(ui.cfgIso.value),
    framesPerPacket: Number(ui.cfgFrames.value),
    bitsPerFrame: Number(ui.cfgBitsPerFrame.value),
    preamble: ui.cfgPreamble.value
      .split(",")
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v)),
    crcLen: Number(ui.cfgCrcLen.value),
    crcPoly: parseInt(ui.cfgCrcPoly.value, 16),
    crcInit: parseInt(ui.cfgCrcInit.value, 16),
    crcXor: parseInt(ui.cfgCrcXor.value, 16),
    idStart: Number(ui.cfgIdStart.value),
    idLen: Number(ui.cfgIdLen.value),
  };
}

function applySupportedConstraints(track, desired) {
  const supported = navigator.mediaDevices.getSupportedConstraints();
  const constraints = {};
  for (const key of Object.keys(desired)) {
    if (supported[key]) constraints[key] = desired[key];
  }
  return track.applyConstraints({ advanced: [constraints] });
}

async function startCamera() {
  try {
    setStatus("Requesting camera...");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: getConfig().targetFps, max: 60 },
      },
      audio: false,
    });

    state.stream = stream;
    state.track = stream.getVideoTracks()[0];

    await applySupportedConstraints(state.track, {
      frameRate: getConfig().targetFps,
      exposureMode: "manual",
      exposureTime: getConfig().targetExposureUs / 1_000_000,
      iso: getConfig().targetIso,
      focusMode: "manual",
    }).catch(() => {
      // Silent: unsupported constraints.
    });

    ui.video.srcObject = stream;
    await ui.video.play();

    resizeCanvases();
    window.addEventListener("resize", resizeCanvases);

    updateDeviceInfo();
    setStatus("Camera ready");
    ui.btnStart.disabled = true;
    ui.btnStop.disabled = false;
    ui.btnAuto.disabled = false;
    ui.btnClear.disabled = false;
    ui.btnDecode.disabled = false;
    ui.chkBgSub.disabled = false;

    startFrameLoop();
  } catch (err) {
    console.error(err);
    setStatus("Camera error");
    logLine("Camera access failed.");
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
  }
  state.stream = null;
  state.track = null;
  state.decoding = false;
  state.capturing = false;
  state.symbolStream = [];
  state.captureSymbols = [];
  ui.video.srcObject = null;
  setStatus("Stopped");
  ui.btnStart.disabled = false;
  ui.btnStop.disabled = true;
  ui.btnAuto.disabled = true;
  ui.btnClear.disabled = true;
  ui.btnDecode.disabled = true;
  ui.chkBgSub.disabled = true;
  ui.chkBgSub.checked = false;
  state.showBgSub = false;
  state.bgModel = null;
  processedCtx.clearRect(0, 0, ui.processed.width, ui.processed.height);
}

function resizeCanvases() {
  const rect = ui.video.getBoundingClientRect();
  ui.overlay.width = rect.width;
  ui.overlay.height = rect.height;
  ui.processed.width = rect.width;
  ui.processed.height = rect.height;
  offscreen.width = ui.video.videoWidth || 1280;
  offscreen.height = ui.video.videoHeight || 720;
  procCanvas.width = 160;
  procCanvas.height = 90;
  state.bgModel = null;
}

function updateDeviceInfo() {
  if (!state.track) return;
  const settings = state.track.getSettings();
  ui.infoFps.textContent = settings.frameRate ? `${settings.frameRate.toFixed(1)} fps` : "-";
  ui.infoExposure.textContent = settings.exposureTime
    ? `${Math.round(settings.exposureTime * 1_000_000)} us`
    : "-";
  ui.infoIso.textContent = settings.iso ? String(settings.iso) : "-";
  ui.infoFocus.textContent = settings.focusMode || "-";

  const cfg = getConfig();
  const fpsOk = settings.frameRate && Math.abs(settings.frameRate - cfg.targetFps) <= 3;
  const targetExposureSec = cfg.targetExposureUs / 1_000_000;
  const exposureOk = settings.exposureTime && settings.exposureTime <= targetExposureSec * 1.2;
  const stableOk = !!settings.frameRate;

  if (fpsOk && exposureOk && stableOk) {
    ui.supportHint.textContent = "Device looks compatible."
    ui.supportHint.className = "support-hint good";
  } else {
    ui.supportHint.textContent = "Device may be unsupported. Results can be unstable.";
    ui.supportHint.className = "support-hint bad";
  }
}

function drawOverlay() {
  overlayCtx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);
  state.rois.forEach((roi, idx) => {
    const x = roi.x * ui.overlay.width;
    const y = roi.y * ui.overlay.height;
    overlayCtx.strokeStyle = "#6be1ff";
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 8, 0, Math.PI * 2);
    overlayCtx.stroke();
    overlayCtx.fillStyle = "rgba(107,225,255,0.2)";
    overlayCtx.fillRect(x - roi.size / 2, y - roi.size / 2, roi.size, roi.size);
    overlayCtx.fillStyle = "#ffffff";
    overlayCtx.fillText(`LED ${idx + 1}`, x + 10, y - 10);
  });
}

function updateBackgroundView() {
  if (!state.showBgSub) {
    processedCtx.clearRect(0, 0, ui.processed.width, ui.processed.height);
    return;
  }

  procCtx.drawImage(ui.video, 0, 0, procCanvas.width, procCanvas.height);
  const image = procCtx.getImageData(0, 0, procCanvas.width, procCanvas.height);
  const { data } = image;
  const length = procCanvas.width * procCanvas.height;

  if (!state.bgModel || state.bgModel.length !== length) {
    state.bgModel = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const idx = i * 4;
      state.bgModel[i] = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    }
  }

  const alpha = 0.02;
  const gain = 4.0;
  for (let i = 0; i < length; i += 1) {
    const idx = i * 4;
    const gray = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
    const bg = state.bgModel[i];
    const nextBg = bg * (1 - alpha) + gray * alpha;
    state.bgModel[i] = nextBg;
    const diff = Math.max(0, gray - nextBg) * gain;
    data[idx] = diff;
    data[idx + 1] = diff;
    data[idx + 2] = diff;
    data[idx + 3] = 255;
  }

  procCtx.putImageData(image, 0, 0);
  processedCtx.clearRect(0, 0, ui.processed.width, ui.processed.height);
  processedCtx.drawImage(procCanvas, 0, 0, ui.processed.width, ui.processed.height);
}

function addRoiFromClick(event) {
  if (!state.stream) return;
  const rect = ui.overlay.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (state.rois.length >= 3) return;
  state.rois.push({ x, y, size: state.roiSize });
  drawOverlay();
}

function clearRois() {
  state.rois = [];
  state.brightnessBuffers = [[], [], []];
  drawOverlay();
}

function autoDetectRois() {
  if (!state.stream) return;
  offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);
  const imageData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
  const { data } = imageData;
  const points = [];
  let sum = 0;
  let count = 0;

  for (let y = 0; y < offscreen.height; y += 4) {
    for (let x = 0; x < offscreen.width; x += 4) {
      const idx = (y * offscreen.width + x) * 4;
      const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      sum += brightness;
      count += 1;
      if (brightness > 200) {
        points.push({ x, y, brightness });
      }
    }
  }

  const mean = sum / Math.max(1, count);
  const candidates = points.filter((p) => p.brightness > mean + 20);
  candidates.sort((a, b) => b.brightness - a.brightness);

  const selected = [];
  const minDist = offscreen.width * 0.08;
  for (const p of candidates) {
    if (selected.length >= 3) break;
    const tooClose = selected.some((s) => {
      const dx = s.x - p.x;
      const dy = s.y - p.y;
      return Math.hypot(dx, dy) < minDist;
    });
    if (!tooClose) selected.push(p);
  }

  if (selected.length === 3) {
    state.rois = selected.map((p) => ({
      x: p.x / offscreen.width,
      y: p.y / offscreen.height,
      size: state.roiSize,
    }));
    logLine("Auto detect succeeded.");
  } else {
    logLine("Auto detect failed. Click to set LEDs.");
  }
  drawOverlay();
}

function computeBrightness(roi) {
  const x = Math.round(roi.x * offscreen.width);
  const y = Math.round(roi.y * offscreen.height);
  const size = roi.size;
  const half = Math.floor(size / 2);
  const startX = Math.max(0, x - half);
  const startY = Math.max(0, y - half);
  const endX = Math.min(offscreen.width - 1, x + half);
  const endY = Math.min(offscreen.height - 1, y + half);
  const w = endX - startX + 1;
  const h = endY - startY + 1;
  const image = offCtx.getImageData(startX, startY, w, h);
  const { data } = image;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
  }
  return sum / (data.length / 4);
}

function updateBrightnessBuffers(values) {
  values.forEach((val, idx) => {
    const buf = state.brightnessBuffers[idx];
    buf.push(val);
    if (buf.length > 20) buf.shift();
  });
}

function computeNormalized(brightness) {
  return brightness.map((value, idx) => {
    const buf = state.brightnessBuffers[idx];
    if (!buf.length) return 0;
    const min = Math.min(...buf);
    const max = Math.max(...buf);
    const denom = Math.max(1, max - min);
    return (value - min) / denom;
  });
}

function smoothNormalized(values) {
  const alpha = 0.5;
  return values.map((val, idx) => {
    const prev = state.smoothValues[idx];
    const next = prev === null ? val : prev * (1 - alpha) + val * alpha;
    state.smoothValues[idx] = next;
    return next;
  });
}

function bitsFromSymbol(symbol, bitsPerFrame) {
  const bits = [];
  for (let i = 0; i < bitsPerFrame; i += 1) {
    bits.push((symbol >> i) & 1);
  }
  return bits;
}

function bitsToNumber(bits) {
  return bits.reduce((acc, bit, idx) => acc | (bit << idx), 0);
}

function computeCrc16(bits, poly, init, xorOut, width) {
  let crc = init;
  const mask = (1 << width) - 1;
  for (const bit of bits) {
    const top = (crc >> (width - 1)) & 1;
    crc = ((crc << 1) & mask) | bit;
    if (top) crc ^= poly;
  }
  return (crc ^ xorOut) & mask;
}

function attemptDecode(symbol) {
  const cfg = getConfig();
  const totalBits = cfg.framesPerPacket * cfg.bitsPerFrame;

  if (!cfg.preamble.length) return;

  state.symbolStream.push(symbol);
  if (state.symbolStream.length > cfg.preamble.length + cfg.framesPerPacket) {
    state.symbolStream.shift();
  }

  if (!state.capturing) {
    const slice = state.symbolStream.slice(-cfg.preamble.length);
    const match = slice.every((v, i) => v === cfg.preamble[i]);
    if (match) {
      state.capturing = true;
      state.captureSymbols = [];
      ui.decodeStatus.textContent = "Preamble matched";
    }
    return;
  }

  state.captureSymbols.push(symbol);
  if (state.captureSymbols.length < cfg.framesPerPacket) return;

  const bits = state.captureSymbols.flatMap((s) => bitsFromSymbol(s, cfg.bitsPerFrame));
  if (bits.length !== totalBits) {
    state.capturing = false;
    return;
  }

  const crcLen = cfg.crcLen;
  let crcOk = true;
  let crcValue = null;

  if (crcLen > 0 && bits.length > crcLen) {
    const payloadBits = bits.slice(0, bits.length - crcLen);
    const crcBits = bits.slice(bits.length - crcLen);
    const expected = bitsToNumber(crcBits);
    const actual = computeCrc16(payloadBits, cfg.crcPoly, cfg.crcInit, cfg.crcXor, crcLen);
    crcValue = { expected, actual };
    crcOk = expected === actual;
  }

  if (crcOk) {
    const idBits = bits.slice(cfg.idStart, cfg.idStart + cfg.idLen);
    const idValue = bitsToNumber(idBits);
    ui.decodeId.textContent = `0x${idValue.toString(16).padStart(Math.ceil(cfg.idLen / 4), "0")}`;
    ui.decodeStatus.textContent = "ID decoded";
    ui.decodeCrc.textContent = crcValue ? `ok (0x${crcValue.actual.toString(16)})` : "-";
    logLine(`ID decoded: 0x${idValue.toString(16)}`);
  } else {
    ui.decodeStatus.textContent = "CRC failed";
    ui.decodeCrc.textContent = crcValue
      ? `expected 0x${crcValue.expected.toString(16)}, got 0x${crcValue.actual.toString(16)}`
      : "-";
    logLine("CRC failed. Waiting for next packet.");
  }

  state.capturing = false;
  state.captureSymbols = [];
}

function updateLiveMetrics(brightness, thresholds, symbol) {
  ui.liveBrightness.textContent = brightness.map((v) => v.toFixed(1)).join(" / ");
  ui.liveThresholds.textContent = thresholds.map((v) => v.toFixed(1)).join(" / ");
  ui.liveSymbol.textContent = symbol !== null ? String(symbol) : "-";

  const vals = thresholds.map((v) => Math.max(0, Math.min(1, v)));
  const pct = vals.map((v) => `${Math.round(v * 100)}%`);
  ui.bar1.style.width = pct[0];
  ui.bar2.style.width = pct[1];
  ui.bar3.style.width = pct[2];
  ui.bar1Val.textContent = vals[0].toFixed(2);
  ui.bar2Val.textContent = vals[1].toFixed(2);
  ui.bar3Val.textContent = vals[2].toFixed(2);
}

function updateFps(ts) {
  if (state.lastFrameTs) {
    const delta = ts - state.lastFrameTs;
    const fps = 1000 / delta;
    state.fpsSamples.push(fps);
    if (state.fpsSamples.length > 12) state.fpsSamples.shift();
    const avg = state.fpsSamples.reduce((a, b) => a + b, 0) / state.fpsSamples.length;
    ui.liveFps.textContent = avg.toFixed(1);
  }
  state.lastFrameTs = ts;
}

function processFrame(ts) {
  updateFps(ts);
  if (!state.decoding || state.rois.length !== 3) {
    updateBackgroundView();
    requestNextFrame();
    return;
  }

  offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);
  const brightness = state.rois.map((roi) => computeBrightness(roi));
  updateBrightnessBuffers(brightness);
  const normalized = computeNormalized(brightness);
  const smoothed = smoothNormalized(normalized);
  const thresholds = [0.5, 0.5, 0.5];

  const bits = smoothed.map((value, i) => (value > thresholds[i] ? 1 : 0));
  const symbol = bits.reduce((acc, bit, idx) => acc | (bit << idx), 0);
  updateLiveMetrics(brightness, smoothed, symbol);

  attemptDecode(symbol);
  updateBackgroundView();
  requestNextFrame();
}

function requestNextFrame() {
  if (!state.stream) return;
  if (ui.video.requestVideoFrameCallback) {
    ui.video.requestVideoFrameCallback((now) => processFrame(now));
  } else {
    requestAnimationFrame((now) => processFrame(now));
  }
}

function startFrameLoop() {
  state.lastFrameTs = 0;
  state.fpsSamples = [];
  requestNextFrame();
}

function toggleDecode() {
  state.decoding = !state.decoding;
  ui.btnDecode.textContent = state.decoding ? "Stop Decode" : "Start Decode";
  ui.decodeStatus.textContent = state.decoding ? "Decoding" : "Idle";
  if (state.decoding) {
    state.symbolStream = [];
    state.captureSymbols = [];
    state.capturing = false;
  }
}

ui.overlay.addEventListener("click", addRoiFromClick);
ui.btnStart.addEventListener("click", startCamera);
ui.btnStop.addEventListener("click", stopCamera);
ui.btnAuto.addEventListener("click", autoDetectRois);
ui.btnClear.addEventListener("click", clearRois);
ui.btnDecode.addEventListener("click", toggleDecode);
ui.chkBgSub.addEventListener("change", (event) => {
  state.showBgSub = event.target.checked;
  state.bgModel = null;
});

window.addEventListener("beforeunload", () => {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
});
