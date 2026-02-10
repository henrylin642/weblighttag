// ===================================================================
// WebTag 6DoF Locator - Main Application Controller
// Integrates: BlueFilter, BlobDetector, GeometryMatcher,
//             PnPSolver, LEDTracker, FeedbackManager
// No OpenCV dependency.
// ===================================================================

(function () {
  'use strict';

  const APP_VERSION = '2.3.0';

  // --- State ---

  const state = {
    running: false,
    stream: null,
    animFrameId: null,
    maskMode: 'off', // 'off' | 'overlay' | 'only'

    // FPS tracking
    frameCount: 0,
    lastFpsTime: 0,
    fps: 0,

    // Detection state
    detectionState: 'idle', // idle | scanning | candidate | locked | tracking
    focusStatus: 'unknown',

    // Offscreen canvas for full-res pixel access (used in sub-pixel refinement)
    offscreen: null,
    offCtx: null,

    // Settings
    sensitivity: 'medium',
    adaptiveThreshold: true,
    audioEnabled: true,
  };

  // --- Modules ---

  let blueFilter, peakDetector, blobDetector, geometryMatcher, pnpSolver, tracker, feedback;

  // --- DOM Elements ---

  const $ = id => document.getElementById(id);
  const video = $('video');
  const glCanvas = $('gl-canvas');
  const overlay = $('overlay');
  const overlayCtx = overlay.getContext('2d');

  const startScreen = $('start-screen');
  const btnStart = $('btn-start');
  const btnSettings = $('btn-settings');
  const btnStop = $('btn-stop');
  const btnReset = $('btn-reset');
  const settingsDrawer = $('settings-drawer');
  const drawerHandle = $('drawer-handle');

  const cfgThreshold = $('cfg-threshold');
  const cfgBrightness = $('cfg-brightness');
  const cfgAdaptive = $('cfg-adaptive');
  const cfgAudio = $('cfg-audio');
  const valThreshold = $('val-threshold');
  const valBrightness = $('val-brightness');

  // HSV controls
  const cfgHue = $('cfg-hue');
  const cfgHueRange = $('cfg-hue-range');
  const cfgSat = $('cfg-sat');
  const valHue = $('val-hue');
  const valHueRange = $('val-hue-range');
  const valSat = $('val-sat');

  const cfgFx = $('cfg-fx');
  const cfgFy = $('cfg-fy');
  const cfgCx = $('cfg-cx');
  const cfgCy = $('cfg-cy');

  // --- Initialize modules ---

  function initModules() {
    blueFilter = new BlueFilter(glCanvas);
    blueFilter.init();

    peakDetector = new PeakDetector({
      nmsRadius: 5,
      minPeakScore: 80,
      minPointiness: 1.15,
      minIsotropy: 0.3,
      maxCandidates: 20,
      minBrightness: 80
    });

    blobDetector = new BlobDetector({
      minArea: 2,
      maxArea: 300,
      maxAspectRatio: 2.5
    });

    geometryMatcher = new GeometryMatcher();

    pnpSolver = new PnPSolver();

    tracker = new LEDTracker({
      processNoise: 0.005,
      measurementNoise: 0.5,
      maxLostFrames: 3,
      minTrackingFeatures: 4
    });

    feedback = new FeedbackManager();
  }

  // --- Camera ---

  async function startCamera() {
    try {
      // Request rear camera at high resolution
      const constraints = {
        video: {
          facingMode: 'environment',
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          focusMode: 'continuous'
        },
        audio: false
      };

      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (e) {
        // Fallback to basic constraints
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      state.stream = stream;
      video.srcObject = stream;
      await video.play();

      // Wait for video dimensions to be available
      await new Promise(resolve => {
        if (video.videoWidth > 0) return resolve();
        video.addEventListener('loadedmetadata', resolve, { once: true });
      });

      let vw = video.videoWidth;
      let vh = video.videoHeight;
      console.log(`Camera initial: ${vw}x${vh}`);

      // Try to upgrade resolution via applyConstraints
      const track = state.stream.getVideoTracks()[0];
      if (track) {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        try {
          const maxW = caps.width ? caps.width.max : 1920;
          const maxH = caps.height ? caps.height.max : 1080;
          const targetW = Math.min(maxW, 1920);
          const targetH = Math.min(maxH, 1080);
          await track.applyConstraints({
            width: { ideal: targetW },
            height: { ideal: targetH }
          });
          // Wait for resolution to update
          await new Promise(r => setTimeout(r, 300));
          vw = video.videoWidth;
          vh = video.videoHeight;
          console.log(`Camera upgraded: ${vw}x${vh} (max: ${maxW}x${maxH})`);
        } catch (e) {
          console.warn('applyConstraints failed:', e);
        }

        // Apply camera settings directly (not via { advanced: [...] } which is silently ignored on mobile Chrome)
        if (caps.focusMode) {
          try {
            await track.applyConstraints({ focusMode: 'continuous' });
            state.focusStatus = 'continuous';
            console.log('focusMode: continuous applied');
          } catch (e) {
            console.warn('focusMode failed:', e.message);
            state.focusStatus = 'failed';
          }
        } else {
          state.focusStatus = 'unsupported';
          console.log('focusMode not in capabilities');
        }
        if (caps.exposureMode) {
          try { await track.applyConstraints({ exposureMode: 'continuous' }); } catch (e) {}
        }
        if (caps.whiteBalanceMode) {
          try { await track.applyConstraints({ whiteBalanceMode: 'continuous' }); } catch (e) {}
        }
      }

      state.resolution = `${vw}x${vh}`;

      // Setup offscreen canvas for full-res pixel access
      state.offscreen = document.createElement('canvas');
      state.offscreen.width = vw;
      state.offscreen.height = vh;
      state.offCtx = state.offscreen.getContext('2d', { willReadFrequently: true });

      // Setup overlay canvas dimensions
      resizeOverlay();

      // Estimate camera intrinsics
      pnpSolver.estimateIntrinsics(vw, vh);

      // Apply custom intrinsics if set
      applyCustomIntrinsics();

      // Try fullscreen
      tryFullscreen();

      // Show UI
      startScreen.classList.add('hidden');
      btnSettings.classList.remove('hidden');

      // Initialize audio on user gesture
      feedback.initAudio();

      // Start processing
      state.running = true;
      state.detectionState = 'scanning';
      feedback.setState('scanning');
      state.lastFpsTime = performance.now();

      requestNextFrame();

    } catch (err) {
      console.error('Camera error:', err);
      alert('Unable to access camera: ' + err.message);
    }
  }

  function stopCamera() {
    state.running = false;

    if (state.animFrameId) {
      cancelAnimationFrame(state.animFrameId);
      state.animFrameId = null;
    }

    if (state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null;
    }

    video.srcObject = null;
    tracker.reset();
    state.detectionState = 'idle';
    feedback.setState('idle');

    // Show start screen
    startScreen.classList.remove('hidden');
    btnSettings.classList.add('hidden');
    settingsDrawer.classList.add('hidden');

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function tryFullscreen() {
    const el = document.documentElement;
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  }

  function resizeOverlay() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    overlay.width = w * dpr;
    overlay.height = h * dpr;
    overlay.style.width = w + 'px';
    overlay.style.height = h + 'px';
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- Main Processing Loop ---

  function requestNextFrame() {
    if (!state.running) return;

    if (video.requestVideoFrameCallback) {
      video.requestVideoFrameCallback(processFrame);
    } else {
      state.animFrameId = requestAnimationFrame(processFrame);
    }
  }

  function processFrame(now) {
    if (!state.running) return;

    // FPS tracking
    state.frameCount++;
    if (now - state.lastFpsTime >= 1000) {
      state.fps = state.frameCount;
      state.frameCount = 0;
      state.lastFpsTime = now;
    }

    // Step 1: Run WebGL blue filter
    let filterResult = null;
    try {
      filterResult = blueFilter.process(video, 3);
    } catch (e) {
      if (state.frameCount === 1) console.error('BlueFilter error:', e);
    }

    if (filterResult) {
      // 記錄 downscale 值供自適應 NMS 使用
      state.lastDownscale = filterResult.downscale;

      // Step 2a: 峰值檢測（主要策略 — 能從連通藍色區域中提取 LED 局部峰值）
      const peaks = peakDetector.detect(
        filterResult.mask,
        filterResult.brightnessValues,
        filterResult.blueDiffValues,
        filterResult.width,
        filterResult.height,
        filterResult.downscale,
        filterResult.bluePixels
      );

      // Step 2b: Blob 檢測（回退策略 — 適用於 LED 獨立分離的情況）
      const blobs = blobDetector.detect(
        filterResult.mask,
        filterResult.width,
        filterResult.height,
        filterResult.blueDiffValues,
        filterResult.downscale,
        filterResult.brightnessValues
      );

      // Step 2c: 燈條偵測 (NEW)
      const stripBlobs = blobDetector.detectStrips(
        filterResult.mask,
        filterResult.width,
        filterResult.height,
        filterResult.blueDiffValues,
        filterResult.downscale,
        filterResult.brightnessValues
      );

      // Extract strip edge midpoints
      for (const strip of stripBlobs) {
        blobDetector.extractStripEdges(strip, filterResult.mask, filterResult.width, filterResult.height, filterResult.brightnessValues);
      }

      // Track peak count for debug HUD
      state.lastPeakCount = peaks.length;

      // Step 2d: 合併兩種策略的候選
      const candidates = mergeCandidates(peaks, blobs);

      // Step 3: Run detection pipeline based on state
      processDetection(candidates, stripBlobs, filterResult);

      // Debug logging (every 2 seconds)
      if (state.frameCount === 1) {
        const maskSum = filterResult.mask.reduce((s, v) => s + (v > 0 ? 1 : 0), 0);
        console.log(`[debug] filter: ${filterResult.width}x${filterResult.height}, mask白點: ${maskSum}, peaks: ${peaks.length}, blobs: ${blobs.length}, strips: ${stripBlobs.length}, 候選: ${candidates.length}, 閾值: ${blueFilter.threshold.toFixed(3)}`);
        // 峰值診斷資訊
        if (peaks.length > 0) {
          const topPeak = peaks[0];
          console.log(`[peak] top: score=${topPeak.peakScore.toFixed(1)}, pointiness=${topPeak.pointiness.toFixed(2)}, isotropy=${topPeak.isotropy.toFixed(2)}, pos=(${topPeak.x.toFixed(3)},${topPeak.y.toFixed(3)})`);
        }
      }
    } else if (state.frameCount === 1) {
      console.warn('[debug] blueFilter.process returned null, video.readyState:', video.readyState);
    }

    // Step 4: Draw visual feedback (clears canvas first)
    const displayW = window.innerWidth;
    const displayH = window.innerHeight;

    if (state.maskMode === 'only' && filterResult) {
      // "Only blue" mode: show blue mask on black background, skip normal feedback
      drawMaskFullscreen(filterResult);
    } else {
      feedback.draw(overlayCtx, displayW, displayH, getDrawData());

      // Draw mask overlay AFTER feedback (so it's not cleared)
      if (state.maskMode === 'overlay' && filterResult) {
        drawMaskOverlay(filterResult);
      }
    }

    requestNextFrame();
  }

  /**
   * 合併峰值檢測和 blob 檢測的候選。
   * 以峰值為主,補充距離所有峰值 > 2% 的 blob。
   */
  function mergeCandidates(peaks, blobs) {
    // 以峰值為主
    const merged = [...peaks];

    // 補充不與任何峰值重疊的 blob
    const minSeparation = 0.02; // 2% 圖像尺寸
    for (const blob of blobs) {
      let tooClose = false;
      for (const peak of merged) {
        const dx = blob.x - peak.x;
        const dy = blob.y - peak.y;
        if (Math.sqrt(dx * dx + dy * dy) < minSeparation) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        merged.push(blob);
      }
    }

    // 按複合分數排序,取 top 20
    // 注意：峰值候選用 realBrightness/brightness,blob 候選用 maxRealBrightness/maxBrightness
    merged.sort((a, b) => {
      const realBrightA = a.maxRealBrightness || a.realBrightness || 0;
      const blueDiffA = a.maxBrightness || a.brightness || 0;
      const sa = realBrightA * 0.5 + blueDiffA * 0.5;

      const realBrightB = b.maxRealBrightness || b.realBrightness || 0;
      const blueDiffB = b.maxBrightness || b.brightness || 0;
      const sb = realBrightB * 0.5 + blueDiffB * 0.5;
      return sb - sa;
    });

    return merged.slice(0, 20);
  }

  function processDetection(blobs, stripBlobs, filterResult) {
    // Tracking mode: try to match detected blobs to tracked positions
    if (state.detectionState === 'tracking' && tracker.isTracking) {
      const predictions = tracker.getPredictions();
      const matched = matchBlobsToPredictions(blobs, stripBlobs, predictions);

      if (matched.length >= 4) {
        const trackResult = tracker.update(matched);

        if (trackResult.isTracking) {
          // Re-match to get full 2D-3D correspondences
          solvePoseFromTracked(trackResult.tracked);
          return;
        }
      }

      // Tracking failed - fall back
      const lostResult = tracker.update([]);
      if (!lostResult.isTracking) {
        state.detectionState = 'scanning';
        feedback.setState('scanning');
      }
      return;
    }

    // Full detection mode
    const ledCount = blobs.length;
    const stripCount = stripBlobs ? stripBlobs.length : 0;
    const extractedEdges = stripBlobs ? stripBlobs.reduce((count, s) =>
      count + (s.edgeLeft ? 1 : 0) + (s.edgeRight ? 1 : 0), 0
    ) : 0;
    const totalFeatures = ledCount + extractedEdges; // actual extracted edge points
    state.lastCandidateCount = ledCount;
    state.lastStripCount = stripCount;

    if (totalFeatures < 4) {
      state.detectionState = 'scanning';
      feedback.setState('scanning', { candidateCount: ledCount, stripCount });
      return;
    }

    // Quick check for promising detection
    const quick = geometryMatcher.quickCheck(blobs, stripBlobs);
    if (quick.promising) {
      feedback.setState('candidate', {
        candidateCount: ledCount,
        stripCount,
        info: quick.info
      });
    }

    // Full geometry matching (NEW: pass both LED candidates and strip blobs)
    const imageAspect = video.videoWidth / video.videoHeight;
    const match = geometryMatcher.match(blobs, stripBlobs, imageAspect);

    if (match && match.success) {
      // Build tracked points with feature IDs for the tracker
      const detectedPoints = [];
      for (let i = 0; i < match.featureIds.length; i++) {
        detectedPoints.push({
          id: match.featureIds[i],
          x: match.points2D[i].x,
          y: match.points2D[i].y
        });
      }

      // Initialize tracker with matched points
      tracker.reset();
      const trackResult = tracker.update(detectedPoints);

      state.detectionState = 'locked';
      feedback.setState('locked', { candidateCount: ledCount, stripCount });

      // Solve pose using the 2D-3D correspondences directly from the matcher
      solvePoseFromMatch(match, trackResult.stability);

      // Transition to tracking mode
      state.detectionState = 'tracking';
      feedback.setState('tracking', { candidateCount: ledCount, stripCount });
    } else {
      if (quick.promising) {
        state.detectionState = 'candidate';
      } else {
        state.detectionState = 'scanning';
        feedback.setState('scanning', { candidateCount: ledCount, stripCount });
      }
    }
  }

  function matchBlobsToPredictions(blobs, stripBlobs, predictions) {
    const matched = [];
    const usedBlobs = new Set();
    const usedStrips = new Set();

    for (const pred of predictions) {
      const isStripEdge = pred.id.startsWith('S') && pred.id.includes('_');

      if (isStripEdge) {
        // Match against strip blobs (using strip center + edge positions)
        // Strip edges are harder to track individually; use strip centers with larger window
        let bestDist = Infinity;
        let bestIdx = -1;

        for (let i = 0; i < (stripBlobs || []).length; i++) {
          if (usedStrips.has(i)) continue;
          const strip = stripBlobs[i];
          // Check against the appropriate edge
          const isLeft = pred.id.endsWith('_L');
          const edgePt = isLeft ? strip.edgeLeft : strip.edgeRight;
          if (!edgePt) continue;

          const dx = edgePt.nx - pred.x;
          const dy = edgePt.ny - pred.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 0.08 && dist < bestDist) { // Larger window for strips
            bestDist = dist;
            bestIdx = i;
          }
        }

        if (bestIdx >= 0) {
          const strip = stripBlobs[bestIdx];
          const isLeft = pred.id.endsWith('_L');
          const edgePt = isLeft ? strip.edgeLeft : strip.edgeRight;
          // Don't mark strip as used — same strip has left AND right edges
          matched.push({ id: pred.id, x: edgePt.nx, y: edgePt.ny });
        }
      } else {
        // Match against LED blobs (original logic)
        let bestDist = Infinity;
        let bestIdx = -1;

        for (let i = 0; i < blobs.length; i++) {
          if (usedBlobs.has(i)) continue;
          const dx = blobs[i].x - pred.x;
          const dy = blobs[i].y - pred.y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 0.05 && dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
          }
        }

        if (bestIdx >= 0) {
          usedBlobs.add(bestIdx);
          matched.push({ id: pred.id, x: blobs[bestIdx].x, y: blobs[bestIdx].y });
        }
      }
    }

    return matched;
  }

  function refinePositions(points) {
    if (!state.offCtx || !state.offscreen) return points;

    // Draw current video frame to offscreen canvas
    state.offCtx.drawImage(video, 0, 0, state.offscreen.width, state.offscreen.height);

    // Only refine LED points (not strip edges)
    const refined = [];
    const ledPoints = [];

    for (const p of points) {
      // Check if this is a LED point (not a strip edge)
      const isStripEdge = p.id && p.id.startsWith('S') && p.id.includes('_');

      if (isStripEdge) {
        // Skip refinement for strip edges
        refined.push(p);
      } else {
        // Collect LED points for batch refinement
        ledPoints.push(p);
      }
    }

    // Refine LED points if any
    if (ledPoints.length > 0) {
      const refinedLEDs = blobDetector.refinePositions(
        ledPoints,
        state.offCtx,
        state.offscreen.width,
        state.offscreen.height,
        16
      );
      refined.push(...refinedLEDs);
    }

    return refined;
  }

  // --- Pose Computation ---

  let lastPose = null;
  let poseStability = 0;

  function solvePoseFromMatch(match, stability) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const objectPoints = match.points3D; // already {x, y, z} in mm
    const imagePoints = match.points2D.map(p => normalizedToPixel(p.x, p.y, vw, vh));

    if (objectPoints.length < 4) return;

    const result = pnpSolver.solve(objectPoints, imagePoints);

    if (result.success && result.reprojError < 30) {
      lastPose = result;
      poseStability = poseStability * 0.8 + stability * 0.2;

      // Adaptive peak detector feedback
      if (peakDetector && result.distance > 0) {
        const distanceMM = result.distance * 1000;
        const ledDiameterMM = 6; // Updated from 5mm to 6mm per dimension diagram
        const ds = state.lastDownscale || 4;
        const expectedPixels = (ledDiameterMM / distanceMM) * pnpSolver.fx / ds;
        peakDetector.setExpectedLEDSize(expectedPixels);
      }
    }
  }

  function solvePoseFromTracked(trackedPoints) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    const objectPoints = [];
    const imagePoints = [];

    for (const p of trackedPoints) {
      // Look up 3D position from DEVICE_GEOMETRY
      let point3D = null;

      // Check if it's a LED
      const led = DEVICE_GEOMETRY.leds.find(l => l.id === p.id);
      if (led) {
        point3D = { x: led.x, y: led.y, z: led.z };
      }

      // Check if it's a strip edge
      if (!point3D) {
        const edge = DEVICE_GEOMETRY.stripEdges.find(e => e.id === p.id);
        if (edge) {
          point3D = { x: edge.x, y: edge.y, z: edge.z };
        }
      }

      if (!point3D) continue;

      objectPoints.push(point3D);
      imagePoints.push(normalizedToPixel(p.x, p.y, vw, vh));
    }

    if (objectPoints.length < 4) return;

    const result = pnpSolver.solve(objectPoints, imagePoints);

    if (result.success && result.reprojError < 30) {
      lastPose = result;
      // Keep the existing poseStability smoothing

      // Adaptive peak detector feedback
      if (peakDetector && result.distance > 0) {
        const distanceMM = result.distance * 1000;
        const ledDiameterMM = 6;
        const ds = state.lastDownscale || 4;
        const expectedPixels = (ledDiameterMM / distanceMM) * pnpSolver.fx / ds;
        peakDetector.setExpectedLEDSize(expectedPixels);
      }
    }
  }

  /**
   * Convert normalized overlay coordinates (0-1) to video pixel coordinates,
   * accounting for object-fit: cover cropping.
   */
  function normalizedToPixel(nx, ny, vw, vh) {
    const displayW = window.innerWidth;
    const displayH = window.innerHeight;

    // Compute how object-fit: cover maps the video
    const videoAspect = vw / vh;
    const displayAspect = displayW / displayH;

    let srcX, srcY;

    if (videoAspect > displayAspect) {
      // Video is wider - horizontal crop
      const scale = displayH / vh;
      const visibleWidth = displayW / scale;
      const offsetX = (vw - visibleWidth) / 2;
      srcX = offsetX + nx * visibleWidth;
      srcY = ny * vh;
    } else {
      // Video is taller - vertical crop
      const scale = displayW / vw;
      const visibleHeight = displayH / scale;
      const offsetY = (vh - visibleHeight) / 2;
      srcX = nx * vw;
      srcY = offsetY + ny * visibleHeight;
    }

    return { x: srcX, y: srcY };
  }

  // --- Draw helpers ---

  function getDrawData() {
    const data = {
      fps: state.fps,
      candidateCount: state.lastCandidateCount || 0,
      stripCount: state.lastStripCount || 0,
      resolution: state.resolution || null,
      threshold: blueFilter ? blueFilter.threshold : 0,
      version: APP_VERSION,
      // Debug info for mobile HUD
      focusStatus: state.focusStatus || 'unknown',
      maskPercent: filterResult ? (filterResult.bluePixels.length / (filterResult.width * filterResult.height) * 100) : 0,
      peakCount: state.lastPeakCount || 0,
      maxCandidates: 20
    };

    if (lastPose && (state.detectionState === 'locked' || state.detectionState === 'tracking')) {
      data.distance = lastPose.distance;
      data.euler = lastPose.euler;
      data.position = lastPose.tvec;
      data.stability = poseStability;
      data.pose = lastPose;

      // Get tracked points for drawing
      const predictions = tracker.getPredictions();
      if (predictions.length > 0) {
        data.points = predictions;
      }
    }

    return data;
  }

  /**
   * Compute object-fit:cover mapping from mask coords to display coords.
   * The mask is at video resolution / downscale, so it maps 1:1 to video space.
   * The video is displayed with object-fit:cover, which may crop edges.
   */
  function getMaskDisplayRect(maskW, maskH) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const displayW = window.innerWidth;
    const displayH = window.innerHeight;

    const videoAspect = vw / vh;
    const displayAspect = displayW / displayH;

    let drawX, drawY, drawW, drawH;

    if (videoAspect > displayAspect) {
      // Video wider than display - horizontal crop
      drawH = displayH;
      drawW = displayH * videoAspect;
      drawX = (displayW - drawW) / 2;
      drawY = 0;
    } else {
      // Video taller than display - vertical crop
      drawW = displayW;
      drawH = displayW / videoAspect;
      drawX = 0;
      drawY = (displayH - drawH) / 2;
    }

    return { drawX, drawY, drawW, drawH };
  }

  function drawMaskOverlay(filterResult) {
    if (!filterResult) return;
    const { mask, blueDiffValues, width, height } = filterResult;

    // Create a small canvas to hold the mask
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = width;
    tmpCanvas.height = height;
    const tmpCtx = tmpCanvas.getContext('2d');
    const imgData = tmpCtx.createImageData(width, height);

    for (let i = 0; i < width * height; i++) {
      const val = mask[i];
      const strength = blueDiffValues ? blueDiffValues[i] : val;
      imgData.data[i * 4] = 0;                    // R
      imgData.data[i * 4 + 1] = 0;                // G
      imgData.data[i * 4 + 2] = val > 0 ? 255 : 0; // B
      imgData.data[i * 4 + 3] = val > 0 ? Math.min(200, strength + 80) : 0; // A
    }

    tmpCtx.putImageData(imgData, 0, 0);

    // Draw with object-fit:cover alignment
    const rect = getMaskDisplayRect(width, height);
    overlayCtx.save();
    overlayCtx.globalAlpha = 0.6;
    overlayCtx.imageSmoothingEnabled = false;
    overlayCtx.drawImage(tmpCanvas, rect.drawX, rect.drawY, rect.drawW, rect.drawH);
    overlayCtx.restore();
  }

  function drawMaskFullscreen(filterResult) {
    if (!filterResult) return;
    const { mask, blueDiffValues, width, height } = filterResult;
    const displayW = window.innerWidth;
    const displayH = window.innerHeight;

    // Black background
    overlayCtx.clearRect(0, 0, displayW, displayH);
    overlayCtx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    overlayCtx.fillRect(0, 0, displayW, displayH);

    // Create mask image
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = width;
    tmpCanvas.height = height;
    const tmpCtx = tmpCanvas.getContext('2d');
    const imgData = tmpCtx.createImageData(width, height);

    for (let i = 0; i < width * height; i++) {
      const val = mask[i];
      const strength = blueDiffValues ? blueDiffValues[i] : 255;
      if (val > 0) {
        // Blue bright spots
        imgData.data[i * 4] = Math.min(255, strength);       // R (slight)
        imgData.data[i * 4 + 1] = Math.min(255, strength);   // G (slight)
        imgData.data[i * 4 + 2] = 255;                        // B (full)
        imgData.data[i * 4 + 3] = 255;                        // A
      } else {
        imgData.data[i * 4 + 3] = 0; // Transparent (show black bg)
      }
    }

    tmpCtx.putImageData(imgData, 0, 0);

    // Draw with object-fit:cover alignment (crisp pixels for debug mask)
    const rect = getMaskDisplayRect(width, height);
    overlayCtx.imageSmoothingEnabled = false;
    overlayCtx.drawImage(tmpCanvas, rect.drawX, rect.drawY, rect.drawW, rect.drawH);
    overlayCtx.imageSmoothingEnabled = true;

    // Still draw HUD info on top
    feedback.draw(overlayCtx, displayW, displayH, getDrawData(), true);
  }

  // --- Settings ---

  function applyCustomIntrinsics() {
    const fx = parseFloat(cfgFx.value);
    const fy = parseFloat(cfgFy.value);
    const cx = parseFloat(cfgCx.value);
    const cy = parseFloat(cfgCy.value);

    if (fx > 0 && fy > 0 && cx > 0 && cy > 0) {
      pnpSolver.setIntrinsics(fx, fy, cx, cy);
    }
  }

  function setupEventListeners() {
    // Start button
    btnStart.addEventListener('click', () => {
      startCamera();
    });

    // Stop button
    btnStop.addEventListener('click', () => {
      stopCamera();
    });

    // Reset tracking
    btnReset.addEventListener('click', () => {
      tracker.reset();
      lastPose = null;
      poseStability = 0;
      state.detectionState = 'scanning';
      feedback.setState('scanning');
    });

    // Settings drawer toggle
    btnSettings.addEventListener('click', () => {
      settingsDrawer.classList.toggle('hidden');
    });

    drawerHandle.addEventListener('click', () => {
      settingsDrawer.classList.add('hidden');
    });

    // Sensitivity buttons
    document.querySelectorAll('[data-sensitivity]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-sensitivity]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.sensitivity = btn.dataset.sensitivity;

        // Map old sensitivity names to new
        const sensitivityMap = { low: 'strict', medium: 'normal', high: 'relaxed' };
        geometryMatcher.setSensitivity(sensitivityMap[state.sensitivity] || 'normal');
      });
    });

    // Threshold slider
    cfgThreshold.addEventListener('input', () => {
      const val = parseFloat(cfgThreshold.value);
      valThreshold.textContent = val.toFixed(2);
      if (blueFilter) {
        blueFilter.setThreshold(val);
        blueFilter.adaptiveEnabled = false;
        cfgAdaptive.checked = false;
      }
    });

    // Brightness slider
    cfgBrightness.addEventListener('input', () => {
      const val = parseFloat(cfgBrightness.value);
      valBrightness.textContent = val.toFixed(2);
      if (blueFilter) blueFilter.setBrightnessFloor(val);
    });

    // Adaptive threshold toggle
    cfgAdaptive.addEventListener('change', () => {
      state.adaptiveThreshold = cfgAdaptive.checked;
      if (blueFilter) blueFilter.adaptiveEnabled = cfgAdaptive.checked;
    });

    // Audio toggle
    cfgAudio.addEventListener('change', () => {
      state.audioEnabled = cfgAudio.checked;
      if (feedback) feedback.audioEnabled = cfgAudio.checked;
    });

    // Mask view mode buttons
    document.querySelectorAll('[data-mask]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-mask]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.maskMode = btn.dataset.mask;
        // Toggle video visibility for "only" mode
        video.style.opacity = (state.maskMode === 'only') ? '0' : '1';
      });
    });

    // HSV Hue Center
    cfgHue.addEventListener('input', () => {
      const deg = parseFloat(cfgHue.value);
      valHue.textContent = deg + '°';
      if (blueFilter) blueFilter.setHueCenter(deg / 360);
    });

    // HSV Hue Range
    cfgHueRange.addEventListener('input', () => {
      const deg = parseFloat(cfgHueRange.value);
      valHueRange.textContent = '±' + deg + '°';
      if (blueFilter) blueFilter.setHueRange(deg / 360);
    });

    // HSV Saturation Min
    cfgSat.addEventListener('input', () => {
      const val = parseFloat(cfgSat.value);
      valSat.textContent = val.toFixed(2);
      if (blueFilter) blueFilter.setSatMin(val);
    });

    // Camera intrinsics
    [cfgFx, cfgFy, cfgCx, cfgCy].forEach(input => {
      input.addEventListener('change', applyCustomIntrinsics);
    });

    // Handle window resize
    window.addEventListener('resize', () => {
      if (state.running) resizeOverlay();
    });

    // Handle orientation change
    window.addEventListener('orientationchange', () => {
      setTimeout(() => {
        if (state.running) resizeOverlay();
      }, 200);
    });
  }

  // --- Initialize ---

  function init() {
    initModules();
    setupEventListeners();
    // Set version on start screen
    const versionHint = document.getElementById('version-hint');
    if (versionHint) versionHint.textContent = `v${APP_VERSION} - 無需 OpenCV`;

    console.log(`WebTag 6DoF Locator v${APP_VERSION} initialized (no OpenCV)`);
  }

  // Run on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
