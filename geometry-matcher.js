/**
 * geometry-matcher.js
 *
 * Hybrid Strip + LED Geometry Matching System
 *
 * Matches detected features (strip blobs and LED candidates) to the known
 * device geometry, providing 2D-3D correspondences for PnP pose estimation.
 *
 * Coordinate System:
 * - World space: Origin at center of middle strip, X=right, Y=up, Z=toward camera (mm)
 * - Image space: Normalized 0-1 coords, (0,0)=top-left, (1,1)=bottom-right
 */

// ============================================================================
// DEVICE GEOMETRY (AUTHORITATIVE from dimension diagram)
// ============================================================================

const DEVICE_GEOMETRY = {
  // LED positions (5 total: 4 corners + 1 top center)
  leds: [
    { id: 'LED1', x: 62,   y: 43.3,  z: 0  },  // right-top
    { id: 'LED2', x: 62,   y: -43.3, z: 0  },  // right-bottom
    { id: 'LED3', x: -62,  y: -43.3, z: 0  },  // left-bottom
    { id: 'LED4', x: -62,  y: 43.3,  z: 0  },  // left-top
    { id: 'LED5', x: 0,    y: 151.6, z: 40 }   // top-center (protrudes 40mm)
  ],

  // Data strips (3 total: top, mid, bottom)
  strips: [
    { id: 'STRIP_TOP', cx: 0, cy: 43.3,  z: 0, halfW: 48, halfH: 26.8 },
    { id: 'STRIP_MID', cx: 0, cy: 0.0,   z: 0, halfW: 48, halfH: 26.8 },
    { id: 'STRIP_BOT', cx: 0, cy: -43.3, z: 0, halfW: 48, halfH: 26.8 }
  ],

  // Strip edge midpoints (6 total: left and right edge of each strip)
  stripEdges: [
    { id: 'ST_L', x: -48, y: 43.3,  z: 0 },  // Strip-Top Left edge
    { id: 'ST_R', x: 48,  y: 43.3,  z: 0 },  // Strip-Top Right edge
    { id: 'SM_L', x: -48, y: 0.0,   z: 0 },  // Strip-Mid Left edge
    { id: 'SM_R', x: 48,  y: 0.0,   z: 0 },  // Strip-Mid Right edge
    { id: 'SB_L', x: -48, y: -43.3, z: 0 },  // Strip-Bot Left edge
    { id: 'SB_R', x: 48,  y: -43.3, z: 0 }   // Strip-Bot Right edge
  ],

  // Physical dimensions (mm)
  dimensions: {
    stripWidth: 96.0,        // Full strip width
    stripHeight: 53.6,       // Full strip height
    stripSpacing: 43.3,      // Center-to-center spacing
    ledDiameter: 6.0,        // LED diameter
    ledHorizontalSpan: 124,  // Distance between left and right LEDs (62mm each side)
    led5Height: 151.6,       // LED5 Y coordinate
    led5Protrusion: 40       // LED5 Z depth
  }
};

// ============================================================================
// GEOMETRY MATCHER CLASS
// ============================================================================

class GeometryMatcher {
  constructor() {
    // Configurable tolerances for matching
    this.sensitivity = {
      stripSpacingTolerance: 0.40,    // ±40% tolerance for strip spacing ratio
      ledStripAlignTolerance: 0.15,   // ±15% for LED-strip Y alignment
      ledLeftRightThreshold: 0.05,    // Minimum X offset to classify left/right
      minFeaturesForPnP: 4,           // Minimum features needed for pose estimation
      minSpatialSpread: 0.3           // Minimum normalized distance span for good distribution
    };
  }

  /**
   * Set sensitivity level for matching tolerances
   * @param {string} level - 'strict', 'normal', or 'relaxed'
   */
  setSensitivity(level) {
    switch (level) {
      case 'strict':
        this.sensitivity.stripSpacingTolerance = 0.25;
        this.sensitivity.ledStripAlignTolerance = 0.10;
        this.sensitivity.minSpatialSpread = 0.4;
        break;
      case 'relaxed':
        this.sensitivity.stripSpacingTolerance = 0.50;
        this.sensitivity.ledStripAlignTolerance = 0.20;
        this.sensitivity.minSpatialSpread = 0.2;
        break;
      default: // 'normal'
        this.sensitivity.stripSpacingTolerance = 0.40;
        this.sensitivity.ledStripAlignTolerance = 0.15;
        this.sensitivity.minSpatialSpread = 0.3;
    }
  }

