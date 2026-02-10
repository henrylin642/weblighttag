// ===================================================================
// Peak-based LED Detector
// 使用非極大值抑制（NMS）在亮度圖上找局部峰值
// 解決：數據燈條泛光淹沒定位 LED 的問題
// ===================================================================

class PeakDetector {
  constructor(config = {}) {
    // NMS 窗口半徑（實際窗口 = 2R+1）
    this.nmsRadius = config.nmsRadius || 3;
    // 最低峰值分數（過濾暗噪點）
    this.minPeakScore = config.minPeakScore || 80;
    // 形狀過濾閾值
    this.minPointiness = config.minPointiness || 1.5;
    this.minIsotropy = config.minIsotropy || 0.3;
    // 最大返回候選數
    this.maxCandidates = config.maxCandidates || 15;
    // 分數權重
    this.brightnessWeight = config.brightnessWeight || 0.7;
    this.blueDiffWeight = config.blueDiffWeight || 0.3;

    // 預分配緩衝區（按需調整大小）
    this._scoreMap = null;
    this._smoothed = null;
    this._lastWidth = 0;
    this._lastHeight = 0;
  }

  /**
   * 在亮度/藍色差異圖上檢測點光源峰值。
   * 即使 LED 被燈條泛光淹沒（形成連通區域），仍能提取出局部亮度峰值。
   *
   * @param {Uint8Array} mask - 二值藍光遮罩 (0 或 255)
   * @param {Uint8Array} brightnessValues - 每像素亮度 (0-255)
   * @param {Uint8Array} blueDiffValues - 每像素藍色差異 (0-255)
   * @param {number} width - 降採樣寬度
   * @param {number} height - 降採樣高度
   * @param {number} downscale - 降採樣倍率
   * @param {Array<number>} [bluePixels] - 可選的稀疏藍色像素索引列表
   * @returns {Array<Object>} 檢測到的峰值，格式與 BlobDetector 相容
   */
  detect(mask, brightnessValues, blueDiffValues, width, height, downscale = 1, bluePixels = null) {
    // 1. 確保緩衝區大小正確
    this._ensureBuffers(width, height);

    const scoreMap = this._scoreMap;
    const smoothed = this._smoothed;

    // 2. 計算分數圖（僅遍歷藍色區域像素）
    this._computeScoreMap(mask, brightnessValues, blueDiffValues, width, height, scoreMap, bluePixels);

    // 3. 3×3 盒狀模糊（消除單像素噪點）
    this._boxBlur3x3(scoreMap, smoothed, width, height);

    // 4. NMS：找局部最大值
    const rawPeaks = this._nms(smoothed, width, height, bluePixels);

    // 5. 亞像素精化 + 形狀分析
    const candidates = [];
    for (const peak of rawPeaks) {
      // 亞像素精化
      const refined = this._subPixelRefine(smoothed, peak.x, peak.y, width, height, 2);

      // 形狀分析：尖銳度 + 各向同性
      const pointiness = this._computePointiness(smoothed, peak.x, peak.y, width, height);
      const isotropy = this._computeIsotropy(smoothed, peak.x, peak.y, width, height);

      // 估算面積（分數 > 50% 峰值的像素數）
      const area = this._estimateArea(smoothed, peak.x, peak.y, width, height, peak.score);

      // 原始像素位置的亮度數據
      const idx = peak.y * width + peak.x;
      const peakBlueDiff = blueDiffValues[idx] || 0;
      const peakBrightness = brightnessValues[idx] || 0;

      candidates.push({
        // 正規化座標 (0-1)
        x: refined.x / width,
        y: refined.y / height,
        // 降採樣圖中的像素座標
        px: refined.x,
        py: refined.y,
        // 統計數據（與 BlobDetector 相容）
        area: Math.max(1, area),
        brightness: peakBlueDiff,
        maxBrightness: peakBlueDiff,
        realBrightness: peakBrightness,
        maxRealBrightness: peakBrightness,
        bbox: {
          x: Math.max(0, (peak.x - 3)) / width,
          y: Math.max(0, (peak.y - 3)) / height,
          w: Math.min(7, width) / width,
          h: Math.min(7, height) / height
        },
        downscale,
        // 峰值專用欄位（診斷用）
        peakScore: peak.score,
        pointiness,
        isotropy,
        isPeak: true  // 標記為峰值檢測結果
      });
    }

    // 6. 形狀過濾：排除非點光源峰值（如燈條上的局部最大值）
    const filtered = candidates.filter(c =>
      c.pointiness >= this.minPointiness && c.isotropy >= this.minIsotropy
    );

    // 7. 排序：複合分數 = peakScore × pointiness × isotropy
    filtered.sort((a, b) => {
      const sa = a.peakScore * a.pointiness * a.isotropy;
      const sb = b.peakScore * b.pointiness * b.isotropy;
      return sb - sa;
    });

    // 返回 top N
    return filtered.slice(0, this.maxCandidates);
  }

