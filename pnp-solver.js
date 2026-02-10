// ===================================================================
// Pure JS PnP Solver
// Perspective-n-Point pose estimation without OpenCV
// DLT initial estimate + Levenberg-Marquardt refinement
// ===================================================================

class PnPSolver {
  constructor() {
    // Default camera intrinsics (updated when camera resolution is known)
    this.fx = 1000;
    this.fy = 1000;
    this.cx = 640;
    this.cy = 360;
  }

  /**
   * Update camera intrinsics.
   * @param {number} fx - Focal length X (pixels)
   * @param {number} fy - Focal length Y (pixels)
   * @param {number} cx - Principal point X
   * @param {number} cy - Principal point Y
   */
  setIntrinsics(fx, fy, cx, cy) {
    this.fx = fx;
    this.fy = fy;
    this.cx = cx;
    this.cy = cy;
  }

  /**
   * Estimate camera intrinsics from resolution.
   * @param {number} width - Image width
   * @param {number} height - Image height
   */
  estimateIntrinsics(width, height) {
    const f = 0.9 * Math.max(width, height);
    this.fx = f;
    this.fy = f;
    this.cx = width / 2;
    this.cy = height / 2;
  }

  /**
   * Solve PnP: find rotation and translation from 3D-2D point correspondences.
   * @param {Array<{x,y,z}>} objectPoints - 3D world coordinates (mm)
   * @param {Array<{x,y}>} imagePoints - 2D image coordinates (pixels)
   * @returns {{ success, rvec, tvec, euler, distance, reprojError }}
   */
  solve(objectPoints, imagePoints) {
    if (objectPoints.length < 4 || objectPoints.length !== imagePoints.length) {
      return { success: false, error: 'Need at least 4 point correspondences' };
    }

    const n = objectPoints.length;

    // Step 1: Normalize image points
    const normImgPts = imagePoints.map(p => ({
      x: (p.x - this.cx) / this.fx,
      y: (p.y - this.cy) / this.fy
    }));

    // Step 2: DLT initial estimate
    const initial = this._dltEstimate(objectPoints, normImgPts);
    if (!initial) {
      return { success: false, error: 'DLT failed' };
    }

    // Step 3: Levenberg-Marquardt refinement
    const refined = this._levenbergMarquardt(objectPoints, normImgPts, initial.R, initial.t);

    // Step 4: Compute reprojection error
    const reprojError = this._computeReprojError(objectPoints, imagePoints, refined.R, refined.t);

    // Step 5: Convert rotation matrix to Euler angles and Rodrigues vector
    const euler = this._rotMatToEuler(refined.R);
    const rvec = this._rotMatToRodrigues(refined.R);
    const tvec = refined.t;

    // Distance in meters
    const distance = Math.sqrt(tvec[0] * tvec[0] + tvec[1] * tvec[1] + tvec[2] * tvec[2]) / 1000;

    return {
      success: true,
      rvec,
      tvec,
      euler, // { roll, pitch, yaw } in degrees
      distance,
      reprojError,
      R: refined.R
    };
  }

  // --- DLT (Direct Linear Transform) ---

