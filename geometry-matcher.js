// ===================================================================
// 5-LED Geometric Structure Matching
// Finds the known 5-LED pattern from candidate blobs
// ===================================================================

// Physical LED configuration (mm)
const LED_GEOMETRY = {
  points3D: [
    { id: 1, x: 33.65, y: 21.8, z: 0 },      // Right-top
    { id: 2, x: 33.65, y: -21.8, z: 0 },     // Right-bottom
    { id: 3, x: -33.65, y: -21.8, z: 0 },    // Left-bottom
    { id: 4, x: -33.65, y: 21.8, z: 0 },     // Left-top
    { id: 5, x: 0, y: 63.09, z: 20.1 }       // Center protrusion
  ],
  // Physical rectangle dimensions
  rectWidth: 67.3,    // mm (33.65 * 2)
  rectHeight: 43.6,   // mm (21.8 * 2)
  expectedAspectRatio: 67.3 / 43.6, // ~1.544
  // LED5 offset from rectangle center
  led5VerticalOffset: 63.09, // mm above center
  led5ForwardOffset: 20.1    // mm forward (z-axis)
};

class GeometryMatcher {
  constructor(config = {}) {
    // Configurable sensitivity: 'low', 'medium', 'high'
    this.sensitivity = config.sensitivity || 'medium';
    this._updateTolerances();
  }

  setSensitivity(level) {
    this.sensitivity = level;
    this._updateTolerances();
  }

  _updateTolerances() {
    const presets = {
      low:    { aspectRatioTol: 0.25, centerTol: 0.30, regularityTol: 0.20, maxCombinations: 200 },
      medium: { aspectRatioTol: 0.40, centerTol: 0.40, regularityTol: 0.35, maxCombinations: 500 },
      high:   { aspectRatioTol: 0.60, centerTol: 0.50, regularityTol: 0.50, maxCombinations: 1000 }
    };
    const p = presets[this.sensitivity] || presets.medium;
    this.aspectRatioTol = p.aspectRatioTol;
    this.centerTol = p.centerTol;
    this.regularityTol = p.regularityTol;
    this.maxCombinations = p.maxCombinations;
  }

