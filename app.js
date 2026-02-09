// ===================================================================
// 6DoF定位系統 - LED檢測與姿態估計
// ===================================================================

// LED 3D世界座標配置
const LED_CONFIG = {
  points3D: [
    { id: 1, x: 33.65, y: 21.8, z: 0 },      // 右上
    { id: 2, x: 33.65, y: -21.8, z: 0 },     // 右下
    { id: 3, x: -33.65, y: -21.8, z: 0 },    // 左下
    { id: 4, x: -33.65, y: 21.8, z: 0 },     // 左上
    { id: 5, x: 0, y: 63.09, z: 20.1 }       // 中心突出
  ],
  expectedAspectRatio: (33.65 * 2) / (21.8 * 2),
  aspectRatioTolerance: 0.25,
  minArea: 4,
  maxArea: 800,
  minCircularity: 0.35,
  blueDiffThreshold: 30
};

// 藍光LED檢測器
class BlueLEDDetector {
  constructor(hsvParams) {
    this.hsvParams = hsvParams || {
      hMin: 192,
      hMax: 260,
      sMin: 0.74,
      vMin: 0.70
    };
  }

  detect(srcMat, crop) {
    const blueDiffMask = this.createBlueDifferentialMask(srcMat);
    const hsvMask = this.createHSVMask(srcMat);

    const combinedMask = new cv.Mat();
    cv.bitwise_and(blueDiffMask, hsvMask, combinedMask);
    this.morphologicalFilter(combinedMask);

    const ledPoints = this.extractLEDPoints(combinedMask, srcMat, crop);

    blueDiffMask.delete();
    hsvMask.delete();
    combinedMask.delete();

    return ledPoints;
  }

  createBlueDifferentialMask(srcMat) {
    const channels = new cv.MatVector();
    cv.split(srcMat, channels);

    const B = channels.get(2);
    const G = channels.get(1);
    const R = channels.get(0);

    const RG_sum = new cv.Mat();
    cv.add(R, G, RG_sum);
    const RG_avg = new cv.Mat();
    RG_sum.convertTo(RG_avg, cv.CV_8U, 0.5);

    const blueDiff = new cv.Mat();
    cv.subtract(B, RG_avg, blueDiff);

    const mask = new cv.Mat();
    cv.threshold(blueDiff, mask, LED_CONFIG.blueDiffThreshold, 255, cv.THRESH_BINARY);

    R.delete(); G.delete(); B.delete();
    RG_sum.delete(); RG_avg.delete(); blueDiff.delete();
    channels.delete();

    return mask;
  }

  createHSVMask(srcMat) {
    const hsvMat = new cv.Mat();
    cv.cvtColor(srcMat, hsvMat, cv.COLOR_RGBA2RGB);
    cv.cvtColor(hsvMat, hsvMat, cv.COLOR_RGB2HSV);

    const lower = new cv.Mat(hsvMat.rows, hsvMat.cols, hsvMat.type(),
      [this.hsvParams.hMin * 179 / 360, this.hsvParams.sMin * 255, this.hsvParams.vMin * 255, 0]);
    const upper = new cv.Mat(hsvMat.rows, hsvMat.cols, hsvMat.type(),
      [this.hsvParams.hMax * 179 / 360, 255, 255, 255]);

    const mask = new cv.Mat();
    cv.inRange(hsvMat, lower, upper, mask);

    hsvMat.delete();
    lower.delete();
    upper.delete();

    return mask;
  }

  morphologicalFilter(mask) {
    const kernel1 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel1);
    kernel1.delete();

    const kernel2 = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel2);
    kernel2.delete();
  }

  extractLEDPoints(mask, srcMat, crop) {
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const ledPoints = [];
    const centerX = mask.cols / 2;
    const centerY = mask.rows / 2;

    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);

      if (area < LED_CONFIG.minArea || area > LED_CONFIG.maxArea) continue;

      const moments = cv.moments(cnt);
      if (moments.m00 === 0) continue;

      const cx = moments.m10 / moments.m00;
      const cy = moments.m01 / moments.m00;

      const perimeter = cv.arcLength(cnt, true);
      const circularity = perimeter === 0 ? 0 : (4 * Math.PI * area) / (perimeter * perimeter);

      if (circularity >= LED_CONFIG.minCircularity) {
        const dist = Math.hypot(cx - centerX, cy - centerY);
        ledPoints.push({
          x: (cx + crop.sx) / offscreen.width,
          y: (cy + crop.sy) / offscreen.height,
          area: area,
          circularity: circularity,
          dist: dist
        });
      }
    }

    contours.delete();
    hierarchy.delete();

    return ledPoints;
  }
}

// 幾何匹配器
class GeometryMatcher {
  match(detectedPoints) {
    if (detectedPoints.length !== 5) {
      return { success: false, error: `檢測到${detectedPoints.length}個點，需要5個` };
    }

    let topPoint = detectedPoints.reduce((min, p) => p.y < min.y ? p : min);
    const bottomPoints = detectedPoints.filter(p => p !== topPoint);

    const centroid = {
      x: bottomPoints.reduce((sum, p) => sum + p.x, 0) / 4,
      y: bottomPoints.reduce((sum, p) => sum + p.y, 0) / 4
    };

    const matchedPoints = bottomPoints.map(p => {
      const dx = p.x - centroid.x;
      const dy = p.y - centroid.y;

      let id;
      if (dx > 0 && dy < 0) id = 1;       // 右上
      else if (dx > 0 && dy > 0) id = 2;  // 右下
      else if (dx < 0 && dy > 0) id = 3;  // 左下
      else id = 4;                         // 左上

      return { ...p, id };
    });

    matchedPoints.push({ ...topPoint, id: 5 });

    const verification = this.verifyGeometry(matchedPoints);
    if (!verification.valid) {
      return { success: false, error: verification.reason };
    }

    return {
      success: true,
      points: matchedPoints.sort((a, b) => a.id - b.id),
      metrics: verification.metrics
    };
  }

  verifyGeometry(points) {
    const p1 = points.find(p => p.id === 1);
    const p2 = points.find(p => p.id === 2);
    const p3 = points.find(p => p.id === 3);
    const p4 = points.find(p => p.id === 4);
    const p5 = points.find(p => p.id === 5);

    const width = Math.abs(p1.x - p3.x);
    const height = Math.abs(p1.y - p2.y);
    const aspectRatio = width / height;

    const ratioError = Math.abs(aspectRatio - LED_CONFIG.expectedAspectRatio) /
                      LED_CONFIG.expectedAspectRatio;

    if (ratioError > LED_CONFIG.aspectRatioTolerance) {
      return {
        valid: false,
        reason: `矩形比例不符：${aspectRatio.toFixed(2)} (預期${LED_CONFIG.expectedAspectRatio.toFixed(2)})`,
        metrics: { aspectRatio, ratioError }
      };
    }

    const avgBottomY = (p1.y + p2.y + p3.y + p4.y) / 4;
    if (p5.y >= avgBottomY) {
      return {
        valid: false,
        reason: 'LED5位置錯誤（應在上方）',
        metrics: { p5Y: p5.y, avgBottomY }
      };
    }

    return {
      valid: true,
      metrics: { aspectRatio, ratioError, width, height }
    };
  }
}

