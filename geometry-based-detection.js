// ===================================================================
// 基於幾何結構的5-LED檢測系統
// 核心理念：從結構而非數量來識別LED設備
// ===================================================================

/**
 * 主檢測函數：基於幾何結構的候選點篩選
 *
 * 工作流程：
 * 1. 檢測所有藍色候選點（ROI限制 + Top-10篩選）
 * 2. 顯示所有候選點（灰色標記）
 * 3. 從候選點中找出符合5-LED幾何結構的組合
 * 4. 只高亮符合結構的5個點
 * 5. 對匹配的5個點進行PnP求解
 *
 * @param {Object} options - 可選配置參數
 * @param {string} options.envMode - 環境模式: 'dark'|'normal'|'bright'
 */
function geometryBasedDetect(offCtx, crop, offscreen, options = {}) {
  // 環境參數配置
  const envMode = options.envMode || 'normal';
  window._detectionEnvMode = envMode;  // 傳遞給檢測函數

  // ===== 階段1: 檢測所有藍色候選點 =====
  console.log(`[幾何檢測] 環境模式: ${envMode}`);
  const imgData = offCtx.getImageData(crop.sx, crop.sy, crop.sw, crop.sh);
  const candidates = detectBlueCandidates(imgData, crop, offscreen);

  console.log(`[階段1] 檢測到 ${candidates.length} 個藍色候選點`);

  // 顯示所有候選點（灰色）
  const allPoints = candidates.map(p => ({
    x: p.x,
    y: p.y,
    isCandidate: true,  // 標記為候選點，繪製時用灰色
    area: p.area
  }));

  if (candidates.length < 5) {
    return {
      success: false,
      error: `候選點不足：只找到 ${candidates.length} 個（需要至少5個）`,
      candidates: allPoints
    };
  }

  // ===== 階段2: 幾何結構匹配 =====
  console.log(`[階段2] 開始幾何結構匹配...`);
  const matched = findBest5LEDConfiguration(candidates);

  if (!matched) {
    return {
      success: false,
      error: `幾何結構不匹配：在 ${candidates.length} 個候選點中找不到符合5-LED結構的組合`,
      candidates: allPoints
    };
  }

  console.log(`[階段2] 匹配成功！評分: ${matched.score.toFixed(2)}`);

  // ===== 階段3: 返回匹配的5個點 =====
  return {
    success: true,
    points: matched.points,
    metrics: matched.metrics,
    score: matched.score,
    candidates: allPoints,  // 保留所有候選點用於診斷顯示
    totalCandidates: candidates.length
  };
}

/**
 * 檢測所有藍色候選點
 * 方案3優化：固定參數 + ROI限制 + Top-N篩選 + 增強濾波
 */
function detectBlueCandidates(imgData, crop, offscreen) {
  const srcMat = cv.matFromImageData(imgData);
  const candidates = [];

  try {
    // ===== 優化1: ROI中心限制（放寬到90%）=====
    const roiScale = 0.90;  // 放寬從70%到90%
    const roiW = Math.round(crop.sw * roiScale);
    const roiH = Math.round(crop.sh * roiScale);
    const roiX = Math.round((crop.sw - roiW) / 2);
    const roiY = Math.round((crop.sh - roiH) / 2);

    const roi = srcMat.roi(new cv.Rect(roiX, roiY, roiW, roiH));

    console.log(`ROI限制: ${roiW}×${roiH} (中心${Math.round(roiScale*100)}%)`);

    // ===== 優化2: 藍光差分（固定閾值）=====
    const channels = new cv.MatVector();
    cv.split(roi, channels);
    const B = channels.get(2);
    const G = channels.get(1);
    const R = channels.get(0);

    const RG_sum = new cv.Mat();
    cv.add(R, G, RG_sum);
    const RG_avg = new cv.Mat();
    RG_sum.convertTo(RG_avg, cv.CV_8U, 0.5);

    const blueDiff = new cv.Mat();
    cv.subtract(B, RG_avg, blueDiff);

    // 根據環境模式選擇閾值（放寬）
    const envMode = window._detectionEnvMode || 'normal';
    const thresholds = {
      dark: 25,     // 暗環境（降低從35到25）
      normal: 30,   // 正常室內（降低從40到30）
      bright: 40    // 明亮環境（降低從50到40）
    };
    const thresh = thresholds[envMode] || 30;
    console.log(`⚙️ 藍光差分閾值: ${thresh} (${envMode}模式)`);

    // 計算平均亮度用於診斷
    const meanVal = cv.mean(blueDiff)[0];
    console.log(`藍光差分平均值: ${meanVal.toFixed(1)}`);

    // 二值化
    const mask = new cv.Mat();
    cv.threshold(blueDiff, mask, thresh, 255, cv.THRESH_BINARY);

    // ===== 優化3: 增強形態學濾波（5×5 kernel）=====
    const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);   // 去除小雜點
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);  // 填充孔洞
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);   // 再次平滑

    // 輪廓檢測
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    console.log(`ROI內找到 ${contours.size()} 個輪廓`);

    const centerX = roiW / 2;
    const centerY = roiH / 2;

    // 收集所有候選點（含亮度信息）
    for (let i = 0; i < contours.size(); i++) {
      const cnt = contours.get(i);
      const area = cv.contourArea(cnt);

      // 面積過濾（放寬到5-1000 px²）
      if (area < 5 || area > 1000) continue;

      const m = cv.moments(cnt);
      if (m.m00 === 0) continue;

      // 質心計算（亞像素精度）
      const cx = m.m10 / m.m00;
      const cy = m.m01 / m.m00;

      // 圓度計算
      const peri = cv.arcLength(cnt, true);
      const circularity = peri === 0 ? 0 : (4 * Math.PI * area) / (peri * peri);

      // 大幅放寬圓度要求（從0.20降到0.15）
      if (circularity < 0.15) continue;

      // 計算該點的藍光差分亮度（用於Top-N排序）
      const px = Math.round(cx);
      const py = Math.round(cy);
      const brightness = (px >= 0 && px < roiW && py >= 0 && py < roiH)
        ? blueDiff.data[py * roiW + px]
        : 0;

      const dist = Math.hypot(cx - centerX, cy - centerY);

      candidates.push({
        x: (cx + roiX + crop.sx) / offscreen.width,  // 轉換回原始座標
        y: (cy + roiY + crop.sy) / offscreen.height,
        area: area,
        circularity: circularity,
        dist: dist,
        brightness: brightness  // 新增亮度信息
      });
    }

    // ===== 優化4: Top-N最亮點篩選 =====
    // 先按亮度排序，取Top-15（增加從10）
    candidates.sort((a, b) => b.brightness - a.brightness);
    const topN = candidates.slice(0, 15);

    console.log(`✨ Top-15最亮點篩選完成 (從 ${candidates.length} 個候選點)`);

    // 輸出Top-5的亮度信息
    if (topN.length > 0) {
      const top5 = topN.slice(0, 5).map((c, i) =>
        `#${i+1}:${c.brightness.toFixed(0)}`
      ).join(', ');
      console.log(`💡 Top-5亮度: ${top5}`);

    // 清理
    R.delete(); G.delete(); B.delete();
    RG_sum.delete(); RG_avg.delete();
    blueDiff.delete(); mask.delete();
    kernel.delete(); contours.delete();
    hierarchy.delete(); channels.delete();
    roi.delete();

  } finally {
    srcMat.delete();
  }

  // 返回Top-N點（按亮度已排序）
  return topN;
}