  /**
   * Find the best 5-LED configuration from candidate blobs.
   * @param {Array<Blob>} candidates - Detected blobs from BlobDetector
   * @param {number} imageAspect - Image width/height ratio (for coordinate scaling)
   * @returns {Object|null} Matched configuration or null
   */
  match(candidates, imageAspect = 16 / 9) {
    if (candidates.length < 5) return null;

    // Limit to top candidates (by brightness)
    const top = candidates.slice(0, Math.min(20, candidates.length));

    // Pre-compute pixel distances between all pairs (using normalized coords scaled by aspect)
    const n = top.length;
    const dists = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = (top[i].x - top[j].x) * imageAspect;
        const dy = top[i].y - top[j].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        dists[i * n + j] = d;
        dists[j * n + i] = d;
      }
    }

    // Pre-cluster: group candidates that are at consistent mutual distances
    // Skip exhaustive enumeration if we can identify likely clusters
    const clusters = this._findClusters(top, dists, n);

    let bestMatch = null;
    let bestScore = Infinity;
    let combinationsTested = 0;

    // Try clusters first, then fall back to brute force
    const searchSets = clusters.length > 0 ? clusters : [top.map((_, i) => i)];

    for (const cluster of searchSets) {
      if (cluster.length < 5) continue;

      const clusterPoints = cluster.map(i => top[i]);
      const result = this._searchCombinations(clusterPoints);

      if (result && result.score < bestScore) {
        bestScore = result.score;
        bestMatch = result;
      }

      combinationsTested += result ? result.combinationsTested : 0;
      if (combinationsTested > this.maxCombinations) break;
    }

    if (bestMatch) {
      bestMatch.totalCandidates = candidates.length;
      bestMatch.combinationsTested = combinationsTested;
    }

    return bestMatch;
  }

  /**
   * Find clusters of points at consistent mutual distances.
   */
  _findClusters(points, dists, n) {
    if (n <= 7) return []; // Too few points, just brute force

    const clusters = [];

    // For each triplet of close points, find potential 5-point groups
    for (let i = 0; i < n; i++) {
      const neighbors = [];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        neighbors.push({ idx: j, dist: dists[i * n + j] });
      }
      neighbors.sort((a, b) => a.dist - b.dist);

      // Take the closest 8 neighbors as a cluster candidate
      if (neighbors.length >= 4) {
        const cluster = [i, ...neighbors.slice(0, Math.min(8, neighbors.length)).map(nb => nb.idx)];
        // Deduplicate
        const unique = [...new Set(cluster)];
        if (unique.length >= 5) {
          clusters.push(unique);
        }
      }
    }

    // Remove duplicate clusters (same set of points)
    const seen = new Set();
    return clusters.filter(c => {
      const key = c.sort((a, b) => a - b).join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Search all 5-point combinations in a set and find the best geometric match.
   */
  _searchCombinations(points) {
    const n = points.length;
    let bestMatch = null;
    let bestScore = Infinity;
    let count = 0;

    for (let a = 0; a < n && count < this.maxCombinations; a++) {
      for (let b = a + 1; b < n && count < this.maxCombinations; b++) {
        for (let c = b + 1; c < n && count < this.maxCombinations; c++) {
          for (let d = c + 1; d < n && count < this.maxCombinations; d++) {
            for (let e = d + 1; e < n && count < this.maxCombinations; e++) {
              count++;
              const set = [points[a], points[b], points[c], points[d], points[e]];
              const result = this._verifyGeometry(set);
              if (!result) continue;

              if (result.score < bestScore) {
                bestScore = result.score;
                bestMatch = result;
              }
            }
          }
        }
      }
    }

    if (bestMatch) {
      bestMatch.combinationsTested = count;
    }
    return bestMatch;
  }

  /**
   * Verify if 5 points match the expected LED geometry.
   * Returns scored result or null if invalid.
   */
  _verifyGeometry(points) {
    // Step 1: Find the topmost point (smallest y) -> LED5 candidate
    let topIdx = 0;
    for (let i = 1; i < 5; i++) {
      if (points[i].y < points[topIdx].y) topIdx = i;
    }
    const led5 = points[topIdx];
    const bottomPoints = points.filter((_, i) => i !== topIdx);

    // Step 2: Compute centroid of bottom 4 points
    const centroid = {
      x: bottomPoints.reduce((s, p) => s + p.x, 0) / 4,
      y: bottomPoints.reduce((s, p) => s + p.y, 0) / 4
    };

    // Step 3: LED5 must be above the bottom 4
    if (led5.y >= centroid.y) return null;

    // Step 4: Assign IDs to bottom 4 based on quadrant
    const assigned = bottomPoints.map(p => {
      const dx = p.x - centroid.x;
      const dy = p.y - centroid.y;
      let id;
      if (dx > 0 && dy < 0) id = 1;       // Right-top
      else if (dx > 0 && dy >= 0) id = 2;  // Right-bottom
      else if (dx <= 0 && dy >= 0) id = 3; // Left-bottom
      else id = 4;                          // Left-top
      return { ...p, id };
    });

    // Check for duplicate IDs (invalid assignment)
    const ids = assigned.map(p => p.id);
    if (new Set(ids).size !== 4) return null;

    assigned.push({ ...led5, id: 5 });
    const ordered = assigned.sort((a, b) => a.id - b.id);

    const p1 = ordered[0]; // id 1: right-top
    const p2 = ordered[1]; // id 2: right-bottom
    const p3 = ordered[2]; // id 3: left-bottom
    const p4 = ordered[3]; // id 4: left-top
    const p5 = ordered[4]; // id 5: top center

    // Step 5: Geometric validation

    // Rectangle dimensions
    const width = Math.abs(p1.x - p3.x);
    const height = Math.abs(p1.y - p2.y);
    if (width < 0.001 || height < 0.001) return null;

    // Aspect ratio check
    const aspectRatio = width / height;
    const ratioError = Math.abs(aspectRatio - LED_GEOMETRY.expectedAspectRatio) / LED_GEOMETRY.expectedAspectRatio;
    if (ratioError > this.aspectRatioTol) return null;

    // LED5 horizontal centering check
    const avgX = (p1.x + p2.x + p3.x + p4.x) / 4;
    const horizontalOffset = Math.abs(p5.x - avgX);
    if (horizontalOffset > width * this.centerTol) return null;

    // Rectangle regularity check (opposite sides should be similar)
    const d12 = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const d23 = Math.hypot(p2.x - p3.x, p2.y - p3.y);
    const d34 = Math.hypot(p3.x - p4.x, p3.y - p4.y);
    const d41 = Math.hypot(p4.x - p1.x, p4.y - p1.y);

    const avgSide = (d12 + d23 + d34 + d41) / 4;
    if (avgSide < 0.001) return null;

    const sideVariance = [d12, d23, d34, d41].reduce((sum, d) =>
      sum + Math.pow(d - avgSide, 2), 0) / 4;
    const sideCV = Math.sqrt(sideVariance) / avgSide;
    if (sideCV > this.regularityTol) return null;

    // Step 6: Compute quality score (lower is better)
    const score = ratioError * 2.0
      + (horizontalOffset / width) * 1.5
      + sideCV * 1.5;

    return {
      success: true,
      points: ordered,
      score,
      metrics: {
        aspectRatio,
        ratioError,
        horizontalOffset: horizontalOffset / width,
        sideCV,
        width,
        height,
        rectCenter: { x: avgX, y: centroid.y }
      }
    };
  }

  /**
   * Quick check if there are "enough" blue candidates that could form the pattern.
   * Used for early visual feedback before full matching.
   * @param {Array<Blob>} candidates
   * @param {number} minCount - Minimum candidates to consider promising
   * @returns {{ promising: boolean, clusterCenter: {x, y}|null }}
   */
  quickCheck(candidates, minCount = 5) {
    if (candidates.length < minCount) {
      return { promising: false, clusterCenter: null };
    }

    // Check if there's a cluster of at least 5 points within a reasonable area
    const top = candidates.slice(0, Math.min(15, candidates.length));

    for (let i = 0; i < top.length; i++) {
      let nearby = 0;
      for (let j = 0; j < top.length; j++) {
        if (i === j) continue;
        const dx = top[i].x - top[j].x;
        const dy = top[i].y - top[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Within 15% of image dimension
        if (dist < 0.15) nearby++;
      }
      if (nearby >= 4) {
        return {
          promising: true,
          clusterCenter: { x: top[i].x, y: top[i].y }
        };
      }
    }

    return { promising: false, clusterCenter: null };
  }
}