// 簡易卡爾曼濾波器
class SimpleKalman {
  constructor() {
    this.x = null;
    this.y = null;
    this.px = 1;
    this.py = 1;
    this.processNoise = 0.01;
    this.measurementNoise = 1;
  }

  update(measureX, measureY) {
    if (this.x === null) {
      this.x = measureX;
      this.y = measureY;
      return { x: this.x, y: this.y };
    }

    this.px += this.processNoise;
    this.py += this.processNoise;

    const kx = this.px / (this.px + this.measurementNoise);
    const ky = this.py / (this.py + this.measurementNoise);

    this.x = this.x + kx * (measureX - this.x);
    this.y = this.y + ky * (measureY - this.y);

    this.px = (1 - kx) * this.px;
    this.py = (1 - ky) * this.py;

    return { x: this.x, y: this.y };
  }

  reset() {
    this.x = null;
    this.y = null;
    this.px = 1;
    this.py = 1;
  }
}

// PnP求解器（增強版）
class PnPSolver {
  constructor() {
    this.cameraMatrix = null;
    this.distCoeffs = null;
  }

  updateCameraMatrix(fx, fy, cx, cy) {
    if (this.cameraMatrix) this.cameraMatrix.delete();
    this.cameraMatrix = cv.matFromArray(3, 3, cv.CV_64F, [
      fx, 0, cx,
      0, fy, cy,
      0, 0, 1
    ]);
  }

