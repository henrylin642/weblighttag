// ===================================================================
// Simple 1D Kalman Filter for LED Tracking
// Smooths position estimates and reduces jitter
// ===================================================================

class SimpleKalman {
  constructor(processNoise = 0.01, measurementNoise = 1.0) {
    this.Q = processNoise;       // Process noise
    this.R = measurementNoise;   // Measurement noise
    this.x = 0;                  // State estimate
    this.P = 1;                  // Estimate covariance
    this.initialized = false;
  }

  /**
   * Update the filter with a new measurement.
   * @param {number} measurement - New measurement value
   * @returns {number} Filtered estimate
   */
  update(measurement) {
    if (!this.initialized) {
      this.x = measurement;
      this.P = 1;
      this.initialized = true;
      return this.x;
    }

    // Predict
    const P_pred = this.P + this.Q;

    // Update
    const K = P_pred / (P_pred + this.R);
    this.x = this.x + K * (measurement - this.x);
    this.P = (1 - K) * P_pred;

    return this.x;
  }

  /**
   * Get current estimate without new measurement (predict only).
   */
  predict() {
    return this.x;
  }

  /**
   * Reset the filter state.
   */
  reset() {
    this.x = 0;
    this.P = 1;
    this.initialized = false;
  }
}

/**
 * Manages Kalman filters for tracking multiple feature positions.
 * Supports dynamic feature IDs (LEDs, strip edges, etc.)
 */
class LEDTracker {
  constructor(config = {}) {
    this.processNoise = config.processNoise || 0.005;
    this.measurementNoise = config.measurementNoise || 0.5;
    this.maxLostFrames = config.maxLostFrames || 3;
    this.minTrackingFeatures = config.minTrackingFeatures || 4;

    // Dynamic feature IDs — supports both LED and strip edge features
    // Default: 5 LEDs + 6 strip edges = 11 features
    this.featureIds = config.featureIds || [
      'LED1', 'LED2', 'LED3', 'LED4', 'LED5',
      'ST_L', 'ST_R', 'SM_L', 'SM_R', 'SB_L', 'SB_R'
    ];

    this.filters = {};
    this.lostCount = {};
    this.lastPositions = {};

    for (const id of this.featureIds) {
      this.filters[id] = {
        x: new SimpleKalman(this.processNoise, this.measurementNoise),
        y: new SimpleKalman(this.processNoise, this.measurementNoise)
      };
      this.lostCount[id] = 0;
      this.lastPositions[id] = null;
    }

    this.isTracking = false;
    this.consecutiveLost = 0;
  }

  /**
   * Update tracking with new detected positions.
   * @param {Array<{id: string, x: number, y: number}>} detectedPoints - Detected feature positions (normalized 0-1)
   * @returns {{ tracked: Array, isTracking: boolean, stability: number }}
   */
  update(detectedPoints) {
    const tracked = [];
    let trackedCount = 0;

    for (const id of this.featureIds) {
      const det = detectedPoints.find(p => p.id === id);

      if (det) {
        const fx = this.filters[id].x.update(det.x);
        const fy = this.filters[id].y.update(det.y);
        this.lostCount[id] = 0;
        this.lastPositions[id] = { x: fx, y: fy };
        tracked.push({ id, x: fx, y: fy, detected: true });
        trackedCount++;
      } else {
        this.lostCount[id]++;
        if (this.lostCount[id] <= this.maxLostFrames && this.lastPositions[id]) {
          // Use predicted position
          const fx = this.filters[id].x.predict();
          const fy = this.filters[id].y.predict();
          tracked.push({ id, x: fx, y: fy, detected: false, predicted: true });
          trackedCount++;
        }
      }
    }

    if (trackedCount >= this.minTrackingFeatures) {
      this.consecutiveLost = 0;
      this.isTracking = true;
    } else {
      this.consecutiveLost++;
      if (this.consecutiveLost > this.maxLostFrames) {
        this.isTracking = false;
      }
    }

    // Stability: percentage of tracked features (smoothed)
    const stability = trackedCount / this.featureIds.length;

    return { tracked, isTracking: this.isTracking, stability };
  }

  /**
   * Get predicted positions for search windows.
   * @returns {Array<{id: string, x: number, y: number}>} Predicted positions for all tracked features
   */
  getPredictions() {
    const predictions = [];
    for (const id of this.featureIds) {
      if (this.lastPositions[id]) {
        predictions.push({
          id,
          x: this.filters[id].x.predict(),
          y: this.filters[id].y.predict()
        });
      }
    }
    return predictions;
  }

  /**
   * Reset all tracking state.
   */
  reset() {
    for (const id of this.featureIds) {
      this.filters[id].x.reset();
      this.filters[id].y.reset();
      this.lostCount[id] = 0;
      this.lastPositions[id] = null;
    }
    this.isTracking = false;
    this.consecutiveLost = 0;
  }

  /**
   * Reconfigure tracked feature IDs at runtime.
   * Resets all filters and creates new ones for the new ID set.
   * @param {Array<string>} ids - New feature ID array
   */
  setFeatureIds(ids) {
    this.featureIds = ids;
    this.filters = {};
    this.lostCount = {};
    this.lastPositions = {};

    for (const id of this.featureIds) {
      this.filters[id] = {
        x: new SimpleKalman(this.processNoise, this.measurementNoise),
        y: new SimpleKalman(this.processNoise, this.measurementNoise)
      };
      this.lostCount[id] = 0;
      this.lastPositions[id] = null;
    }

    this.isTracking = false;
    this.consecutiveLost = 0;
  }
}
