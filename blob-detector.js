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
   * Detect blobs in a binary mask using connected-component labeling.
   * @param {Uint8Array} mask - Binary mask (0 or 255)
   * @param {number} width - Mask width
   * @param {number} height - Mask height
   * @param {Uint8Array} [blueDiffValues] - Optional blue diff strength per pixel
   * @param {number} [downscale] - Downscale factor used to create the mask
   * @returns {Array<Blob>} Detected blobs with centroid, area, bbox, brightness
   */
  detect(mask, width, height, blueDiffValues, downscale = 1) {
    // Connected-component labeling with Union-Find
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

    // Second pass: collect statistics per component
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
            maxBrightness: 0
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
      }
    }

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
        bbox: {
          x: s.minX / width,
          y: s.minY / height,
          w: bboxW / width,
          h: bboxH / height
        },
        downscale
      });
    }

    // Sort by brightness (strongest blue diff first)
    blobs.sort((a, b) => b.maxBrightness - a.maxBrightness);

    return blobs;
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

      // Weighted centroid using blue differential as weight
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
          if (blueDiff <= 0) continue;

          const weight = blueDiff * blueDiff; // Square for sharper peak
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