  solve(matched2DPoints) {
    if (!this.cameraMatrix) return { success: false, error: '相機矩陣未初始化' };

    try {
      const object3D = matched2DPoints.map(p => {
        const led = LED_CONFIG.points3D.find(l => l.id === p.id);
        return [led.x, led.y, led.z];
      });

      const image2D = matched2DPoints.map(p => {
        const { px, py } = mapOverlayToSource({ x: p.x, y: p.y });
        return [px, py];
      });

      const objectPoints = cv.matFromArray(5, 1, cv.CV_32FC3, object3D.flat());
      const imagePoints = cv.matFromArray(5, 1, cv.CV_32FC2, image2D.flat());

      if (!this.distCoeffs) {
        this.distCoeffs = cv.Mat.zeros(5, 1, cv.CV_64F);
      }

      const rvec = new cv.Mat();
      const tvec = new cv.Mat();

      const success = cv.solvePnP(
        objectPoints,
        imagePoints,
        this.cameraMatrix,
        this.distCoeffs,
        rvec,
        tvec,
        false,
        cv.SOLVEPNP_ITERATIVE
      );

      if (!success) {
        throw new Error('PnP求解失敗');
      }

      const rmat = new cv.Mat();
      cv.Rodrigues(rvec, rmat);

      const pose = {
        position: {
          x: tvec.data64F[0],
          y: tvec.data64F[1],
          z: tvec.data64F[2]
        },
        distance: Math.sqrt(
          Math.pow(tvec.data64F[0], 2) +
          Math.pow(tvec.data64F[1], 2) +
          Math.pow(tvec.data64F[2], 2)
        ) / 1000,
        rotation: this.rotationMatrixToEuler(rmat),
        rvec: [rvec.data64F[0], rvec.data64F[1], rvec.data64F[2]],
        tvec: [tvec.data64F[0], tvec.data64F[1], tvec.data64F[2]]
      };

      objectPoints.delete();
      imagePoints.delete();
      rvec.delete();
      tvec.delete();
      rmat.delete();

      return { success: true, pose };

    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  rotationMatrixToEuler(R) {
    const r = [];
    for (let i = 0; i < 3; i++) {
      r[i] = [];
      for (let j = 0; j < 3; j++) {
        r[i][j] = R.doubleAt(i, j);
      }
    }

    const sy = Math.sqrt(r[0][0] * r[0][0] + r[1][0] * r[1][0]);
    const singular = sy < 1e-6;

    let roll, pitch, yaw;
    if (!singular) {
      roll = Math.atan2(r[2][1], r[2][2]);
      pitch = Math.atan2(-r[2][0], sy);
      yaw = Math.atan2(r[1][0], r[0][0]);
    } else {
      roll = Math.atan2(-r[1][2], r[1][1]);
      pitch = Math.atan2(-r[2][0], sy);
      yaw = 0;
    }

    return {
      roll: roll * 180 / Math.PI,
      pitch: pitch * 180 / Math.PI,
      yaw: yaw * 180 / Math.PI
    };
  }

  dispose() {
    if (this.cameraMatrix) this.cameraMatrix.delete();
    if (this.distCoeffs) this.distCoeffs.delete();
  }
}

// LED 6DoF定位系統（主系統）
class LED6DoFLocalizer {
  constructor() {
    this.detector = null;
    this.matcher = new GeometryMatcher();
    this.solver = new PnPSolver();
    this.kalmanFilters = {};
    this.history = [];
    this.maxHistory = 5;
  }

  updateHSVParams(hsvParams) {
    this.detector = new BlueLEDDetector(hsvParams);
  }

  updateCameraParams(fx, fy, cx, cy) {
    this.solver.updateCameraMatrix(fx, fy, cx, cy);
  }

  process(srcMat, crop) {
    if (!this.detector) {
      this.detector = new BlueLEDDetector();
    }

    const detectedPoints = this.detector.detect(srcMat, crop);

    if (detectedPoints.length === 0) {
      return { success: false, error: '未檢測到LED' };
    }

    const matchResult = this.matcher.match(detectedPoints);
    if (!matchResult.success) {
      return matchResult;
    }

    const smoothedPoints = this.applyKalmanFilter(matchResult.points);
    const poseResult = this.solver.solve(smoothedPoints);

    if (!poseResult.success) {
      return poseResult;
    }

    this.history.push(poseResult.pose);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return {
      success: true,
      pose: poseResult.pose,
      points: smoothedPoints,
      metrics: matchResult.metrics,
      stability: this.calculateStability()
    };
  }

  applyKalmanFilter(points) {
    return points.map(p => {
      if (!this.kalmanFilters[p.id]) {
        this.kalmanFilters[p.id] = new SimpleKalman();
      }

      const smoothed = this.kalmanFilters[p.id].update(p.x, p.y);

      return {
        ...p,
        x: smoothed.x,
        y: smoothed.y
      };
    });
  }

  calculateStability() {
    if (this.history.length < 2) return 0;

    const current = this.history[this.history.length - 1];
    const previous = this.history[this.history.length - 2];

    const positionDiff = Math.sqrt(
      Math.pow(current.position.x - previous.position.x, 2) +
      Math.pow(current.position.y - previous.position.y, 2) +
      Math.pow(current.position.z - previous.position.z, 2)
    );

    return Math.max(0, 1 - positionDiff / 100);
  }

  reset() {
    this.kalmanFilters = {};
    this.history = [];
  }

  dispose() {
    this.solver.dispose();
  }
}

// ===================================================================

const ui = {
  status: document.getElementById("status"),
  video: document.getElementById("video"),
  overlay: document.getElementById("overlay"),
  processed: document.getElementById("processed"),
  btnStart: document.getElementById("btnStart"),
  btnStop: document.getElementById("btnStop"),
  btnLocClear: document.getElementById("btnLocClear"),
  btnLocAuto: document.getElementById("btnLocAuto"),
  btnLocSolve: document.getElementById("btnLocSolve"),
  cfgFx: document.getElementById("cfgFx"),
  cfgFy: document.getElementById("cfgFy"),
  cfgCx: document.getElementById("cfgCx"),
  cfgCy: document.getElementById("cfgCy"),
  locStatus: document.getElementById("locStatus"),
  locPos: document.getElementById("locPos"),
  locRot: document.getElementById("locRot"),
  locDist: document.getElementById("locDist"),
  camRes: document.getElementById("camRes"),
  ledQuality: document.getElementById("ledQuality"),
  btnLedQuality: document.getElementById("btnLedQuality"),
  qualityLog: document.getElementById("qualityLog"),
  log: document.getElementById("log"),
  btnAutoHsv: document.getElementById("btnAutoHsv"),
  cfgEnvMode: document.getElementById("cfgEnvMode"),
  // HSV 控制
  cfgHueMin: document.getElementById("cfgHueMin"),
  cfgHueMax: document.getElementById("cfgHueMax"),
  cfgSatMin: document.getElementById("cfgSatMin"),
  cfgValMin: document.getElementById("cfgValMin"),
  valHueMin: document.getElementById("valHueMin"),
  valHueMax: document.getElementById("valHueMax"),
  valSatMin: document.getElementById("valSatMin"),
  valValMin: document.getElementById("valValMin"),
  // 顯示選項
  chkShowMask: document.getElementById("chkShowMask"),
  chkMaskOnly: document.getElementById("chkMaskOnly"),
  chkOnlyEnhance: document.getElementById("chkOnlyEnhance"),
};

const state = {
  stream: null,
  track: null,
  lastFrameTs: 0,
  fpsSamples: [],
  locPoints: [],
  locCandidates: [],  // 所有候選LED點（用於診斷顯示）
  cvReady: false,
  autoLocating: false,
  trackPoints: null,
  lastTrackTs: 0,
  lastAutoDetectTs: 0,
  autoDetectBusy: false,
  logLines: [],
  qualityLines: [],
  localizer: null,  // 6DoF定位器實例
  useEnhancedLocalizer: true,  // 使用增強版定位器
  kalmanFilters: {},  // 卡爾曼濾波器
  pnpSolver: null,  // PnP求解器
  // 顯示選項
  showMask: false,     // 顯示藍燈遮罩
  maskOnly: false,     // 只顯示遮罩
  onlyEnhance: true,   // 只顯示強化畫面
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

function logQuality(text) {
  const stamp = new Date().toLocaleTimeString();
  state.qualityLines.unshift(`[${stamp}] ${text}`);
  state.qualityLines = state.qualityLines.slice(0, 12);
  ui.qualityLog.textContent = state.qualityLines.join("\n");
}

function setStatus(text) {
  ui.status.textContent = text;
}

// Removed - no longer needed for 5-LED positioning
function updateEnhanceLabels() {
  // 更新 HSV 滑桿標籤
  if (ui.valHueMin) ui.valHueMin.textContent = ui.cfgHueMin.value;
  if (ui.valHueMax) ui.valHueMax.textContent = ui.cfgHueMax.value;
  if (ui.valSatMin) ui.valSatMin.textContent = Number(ui.cfgSatMin.value).toFixed(2);
  if (ui.valValMin) ui.valValMin.textContent = Number(ui.cfgValMin.value).toFixed(2);
}

// Removed - no longer needed for 5-LED positioning
function getEnhanceConfig() {
  return {
    enabled: false
  };
}

// Simplified config for 5-LED positioning only
function getConfig() {
  return {
    targetWidth: 1280,
    targetHeight: 720,
    targetFps: 30,
    targetExposureUs: 8000,
    targetIso: 400
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
        width: { ideal: getConfig().targetWidth },
        height: { ideal: getConfig().targetHeight },
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
    ui.camRes.textContent = `${offscreen.width} x ${offscreen.height}`;
    setStatus("Camera ready");
    ui.btnStart.disabled = true;
    ui.btnStop.disabled = false;
    ui.btnLocClear.disabled = false;
    ui.btnLocAuto.disabled = false;
    ui.btnLocSolve.disabled = false;
    ui.btnLedQuality.disabled = false;
    ui.btnAutoHsv.disabled = false;

    estimateIntrinsics();
    initLocalizer();  // 初始化6DoF定位器

    startFrameLoop();
  } catch (err) {
    console.error(err);
    setStatus("Camera error");
    logLine("Camera access failed.");
  }
}

// 初始化6DoF定位器
function initLocalizer() {
  if (state.localizer) {
    state.localizer.dispose();
  }
  state.localizer = new LED6DoFLocalizer();

  // 從 UI 讀取 HSV 參數
  const hMin = Number(ui.cfgHueMin.value);
  const hMax = Number(ui.cfgHueMax.value);
  const sMin = Number(ui.cfgSatMin.value);
  const vMin = Number(ui.cfgValMin.value);

  state.localizer.updateHSVParams({ hMin, hMax, sMin, vMin });

  // 更新相機內參
  const { fx, fy, cx, cy } = getCameraMatrix();
  state.localizer.updateCameraParams(fx, fy, cx, cy);

  console.log(`6DoF定位器已初始化 (HSV: H=${hMin}-${hMax}, S=${sMin}, V=${vMin})`);
  logLine("6DoF定位器已初始化");
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
  }
  state.stream = null;
  state.track = null;
  ui.video.srcObject = null;
  setStatus("Stopped");
  ui.btnStart.disabled = false;
  ui.btnStop.disabled = true;
  ui.btnLocClear.disabled = true;
  ui.btnLocAuto.disabled = true;
  ui.btnLocSolve.disabled = true;
  ui.btnLedQuality.disabled = true;
  ui.btnAutoHsv.disabled = true;
  state.autoLocating = false;
  ui.btnLocAuto.textContent = "🎯 開始自動偵測";
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

// Simplified - no longer displays device info
function updateDeviceInfo() {
  // No-op: device info display removed
}

function drawOverlay() {
  overlayCtx.clearRect(0, 0, ui.overlay.width, ui.overlay.height);

  // 繪製定位LED系統（僅5-LED）
  // 第一階段：繪製所有候選點（灰色小圓圈）用於診斷
  if (state.locCandidates && state.locCandidates.length > 0) {
    overlayCtx.fillStyle = 'rgba(128, 128, 128, 0.4)';
    overlayCtx.strokeStyle = '#666';
    overlayCtx.lineWidth = 1;

    state.locCandidates.forEach((pt) => {
      const x = pt.x * ui.overlay.width;
      const y = pt.y * ui.overlay.height;

      overlayCtx.beginPath();
      overlayCtx.arc(x, y, 4, 0, Math.PI * 2);
      overlayCtx.fill();
      overlayCtx.stroke();
    });
  }

  // 第二階段：繪製匹配成功的5個LED（彩色，覆蓋在候選點上方）
  if (state.locPoints.length === 5) {
    // 根據ID繪製不同顏色
    state.locPoints.forEach((pt) => {
      const x = pt.x * ui.overlay.width;
      const y = pt.y * ui.overlay.height;

      // LED5（突出點）用綠色，其他用藍色
      const color = pt.id === 5 ? '#00ff00' : '#00aaff';
      const radius = pt.id === 5 ? 10 : 8;

      overlayCtx.fillStyle = color;
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, radius, 0, Math.PI * 2);
      overlayCtx.fill();

      // 繪製外圈
      overlayCtx.strokeStyle = '#ffffff';
      overlayCtx.lineWidth = 2;
      overlayCtx.beginPath();
      overlayCtx.arc(x, y, radius + 2, 0, Math.PI * 2);
      overlayCtx.stroke();

      // ID標籤
      overlayCtx.fillStyle = '#ffffff';
      overlayCtx.font = 'bold 14px monospace';
      overlayCtx.fillText(`${pt.id}`, x + radius + 4, y + 5);
    });

    // 繪製底部矩形連線
    const p1 = state.locPoints.find(p => p.id === 1);
    const p2 = state.locPoints.find(p => p.id === 2);
    const p3 = state.locPoints.find(p => p.id === 3);
    const p4 = state.locPoints.find(p => p.id === 4);
    const p5 = state.locPoints.find(p => p.id === 5);

    if (p1 && p2 && p3 && p4) {
      overlayCtx.strokeStyle = '#00aaff';
      overlayCtx.lineWidth = 2;
      overlayCtx.beginPath();
      overlayCtx.moveTo(p1.x * ui.overlay.width, p1.y * ui.overlay.height);
      overlayCtx.lineTo(p2.x * ui.overlay.width, p2.y * ui.overlay.height);
      overlayCtx.lineTo(p3.x * ui.overlay.width, p3.y * ui.overlay.height);
      overlayCtx.lineTo(p4.x * ui.overlay.width, p4.y * ui.overlay.height);
      overlayCtx.closePath();
      overlayCtx.stroke();

      // 繪製中心到LED5的連線
      if (p5) {
        const centerX = (p1.x + p2.x + p3.x + p4.x) / 4 * ui.overlay.width;
        const centerY = (p1.y + p2.y + p3.y + p4.y) / 4 * ui.overlay.height;

        overlayCtx.strokeStyle = '#00ff00';
        overlayCtx.lineWidth = 2;
        overlayCtx.setLineDash([5, 5]);
        overlayCtx.beginPath();
        overlayCtx.moveTo(centerX, centerY);
        overlayCtx.lineTo(p5.x * ui.overlay.width, p5.y * ui.overlay.height);
        overlayCtx.stroke();
        overlayCtx.setLineDash([]);
      }
    }
  }
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

// Removed getRoiRects function (3-LED data capture)

// Removed updateProcessedView - no longer needed for 5-LED positioning
function updateProcessedView() {
  // 如果沒有啟用任何顯示選項，顯示原始視頻
  if (!state.showMask && !state.maskOnly && !state.onlyEnhance) {
    processedCtx.clearRect(0, 0, ui.processed.width, ui.processed.height);
    ui.processed.style.opacity = "0";
    ui.video.style.opacity = "1";
    ui.processed.style.mixBlendMode = "normal";
    return;
  }

  // 設置顯示模式
  if (state.onlyEnhance || state.maskOnly) {
    ui.processed.style.opacity = "1";
    ui.video.style.opacity = "0";
    ui.processed.style.mixBlendMode = "normal";
  } else {
    ui.processed.style.opacity = "0.65";
    ui.video.style.opacity = "1";
    ui.processed.style.mixBlendMode = "screen";
  }

  // 繪製當前畫面到 offscreen
  offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);
  const crop = getCoverRect(
    offscreen.width,
    offscreen.height,
    ui.processed.width,
    ui.processed.height
  );

  // 如果只是顯示強化畫面（無遮罩），直接繪製
  if (!state.showMask && !state.maskOnly) {
    processedCtx.drawImage(
      offscreen,
      crop.sx, crop.sy, crop.sw, crop.sh,
      0, 0, ui.processed.width, ui.processed.height
    );
    return;
  }

  // 需要處理遮罩，使用 procCanvas
  procCanvas.width = ui.processed.width;
  procCanvas.height = ui.processed.height;
  procCtx.drawImage(
    offscreen,
    crop.sx, crop.sy, crop.sw, crop.sh,
    0, 0, procCanvas.width, procCanvas.height
  );

  const image = procCtx.getImageData(0, 0, procCanvas.width, procCanvas.height);
  const { data } = image;
  const length = procCanvas.width * procCanvas.height;

  // 讀取 HSV 參數
  const hueMin = Number(ui.cfgHueMin.value);
  const hueMax = Number(ui.cfgHueMax.value);
  const satMin = Number(ui.cfgSatMin.value);
  const valMin = Number(ui.cfgValMin.value);

  // 處理藍燈遮罩
  for (let i = 0; i < length; i += 1) {
    const idx = i * 4;
    const r = data[idx] / 255;
    const g = data[idx + 1] / 255;
    const b = data[idx + 2] / 255;

    // RGB to HSV 轉換
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if (delta !== 0) {
      if (max === r) h = ((g - b) / delta) % 6;
      else if (max === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : delta / max;
    const v = max;

    // 檢查是否在藍色範圍內
    const inHue = h >= hueMin && h <= hueMax;
    const isBlueLed = inHue && s >= satMin && v >= valMin;

    if (state.maskOnly) {
      // 只顯示遮罩：藍色區域顯示白色，其他顯示黑色
      if (isBlueLed) {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
      } else {
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
      }
    } else if (!isBlueLed) {
      // 顯示遮罩：非藍色區域暗化
      data[idx] = Math.floor(data[idx] * 0.3);
      data[idx + 1] = Math.floor(data[idx + 1] * 0.3);
      data[idx + 2] = Math.floor(data[idx + 2] * 0.3);
    }
  }

  // 繪製處理後的圖像
  processedCtx.putImageData(image, 0, 0);
}

function toggleAutoLocating() {
  state.autoLocating = !state.autoLocating;
  console.log(`🎬 切換自動定位: ${state.autoLocating ? '開啟' : '關閉'}`);
  logLine(`[系統] 自動定位已${state.autoLocating ? '啟動' : '停止'}`);
  ui.btnLocAuto.textContent = state.autoLocating ? "停止自動偵測" : "🎯 開始自動偵測";
  if (!state.autoLocating) {
    state.trackPoints = null;
    state.autoDetectBusy = false;
  }
}

function startTracking(points) {
  state.trackPoints = points.map((p) => ({ x: p.x, y: p.y }));
  state.lastTrackTs = performance.now();
}

function updateTracking() {
  if (!state.trackPoints || !state.trackPoints.length) return false;
  offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);
  const next = [];
  let ok = true;
  for (const pt of state.trackPoints) {
    const { px, py, scale } = mapOverlayToSource(pt);
    const x = Math.round(px);
    const y = Math.round(py);
    const win = Math.max(10, Math.round(26 * scale));
    const { values, w, h, startX, startY } = computeBlueDiffAt(x, y, win);
    let max = 0;
    let maxIdx = 0;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] > max) {
        max = values[i];
        maxIdx = i;
      }
    }
    if (max < 10) {
      ok = false;
      break;
    }
    const nx = startX + (maxIdx % w);
    const ny = startY + Math.floor(maxIdx / w);
    next.push({ x: nx / offscreen.width, y: ny / offscreen.height });
  }
  if (!ok || next.length !== 5) return false;
  state.trackPoints = next;
  state.locPoints = next;
  drawOverlay();
  return true;
}

