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
  chkEnhance: document.getElementById("chkEnhance"),
  modeDataLed: document.getElementById("modeDataLed"),
  modeLocLed: document.getElementById("modeLocLed"),
  btnLocClear: document.getElementById("btnLocClear"),
  btnLocSolve: document.getElementById("btnLocSolve"),
  cfgFx: document.getElementById("cfgFx"),
  cfgFy: document.getElementById("cfgFy"),
  cfgCx: document.getElementById("cfgCx"),
  cfgCy: document.getElementById("cfgCy"),
  locStatus: document.getElementById("locStatus"),
  locPos: document.getElementById("locPos"),
  locRot: document.getElementById("locRot"),
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
  cfgChannel: document.getElementById("cfgChannel"),
  cfgBrightness: document.getElementById("cfgBrightness"),
  cfgContrast: document.getElementById("cfgContrast"),
  cfgGamma: document.getElementById("cfgGamma"),
  chkHighPass: document.getElementById("chkHighPass"),
  cfgHighPass: document.getElementById("cfgHighPass"),
  chkRoiStretch: document.getElementById("chkRoiStretch"),
  chkOnlyEnhance: document.getElementById("chkOnlyEnhance"),
  cfgBgDim: document.getElementById("cfgBgDim"),
  valBrightness: document.getElementById("valBrightness"),
  valContrast: document.getElementById("valContrast"),
  valGamma: document.getElementById("valGamma"),
  valHighPass: document.getElementById("valHighPass"),
  valBgDim: document.getElementById("valBgDim"),
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
  locPoints: [],
  cvReady: false,
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

function updateEnhanceLabels() {
  ui.valBrightness.textContent = Number(ui.cfgBrightness.value).toFixed(2);
  ui.valContrast.textContent = Number(ui.cfgContrast.value).toFixed(2);
  ui.valGamma.textContent = Number(ui.cfgGamma.value).toFixed(2);
  ui.valHighPass.textContent = Number(ui.cfgHighPass.value).toFixed(1);
  ui.valBgDim.textContent = Number(ui.cfgBgDim.value).toFixed(2);
}

function getEnhanceConfig() {
  return {
    enabled: ui.chkEnhance.checked,
    channel: ui.cfgChannel.value,
    brightness: Number(ui.cfgBrightness.value),
    contrast: Number(ui.cfgContrast.value),
    gamma: Number(ui.cfgGamma.value),
    highPass: ui.chkHighPass.checked,
    highPassGain: Number(ui.cfgHighPass.value),
    roiStretch: ui.chkRoiStretch.checked,
    onlyEnhanced: ui.chkOnlyEnhance.checked,
    bgDim: Number(ui.cfgBgDim.value),
  };
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
    ui.chkEnhance.disabled = false;
    ui.btnLocClear.disabled = false;
    ui.btnLocSolve.disabled = false;

    estimateIntrinsics();

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
  ui.chkEnhance.disabled = true;
  ui.chkEnhance.checked = true;
  ui.btnLocClear.disabled = true;
  ui.btnLocSolve.disabled = true;
  state.showBgSub = false;
  state.bgModel = null;
  processedCtx.clearRect(0, 0, ui.processed.width, ui.processed.height);
  ui.processed.style.opacity = "0";
  ui.video.style.opacity = "1";
  clearLocPoints();
}

function resizeCanvases() {
  const rect = ui.video.getBoundingClientRect();
  ui.overlay.width = rect.width;
  ui.overlay.height = rect.height;
  ui.processed.width = rect.width;
  ui.processed.height = rect.height;
  offscreen.width = ui.video.videoWidth || 1280;
  offscreen.height = ui.video.videoHeight || 720;
  const scale = 0.25;
  procCanvas.width = Math.max(1, Math.round(offscreen.width * scale));
  procCanvas.height = Math.max(1, Math.round(offscreen.height * scale));
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

  state.locPoints.forEach((pt, idx) => {
    const x = pt.x * ui.overlay.width;
    const y = pt.y * ui.overlay.height;
    overlayCtx.strokeStyle = "#6b7bff";
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.arc(x, y, 6, 0, Math.PI * 2);
    overlayCtx.stroke();
    overlayCtx.fillStyle = "#6b7bff";
    overlayCtx.fillText(`P${idx + 1}`, x + 8, y - 8);
  });
}