  /**
   * Quick check to determine if the detected features are promising
   * @param {Array} ledCandidates - Array of LED candidate objects with {x, y} normalized coords
   * @param {Array} stripBlobs - Array of strip blob objects
   * @returns {Object} {promising: boolean, info: string}
   */
  quickCheck(ledCandidates, stripBlobs) {
    const numStrips = stripBlobs ? stripBlobs.length : 0;
    const numLEDs = ledCandidates ? ledCandidates.length : 0;

    // Good scenarios:
    if (numStrips >= 2) {
      return { promising: true, info: `${numStrips} strips detected` };
    }

    if (numLEDs >= 4) {
      return { promising: true, info: `${numLEDs} LED candidates detected` };
    }

    if (numStrips >= 1 && numLEDs >= 2) {
      return { promising: true, info: `${numStrips} strip(s) + ${numLEDs} LEDs detected` };
    }

    return {
      promising: false,
      info: `Insufficient features: ${numStrips} strips, ${numLEDs} LEDs`
    };
  }

  /**
   * Main matching method: matches all detected features to device geometry
   * @param {Array} ledCandidates - Array of LED candidate objects with {x, y, intensity} in normalized coords
   * @param {Array} stripBlobs - Array of strip blob objects with {x, y, bbox, edgeLeft, edgeRight}
   * @param {number} imageAspect - Image aspect ratio (width/height)
   * @returns {Object} Match result with 2D-3D correspondences
   */
  match(ledCandidates, stripBlobs, imageAspect) {
    const result = {
      success: false,
      points2D: [],      // Array of {x, y} in normalized coords
      points3D: [],      // Array of {x, y, z} in mm
      featureIds: [],    // Array of feature ID strings
      ledCount: 0,
      stripCount: 0,
      score: 0,
      diagnostics: {}
    };

    // Step 1: Match strips and extract edge points
    const matchedStrips = this.matchStrips(stripBlobs);
    result.stripCount = matchedStrips.length;
    result.diagnostics.matchedStrips = matchedStrips.map(s => s.id);

    // Step 2: Add strip edge points to correspondences
    for (const strip of matchedStrips) {
      // Left edge
      if (strip.edgeLeft) {
        result.points2D.push({ x: strip.edgeLeft.nx, y: strip.edgeLeft.ny });
        result.points3D.push(this._getEdgePoint3D(strip.id, 'left'));
        result.featureIds.push(`S${strip.id.substring(6)[0]}_L`); // e.g., "ST_L"
      }

      // Right edge
      if (strip.edgeRight) {
        result.points2D.push({ x: strip.edgeRight.nx, y: strip.edgeRight.ny });
        result.points3D.push(this._getEdgePoint3D(strip.id, 'right'));
        result.featureIds.push(`S${strip.id.substring(6)[0]}_R`); // e.g., "ST_R"
      }
    }

    // Step 3: Match LEDs using strips as context
    const matchedLEDs = this.matchLEDs(ledCandidates, matchedStrips);
    result.ledCount = matchedLEDs.length;
    result.diagnostics.matchedLEDs = matchedLEDs.map(led => led.id);

    // Step 4: Add LED points to correspondences
    for (const led of matchedLEDs) {
      result.points2D.push({ x: led.x, y: led.y });
      result.points3D.push(this._getLED3D(led.id));
      result.featureIds.push(led.id);
    }

    // Step 5: Validate results
    const totalFeatures = result.points2D.length;
    const spatialSpread = this._calculateSpatialSpread(result.points2D);

    result.success = (
      totalFeatures >= this.sensitivity.minFeaturesForPnP &&
      spatialSpread >= this.sensitivity.minSpatialSpread
    );

    // Step 6: Calculate match quality score
    result.score = this._calculateMatchScore(
      matchedStrips,
      matchedLEDs,
      totalFeatures,
      spatialSpread
    );

    result.diagnostics.totalFeatures = totalFeatures;
    result.diagnostics.spatialSpread = spatialSpread.toFixed(3);

    return result;
  }