// Removed 3-LED ROI selection functions

function clearLocPoints() {
  state.locPoints = [];
  ui.locStatus.textContent = "-";
  ui.locPos.textContent = "-";
  ui.locRot.textContent = "-";
  ui.locDist.textContent = "-";
  drawOverlay();
}

// Removed 3-LED data capture functions (autoDetectRois, computeBrightness, etc.)

function computeBlueDiffAt(x, y, size) {
  const half = Math.floor(size / 2);
  const startX = Math.max(0, x - half);
  const startY = Math.max(0, y - half);
  const endX = Math.min(offscreen.width - 1, x + half);
  const endY = Math.min(offscreen.height - 1, y + half);
  const w = endX - startX + 1;
  const h = endY - startY + 1;
  const image = offCtx.getImageData(startX, startY, w, h);
  const { data } = image;
  const values = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const v = Math.max(0, b - (r + g) / 2);
    values.push(v);
  }
  return { values, w, h, startX, startY };
}

function sortLocPoints(points) {
  if (points.length !== 5) return points;
  const sorted = [...points];
  sorted.sort((a, b) => a.y - b.y);
  const top = sorted.shift();
  const rest = sorted;
  const cx = rest.reduce((acc, p) => acc + p.x, 0) / rest.length;
  const cy = rest.reduce((acc, p) => acc + p.y, 0) / rest.length;
  const quad = { rt: null, rb: null, lb: null, lt: null };
  rest.forEach((p) => {
    const right = p.x >= cx;
    const topQ = p.y <= cy;
    if (right && topQ) quad.rt = p;
    else if (right && !topQ) quad.rb = p;
    else if (!right && !topQ) quad.lb = p;
    else quad.lt = p;
  });
  const remaining = rest.filter((p) => !Object.values(quad).includes(p));
  if (remaining.length) {
    const byAngle = [...rest].sort(
      (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
    );
    quad.rt = quad.rt || byAngle[0];
    quad.rb = quad.rb || byAngle[1];
    quad.lb = quad.lb || byAngle[2];
    quad.lt = quad.lt || byAngle[3];
  }
  return [quad.rt, quad.rb, quad.lb, quad.lt, top].filter(Boolean);
}

function scorePnP(points) {
  if (!ensureCvReady()) return { ok: false };
  if (points.length !== 5) return { ok: false };

  const objectPts = [
    [33.65, 21.8, 0],
    [33.65, -21.8, 0],
    [-33.65, -21.8, 0],
    [-33.65, 21.8, 0],
    [0, 63.09, 20.1],
  ];

  const imgPts = points.map((pt) => {
    const { px, py } = mapOverlayToSource(pt);
    return [px, py];
  });

  const objMat = cv.matFromArray(5, 3, cv.CV_32F, objectPts.flat());
  const imgMat = cv.matFromArray(5, 2, cv.CV_32F, imgPts.flat());

  const { fx, fy, cx, cy } = getCameraMatrix();
  if (!fx || !fy) {
    objMat.delete();
    imgMat.delete();
    return { ok: false };
  }
  const camMat = cv.matFromArray(3, 3, cv.CV_32F, [
    fx, 0, cx,
    0, fy, cy,
    0, 0, 1
  ]);
  const distCoeffs = cv.Mat.zeros(4, 1, cv.CV_32F);
  const rvec = new cv.Mat();
  const tvec = new cv.Mat();

  const ok = cv.solvePnP(objMat, imgMat, camMat, distCoeffs, rvec, tvec, false, cv.SOLVEPNP_ITERATIVE);
  let error = Infinity;
  let z = null;
  if (ok) {
    const projected = new cv.Mat();
    cv.projectPoints(objMat, rvec, tvec, camMat, distCoeffs, projected);
    const p = projected.data32F;
    let sum = 0;
    for (let i = 0; i < 5; i += 1) {
      const dx = p[i * 2] - imgPts[i][0];
      const dy = p[i * 2 + 1] - imgPts[i][1];
      sum += Math.hypot(dx, dy);
    }
    error = sum / 5;
    z = tvec.data32F[2];
    projected.delete();
  }

  objMat.delete();
  imgMat.delete();
  camMat.delete();
  distCoeffs.delete();
  rvec.delete();
  tvec.delete();

  return { ok, error, z };
}

function autoDetectLocPoints() {
  if (state.autoDetectBusy) {
    console.log('⏸️ 檢測忙碌中，跳過');
    return;
  }
  if (!ensureCvReady()) {
    console.log('⚠️ OpenCV 尚未就緒');
    ui.locStatus.textContent = "OpenCV 尚未就緒";
    return;
  }
  if (!state.stream) {
    console.log('⚠️ 視頻流未就緒');
    return;
  }

  console.log('🔄 autoDetectLocPoints() 被調用');
  state.autoDetectBusy = true;

  // 使用增強版定位器
  if (state.useEnhancedLocalizer && state.localizer) {
    console.log('✅ 使用增強版定位器');
    autoDetectWithEnhancedLocalizer();
  } else {
    console.log(`⚠️ 使用傳統方法 (useEnhancedLocalizer=${state.useEnhancedLocalizer}, localizer=${!!state.localizer})`);
    autoDetectWithLegacyMethod();
  }

  state.autoDetectBusy = false;
}

// 增強版定位器自動檢測
function autoDetectWithEnhancedLocalizer() {
  console.log('🎯 === 開始自動檢測 ===');
  logLine('[檢測] 啟動幾何結構檢測');

  offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);
  const cropRaw = getCoverRect(
    offscreen.width,
    offscreen.height,
    ui.overlay.width,
    ui.overlay.height
  );
  const crop = {
    sx: Math.round(cropRaw.sx),
    sy: Math.round(cropRaw.sy),
    sw: Math.round(cropRaw.sw),
    sh: Math.round(cropRaw.sh),
  };

  console.log(`📐 視頻尺寸: ${offscreen.width}×${offscreen.height}`);
  console.log(`📐 Crop區域: ${crop.sw}×${crop.sh} @ (${crop.sx},${crop.sy})`);

  // 使用基於幾何結構的檢測（方案3優化版）
  const envMode = ui.cfgEnvMode ? ui.cfgEnvMode.value : 'normal';
  console.log(`🌍 環境模式: ${envMode}`);

  const result = geometryBasedDetect(offCtx, crop, offscreen, { envMode });
  console.log(`📊 檢測結果: success=${result.success}, candidates=${result.candidates?.length || 0}`);

  // 保存候選點用於顯示診斷信息
  state.locCandidates = result.candidates || [];
  console.log(`💾 候選點數量: ${state.locCandidates.length}`);

  if (result.success) {
    console.log('✅ 幾何結構驗證通過，開始PnP求解');
    logLine(`[檢測] 找到5個LED點，準備計算姿態`);

    // 應用卡爾曼濾波器平滑點位
    const smoothedPoints = result.points.map(p => {
      if (!state.kalmanFilters) state.kalmanFilters = {};
      if (!state.kalmanFilters[p.id]) {
        state.kalmanFilters[p.id] = new SimpleKalman();
      }
      const smoothed = state.kalmanFilters[p.id].update(p.x, p.y);
      return { ...p, x: smoothed.x, y: smoothed.y };
    });

    state.locPoints = smoothedPoints;
    startTracking(smoothedPoints);

    // 計算PnP姿態
    if (!state.pnpSolver) {
      state.pnpSolver = new PnPSolver();
      console.log('🔧 PnP求解器已初始化');
    }
    console.log('🎲 開始PnP姿態求解...');
    const poseResult = state.pnpSolver.solve(smoothedPoints);
    console.log(`🎲 PnP求解結果: success=${poseResult.success}`);

    if (poseResult.success) {
      // 更新UI
      updateLocalizationUI({
        pose: poseResult.pose,
        points: smoothedPoints,
        metrics: result.metrics,
        stability: 0.85
      });

      drawOverlay();

      // 顯示診斷信息
      const candidateCount = result.totalCandidates || result.candidates.length;
      ui.locStatus.textContent = `✅ 定位成功 | 候選: ${candidateCount} → 有效: 5 | 評分: ${result.score.toFixed(1)}`;
    } else {
      ui.locStatus.textContent = `PnP求解失敗: ${poseResult.error}`;
    }
  } else {
    // 顯示失敗原因和候選點數量
    const candidateCount = result.candidates ? result.candidates.length : 0;
    console.log(`❌ 檢測失敗: ${result.error} (候選點: ${candidateCount})`);
    logLine(`[檢測] 失敗: ${result.error}`);
    ui.locStatus.textContent = `❌ ${result.error} (候選點: ${candidateCount})`;

    // 仍然繪製候選點用於診斷
    drawOverlay();
  }
  console.log('🏁 === 自動檢測結束 ===\n');
}

