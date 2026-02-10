// ===================================================================
// Pure JS Connected-Component Blob Detection
// Union-Find based blob detection - no OpenCV dependency
// ===================================================================

class BlobDetector {
  constructor(config = {}) {
    this.minArea = config.minArea || 1;
    this.maxArea = config.maxArea || 200;
    this.maxAspectRatio = config.maxAspectRatio || 3.0;
  }

  /**
   * Private: Label connected components using Union-Find.
   * @param {Uint8Array} mask - Binary mask (0 or 255)
   * @param {number} width - Mask width
   * @param {number} height - Mask height
   * @returns {Object} {labels, uf, nextLabel} - Labeled components
   */
  _labelComponents(mask, width, height) {
    const labels = new Int32Array(width * height);
    labels.fill(-1);
    const uf = new UnionFind(width * height);
    let nextLabel = 0;

    // First pass: assign labels with 4-connectivity
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (mask[idx] === 0) continue;

        const leftIdx = x > 0 ? idx - 1 : -1;
        const topIdx = y > 0 ? idx - width : -1;

        const leftLabel = (leftIdx >= 0 && mask[leftIdx] !== 0) ? labels[leftIdx] : -1;
        const topLabel = (topIdx >= 0 && mask[topIdx] !== 0) ? labels[topIdx] : -1;

        if (leftLabel === -1 && topLabel === -1) {
          // New component
          labels[idx] = nextLabel++;
        } else if (leftLabel !== -1 && topLabel === -1) {
          labels[idx] = leftLabel;
        } else if (leftLabel === -1 && topLabel !== -1) {
          labels[idx] = topLabel;
        } else {
          // Both neighbors labeled - union them
          labels[idx] = leftLabel;
          uf.union(leftLabel, topLabel);
        }
      }
    }

    return { labels, uf, nextLabel };
  }

  /**
   * Private: Collect statistics for each component.
   * @param {Int32Array} labels - Component labels
   * @param {UnionFind} uf - Union-Find structure
   * @param {number} width - Mask width
   * @param {number} height - Mask height
   * @param {Uint8Array} [blueDiffValues] - Optional blue diff values
   * @param {Uint8Array} [brightnessValues] - Optional brightness values
   * @returns {Map} Map of root label -> component stats
   */
  _collectStats(labels, uf, width, height, blueDiffValues, brightnessValues) {
    const stats = new Map(); // root label -> stats

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (labels[idx] === -1) continue;

        const root = uf.find(labels[idx]);
        let s = stats.get(root);
        if (!s) {
          s = {
            area: 0,
            sumX: 0, sumY: 0,
            minX: width, minY: height,
            maxX: 0, maxY: 0,
            sumBrightness: 0,
            maxBrightness: 0,
            sumRealBrightness: 0,
            maxRealBrightness: 0
          };
          stats.set(root, s);
        }

        s.area++;
        s.sumX += x;
        s.sumY += y;
        if (x < s.minX) s.minX = x;
        if (y < s.minY) s.minY = y;
        if (x > s.maxX) s.maxX = x;
        if (y > s.maxY) s.maxY = y;

        if (blueDiffValues) {
          const bv = blueDiffValues[idx];
          s.sumBrightness += bv;
          if (bv > s.maxBrightness) s.maxBrightness = bv;
        }
        if (brightnessValues) {
          const rv = brightnessValues[idx];
          s.sumRealBrightness += rv;
          if (rv > s.maxRealBrightness) s.maxRealBrightness = rv;
        }
      }
    }

    return stats;
  }

  /**
   * Detect blobs in a binary mask using connected-component labeling.
   * @param {Uint8Array} mask - Binary mask (0 or 255)
   * @param {number} width - Mask width
   * @param {number} height - Mask height
   * @param {Uint8Array} [blueDiffValues] - Optional blue diff strength per pixel
   * @param {number} [downscale] - Downscale factor used to create the mask
   * @param {Uint8Array} [brightnessValues] - Optional brightness per pixel (from shader B channel)
   * @returns {Array<Blob>} Detected blobs with centroid, area, bbox, brightness
   */
  detect(mask, width, height, blueDiffValues, downscale = 1, brightnessValues = null) {
    // Connected-component labeling
    const { labels, uf } = this._labelComponents(mask, width, height);

    // Collect statistics per component
    const stats = this._collectStats(labels, uf, width, height, blueDiffValues, brightnessValues);

    // Convert stats to blob list with filtering
    const blobs = [];
    for (const [, s] of stats) {
      // Area filter
      if (s.area < this.minArea || s.area > this.maxArea) continue;

      // Aspect ratio filter
      const bboxW = s.maxX - s.minX + 1;
      const bboxH = s.maxY - s.minY + 1;
      const aspect = Math.max(bboxW, bboxH) / Math.max(1, Math.min(bboxW, bboxH));
      if (aspect > this.maxAspectRatio) continue;

      // Minimum average brightness filter: reject dim noise blobs
      if (blueDiffValues) {
        const avgBlueDiff = s.sumBrightness / s.area;
        // Real LEDs have blueDiff typically 30-200; noise is 1-8
        // But saturated LED centers may have low blueDiff, so also check real brightness
        const avgRealBright = brightnessValues ? (s.sumRealBrightness / s.area) : 0;
        if (avgBlueDiff < 10 && avgRealBright < 200) continue;
      }

      // Compactness filter: real LEDs should be roughly circular
      // Compactness = area / (bboxW * bboxH); circle ≈ 0.78, square = 1.0
      const compactness = s.area / (bboxW * bboxH);
      if (compactness < 0.3) continue;

      // Centroid in normalized coordinates (0-1)
      const cx = s.sumX / s.area;
      const cy = s.sumY / s.area;

      blobs.push({
        // Normalized coordinates (relative to full image)
        x: cx / width,
        y: cy / height,
        // Pixel coordinates in the downscaled image
        px: cx,
        py: cy,
        // Stats
        area: s.area,
        brightness: blueDiffValues ? (s.sumBrightness / s.area) : 0,
        maxBrightness: s.maxBrightness,
        realBrightness: brightnessValues ? (s.sumRealBrightness / s.area) : 0,
        maxRealBrightness: s.maxRealBrightness,
        bbox: {
          x: s.minX / width,
          y: s.minY / height,
          w: bboxW / width,
          h: bboxH / height
        },
        downscale
      });
    }

    // Sort by composite score: real brightness + blue signal
    // This ensures saturated LEDs (high brightness, low blueDiff) rank high
    blobs.sort((a, b) => {
      const scoreA = a.maxRealBrightness * 0.5 + a.maxBrightness * 0.5;
      const scoreB = b.maxRealBrightness * 0.5 + b.maxBrightness * 0.5;
      return scoreB - scoreA;
    });

    return blobs;
  }

  /**
   * Detect LARGE horizontal strips (data light strips) in a binary mask.
   * Uses same connected-component algorithm but different filter criteria.
   * @param {Uint8Array} mask - Binary mask (0 or 255)
   * @param {number} width - Mask width
   * @param {number} height - Mask height
   * @param {Uint8Array} [blueDiffValues] - Optional blue diff strength per pixel
   * @param {number} [downscale] - Downscale factor used to create the mask
   * @param {Uint8Array} [brightnessValues] - Optional brightness per pixel
   * @returns {Array<StripBlob>} Detected strip blobs, sorted by Y position (top to bottom)
   */
  detectStrips(mask, width, height, blueDiffValues, downscale = 1, brightnessValues = null) {
    // Connected-component labeling
    const { labels, uf } = this._labelComponents(mask, width, height);

    // Collect statistics per component
    const stats = this._collectStats(labels, uf, width, height, blueDiffValues, brightnessValues);

    // Convert stats to strip list with strip-specific filtering
    const strips = [];
    for (const [, s] of stats) {
      // Strip-specific filters:
      const minArea = 40;
      const maxArea = 50000;
      const minAspectRatio = 1.5;

      // Area filter: strips are large
      if (s.area < minArea || s.area > maxArea) continue;

      // Bbox dimensions
      const bboxW = s.maxX - s.minX + 1;
      const bboxH = s.maxY - s.minY + 1;

      // Must be horizontally oriented
      if (bboxW <= bboxH) continue;

      // Aspect ratio filter: strips are elongated
      const aspect = Math.max(bboxW, bboxH) / Math.max(1, Math.min(bboxW, bboxH));
      if (aspect < minAspectRatio) continue;

      // Centroid in normalized coordinates (0-1)
      const cx = s.sumX / s.area;
      const cy = s.sumY / s.area;

      strips.push({
        // Normalized coordinates (relative to full image)
        x: cx / width,
        y: cy / height,
        // Pixel coordinates in the downscaled image
        px: cx,
        py: cy,
        // Stats
        area: s.area,
        brightness: blueDiffValues ? (s.sumBrightness / s.area) : 0,
        maxBrightness: s.maxBrightness,
        realBrightness: brightnessValues ? (s.sumRealBrightness / s.area) : 0,
        maxRealBrightness: s.maxRealBrightness,
        bbox: {
          x: s.minX / width,
          y: s.minY / height,
          w: bboxW / width,
          h: bboxH / height
        },
        bboxW_px: bboxW,
        bboxH_px: bboxH,
        downscale,
        edgeLeft: null,
        edgeRight: null
      });
    }

    // Sort by vertical position (Y ascending = top to bottom)
    strips.sort((a, b) => a.y - b.y);

    return strips;
  }

  /**
   * Extract left and right edge midpoints of a strip blob.
   * These edge points serve as PnP reference points.
   * @param {StripBlob} stripBlob - Strip blob from detectStrips()
   * @param {Uint8Array} mask - Binary mask
   * @param {number} width - Mask width
   * @param {number} height - Mask height
   * @param {Uint8Array} [brightnessValues] - Optional brightness values for weighted centroid
   * @returns {Object} {edgeLeft, edgeRight} with normalized coordinates
   */
  extractStripEdges(stripBlob, mask, width, height, brightnessValues = null) {
    const bbox = stripBlob.bbox;
    const minX = Math.floor(bbox.x * width);
    const maxX = Math.ceil((bbox.x + bbox.w) * width);
    const minY = Math.floor(bbox.y * height);
    const maxY = Math.ceil((bbox.y + bbox.h) * height);

    // Scan columns to find leftmost and rightmost edges
    let leftCols = [];
    let rightCols = [];

    for (let x = minX; x < maxX; x++) {
      let hasPixel = false;
      for (let y = minY; y < maxY; y++) {
        const idx = y * width + x;
        if (mask[idx] !== 0) {
          hasPixel = true;
          break;
        }
      }
      if (hasPixel) {
        leftCols.push(x);
        if (leftCols.length >= 3) break; // Use first 3 columns
      }
    }

    for (let x = maxX - 1; x >= minX; x--) {
      let hasPixel = false;
      for (let y = minY; y < maxY; y++) {
        const idx = y * width + x;
        if (mask[idx] !== 0) {
          hasPixel = true;
          break;
        }
      }
      if (hasPixel) {
        rightCols.push(x);
        if (rightCols.length >= 3) break; // Use last 3 columns
      }
    }

    // Helper function: compute vertical centroid of a column
    const computeColumnCentroid = (colX) => {
      let sumY = 0;
      let sumWeight = 0;

      for (let y = minY; y < maxY; y++) {
        const idx = y * width + colX;
        if (mask[idx] === 0) continue;

        const weight = brightnessValues ? brightnessValues[idx] : 1;
        sumY += y * weight;
        sumWeight += weight;
      }

      return sumWeight > 0 ? sumY / sumWeight : (minY + maxY) / 2;
    };

    // Compute left edge: average centroid of leftmost columns
    let edgeLeft = null;
    if (leftCols.length > 0) {
      let sumX = 0;
      let sumY = 0;
      for (const colX of leftCols) {
        sumX += colX;
        sumY += computeColumnCentroid(colX);
      }
      edgeLeft = {
        nx: (sumX / leftCols.length) / width,
        ny: (sumY / leftCols.length) / height
      };
    }

    // Compute right edge: average centroid of rightmost columns
    let edgeRight = null;
    if (rightCols.length > 0) {
      let sumX = 0;
      let sumY = 0;
      for (const colX of rightCols) {
        sumX += colX;
        sumY += computeColumnCentroid(colX);
      }
      edgeRight = {
        nx: (sumX / rightCols.length) / width,
        ny: (sumY / rightCols.length) / height
      };
    }

    // Mutate stripBlob to set edge fields
    stripBlob.edgeLeft = edgeLeft;
    stripBlob.edgeRight = edgeRight;

    return { edgeLeft, edgeRight };
  }

  /**
   * Refine blob center positions using full-resolution data.
   * Reads a small window around each blob from the full-res canvas.
   * @param {Array<Blob>} blobs - Detected blobs from detect()
   * @param {CanvasRenderingContext2D} fullResCtx - Full-resolution canvas context
   * @param {number} fullW - Full resolution width
   * @param {number} fullH - Full resolution height
   * @param {number} windowSize - Size of the refinement window (default 16)
   * @returns {Array<Blob>} Blobs with refined positions
   */
  refinePositions(blobs, fullResCtx, fullW, fullH, windowSize = 16) {
    const half = Math.floor(windowSize / 2);

    return blobs.map(blob => {
      // Convert normalized coords to full-res pixels
      const cx = Math.round(blob.x * fullW);
      const cy = Math.round(blob.y * fullH);

      // Window bounds (clamped)
      const x0 = Math.max(0, cx - half);
      const y0 = Math.max(0, cy - half);
      const x1 = Math.min(fullW, cx + half);
      const y1 = Math.min(fullH, cy + half);
      const w = x1 - x0;
      const h = y1 - y0;

      if (w <= 0 || h <= 0) return blob;

      const imgData = fullResCtx.getImageData(x0, y0, w, h);
      const data = imgData.data;

      // Weighted centroid: use brightness for saturated pixels, blueDiff for normal
      let sumWeight = 0;
      let sumWX = 0;
      let sumWY = 0;

      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const i = (py * w + px) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];

          const blueDiff = b - (r + g) * 0.5;
          const pixBrightness = (r + g + b) / 3.0;
          let weight;

          if (pixBrightness > 200 && blueDiff > 0) {
            // Saturated LED center: weight by brightness (converges to brightest point)
            weight = pixBrightness * pixBrightness;
          } else if (blueDiff > 0) {
            // Normal blue pixel: weight by blue differential
            weight = blueDiff * blueDiff;
          } else {
            continue;
          }

          sumWeight += weight;
          sumWX += (x0 + px) * weight;
          sumWY += (y0 + py) * weight;
        }
      }

      if (sumWeight > 0) {
        return {
          ...blob,
          x: (sumWX / sumWeight) / fullW,
          y: (sumWY / sumWeight) / fullH,
          refined: true
        };
      }

      return blob;
    });
  }
}

// --- Union-Find data structure ---

class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.parent[i] = i;
    }
  }

  find(x) {
    // Path compression
    let root = x;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }
    // Path halving
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }

  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;

    // Union by rank
    if (this.rank[ra] < this.rank[rb]) {
      this.parent[ra] = rb;
    } else if (this.rank[ra] > this.rank[rb]) {
      this.parent[rb] = ra;
    } else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }
}