  /**
   * Match detected strip blobs to known strip geometry
   * @param {Array} stripBlobs - Array of strip blob objects
   * @returns {Array} Array of matched strips with assigned IDs
   */
  matchStrips(stripBlobs) {
    if (!stripBlobs || stripBlobs.length === 0) {
      return [];
    }

    // Sort strips by Y position (top to bottom in image = ascending y)
    // Note: In image coords, y=0 is top, y=1 is bottom
    const sortedStrips = [...stripBlobs].sort((a, b) => a.y - b.y);

    const matched = [];

    // Validate strip spacing if we have 2+ strips
    if (sortedStrips.length >= 2) {
      const spacings = [];
      for (let i = 1; i < sortedStrips.length; i++) {
        spacings.push(sortedStrips[i].y - sortedStrips[i - 1].y);
      }

      // Check if spacings are approximately equal (within tolerance)
      const avgSpacing = spacings.reduce((sum, s) => sum + s, 0) / spacings.length;
      const spacingVariation = Math.max(...spacings.map(s => Math.abs(s - avgSpacing) / avgSpacing));

      if (spacingVariation > this.sensitivity.stripSpacingTolerance) {
        console.warn(`Strip spacing inconsistent: variation ${(spacingVariation * 100).toFixed(1)}%`);
        // Continue anyway - we'll use what we have
      }
    }

    // Assign IDs based on position (top to bottom)
    const stripIds = ['STRIP_TOP', 'STRIP_MID', 'STRIP_BOT'];

    for (let i = 0; i < Math.min(sortedStrips.length, 3); i++) {
      matched.push({
        ...sortedStrips[i],
        id: stripIds[i]
      });
    }

    return matched;
  }

  /**
   * Match LED candidates to known LED geometry using strips as anchors
   * @param {Array} ledCandidates - Array of LED candidate objects with {x, y, intensity}
   * @param {Array} matchedStrips - Array of matched strips with IDs
   * @returns {Array} Array of matched LEDs with assigned IDs
   */
  matchLEDs(ledCandidates, matchedStrips) {
    if (!ledCandidates || ledCandidates.length === 0) {
      return [];
    }

    const matched = [];

    // If we have matched strips, use them as spatial anchors
    if (matchedStrips && matchedStrips.length > 0) {
      matched.push(...this._matchLEDsWithStripContext(ledCandidates, matchedStrips));
    } else {
      // Fall back to pattern-based matching (4 corners + 1 top)
      matched.push(...this._matchLEDsPatternBased(ledCandidates));
    }

    return matched;
  }

  // ============================================================================
  // PRIVATE HELPER METHODS
  // ============================================================================

  /**
   * Match LEDs using strip positions as context
   * @private
   */
  _matchLEDsWithStripContext(ledCandidates, matchedStrips) {
    const matched = [];

    // Calculate strip center X (should be near 0.5 in normalized coords)
    const stripCenterX = matchedStrips.reduce((sum, s) => sum + s.x, 0) / matchedStrips.length;

    // Find top and bottom strip Y positions for alignment checking
    const stripYs = matchedStrips.map(s => s.y).sort((a, b) => a - b);
    const topStripY = stripYs[0];
    const bottomStripY = stripYs[stripYs.length - 1];

    // Classify LEDs by position relative to strips
    const leftLEDs = [];   // x < stripCenterX
    const rightLEDs = [];  // x > stripCenterX
    const topLEDs = [];    // y < topStripY (above all strips)

    for (const led of ledCandidates) {
      if (led.y < topStripY - 0.1) { // Well above strips
        topLEDs.push(led);
      } else if (led.x < stripCenterX - this.sensitivity.ledLeftRightThreshold) {
        leftLEDs.push(led);
      } else if (led.x > stripCenterX + this.sensitivity.ledLeftRightThreshold) {
        rightLEDs.push(led);
      }
    }

    // Match LED5 (top center) - should be above all strips, near horizontal center
    if (topLEDs.length > 0) {
      // Find the one closest to horizontal center
      const led5 = topLEDs.reduce((best, led) =>
        Math.abs(led.x - 0.5) < Math.abs(best.x - 0.5) ? led : best
      );
      matched.push({ ...led5, id: 'LED5' });
    }

    // Match right-side LEDs (LED1 and LED2)
    if (rightLEDs.length >= 2) {
      // Sort by Y: top to bottom
      rightLEDs.sort((a, b) => a.y - b.y);
      matched.push({ ...rightLEDs[0], id: 'LED1' }); // Top-right
      matched.push({ ...rightLEDs[1], id: 'LED2' }); // Bottom-right
    } else if (rightLEDs.length === 1) {
      // Only one right LED - assign to LED1 or LED2 based on Y position
      const led = rightLEDs[0];
      const closerToTop = Math.abs(led.y - topStripY) < Math.abs(led.y - bottomStripY);
      matched.push({ ...led, id: closerToTop ? 'LED1' : 'LED2' });
    }

    // Match left-side LEDs (LED3 and LED4)
    if (leftLEDs.length >= 2) {
      // Sort by Y: bottom to top (reversed for left side)
      leftLEDs.sort((a, b) => b.y - a.y);
      matched.push({ ...leftLEDs[0], id: 'LED3' }); // Bottom-left
      matched.push({ ...leftLEDs[1], id: 'LED4' }); // Top-left
    } else if (leftLEDs.length === 1) {
      // Only one left LED - assign to LED3 or LED4 based on Y position
      const led = leftLEDs[0];
      const closerToTop = Math.abs(led.y - topStripY) < Math.abs(led.y - bottomStripY);
      matched.push({ ...led, id: closerToTop ? 'LED4' : 'LED3' });
    }

    return matched;
  }