// 傳統方法自動檢測（保留向後兼容）
function autoDetectWithLegacyMethod() {
  offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);
  const cropRaw = getCoverRect(
    offscreen.width,
    offscreen.height,
    ui.overlay.width,
    ui.overlay.height
  );
  const crop = {
    sx: Math.round(cropRaw.sx),
    sy: Math.round(cropRaw.sy),
    sw: Math.round(cropRaw.sw),
    sh: Math.round(cropRaw.sh),
  };
  const imgData = offCtx.getImageData(crop.sx, crop.sy, crop.sw, crop.sh);
  const diff = new Uint8Array(crop.sw * crop.sh);
  const hist = new Uint32Array(256);
  const data = imgData.data;
  for (let i = 0, j = 0; i < data.length; i += 4, j += 1) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const v = Math.max(0, b - (r + g) / 2);
    diff[j] = v;
    hist[v] += 1;
  }
  const total = diff.length;
  let cum = 0;
  let thresh = 40;
  const target = total * 0.995;
  for (let i = 0; i < 256; i += 1) {
    cum += hist[i];
    if (cum >= target) {
      thresh = Math.max(20, i);
      break;
    }
  }

  const mask = new cv.Mat(crop.sh, crop.sw, cv.CV_8UC1);
  mask.data.set(diff);
  cv.threshold(mask, mask, thresh, 255, cv.THRESH_BINARY);

  const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const blobs = [];
  const centerX = crop.sw / 2;
  const centerY = crop.sh / 2;
  for (let i = 0; i < contours.size(); i += 1) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);
    if (area < 4) continue;
    const m = cv.moments(cnt);
    if (m.m00 === 0) continue;
    const peri = cv.arcLength(cnt, true);
    const circularity = peri === 0 ? 0 : (4 * Math.PI * area) / (peri * peri);
    if (circularity < 0.35) continue;
    const cx = m.m10 / m.m00;
    const cy = m.m01 / m.m00;
    const dist = Math.hypot(cx - centerX, cy - centerY);
    blobs.push({ x: cx, y: cy, area, circularity, dist });
  }

  const areaSorted = [...blobs].sort((a, b) => a.area - b.area);
  const medianArea = areaSorted.length
    ? areaSorted[Math.floor(areaSorted.length / 2)].area
    : 0;
  const minArea = medianArea * 0.4;
  const maxArea = medianArea * 2.5;
  const maxDist = Math.min(crop.sw, crop.sh) * 0.6;
  const filtered = blobs.filter((b) => {
    if (medianArea > 0 && (b.area < minArea || b.area > maxArea)) return false;
    if (b.dist > maxDist) return false;
    return true;
  });

  filtered.sort((a, b) => b.area - a.area);
  const candidates = filtered.slice(0, 12);
  if (candidates.length < 5) {
    ui.locStatus.textContent = "偵測到的藍燈不足 5 顆";
  } else {
    let best = null;
    const combos = [];
    for (let a = 0; a < candidates.length; a += 1) {
      for (let b = a + 1; b < candidates.length; b += 1) {
        for (let c = b + 1; c < candidates.length; c += 1) {
          for (let d = c + 1; d < candidates.length; d += 1) {
            for (let e = d + 1; e < candidates.length; e += 1) {
              combos.push([candidates[a], candidates[b], candidates[c], candidates[d], candidates[e]]);
            }
          }
        }
      }
    }

    for (const set of combos) {
      const normalized = set.map((p) => ({
        x: p.x / crop.sw,
        y: p.y / crop.sh,
      }));
      const ordered = sortLocPoints(normalized);
      if (ordered.length !== 5) continue;
      const score = scorePnP(ordered);
      if (!score.ok || score.z === null || score.z <= 0) continue;
      const centerPenalty = ordered.reduce((acc, p) => {
        const dx = p.x - 0.5;
        const dy = p.y - 0.5;
        return acc + Math.hypot(dx, dy);
      }, 0) / ordered.length;
      const finalScore = score.error + centerPenalty * 3.0;
      if (!best || finalScore < best.error) {
        best = { error: finalScore, ordered };
      }
    }

    if (!best) {
      ui.locStatus.textContent = "定位燈幾何不符合";
    } else {
      state.locPoints = best.ordered;
      startTracking(best.ordered);
      ui.locStatus.textContent = `定位燈自動偵測完成 (err≈${best.error.toFixed(2)}px)`;
      drawOverlay();
    }
  }

  mask.delete();
  kernel.delete();
  contours.delete();
  hierarchy.delete();
}