/**
 * 從候選點中找出最佳的5-LED配置
 * 使用幾何驗證 + PnP評分
 */
function findBest5LEDConfiguration(candidates) {
  if (candidates.length < 5) return null;

  // 限制在前15個最大的候選點
  const topCandidates = candidates.slice(0, Math.min(15, candidates.length));

  let bestMatch = null;
  let bestScore = Infinity;

  // 限制組合數量避免卡死
  const maxCombinations = 300;
  let combinationCount = 0;
  let validGeometryCount = 0;

  console.log(`開始測試組合，候選點: ${topCandidates.length}`);

  // 遍歷所有可能的5點組合
  for (let a = 0; a < topCandidates.length && combinationCount < maxCombinations; a++) {
    for (let b = a + 1; b < topCandidates.length && combinationCount < maxCombinations; b++) {
      for (let c = b + 1; c < topCandidates.length && combinationCount < maxCombinations; c++) {
        for (let d = c + 1; d < topCandidates.length && combinationCount < maxCombinations; d++) {
          for (let e = d + 1; e < topCandidates.length && combinationCount < maxCombinations; e++) {
            combinationCount++;

            const set = [
              topCandidates[a],
              topCandidates[b],
              topCandidates[c],
              topCandidates[d],
              topCandidates[e]
            ];

            // 幾何驗證
            const geometry = verify5LEDGeometry(set);
            if (!geometry.valid) continue;

            validGeometryCount++;

            // PnP驗證（快速檢查）
            const pnpScore = quickPnPScore(geometry.orderedPoints);
            if (!pnpScore.ok || pnpScore.z === null || pnpScore.z <= 0) continue;

            // 綜合評分
            const totalScore = pnpScore.error + geometry.geometryError * 5;

            if (totalScore < bestScore) {
              bestScore = totalScore;
              bestMatch = {
                points: geometry.orderedPoints,
                metrics: geometry.metrics,
                score: totalScore,
                pnpError: pnpScore.error,
                geometryError: geometry.geometryError
              };
            }
          }
        }
      }
    }
  }

  console.log(`測試了 ${combinationCount} 種組合，其中 ${validGeometryCount} 個通過幾何驗證`);
  if (bestMatch) {
    console.log(`最佳匹配評分: ${bestScore.toFixed(2)} (PnP: ${bestMatch.pnpError.toFixed(2)}, 幾何: ${bestMatch.geometryError.toFixed(3)})`);
  }

  return bestMatch;
}

/**
 * 驗證5個點是否符合LED幾何結構
 *
 * 預期結構：
 * - 4個點形成矩形（LED 1-4）
 * - 1個點在矩形上方中央（LED 5，突出點）
 */