  /**
   * Match LEDs using geometric pattern (fallback when no strips detected)
   * Expects 4 corner LEDs + 1 top center LED
   * @private
   */
  _matchLEDsPatternBased(ledCandidates) {
    if (ledCandidates.length < 4) {
      return []; // Not enough for pattern matching
    }

    const matched = [];

    // Find bounding box of all LED candidates
    const xs = ledCandidates.map(led => led.x);
    const ys = ledCandidates.map(led => led.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    // Find the 4 corners
    const corners = [
      { led: null, id: 'LED1', targetX: maxX, targetY: minY }, // top-right
      { led: null, id: 'LED2', targetX: maxX, targetY: maxY }, // bottom-right
      { led: null, id: 'LED3', targetX: minX, targetY: maxY }, // bottom-left
      { led: null, id: 'LED4', targetX: minX, targetY: minY }  // top-left
    ];

    // Assign LEDs to corners based on proximity
    const remaining = [...ledCandidates];

    for (const corner of corners) {
      if (remaining.length === 0) break;

      // Find closest LED to this corner target
      let bestIdx = 0;
      let bestDist = Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const led = remaining[i];
        const dist = Math.hypot(led.x - corner.targetX, led.y - corner.targetY);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }

      corner.led = remaining.splice(bestIdx, 1)[0];
      matched.push({ ...corner.led, id: corner.id });
    }

    // If there's a remaining LED and it's significantly above the top corners, assign as LED5
    if (remaining.length > 0) {
      const topCornerY = Math.min(
        matched.find(m => m.id === 'LED1')?.y ?? Infinity,
        matched.find(m => m.id === 'LED4')?.y ?? Infinity
      );

      const topCandidate = remaining.reduce((best, led) =>
        led.y < best.y ? led : best
      );

      if (topCandidate.y < topCornerY - 0.1) {
        matched.push({ ...topCandidate, id: 'LED5' });
      }
    }

    return matched;
  }

  /**
   * Get 3D coordinates for strip edge point
   * @private
   */
  _getEdgePoint3D(stripId, side) {
    const prefix = stripId.substring(6); // Extract "TOP", "MID", or "BOT"
    const edgeId = `S${prefix[0]}_${side === 'left' ? 'L' : 'R'}`; // e.g., "ST_L"

    const edge = DEVICE_GEOMETRY.stripEdges.find(e => e.id === edgeId);
    if (!edge) {
      console.error(`Edge point not found: ${edgeId}`);
      return { x: 0, y: 0, z: 0 };
    }

    return { x: edge.x, y: edge.y, z: edge.z };
  }

  /**
   * Get 3D coordinates for LED
   * @private
   */
  _getLED3D(ledId) {
    const led = DEVICE_GEOMETRY.leds.find(l => l.id === ledId);
    if (!led) {
      console.error(`LED not found: ${ledId}`);
      return { x: 0, y: 0, z: 0 };
    }

    return { x: led.x, y: led.y, z: led.z };
  }

  /**
   * Calculate spatial spread of 2D points (for validation)
   * @private
   */
  _calculateSpatialSpread(points2D) {
    if (points2D.length < 2) return 0;

    const xs = points2D.map(p => p.x);
    const ys = points2D.map(p => p.y);

    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);

    // Return diagonal span in normalized space
    return Math.hypot(spanX, spanY);
  }

  /**
   * Calculate overall match quality score
   * @private
   */
  _calculateMatchScore(matchedStrips, matchedLEDs, totalFeatures, spatialSpread) {
    let score = 0;

    // Strip contribution (40% max)
    const stripScore = Math.min(matchedStrips.length / 3, 1.0) * 40;
    score += stripScore;

    // LED contribution (40% max)
    const ledScore = Math.min(matchedLEDs.length / 5, 1.0) * 40;
    score += ledScore;

    // Spatial spread contribution (20% max)
    const spreadScore = Math.min(spatialSpread / 1.0, 1.0) * 20; // normalized diagonal ≤ ~1.4
    score += spreadScore;

    return Math.round(score);
  }
}

// (No ES module exports — loaded via <script> tag in browser environment)