// 更新定位UI顯示
function updateLocalizationUI(result) {
  if (!result || !result.success) return;

  const { pose, stability, metrics } = result;

  // 位置信息
  ui.locPos.textContent =
    `X: ${pose.position.x.toFixed(1)}mm | ` +
    `Y: ${pose.position.y.toFixed(1)}mm | ` +
    `Z: ${pose.position.z.toFixed(1)}mm`;

  // 旋轉信息
  ui.locRot.textContent =
    `Roll: ${pose.rotation.roll.toFixed(1)}° | ` +
    `Pitch: ${pose.rotation.pitch.toFixed(1)}° | ` +
    `Yaw: ${pose.rotation.yaw.toFixed(1)}°`;

  // 距離
  ui.locDist.textContent = `${pose.distance.toFixed(2)} m`;

  // 狀態和質量指標
  const stabilityPercent = (stability * 100).toFixed(0);
  const aspectRatio = metrics.aspectRatio.toFixed(2);
  const ratioError = (metrics.ratioError * 100).toFixed(1);

  ui.locStatus.textContent =
    `穩定性: ${stabilityPercent}% | ` +
    `比例: ${aspectRatio} (誤差${ratioError}%)`;
}

function estimateLedQuality() {
  if (!state.stream) return;
  if (state.locPoints.length !== 5) {
    ui.ledQuality.textContent = "需要 5 點";
    logQuality("請先點選 5 顆定位藍燈");
    return;
  }
  offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);

  const sizes = [];
  const snrs = [];

  state.locPoints.forEach((pt, idx) => {
    const { px, py, scale } = mapOverlayToSource(pt);
    const x = Math.round(px);
    const y = Math.round(py);
    const win = Math.max(12, Math.round(24 * scale));
    const { values, w, h } = computeBlueDiffAt(x, y, win);

    let max = 0;
    for (const v of values) max = Math.max(max, v);
    const thresh = max * 0.5;
    let area = 0;
    let sum = 0;
    let sumSq = 0;
    for (const v of values) {
      if (v >= thresh) area += 1;
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / values.length;
    const varv = Math.max(0, sumSq / values.length - mean * mean);
    const std = Math.sqrt(varv);
    const snr = max / (std + 1);
    const diameter = 2 * Math.sqrt(area / Math.PI);

    sizes.push(diameter);
    snrs.push(snr);
    logQuality(`P${idx + 1}: px直徑≈${diameter.toFixed(1)}, SNR≈${snr.toFixed(1)}`);
  });

  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const avgSnr = snrs.reduce((a, b) => a + b, 0) / snrs.length;
  ui.ledQuality.textContent = `平均直徑 ${avgSize.toFixed(1)} px, 平均SNR ${avgSnr.toFixed(1)}`;
}