function verify5LEDGeometry(points) {
  // Step 1: 找出最上方的點（Y座標最小）→ LED5
  let topPoint = points.reduce((min, p) => p.y < min.y ? p : min);
  const bottomPoints = points.filter(p => p !== topPoint);

  // Step 2: 計算底部4點的質心
  const centroid = {
    x: bottomPoints.reduce((sum, p) => sum + p.x, 0) / 4,
    y: bottomPoints.reduce((sum, p) => sum + p.y, 0) / 4
  };

  // Step 3: 根據相對位置分配ID
  const matched = bottomPoints.map(p => {
    const dx = p.x - centroid.x;
    const dy = p.y - centroid.y;

    let id;
    if (dx > 0 && dy < 0) id = 1;       // 右上
    else if (dx > 0 && dy > 0) id = 2;  // 右下
    else if (dx < 0 && dy > 0) id = 3;  // 左下
    else id = 4;                         // 左上

    return { ...p, id };
  });

  matched.push({ ...topPoint, id: 5 });
  const ordered = matched.sort((a, b) => a.id - b.id);

  // Step 4: 幾何驗證
  const p1 = ordered.find(p => p.id === 1);
  const p2 = ordered.find(p => p.id === 2);
  const p3 = ordered.find(p => p.id === 3);
  const p4 = ordered.find(p => p.id === 4);
  const p5 = ordered.find(p => p.id === 5);

  const width = Math.abs(p1.x - p3.x);
  const height = Math.abs(p1.y - p2.y);

  if (width === 0 || height === 0) {
    return { valid: false };
  }

  const aspectRatio = width / height;

  // 預期比例：(33.65 * 2) / (21.80 * 2) ≈ 1.544
  const expectedRatio = (33.65 * 2) / (21.80 * 2);
  const ratioError = Math.abs(aspectRatio - expectedRatio) / expectedRatio;

  // 檢查1: 矩形比例（容差50%，考慮透視變形）
  if (ratioError > 0.50) {
    return { valid: false };
  }

  // 檢查2: LED5應該在矩形上方
  const avgBottomY = (p1.y + p2.y + p3.y + p4.y) / 4;
  if (p5.y >= avgBottomY) {
    return { valid: false };
  }

  // 檢查3: LED5應該水平居中（容差50%，考慮透視變形）
  const avgBottomX = (p1.x + p2.x + p3.x + p4.x) / 4;
  const horizontalOffset = Math.abs(p5.x - avgBottomX);
  if (horizontalOffset > width * 0.50) {
    return { valid: false };
  }

  // 檢查4: 矩形規則性（容差50%，考慮透視變形）
  const d12 = Math.hypot(p1.x - p2.x, p1.y - p2.y);
  const d23 = Math.hypot(p2.x - p3.x, p2.y - p3.y);
  const d34 = Math.hypot(p3.x - p4.x, p3.y - p4.y);
  const d41 = Math.hypot(p4.x - p1.x, p4.y - p1.y);

  const avgSide = (d12 + d23 + d34 + d41) / 4;
  const sideVariance = [d12, d23, d34, d41].reduce((sum, d) =>
    sum + Math.pow(d - avgSide, 2), 0) / 4;

  if (Math.sqrt(sideVariance) / avgSide > 0.50) {
    return { valid: false };
  }

  return {
    valid: true,
    orderedPoints: ordered,
    metrics: { aspectRatio, ratioError, width, height },
    geometryError: ratioError + (horizontalOffset / width) * 0.5
  };
}

/**
 * 快速PnP評分（用於組合篩選）
 */
function quickPnPScore(orderedPoints) {
  if (!window.cv || !window.cv.Mat) {
    return { ok: false };
  }

  try {
    const objectPts = orderedPoints.map(p => {
      const coords = [
        { id: 1, x: 33.65, y: 21.8, z: 0 },
        { id: 2, x: 33.65, y: -21.8, z: 0 },
        { id: 3, x: -33.65, y: -21.8, z: 0 },
        { id: 4, x: -33.65, y: 21.8, z: 0 },
        { id: 5, x: 0, y: 63.09, z: 20.1 }
      ];
      const led = coords.find(l => l.id === p.id);
      return [led.x, led.y, led.z];
    });

    const imgPts = orderedPoints.map(p => {
      // 簡化版mapOverlayToSource
      const srcW = window.offscreen ? window.offscreen.width : 1920;
      const x = p.x * srcW;
      const y = p.y * (window.offscreen ? window.offscreen.height : 1080);
      return [x, y];
    });

    const objMat = cv.matFromArray(5, 3, cv.CV_32F, objectPts.flat());
    const imgMat = cv.matFromArray(5, 2, cv.CV_32F, imgPts.flat());

    // 簡化的相機矩陣
    const w = window.offscreen ? window.offscreen.width : 1920;
    const h = window.offscreen ? window.offscreen.height : 1080;
    const f = 0.9 * Math.max(w, h);
    const camMat = cv.matFromArray(3, 3, cv.CV_32F, [
      f, 0, w / 2,
      0, f, h / 2,
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
      for (let i = 0; i < 5; i++) {
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

  } catch (e) {
    return { ok: false };
  }
}