  _dltEstimate(objPts, normImgPts) {
    const n = objPts.length;

    // Build the 2n x 12 matrix for DLT
    const A = [];
    for (let i = 0; i < n; i++) {
      const X = objPts[i].x, Y = objPts[i].y, Z = objPts[i].z;
      const u = normImgPts[i].x, v = normImgPts[i].y;

      A.push([X, Y, Z, 1, 0, 0, 0, 0, -u * X, -u * Y, -u * Z, -u]);
      A.push([0, 0, 0, 0, X, Y, Z, 1, -v * X, -v * Y, -v * Z, -v]);
    }

    // Solve Ax = 0 via SVD (find null space)
    const svdResult = this._svd(A);
    if (!svdResult) return null;

    // Last column of V is the solution
    const p = svdResult.V.map(row => row[row.length - 1]);

    // Reconstruct projection matrix P = [p1 p2 p3 p4] as 3x4
    const P = [
      [p[0], p[1], p[2], p[3]],
      [p[4], p[5], p[6], p[7]],
      [p[8], p[9], p[10], p[11]]
    ];

    // Extract R and t from P
    // P = [R | t] (since we already normalized by intrinsics)
    const R_approx = [
      [P[0][0], P[0][1], P[0][2]],
      [P[1][0], P[1][1], P[1][2]],
      [P[2][0], P[2][1], P[2][2]]
    ];
    const t = [P[0][3], P[1][3], P[2][3]];

    // Enforce rotation matrix constraint via SVD
    const R = this._closestRotationMatrix(R_approx);

    // Fix scale: det(R) should be 1, and t should be consistent
    const scale = this._matNorm(R_approx) / this._matNorm(R);
    const t_scaled = [t[0] / scale, t[1] / scale, t[2] / scale];

    // Ensure z is positive (camera looks at positive z)
    if (t_scaled[2] < 0) {
      // Flip
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) R[i][j] = -R[i][j];
        t_scaled[i] = -t_scaled[i];
      }
    }

    return { R, t: t_scaled };
  }

  // --- Levenberg-Marquardt Refinement ---

  _levenbergMarquardt(objPts, normImgPts, R0, t0, maxIter = 30) {
    // Parameterize rotation as Rodrigues vector (3 params) + translation (3 params)
    let rvec = this._rotMatToRodrigues(R0);
    let tvec = [...t0];
    let lambda = 0.001;

    for (let iter = 0; iter < maxIter; iter++) {
      const R = this._rodrigues(rvec);
      const { residuals, J } = this._computeJacobian(objPts, normImgPts, R, tvec, rvec);

      // Normal equations: (J^T J + lambda * diag(J^T J)) * delta = J^T * residuals
      const JtJ = this._matMulTranspose(J);
      const Jtr = this._matVecMulTranspose(J, residuals);

      // Add damping
      for (let i = 0; i < 6; i++) {
        JtJ[i][i] *= (1 + lambda);
      }

      // Solve 6x6 linear system
      const delta = this._solve6x6(JtJ, Jtr);
      if (!delta) break;

      // Update parameters
      const newRvec = [rvec[0] + delta[0], rvec[1] + delta[1], rvec[2] + delta[2]];
      const newTvec = [tvec[0] + delta[3], tvec[1] + delta[4], tvec[2] + delta[5]];

      // Compute new error
      const newR = this._rodrigues(newRvec);
      const newResiduals = this._computeResiduals(objPts, normImgPts, newR, newTvec);
      const oldErr = residuals.reduce((s, r) => s + r * r, 0);
      const newErr = newResiduals.reduce((s, r) => s + r * r, 0);

      if (newErr < oldErr) {
        rvec = newRvec;
        tvec = newTvec;
        lambda *= 0.5;
        if (Math.abs(oldErr - newErr) < 1e-10) break;
      } else {
        lambda *= 2;
      }
    }

    return { R: this._rodrigues(rvec), t: tvec };
  }

  _computeResiduals(objPts, normImgPts, R, t) {
    const residuals = [];
    for (let i = 0; i < objPts.length; i++) {
      const X = objPts[i].x, Y = objPts[i].y, Z = objPts[i].z;
      const px = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0];
      const py = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1];
      const pz = R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2];

      if (Math.abs(pz) < 1e-10) {
        residuals.push(0, 0);
        continue;
      }

      const u_proj = px / pz;
      const v_proj = py / pz;

      residuals.push(u_proj - normImgPts[i].x);
      residuals.push(v_proj - normImgPts[i].y);
    }
    return residuals;
  }

  _computeJacobian(objPts, normImgPts, R, t, rvec) {
    const n = objPts.length;
    const residuals = [];
    const J = []; // 2n x 6 Jacobian

    const eps = 1e-6;

    // Compute residuals at current parameters
    for (let i = 0; i < n; i++) {
      const X = objPts[i].x, Y = objPts[i].y, Z = objPts[i].z;
      const px = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0];
      const py = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1];
      const pz = R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2];

      const invZ = Math.abs(pz) > 1e-10 ? 1.0 / pz : 0;
      const u_proj = px * invZ;
      const v_proj = py * invZ;

      residuals.push(u_proj - normImgPts[i].x);
      residuals.push(v_proj - normImgPts[i].y);
    }

    // Numerical Jacobian (finite differences)
    const params = [...rvec, ...t];
    for (let i = 0; i < 2 * n; i++) {
      J.push(new Array(6).fill(0));
    }

    for (let j = 0; j < 6; j++) {
      const paramPlus = [...params];
      paramPlus[j] += eps;

      const Rp = this._rodrigues([paramPlus[0], paramPlus[1], paramPlus[2]]);
      const tp = [paramPlus[3], paramPlus[4], paramPlus[5]];

      for (let i = 0; i < n; i++) {
        const X = objPts[i].x, Y = objPts[i].y, Z = objPts[i].z;
        const px = Rp[0][0] * X + Rp[0][1] * Y + Rp[0][2] * Z + tp[0];
        const py = Rp[1][0] * X + Rp[1][1] * Y + Rp[1][2] * Z + tp[1];
        const pz = Rp[2][0] * X + Rp[2][1] * Y + Rp[2][2] * Z + tp[2];

        const invZ = Math.abs(pz) > 1e-10 ? 1.0 / pz : 0;
        const u_p = px * invZ;
        const v_p = py * invZ;

        J[2 * i][j] = (u_p - normImgPts[i].x - residuals[2 * i]) / eps;
        J[2 * i + 1][j] = (v_p - normImgPts[i].y - residuals[2 * i + 1]) / eps;
      }
    }

    return { residuals, J };
  }

  // --- Rotation conversions ---

  /**
   * Rodrigues vector to rotation matrix.
   */
  _rodrigues(rvec) {
    const theta = Math.sqrt(rvec[0] * rvec[0] + rvec[1] * rvec[1] + rvec[2] * rvec[2]);

    if (theta < 1e-10) {
      return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    }

    const k = [rvec[0] / theta, rvec[1] / theta, rvec[2] / theta];
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    const vt = 1 - ct;

    return [
      [ct + k[0] * k[0] * vt,       k[0] * k[1] * vt - k[2] * st, k[0] * k[2] * vt + k[1] * st],
      [k[1] * k[0] * vt + k[2] * st, ct + k[1] * k[1] * vt,       k[1] * k[2] * vt - k[0] * st],
      [k[2] * k[0] * vt - k[1] * st, k[2] * k[1] * vt + k[0] * st, ct + k[2] * k[2] * vt]
    ];
  }

  /**
   * Rotation matrix to Rodrigues vector.
   */
  _rotMatToRodrigues(R) {
    const theta = Math.acos(Math.max(-1, Math.min(1, (R[0][0] + R[1][1] + R[2][2] - 1) / 2)));

    if (theta < 1e-10) {
      return [0, 0, 0];
    }

    const factor = theta / (2 * Math.sin(theta));
    return [
      factor * (R[2][1] - R[1][2]),
      factor * (R[0][2] - R[2][0]),
      factor * (R[1][0] - R[0][1])
    ];
  }

  /**
   * Rotation matrix to Euler angles (Roll, Pitch, Yaw) in degrees.
   */
  _rotMatToEuler(R) {
    const sy = Math.sqrt(R[0][0] * R[0][0] + R[1][0] * R[1][0]);
    const singular = sy < 1e-6;

    let roll, pitch, yaw;
    if (!singular) {
      roll = Math.atan2(R[2][1], R[2][2]);
      pitch = Math.atan2(-R[2][0], sy);
      yaw = Math.atan2(R[1][0], R[0][0]);
    } else {
      roll = Math.atan2(-R[1][2], R[1][1]);
      pitch = Math.atan2(-R[2][0], sy);
      yaw = 0;
    }

    const toDeg = 180 / Math.PI;
    return {
      roll: roll * toDeg,
      pitch: pitch * toDeg,
      yaw: yaw * toDeg
    };
  }

  // --- Matrix utilities ---

  /**
   * Compact SVD for small matrices using Jacobi method.
   */
  _svd(A) {
    const m = A.length;
    const n = A[0].length;

    // Compute A^T A
    const AtA = [];
    for (let i = 0; i < n; i++) {
      AtA.push(new Array(n).fill(0));
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < m; k++) {
          AtA[i][j] += A[k][i] * A[k][j];
        }
      }
    }

    // Jacobi eigendecomposition of AtA
    const { eigenvalues, eigenvectors } = this._jacobiEigen(AtA, n);

    // Sort by eigenvalue (ascending - we want smallest)
    const indices = eigenvalues.map((v, i) => i);
    indices.sort((a, b) => eigenvalues[a] - eigenvalues[b]);

    // V matrix (columns are eigenvectors, sorted by eigenvalue)
    const V = [];
    for (let i = 0; i < n; i++) {
      V.push(indices.map(idx => eigenvectors[i][idx]));
    }

    return { V };
  }

  /**
   * Jacobi eigendecomposition for symmetric matrices.
   */
  _jacobiEigen(A, n, maxIter = 100) {
    // Copy A
    const S = A.map(row => [...row]);
    // V starts as identity
    const V = [];
    for (let i = 0; i < n; i++) {
      V.push(new Array(n).fill(0));
      V[i][i] = 1;
    }

    for (let iter = 0; iter < maxIter; iter++) {
      // Find largest off-diagonal element
      let maxVal = 0, p = 0, q = 1;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (Math.abs(S[i][j]) > maxVal) {
            maxVal = Math.abs(S[i][j]);
            p = i;
            q = j;
          }
        }
      }

      if (maxVal < 1e-12) break;

      // Compute rotation
      const theta = 0.5 * Math.atan2(2 * S[p][q], S[p][p] - S[q][q]);
      const c = Math.cos(theta);
      const s = Math.sin(theta);

      // Apply rotation to S
      const Sp = [];
      const Sq = [];
      for (let i = 0; i < n; i++) {
        Sp.push(c * S[i][p] + s * S[i][q]);
        Sq.push(-s * S[i][p] + c * S[i][q]);
      }
      for (let i = 0; i < n; i++) {
        S[i][p] = Sp[i];
        S[i][q] = Sq[i];
      }
      for (let j = 0; j < n; j++) {
        const tmp = c * S[p][j] + s * S[q][j];
        S[q][j] = -s * S[p][j] + c * S[q][j];
        S[p][j] = tmp;
      }

      // Apply rotation to V
      for (let i = 0; i < n; i++) {
        const tmp = c * V[i][p] + s * V[i][q];
        V[i][q] = -s * V[i][p] + c * V[i][q];
        V[i][p] = tmp;
      }
    }

    const eigenvalues = [];
    for (let i = 0; i < n; i++) {
      eigenvalues.push(S[i][i]);
    }

    return { eigenvalues, eigenvectors: V };
  }

  /**
   * Find closest rotation matrix to a given 3x3 matrix (via SVD).
   */
  _closestRotationMatrix(M) {
    // SVD of M = U * S * Vt
    // Closest R = U * Vt (with det correction)
    const MtM = this._mat3x3Mul(this._mat3x3Transpose(M), M);
    const { eigenvalues, eigenvectors: V } = this._jacobiEigen(
      [MtM[0].slice(), MtM[1].slice(), MtM[2].slice()], 3
    );

    // S_inv = diag(1/sqrt(eigenvalue))
    const S_inv = eigenvalues.map(v => v > 1e-10 ? 1 / Math.sqrt(v) : 0);

    // R = M * V * S_inv * Vt
    const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          let sum = 0;
          for (let l = 0; l < 3; l++) {
            sum += V[k][l] * S_inv[l] * V[j][l];
          }
          R[i][j] += M[i][k] * sum;
        }
      }
    }

    // Ensure det(R) = 1
    const det = this._det3x3(R);
    if (det < 0) {
      for (let i = 0; i < 3; i++) R[i][2] = -R[i][2];
    }

    return R;
  }

  _mat3x3Mul(A, B) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        for (let k = 0; k < 3; k++)
          C[i][j] += A[i][k] * B[k][j];
    return C;
  }

  _mat3x3Transpose(A) {
    return [
      [A[0][0], A[1][0], A[2][0]],
      [A[0][1], A[1][1], A[2][1]],
      [A[0][2], A[1][2], A[2][2]]
    ];
  }

  _det3x3(M) {
    return M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
         - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
         + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  }

  _matNorm(M) {
    let sum = 0;
    for (const row of M) for (const v of row) sum += v * v;
    return Math.sqrt(sum);
  }

  /**
   * J^T * J (for 2n x 6 Jacobian -> 6x6 result)
   */
  _matMulTranspose(J) {
    const m = J.length;
    const n = J[0].length;
    const result = [];
    for (let i = 0; i < n; i++) {
      result.push(new Array(n).fill(0));
      for (let j = 0; j < n; j++) {
        for (let k = 0; k < m; k++) {
          result[i][j] += J[k][i] * J[k][j];
        }
      }
    }
    return result;
  }

  /**
   * J^T * r (for 2n x 6 Jacobian, 2n residuals -> 6-vector)
   */
  _matVecMulTranspose(J, r) {
    const n = J[0].length;
    const m = J.length;
    const result = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < m; k++) {
        result[i] += J[k][i] * r[k];
      }
    }
    return result;
  }

  /**
   * Solve 6x6 linear system Ax = b via Gaussian elimination with partial pivoting.
   */
  _solve6x6(A, b) {
    const n = 6;
    // Augmented matrix
    const aug = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
      // Partial pivoting
      let maxRow = col;
      let maxVal = Math.abs(aug[col][col]);
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(aug[row][col]) > maxVal) {
          maxVal = Math.abs(aug[row][col]);
          maxRow = row;
        }
      }
      if (maxVal < 1e-12) return null; // Singular

      // Swap rows
      if (maxRow !== col) {
        [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      }

      // Eliminate
      const pivot = aug[col][col];
      for (let row = col + 1; row < n; row++) {
        const factor = aug[row][col] / pivot;
        for (let j = col; j <= n; j++) {
          aug[row][j] -= factor * aug[col][j];
        }
      }
    }

    // Back substitution
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let sum = aug[i][n];
      for (let j = i + 1; j < n; j++) {
        sum -= aug[i][j] * x[j];
      }
      x[i] = sum / aug[i][i];
    }

    return x;
  }

  /**
   * Compute reprojection error (RMS in pixels).
   */
  _computeReprojError(objPts, imgPts, R, t) {
    let sumSq = 0;
    const n = objPts.length;

    for (let i = 0; i < n; i++) {
      const X = objPts[i].x, Y = objPts[i].y, Z = objPts[i].z;
      const px = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0];
      const py = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1];
      const pz = R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2];

      if (Math.abs(pz) < 1e-10) continue;

      const u_proj = this.fx * (px / pz) + this.cx;
      const v_proj = this.fy * (py / pz) + this.cy;

      const dx = u_proj - imgPts[i].x;
      const dy = v_proj - imgPts[i].y;
      sumSq += dx * dx + dy * dy;
    }

    return Math.sqrt(sumSq / n);
  }
}