function autoCalibrateHsv() {
  if (!state.stream) return;
  offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);
  const crop = getCoverRect(
    offscreen.width,
    offscreen.height,
    ui.overlay.width,
    ui.overlay.height
  );
  const imgData = offCtx.getImageData(crop.sx, crop.sy, crop.sw, crop.sh);
  const src = cv.matFromImageData(imgData);
  const hsv = new cv.Mat();
  cv.cvtColor(src, hsv, cv.COLOR_RGBA2RGB);
  cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);

  const total = hsv.rows * hsv.cols;
  const step = Math.max(1, Math.floor(total / 12000));
  const hues = [];
  const sats = [];
  const vals = [];
  const data = hsv.data;

  // 先用藍光差分找出可能的藍色LED區域
  const imgDataRaw = offCtx.getImageData(crop.sx, crop.sy, crop.sw, crop.sh);
  const rawData = imgDataRaw.data;

  for (let i = 0; i < total; i += step) {
    const idx = i * 3;
    const idx4 = i * 4;

    // 藍光差分過濾
    const r = rawData[idx4];
    const g = rawData[idx4 + 1];
    const b = rawData[idx4 + 2];
    const blueDiff = b - (r + g) / 2;

    // 只採樣藍光差分值高的像素
    if (blueDiff < 30) continue;

    const h = data[idx];
    const s = data[idx + 1];
    const v = data[idx + 2];

    // 放寬飽和度和明度要求
    if (s < 30 || v < 30) continue;

    // 藍色範圍：OpenCV HSV中 100-145 對應 360度中的 200-290度
    if (h >= 100 && h <= 145) {
      hues.push(h);
      sats.push(s);
      vals.push(v);
    }
  }

  if (hues.length < 10) {
    ui.locStatus.textContent = `HSV 校準失敗：藍燈像素不足 (${hues.length})`;
    logLine(`HSV校準失敗：只找到${hues.length}個藍色像素，需要至少10個`);
  } else {
    hues.sort((a, b) => a - b);
    sats.sort((a, b) => a - b);
    vals.sort((a, b) => a - b);
    const p = (arr, q) => arr[Math.floor((arr.length - 1) * q)];

    // 使用更寬鬆的百分位數
    const hMin = Math.max(0, p(hues, 0.10));  // 10%
    const hMax = Math.min(179, p(hues, 0.90)); // 90%
    const sMin = Math.max(0, p(sats, 0.15) / 255);  // 15%
    const vMin = Math.max(0, p(vals, 0.15) / 255);  // 15%

    // 轉換到360度範圍
    ui.cfgHueMin.value = Math.round((hMin / 179) * 360);
    ui.cfgHueMax.value = Math.round((hMax / 179) * 360);
    ui.cfgSatMin.value = Math.min(1, sMin).toFixed(2);
    ui.cfgValMin.value = Math.min(1, vMin).toFixed(2);
    updateEnhanceLabels();

    // 更新定位器HSV參數
    if (state.localizer) {
      state.localizer.updateHSVParams({
        hMin: Number(ui.cfgHueMin.value),
        hMax: Number(ui.cfgHueMax.value),
        sMin: Number(ui.cfgSatMin.value),
        vMin: Number(ui.cfgValMin.value)
      });
    }

    ui.locStatus.textContent = `HSV 校準完成 (${hues.length} 藍色像素)`;
    logLine(`HSV校準：H(${ui.cfgHueMin.value}-${ui.cfgHueMax.value}), S(${ui.cfgSatMin.value}), V(${ui.cfgValMin.value})`);
  }

  src.delete();
  hsv.delete();
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
    const tx = tvec.data32F[0];
    const ty = tvec.data32F[1];
    const tz = tvec.data32F[2];
    const dist = Math.sqrt(tx * tx + ty * ty + tz * tz) / 1000;
    ui.locStatus.textContent = "PnP 成功";
    ui.locPos.textContent = `${tx.toFixed(1)}, ${ty.toFixed(1)}, ${tz.toFixed(1)}`;
    ui.locRot.textContent = `${deg(roll).toFixed(1)}, ${deg(pitch).toFixed(1)}, ${deg(yaw).toFixed(1)}`;
    ui.locDist.textContent = dist.toFixed(2);
  }

  objMat.delete();
  imgMat.delete();
  camMat.delete();
  distCoeffs.delete();
  rvec.delete();
  tvec.delete();
}