  /**
   * 根據預期 LED 像素大小設定自適應 NMS 半徑。
   * @param {number} pixelDiameter - 預期 LED 在降採樣圖中的直徑（像素）
   */
  setExpectedLEDSize(pixelDiameter) {
    // NMS 半徑 ≈ LED 直徑的 1.5 倍（避免同一 LED 產生多個峰值）
    this.nmsRadius = Math.max(2, Math.min(8, Math.round(pixelDiameter * 1.5)));
  }

  // --- 內部方法 ---

  /**
   * 確保內部緩衝區大小正確。
   */
  _ensureBuffers(width, height) {
    const size = width * height;
    if (this._lastWidth !== width || this._lastHeight !== height) {
      this._scoreMap = new Float32Array(size);
      this._smoothed = new Float32Array(size);
      this._lastWidth = width;
      this._lastHeight = height;
    } else {
      // 清零
      this._scoreMap.fill(0);
      this._smoothed.fill(0);
    }
  }

  /**
   * 計算分數圖：brightness × 0.7 + blueDiff × 0.3
   * 僅處理藍色遮罩內的像素（或極亮像素）以節省時間。
   */
  _computeScoreMap(mask, brightness, blueDiff, width, height, output, bluePixels) {
    const bw = this.brightnessWeight;
    const dw = this.blueDiffWeight;

    if (bluePixels && bluePixels.length > 0) {
      // 稀疏模式：僅遍歷已知的藍色像素
      for (let k = 0; k < bluePixels.length; k++) {
        const i = bluePixels[k];
        const baseScore = brightness[i] * bw + blueDiff[i] * dw;
        // Saturated LED floor: very bright pixels score at least 80% of brightness
        // Prevents glow rings from outscoring bright LED centers with low blueDiff
        output[i] = brightness[i] > 200 ? Math.max(baseScore, brightness[i] * 0.8) : baseScore;
      }
    } else {
      // 完整遍歷（回退）
      const size = width * height;
      for (let i = 0; i < size; i++) {
        if (mask[i] > 0 || brightness[i] > 200) {
          const baseScore = brightness[i] * bw + blueDiff[i] * dw;
          output[i] = brightness[i] > 200 ? Math.max(baseScore, brightness[i] * 0.8) : baseScore;
        }
      }
    }
  }