function getCoverRect(srcW, srcH, dstW, dstH) {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    const sw = srcH * dstAspect;
    const sx = (srcW - sw) / 2;
    return { sx, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / dstAspect;
  const sy = (srcH - sh) / 2;
  return { sx: 0, sy, sw: srcW, sh };
}

function mapOverlayToSource(roi) {
  const srcW = offscreen.width;
  const srcH = offscreen.height;
  const dstW = ui.overlay.width;
  const dstH = ui.overlay.height;
  const { sx, sy, sw, sh } = getCoverRect(srcW, srcH, dstW, dstH);
  const px = sx + roi.x * sw;
  const py = sy + roi.y * sh;
  const scale = (sw / dstW + sh / dstH) / 2;
  return { px, py, scale };
}

function getRoiRects() {
  if (!state.rois.length || ui.overlay.width === 0) return [];
  const scale = procCanvas.width / ui.overlay.width;
  return state.rois.map((roi) => {
    const size = Math.max(6, Math.round(roi.size * scale));
    const x = Math.round(roi.x * procCanvas.width - size / 2);
    const y = Math.round(roi.y * procCanvas.height - size / 2);
    return {
      x: Math.max(0, x),
      y: Math.max(0, y),
      w: Math.min(procCanvas.width, x + size) - Math.max(0, x),
      h: Math.min(procCanvas.height, y + size) - Math.max(0, y),
    };
  });
}

function updateProcessedView() {
  const enhance = getEnhanceConfig();
  if (!enhance.enabled) {
    processedCtx.clearRect(0, 0, ui.processed.width, ui.processed.height);
    ui.processed.style.opacity = "0";
    ui.video.style.opacity = "1";
    ui.processed.style.mixBlendMode = "normal";
    return;
  }

  ui.processed.style.opacity = enhance.onlyEnhanced ? "1" : "0.65";
  ui.processed.style.mixBlendMode = enhance.onlyEnhanced ? "normal" : "screen";
  ui.video.style.opacity = enhance.onlyEnhanced ? "0" : "1";

  offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);
  const crop = getCoverRect(
    offscreen.width,
    offscreen.height,
    ui.processed.width,
    ui.processed.height
  );
  procCtx.drawImage(
    offscreen,
    crop.sx,
    crop.sy,
    crop.sw,
    crop.sh,
    0,
    0,
    procCanvas.width,
    procCanvas.height
  );
  const image = procCtx.getImageData(0, 0, procCanvas.width, procCanvas.height);
  const { data } = image;
  const length = procCanvas.width * procCanvas.height;
  const gray = new Float32Array(length);

  for (let i = 0; i < length; i += 1) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    let v = 0;
    switch (enhance.channel) {
      case "red":
        v = r;
        break;
      case "green":
        v = g;
        break;
      case "blue":
        v = b;
        break;
      default:
        v = (r + g + b) / 3;
        break;
    }
    gray[i] = v;
  }

  if (state.showBgSub) {
    if (!state.bgModel || state.bgModel.length !== length) {
      state.bgModel = new Float32Array(length);
      state.bgModel.set(gray);
    }
    const alpha = 0.02;
    const gain = 4.0;
    for (let i = 0; i < length; i += 1) {
      const bg = state.bgModel[i];
      const nextBg = bg * (1 - alpha) + gray[i] * alpha;
      state.bgModel[i] = nextBg;
      gray[i] = Math.max(0, gray[i] - nextBg) * gain;
    }
  }

  if (enhance.highPass) {
    const blur = new Float32Array(length);
    const w = procCanvas.width;
    const h = procCanvas.height;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        let sum = 0;
        let count = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = Math.max(0, Math.min(w - 1, x + dx));
            const ny = Math.max(0, Math.min(h - 1, y + dy));
            sum += gray[ny * w + nx];
            count += 1;
          }
        }
        blur[y * w + x] = sum / count;
      }
    }
    for (let i = 0; i < length; i += 1) {
      gray[i] = Math.max(0, gray[i] - blur[i]) * enhance.highPassGain;
    }
  }

  const roiRects = enhance.roiStretch ? getRoiRects() : [];
  const roiStats = roiRects.map((rect) => {
    let min = 255;
    let max = 0;
    for (let y = rect.y; y < rect.y + rect.h; y += 1) {
      for (let x = rect.x; x < rect.x + rect.w; x += 1) {
        const v = gray[y * procCanvas.width + x];
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    return { min, max };
  });

  for (let i = 0; i < length; i += 1) {
    let v = gray[i];
    if (enhance.roiStretch && roiRects.length) {
      const x = i % procCanvas.width;
      const y = Math.floor(i / procCanvas.width);
      let inRoi = false;
      for (let r = 0; r < roiRects.length; r += 1) {
        const rect = roiRects[r];
        if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) {
          const stats = roiStats[r];
          const denom = Math.max(1, stats.max - stats.min);
          v = ((v - stats.min) / denom) * 255;
          inRoi = true;
          break;
        }
      }
      if (!inRoi) {
        v *= enhance.bgDim;
      }
    }

    v = Math.max(0, Math.min(255, v));
    let f = v / 255;
    f = (f - 0.5) * enhance.contrast + 0.5;
    f = f * enhance.brightness;
    f = Math.max(0, Math.min(1, f));
    f = Math.pow(f, 1 / enhance.gamma);
    const out = Math.max(0, Math.min(255, f * 255));
    const idx = i * 4;
    data[idx] = out;
    data[idx + 1] = out;
    data[idx + 2] = out;
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
  if (ui.modeLocLed.checked) {
    if (state.locPoints.length >= 5) return;
    state.locPoints.push({ x, y });
  } else {
    if (state.rois.length >= 3) return;
    state.rois.push({ x, y, size: state.roiSize });
  }
  drawOverlay();
}

function clearRois() {
  state.rois = [];
  state.brightnessBuffers = [[], [], []];
  drawOverlay();
}

function clearLocPoints() {
  state.locPoints = [];
  ui.locStatus.textContent = "-";
  ui.locPos.textContent = "-";
  ui.locRot.textContent = "-";
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

  const crop = getCoverRect(
    offscreen.width,
    offscreen.height,
    ui.overlay.width,
    ui.overlay.height
  );

  const selected = [];
  const minDist = offscreen.width * 0.08;
  for (const p of candidates) {
    if (selected.length >= 3) break;
    if (
      p.x < crop.sx ||
      p.x > crop.sx + crop.sw ||
      p.y < crop.sy ||
      p.y > crop.sy + crop.sh
    ) {
      continue;
    }
    const tooClose = selected.some((s) => {
      const dx = s.x - p.x;
      const dy = s.y - p.y;
      return Math.hypot(dx, dy) < minDist;
    });
    if (!tooClose) selected.push(p);
  }

  if (selected.length === 3) {
    state.rois = selected.map((p) => ({
      x: (p.x - crop.sx) / crop.sw,
      y: (p.y - crop.sy) / crop.sh,
      size: state.roiSize,
    }));
    logLine("Auto detect succeeded.");
  } else {
    logLine("Auto detect failed. Click to set LEDs.");
  }
  drawOverlay();
}

function computeBrightness(roi) {
  const { px, py, scale } = mapOverlayToSource(roi);
  const x = Math.round(px);
  const y = Math.round(py);
  const size = Math.max(4, Math.round(roi.size * scale));
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

function estimateIntrinsics() {
  const w = offscreen.width || 1280;
  const h = offscreen.height || 720;
  const f = 0.9 * Math.max(w, h);
  ui.cfgFx.value = Math.round(f);
  ui.cfgFy.value = Math.round(f);
  ui.cfgCx.value = Math.round(w / 2);
  ui.cfgCy.value = Math.round(h / 2);
}

function getCameraMatrix() {
  const fx = Number(ui.cfgFx.value);
  const fy = Number(ui.cfgFy.value);
  const cx = Number(ui.cfgCx.value);
  const cy = Number(ui.cfgCy.value);
  return { fx, fy, cx, cy };
}

function ensureCvReady() {
  if (state.cvReady) return true;
  if (window.__cvReady && window.cv && window.cv.Mat) {
    state.cvReady = true;
    return true;
  }
  return false;
}

function solvePnP() {
  if (!ensureCvReady()) {
    ui.locStatus.textContent = "OpenCV 尚未就緒";
    return;
  }
  if (state.locPoints.length !== 5) {
    ui.locStatus.textContent = "需要 5 個定位點";
    return;
  }

  const objectPts = [
    [33.65, 21.8, 0],
    [33.65, -21.8, 0],
    [-33.65, -21.8, 0],
    [-33.65, 21.8, 0],
    [0, 63.09, 20.1],
  ];

  const imgPts = state.locPoints.map((pt) => {
    const { px, py } = mapOverlayToSource(pt);
    return [px, py];
  });

  const objMat = cv.matFromArray(5, 3, cv.CV_32F, objectPts.flat());
  const imgMat = cv.matFromArray(5, 2, cv.CV_32F, imgPts.flat());

  const { fx, fy, cx, cy } = getCameraMatrix();
  const camMat = cv.matFromArray(3, 3, cv.CV_32F, [
    fx, 0, cx,
    0, fy, cy,
    0, 0, 1
  ]);
  const distCoeffs = cv.Mat.zeros(4, 1, cv.CV_32F);
  const rvec = new cv.Mat();
  const tvec = new cv.Mat();

  const ok = cv.solvePnP(objMat, imgMat, camMat, distCoeffs, rvec, tvec, false, cv.SOLVEPNP_ITERATIVE);

  if (!ok) {
    ui.locStatus.textContent = "PnP 失敗";
  } else {
    const rmat = new cv.Mat();
    cv.Rodrigues(rvec, rmat);
    const r = rmat.data32F;
    const yaw = Math.atan2(r[3], r[0]);
    const pitch = Math.atan2(-r[6], Math.sqrt(r[7] * r[7] + r[8] * r[8]));
    const roll = Math.atan2(r[7], r[8]);
    const deg = (v) => (v * 180) / Math.PI;
    ui.locStatus.textContent = "PnP 成功";
    ui.locPos.textContent = `${tvec.data32F[0].toFixed(1)}, ${tvec.data32F[1].toFixed(1)}, ${tvec.data32F[2].toFixed(1)}`;
    ui.locRot.textContent = `${deg(roll).toFixed(1)}, ${deg(pitch).toFixed(1)}, ${deg(yaw).toFixed(1)}`;
  }

  objMat.delete();
  imgMat.delete();
  camMat.delete();
  distCoeffs.delete();
  rvec.delete();
  tvec.delete();
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
    updateProcessedView();
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
  updateProcessedView();
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
ui.btnLocClear.addEventListener("click", clearLocPoints);
ui.btnLocSolve.addEventListener("click", solvePnP);
ui.chkBgSub.addEventListener("change", (event) => {
  state.showBgSub = event.target.checked;
  state.bgModel = null;
});

  [
    ui.cfgBrightness,
    ui.cfgContrast,
    ui.cfgGamma,
    ui.cfgHighPass,
    ui.cfgBgDim,
    ui.cfgChannel,
    ui.chkHighPass,
    ui.chkRoiStretch,
    ui.chkOnlyEnhance,
    ui.chkEnhance,
  ].forEach((el) => {
    el.addEventListener("input", updateEnhanceLabels);
  });

updateEnhanceLabels();

window.addEventListener("beforeunload", () => {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
});
