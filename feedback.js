// ===================================================================
// Visual and Audio Feedback System
// Provides real-time feedback during LED scanning and tracking
// ===================================================================

class FeedbackManager {
  constructor() {
    this.audioCtx = null;
    this.lastBeepTime = 0;
    this.minBeepInterval = 400; // ms between beeps
    this.audioEnabled = true;

    // Visual state
    this.state = 'idle'; // 'idle' | 'scanning' | 'candidate' | 'locked' | 'tracking'
    this.stateStartTime = 0;
    this.scanPulse = 0;

    // Candidate info
    this.candidateCenter = null;
    this.candidateCount = 0;
  }

  /**
   * Initialize audio (must be called on user gesture).
   */
  initAudio() {
    if (this.audioCtx) return;
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio API not available');
      this.audioEnabled = false;
    }
  }

  /**
   * Set the current detection state.
   */
  setState(newState, data = {}) {
    const prevState = this.state;
    this.state = newState;

    if (newState !== prevState) {
      this.stateStartTime = performance.now();

      // Audio feedback on state transitions
      if (newState === 'candidate' && prevState === 'scanning') {
        this._beep(440, 100, 0.3);
      } else if (newState === 'locked') {
        this._doubleBeep();
      }
    }

    if (data.candidateCenter) this.candidateCenter = data.candidateCenter;
    if (data.candidateCount !== undefined) this.candidateCount = data.candidateCount;
  }

  /**
   * Draw visual feedback on the overlay canvas.
   * @param {CanvasRenderingContext2D} ctx - Overlay canvas context
   * @param {number} width - Canvas width
   * @param {number} height - Canvas height
   * @param {Object} data - Current detection data
   */
  draw(ctx, width, height, data = {}) {
    const now = performance.now();
    const stateAge = now - this.stateStartTime;
    this.scanPulse = (Math.sin(now / 500) + 1) / 2; // 0-1 pulsing

    ctx.clearRect(0, 0, width, height);

    switch (this.state) {
      case 'scanning':
        this._drawScanning(ctx, width, height, data, stateAge);
        break;
      case 'candidate':
        this._drawCandidate(ctx, width, height, data, stateAge);
        break;
      case 'locked':
      case 'tracking':
        this._drawLocked(ctx, width, height, data, stateAge);
        break;
    }

    // Always draw HUD
    this._drawHUD(ctx, width, height, data);
  }

  // --- Private drawing methods ---

  _drawScanning(ctx, w, h, data, age) {
    // Crosshair
    const cx = w / 2, cy = h / 2;
    const size = Math.min(w, h) * 0.08;
    const alpha = 0.3 + this.scanPulse * 0.3;

    ctx.strokeStyle = `rgba(100, 180, 255, ${alpha})`;
    ctx.lineWidth = 1.5;

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(cx - size, cy);
    ctx.lineTo(cx + size, cy);
    ctx.stroke();

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(cx, cy - size);
    ctx.lineTo(cx, cy + size);
    ctx.stroke();

    // Scanning ring
    const ringRadius = size * 1.5;
    const startAngle = (age / 1000) * Math.PI;
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, startAngle, startAngle + Math.PI * 1.2);
    ctx.stroke();

    // Draw candidate blobs
    if (data.candidates) {
      ctx.fillStyle = 'rgba(100, 180, 255, 0.4)';
      for (const c of data.candidates) {
        ctx.beginPath();
        ctx.arc(c.x * w, c.y * h, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _drawCandidate(ctx, w, h, data, age) {
    // Yellow highlight for candidate region
    if (this.candidateCenter) {
      const cx = this.candidateCenter.x * w;
      const cy = this.candidateCenter.y * h;
      const boxSize = Math.min(w, h) * 0.15;

      const alpha = 0.4 + this.scanPulse * 0.3;
      ctx.strokeStyle = `rgba(255, 220, 50, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(cx - boxSize, cy - boxSize, boxSize * 2, boxSize * 2);
      ctx.setLineDash([]);
    }

    // Draw candidate blobs in yellow
    if (data.candidates) {
      ctx.fillStyle = 'rgba(255, 220, 50, 0.6)';
      for (const c of data.candidates) {
        ctx.beginPath();
        ctx.arc(c.x * w, c.y * h, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _drawLocked(ctx, w, h, data, age) {
    if (!data.points || data.points.length < 5) return;

    const pts = data.points;

    // Draw connecting lines for rectangle (LED 1-2-3-4)
    const rectPts = pts.filter(p => p.id <= 4).sort((a, b) => a.id - b.id);
    if (rectPts.length === 4) {
      ctx.strokeStyle = 'rgba(50, 200, 100, 0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(rectPts[0].x * w, rectPts[0].y * h);
      for (let i = 1; i < 4; i++) {
        ctx.lineTo(rectPts[i].x * w, rectPts[i].y * h);
      }
      ctx.closePath();
      ctx.stroke();

      // Draw center to LED5 connection
      const led5 = pts.find(p => p.id === 5);
      if (led5) {
        const centerX = rectPts.reduce((s, p) => s + p.x, 0) / 4;
        const centerY = rectPts.reduce((s, p) => s + p.y, 0) / 4;

        ctx.strokeStyle = 'rgba(50, 200, 100, 0.5)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(centerX * w, centerY * h);
        ctx.lineTo(led5.x * w, led5.y * h);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw LED markers
    for (const p of pts) {
      const px = p.x * w;
      const py = p.y * h;
      const radius = 6;

      if (p.id === 5) {
        // LED5: green circle
        ctx.fillStyle = 'rgba(50, 220, 100, 0.9)';
      } else {
        // LED 1-4: blue circle
        ctx.fillStyle = 'rgba(50, 150, 255, 0.9)';
      }

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fill();

      // ID label
      ctx.fillStyle = '#fff';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(p.id.toString(), px, py - radius - 3);
    }

    // Draw 3D axes if pose is available
    if (data.pose) {
      this._draw3DAxes(ctx, w, h, data.pose, pts);
    }
  }

  _draw3DAxes(ctx, w, h, pose, pts) {
    // Simple axis indicator at the center of the detected pattern
    const centerX = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const centerY = pts.reduce((s, p) => s + p.y, 0) / pts.length;

    const cx = centerX * w;
    const cy = centerY * h;
    const axisLen = 20;

    // X axis (red)
    ctx.strokeStyle = 'rgba(255, 50, 50, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + axisLen, cy);
    ctx.stroke();

    // Y axis (green)
    ctx.strokeStyle = 'rgba(50, 255, 50, 0.8)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - axisLen);
    ctx.stroke();

    // Z axis (blue, diagonal to suggest depth)
    ctx.strokeStyle = 'rgba(50, 100, 255, 0.8)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - axisLen * 0.5, cy + axisLen * 0.5);
    ctx.stroke();
  }

  _drawHUD(ctx, w, h, data) {
    const padding = 16;

    // Status text (top-left)
    ctx.font = '14px monospace';
    ctx.textAlign = 'left';

    const statusMessages = {
      idle: '-- 等待啟動 --',
      scanning: '🔍 掃描中...',
      candidate: '📡 發現候選結構...',
      locked: '🎯 結構鎖定!',
      tracking: '📍 追蹤定位中'
    };

    const statusColors = {
      idle: 'rgba(150, 150, 150, 0.8)',
      scanning: 'rgba(100, 180, 255, 0.9)',
      candidate: 'rgba(255, 220, 50, 0.9)',
      locked: 'rgba(50, 220, 100, 0.9)',
      tracking: 'rgba(50, 220, 100, 0.9)'
    };

    // Background strip for status
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, w, 36);

    ctx.fillStyle = statusColors[this.state] || '#fff';
    ctx.fillText(statusMessages[this.state] || '', padding, 24);

    // Candidate count
    if (data.candidateCount !== undefined) {
      ctx.fillStyle = 'rgba(200, 200, 200, 0.7)';
      ctx.textAlign = 'right';
      ctx.fillText(`候選: ${data.candidateCount}`, w - padding, 24);
    }

    // Distance and pose info (bottom area)
    if (data.distance !== undefined && (this.state === 'locked' || this.state === 'tracking')) {
      // Bottom bar
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillRect(0, h - 80, w, 80);

      // Distance (large)
      ctx.font = 'bold 28px monospace';
      ctx.fillStyle = 'rgba(50, 220, 100, 0.95)';
      ctx.textAlign = 'center';
      ctx.fillText(`${data.distance.toFixed(2)} m`, w / 2, h - 45);

      // Pose details
      if (data.euler) {
        ctx.font = '12px monospace';
        ctx.fillStyle = 'rgba(200, 200, 200, 0.8)';
        ctx.fillText(
          `R: ${data.euler.roll.toFixed(1)}° P: ${data.euler.pitch.toFixed(1)}° Y: ${data.euler.yaw.toFixed(1)}°`,
          w / 2, h - 18
        );
      }

      if (data.position) {
        ctx.font = '11px monospace';
        ctx.fillStyle = 'rgba(180, 180, 180, 0.7)';
        ctx.textAlign = 'left';
        ctx.fillText(
          `X:${data.position[0].toFixed(0)} Y:${data.position[1].toFixed(0)} Z:${data.position[2].toFixed(0)} mm`,
          padding, h - 18
        );
      }

      // Stability bar
      if (data.stability !== undefined) {
        const barWidth = 80;
        const barHeight = 4;
        const barX = w - padding - barWidth;
        const barY = h - 22;

        ctx.fillStyle = 'rgba(50, 50, 50, 0.8)';
        ctx.fillRect(barX, barY, barWidth, barHeight);

        const fillColor = data.stability > 0.8 ? 'rgba(50, 220, 100, 0.9)' :
                         data.stability > 0.5 ? 'rgba(255, 220, 50, 0.9)' :
                         'rgba(255, 80, 50, 0.9)';
        ctx.fillStyle = fillColor;
        ctx.fillRect(barX, barY, barWidth * data.stability, barHeight);

        ctx.font = '10px monospace';
        ctx.fillStyle = 'rgba(180, 180, 180, 0.7)';
        ctx.textAlign = 'right';
        ctx.fillText(`穩定: ${(data.stability * 100).toFixed(0)}%`, w - padding, barY - 3);
      }
    }

    // FPS counter (top-right, small)
    if (data.fps !== undefined) {
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(150, 150, 150, 0.5)';
      ctx.textAlign = 'right';
      ctx.fillText(`${data.fps} FPS`, w - padding, 12);
    }
  }

  // --- Audio methods ---

  _beep(frequency, duration, volume = 0.3) {
    if (!this.audioEnabled || !this.audioCtx) return;

    const now = performance.now();
    if (now - this.lastBeepTime < this.minBeepInterval) return;
    this.lastBeepTime = now;

    try {
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.frequency.value = frequency;
      gain.gain.value = volume;
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + duration / 1000);
      osc.start();
      osc.stop(this.audioCtx.currentTime + duration / 1000 + 0.05);
    } catch (e) {
      // Ignore audio errors
    }
  }

  _doubleBeep() {
    this._beep(440, 80, 0.3);
    setTimeout(() => {
      this.lastBeepTime = 0; // Reset to allow second beep
      this._beep(880, 80, 0.3);
    }, 120);
  }
}