  /**
   * 可分離 3×3 盒狀模糊。
   * 兩遍 1D 平均：先水平，再垂直。
   */
  _boxBlur3x3(input, output, width, height) {
    // 使用臨時緩衝區做水平遍歷
    const temp = this._tempBlur || (this._tempBlur = new Float32Array(width * height));
    if (temp.length !== width * height) {
      this._tempBlur = new Float32Array(width * height);
    }
    const t = this._tempBlur;
    t.fill(0);

    // 水平遍歷
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const idx = row + x;
        t[idx] = (input[idx - 1] + input[idx] + input[idx + 1]) / 3;
      }
      // 邊界：複製邊緣像素以保持歸一化一致性
      t[row] = (input[row] * 2 + input[row + 1]) / 3;
      t[row + width - 1] = (input[row + width - 2] + input[row + width - 1] * 2) / 3;
    }

    // 垂直遍歷
    for (let y = 1; y < height - 1; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        output[idx] = (t[idx - width] + t[idx] + t[idx + width]) / 3;
      }
    }
    // 上下邊界：複製邊緣像素
    for (let x = 0; x < width; x++) {
      output[x] = (t[x] * 2 + t[x + width]) / 3;
      const last = (height - 1) * width + x;
      output[last] = (t[last - width] + t[last] * 2) / 3;
    }
  }

  /**
   * 非極大值抑制：在 (2R+1)×(2R+1) 窗口中找局部最大值。
   * 使用稀疏掃描跳過非藍色區域。
   */
  _nms(scoreMap, width, height, bluePixels) {
    const R = this.nmsRadius;
    const minScore = this.minPeakScore;
    const peaks = [];

    // 決定掃描範圍
    let pixelsToCheck;
    if (bluePixels && bluePixels.length > 0) {
      pixelsToCheck = bluePixels;
    } else {
      // 回退：掃描所有非零像素
      pixelsToCheck = [];
      for (let i = 0; i < width * height; i++) {
        if (scoreMap[i] >= minScore) pixelsToCheck.push(i);
      }
    }

    for (let k = 0; k < pixelsToCheck.length; k++) {
      const idx = pixelsToCheck[k];
      const val = scoreMap[idx];
      if (val < minScore) continue;

      const x = idx % width;
      const y = (idx - x) / width;

      // 動態邊界 NMS（允許部分窗口，避免邊緣死區）
      const yMin = Math.max(0, y - R);
      const yMax = Math.min(height - 1, y + R);
      const xMin = Math.max(0, x - R);
      const xMax = Math.min(width - 1, x + R);

      // 檢查是否為窗口內最大值
      let isMax = true;
      for (let ny = yMin; ny <= yMax && isMax; ny++) {
        for (let nx = xMin; nx <= xMax; nx++) {
          if (nx === x && ny === y) continue;
          if (scoreMap[ny * width + nx] > val) {
            isMax = false;
            break;
          }
        }
      }

      if (isMax) {
        peaks.push({ x, y, score: val });
      }
    }

    // 按分數降序排序
    peaks.sort((a, b) => b.score - a.score);

    // 限制最大峰值數（避免過多計算）
    return peaks.slice(0, this.maxCandidates * 2);
  }

  /**
   * 亞像素精化：在小窗口內用加權質心提升位置精度。
   * @returns {{ x: number, y: number }} 精化後的浮點座標
   */
  _subPixelRefine(scoreMap, cx, cy, width, height, radius) {
    let sumW = 0, sumWX = 0, sumWY = 0;

    const yMin = Math.max(0, cy - radius);
    const yMax = Math.min(height - 1, cy + radius);
    const xMin = Math.max(0, cx - radius);
    const xMax = Math.min(width - 1, cx + radius);

    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        const w = scoreMap[y * width + x];
        if (w > 0) {
          // 使用 score² 作權重（強調峰值中心）
          const w2 = w * w;
          sumW += w2;
          sumWX += x * w2;
          sumWY += y * w2;
        }
      }
    }

    if (sumW > 0) {
      return {
        x: Math.max(0, Math.min(width - 1, sumWX / sumW)),
        y: Math.max(0, Math.min(height - 1, sumWY / sumW))
      };
    }
    return { x: cx, y: cy };
  }

  /**
   * 計算尖銳度：中心值與環形區域平均值的比值。
   * LED 點光源 ≈ 3-10x，燈條面光源 ≈ 1.2-2x。
   */
  _computePointiness(scoreMap, cx, cy, width, height) {
    const centerVal = scoreMap[cy * width + cx];
    if (centerVal <= 0) return 0;

    // 取距離 3-5 像素的環形區域
    let ringSum = 0;
    let ringCount = 0;
    const innerR = 3;
    const outerR = 5;

    for (let dy = -outerR; dy <= outerR; dy++) {
      const py = cy + dy;
      if (py < 0 || py >= height) continue;
      for (let dx = -outerR; dx <= outerR; dx++) {
        const px = cx + dx;
        if (px < 0 || px >= width) continue;

        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= innerR && dist <= outerR) {
          ringSum += scoreMap[py * width + px];
          ringCount++;
        }
      }
    }

    const ringAvg = ringCount > 0 ? ringSum / ringCount : 0;
    return centerVal / Math.max(1, ringAvg);
  }

  /**
   * 計算各向同性：水平 vs 垂直衰減率的比值。
   * 點光源（圓形） ≈ 0.8-1.0，燈條（細長） ≈ 0.2-0.5。
   */
  _computeIsotropy(scoreMap, cx, cy, width, height) {
    const centerVal = scoreMap[cy * width + cx];
    if (centerVal <= 0) return 0;

    const sampleR = 4; // 採樣半徑

    // 水平方向衰減
    const left = (cx - sampleR >= 0) ? scoreMap[cy * width + (cx - sampleR)] : 0;
    const right = (cx + sampleR < width) ? scoreMap[cy * width + (cx + sampleR)] : 0;
    const hFalloff = centerVal - (left + right) / 2;

    // 垂直方向衰減
    const top = (cy - sampleR >= 0) ? scoreMap[(cy - sampleR) * width + cx] : 0;
    const bottom = (cy + sampleR < height) ? scoreMap[(cy + sampleR) * width + cx] : 0;
    const vFalloff = centerVal - (top + bottom) / 2;

    // 兩個方向衰減率的比值，接近 1.0 表示各向同性
    const maxFalloff = Math.max(hFalloff, vFalloff);
    const minFalloff = Math.min(hFalloff, vFalloff);

    if (maxFalloff <= 0) return 0;
    return Math.max(0, minFalloff) / maxFalloff;
  }

  /**
   * 估算峰值面積：分數超過峰值 50% 的像素數。
   */
  _estimateArea(scoreMap, cx, cy, width, height, peakScore) {
    const threshold = peakScore * 0.5;
    let area = 0;
    const radius = 5;

    const yMin = Math.max(0, cy - radius);
    const yMax = Math.min(height - 1, cy + radius);
    const xMin = Math.max(0, cx - radius);
    const xMax = Math.min(width - 1, cx + radius);

    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (scoreMap[y * width + x] >= threshold) {
          area++;
        }
      }
    }

    return area;
  }
}