// Removed all 3-LED data decoding functions:
// - updateBrightnessBuffers
// - computeNormalized
// - smoothNormalized
// - bitsFromSymbol
// - bitsToNumber
// - computeCrc16
// - attemptDecode
// - updateLiveMetrics

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
  try {
    updateFps(ts);

    // 5-LED定位處理
    if (state.autoLocating) {
    const tracked = updateTracking();
    const intervalMs = 300;
    if (!tracked && ts - state.lastAutoDetectTs >= intervalMs) {
      state.lastAutoDetectTs = ts;
      autoDetectLocPoints();
    }

    // 即時PnP求解（如果有匹配的5個點）
    if (state.locPoints.length === 5 && state.useEnhancedLocalizer && state.localizer) {
      offCtx.drawImage(ui.video, 0, 0, offscreen.width, offscreen.height);
      const cropRaw = getCoverRect(
        offscreen.width,
        offscreen.height,
        ui.overlay.width,
        ui.overlay.height
      );
      const crop = {
        sx: Math.round(cropRaw.sx),
        sy: Math.round(cropRaw.sy),
        sw: Math.round(cropRaw.sw),
        sh: Math.round(cropRaw.sh),
      };
      const imgData = offCtx.getImageData(crop.sx, crop.sy, crop.sw, crop.sh);
      const srcMat = cv.matFromImageData(imgData);

      const result = state.localizer.process(srcMat, crop);
      srcMat.delete();

      if (result.success) {
        state.locPoints = result.points;
        updateLocalizationUI(result);
        drawOverlay();
      }
    }
  }

  // Removed 3-LED data decoding logic

    updateProcessedView();
  } catch (err) {
    console.error('processFrame error:', err);
  }
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

// Event listeners
ui.btnStart.addEventListener("click", startCamera);
ui.btnStop.addEventListener("click", stopCamera);
ui.btnLocClear.addEventListener("click", clearLocPoints);
ui.btnLocAuto.addEventListener("click", toggleAutoLocating);
ui.btnLocSolve.addEventListener("click", solvePnP);
ui.btnLedQuality.addEventListener("click", estimateLedQuality);
ui.btnAutoHsv.addEventListener("click", autoCalibrateHsv);

// HSV參數變更時更新定位器
[
  ui.cfgHueMin,
  ui.cfgHueMax,
  ui.cfgSatMin,
  ui.cfgValMin,
].forEach((el) => {
  el.addEventListener("input", () => {
    updateEnhanceLabels();
    // 更新定位器HSV參數
    if (state.localizer) {
      state.localizer.updateHSVParams({
        hMin: Number(ui.cfgHueMin.value),
        hMax: Number(ui.cfgHueMax.value),
        sMin: Number(ui.cfgSatMin.value),
        vMin: Number(ui.cfgValMin.value)
      });
    }
  });
});

updateEnhanceLabels();

// 顯示選項事件監聽器
ui.chkShowMask.addEventListener("change", () => {
  state.showMask = ui.chkShowMask.checked;
});
ui.chkMaskOnly.addEventListener("change", () => {
  state.maskOnly = ui.chkMaskOnly.checked;
});
ui.chkOnlyEnhance.addEventListener("change", () => {
  state.onlyEnhance = ui.chkOnlyEnhance.checked;
});

window.addEventListener("beforeunload", () => {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
});
