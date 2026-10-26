// Sculpt Scan core: depth fusion -> watertight mesh -> OBJ.
// Pure JavaScript (no three.js), so it can be tested outside the browser.
//
// Coordinates are the selection box's local frame, in metres:
//   x: -w/2 .. w/2,  y: 0 (base cut) .. h,  z: -d/2 .. d/2
// Signed distance convention: positive = outside (air), negative = inside the object.

export class Volume {
  constructor(w, h, d, maxCells = 96) {
    this.w = w; this.h = h; this.d = d;
    this.voxel = Math.max(0.003, Math.max(w, h, d) / maxCells);
    this.nx = Math.max(2, Math.ceil(w / this.voxel) + 1);
    this.ny = Math.max(2, Math.ceil(h / this.voxel) + 1);
    this.nz = Math.max(2, Math.ceil(d / this.voxel) + 1);
    this.ox = -w / 2; this.oy = 0; this.oz = -d / 2;     // grid origin (local)
    const N = this.nx * this.ny * this.nz;
    this.tsdf = new Float32Array(N);
    this.wt = new Float32Array(N);
    // air seen through by the sensor, on a coarser grid (fills in quickly from sparse rays)
    this.fc = 3;
    this.fnx = Math.ceil(this.nx / this.fc); this.fny = Math.ceil(this.ny / this.fc); this.fnz = Math.ceil(this.nz / this.fc);
    this.free = new Uint8Array(this.fnx * this.fny * this.fnz);
    this.trunc = Math.max(3 * this.voxel, 0.012);
    this.baseIgnore = 0.012;   // metres above the base cut where up-facing hits count as the table
    this.points = 0;
  }
  idx(i, j, k) { return (k * this.ny + j) * this.nx + i; }
  inside(p) {
    return p[0] >= -this.w / 2 && p[0] <= this.w / 2 && p[1] >= 0 && p[1] <= this.h && p[2] >= -this.d / 2 && p[2] <= this.d / 2;
  }

  // one surface sample: p = point, n = unit normal facing the sensor, cam = sensor position (all local)
  addPoint(p, n, cam) {
    // keep the normal facing the sensor
    const vx = cam[0] - p[0], vy = cam[1] - p[1], vz = cam[2] - p[2];
    if (n[0] * vx + n[1] * vy + n[2] * vz < 0) n = [-n[0], -n[1], -n[2]];
    this.carve(cam, p);
    if (!this.inside(p)) return false;
    // table/floor hits that noise pushed just above the base line: flat, facing up, near y = 0
    if (p[1] < this.baseIgnore && n[1] > 0.75) return false;
    const vs = this.voxel, T = this.trunc, R = Math.ceil(T / vs);
    const ci = Math.round((p[0] - this.ox) / vs), cj = Math.round((p[1] - this.oy) / vs), ck = Math.round((p[2] - this.oz) / vs);
    const perpMax2 = (1.6 * vs) ** 2;
    for (let k = ck - R; k <= ck + R; k++) {
      if (k < 0 || k >= this.nz) continue;
      for (let j = cj - R; j <= cj + R; j++) {
        if (j < 0 || j >= this.ny) continue;
        for (let i = ci - R; i <= ci + R; i++) {
          if (i < 0 || i >= this.nx) continue;
          const dx = this.ox + i * vs - p[0], dy = this.oy + j * vs - p[1], dz = this.oz + k * vs - p[2];
          const sd = dx * n[0] + dy * n[1] + dz * n[2];
          if (sd > T || sd < -T) continue;
          const perp2 = dx * dx + dy * dy + dz * dz - sd * sd;
          if (perp2 > perpMax2) continue;
          const a = this.idx(i, j, k);
          const w = 1 - perp2 / perpMax2 * 0.5;
          const W = this.wt[a];
          this.tsdf[a] = (this.tsdf[a] * W + sd * w) / (W + w);
          this.wt[a] = Math.min(60, W + w);
        }
      }
    }
    this.points++;
    return true;
  }

  // mark the voxels the sensor saw straight through as air (stops short of the surface)
  carve(cam, p) {
    let dx = p[0] - cam[0], dy = p[1] - cam[1], dz = p[2] - cam[2];
    const L = Math.hypot(dx, dy, dz);
    if (L < 1e-6) return;
    dx /= L; dy /= L; dz /= L;
    // clip the segment to the box (slab method). Stop just short of surfaces inside the box;
    // rays to the table/background (outside the box) clear the air all the way through it.
    let t0 = 0, t1 = this.inside(p) ? L - this.trunc * 1.2 : L;
    const lo = [-this.w / 2, 0, -this.d / 2], hi = [this.w / 2, this.h, this.d / 2], o = cam, dir = [dx, dy, dz];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(dir[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) return; continue; }
      let ta = (lo[a] - o[a]) / dir[a], tb = (hi[a] - o[a]) / dir[a];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return;
    }
    const cs = this.voxel * this.fc, step = cs * 0.5;
    let last = -1;
    for (let t = t0; t <= t1; t += step) {
      const i = Math.floor((o[0] + dx * t - this.ox) / cs), j = Math.floor((o[1] + dy * t - this.oy) / cs), k = Math.floor((o[2] + dz * t - this.oz) / cs);
      if (i < 0 || j < 0 || k < 0 || i >= this.fnx || j >= this.fny || k >= this.fnz) continue;
      const a = (k * this.fny + j) * this.fnx + i;
      if (a === last) continue;
      last = a;
      if (this.free[a] < 255) this.free[a]++;
    }
  }
  freeAt(i, j, k) {
    const f = this.fc;
    return this.free[(Math.floor(k / f) * this.fny + Math.floor(j / f)) * this.fnx + Math.floor(i / f)];
  }

  // Which voxels are air? Space the sensor looked through, plus the air side of the scanned
  // surface. Anything never seen (inside the object, the hidden underside) becomes solid.
  outsideMask() {
    const { nx, ny, nz } = this, N = nx * ny * nz, out = new Uint8Array(N);
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = this.idx(i, j, k);
      if (this.wt[a] >= 0.6) { if (this.tsdf[a] > 0) out[a] = 1; }
      else if (this.freeAt(i, j, k) >= 1) out[a] = 1;
    }
    return out;
  }

  // signed field with a 1-voxel border of air around it (so the mesh is closed)
  field(fillHidden = true) {
    const { nx, ny, nz, trunc: T } = this;
    const X = nx + 2, Y = ny + 2, Z = nz + 2;
    const f = new Float32Array(X * Y * Z).fill(T);
    const outside = fillHidden ? this.outsideMask() : null;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = this.idx(i, j, k);
      let v;
      if (this.wt[a] >= 0.6) v = this.tsdf[a];
      else if (!fillHidden || outside[a]) v = T;
      else v = -T;                                   // enclosed and never seen -> solid
      f[((k + 1) * Y + (j + 1)) * X + (i + 1)] = v;
    }
    return { f, X, Y, Z, origin: [this.ox - this.voxel, this.oy - this.voxel, this.oz - this.voxel], vs: this.voxel };
  }
}

// ---------- surface nets (watertight quad mesh from a signed field) ----------
export function surfaceNets({ f, X, Y, Z, origin, vs }) {
  const cellVert = new Int32Array(X * Y * Z).fill(-1);
  const pos = [];
  const at = (i, j, k) => f[(k * Y + j) * X + i];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float32Array(8);
  for (let k = 0; k < Z - 1; k++) for (let j = 0; j < Y - 1; j++) for (let i = 0; i < X - 1; i++) {
    let neg = 0;
    for (let c = 0; c < 8; c++) { val[c] = at(i + corners[c][0], j + corners[c][1], k + corners[c][2]); if (val[c] < 0) neg++; }
    if (neg === 0 || neg === 8) continue;
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const [a, b] of edges) {
      const va = val[a], vb = val[b];
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += corners[a][0] + (corners[b][0] - corners[a][0]) * t;
      sy += corners[a][1] + (corners[b][1] - corners[a][1]) * t;
      sz += corners[a][2] + (corners[b][2] - corners[a][2]) * t;
      cnt++;
    }
    cellVert[(k * Y + j) * X + i] = pos.length / 3;
    pos.push(origin[0] + (i + sx / cnt) * vs, origin[1] + (j + sy / cnt) * vs, origin[2] + (k + sz / cnt) * vs);
  }
  const tri = [];
  const cv = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= X - 1 || j >= Y - 1 || k >= Z - 1) ? -1 : cellVert[(k * Y + j) * X + i];
  for (let k = 0; k < Z; k++) for (let j = 0; j < Y; j++) for (let i = 0; i < X; i++) {
    const v0 = at(i, j, k);
    // edges along +x, +y, +z from this grid point
    const axes = [
      [i + 1, j, k, [[0, 0, 0], [0, -1, 0], [0, -1, -1], [0, 0, -1]]],
      [i, j + 1, k, [[0, 0, 0], [0, 0, -1], [-1, 0, -1], [-1, 0, 0]]],
      [i, j, k + 1, [[0, 0, 0], [-1, 0, 0], [-1, -1, 0], [0, -1, 0]]],
    ];
    for (const [ni, nj, nk, q] of axes) {
      if (ni >= X || nj >= Y || nk >= Z) continue;
      const v1 = at(ni, nj, nk);
      if ((v0 < 0) === (v1 < 0)) continue;
      const a = cv(i + q[0][0], j + q[0][1], k + q[0][2]), b = cv(i + q[1][0], j + q[1][1], k + q[1][2]);
      const c = cv(i + q[2][0], j + q[2][1], k + q[2][2]), d = cv(i + q[3][0], j + q[3][1], k + q[3][2]);
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      if (v0 < 0) tri.push(a, b, c, a, c, d);
      else tri.push(a, c, b, a, d, c);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(tri) };
}

// ---------- mesh clean-up ----------
function neighbours(nv, idx) {
  const sets = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    sets[a].add(b); sets[a].add(c); sets[b].add(a); sets[b].add(c); sets[c].add(a); sets[c].add(b);
  }
  return sets.map((s) => Int32Array.from(s));
}

// Taubin smoothing: removes scan noise without shrinking the shape
export function smooth(mesh, iterations = 4) {
  if (iterations <= 0) return mesh;
  const P = mesh.positions.slice(), nv = P.length / 3, nb = neighbours(nv, mesh.indices), tmp = new Float32Array(P.length);
  const step = (lambda) => {
    for (let v = 0; v < nv; v++) {
      const n = nb[v];
      if (!n.length) { tmp[3 * v] = P[3 * v]; tmp[3 * v + 1] = P[3 * v + 1]; tmp[3 * v + 2] = P[3 * v + 2]; continue; }
      let x = 0, y = 0, z = 0;
      for (const u of n) { x += P[3 * u]; y += P[3 * u + 1]; z += P[3 * u + 2]; }
      x /= n.length; y /= n.length; z /= n.length;
      tmp[3 * v] = P[3 * v] + lambda * (x - P[3 * v]);
      tmp[3 * v + 1] = P[3 * v + 1] + lambda * (y - P[3 * v + 1]);
      tmp[3 * v + 2] = P[3 * v + 2] + lambda * (z - P[3 * v + 2]);
    }
    P.set(tmp);
  };
  for (let it = 0; it < iterations; it++) { step(0.5); step(-0.53); }
  return { positions: P, indices: mesh.indices };
}

// keep only the biggest connected piece (drops floating specks)
export function largestPiece(mesh) {
  const nv = mesh.positions.length / 3, parent = new Int32Array(nv).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = find(I[t]), b = find(I[t + 1]), c = find(I[t + 2]);
    parent[b] = a; parent[find(c)] = a;
  }
  const count = new Map();
  for (let t = 0; t < I.length; t += 3) { const r = find(I[t]); count.set(r, (count.get(r) || 0) + 1); }
  let best = -1, bc = 0;
  for (const [r, c] of count) if (c > bc) { bc = c; best = r; }
  const remap = new Int32Array(nv).fill(-1), pos = [], tri = [];
  for (let t = 0; t < I.length; t += 3) {
    if (find(I[t]) !== best) continue;
    for (let k = 0; k < 3; k++) {
      const v = I[t + k];
      if (remap[v] < 0) { remap[v] = pos.length / 3; pos.push(mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]); }
      tri.push(remap[v]);
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(tri) };
}

export function vertexNormals(mesh) {
  const P = mesh.positions, I = mesh.indices, N = new Float32Array(P.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;   // area-weighted
    for (const v of [a, b, c]) { N[v] += nx; N[v + 1] += ny; N[v + 2] += nz; }
  }
  for (let v = 0; v < N.length; v += 3) {
    const l = Math.hypot(N[v], N[v + 1], N[v + 2]) || 1;
    N[v] /= l; N[v + 1] /= l; N[v + 2] /= l;
  }
  return N;
}

export function bounds(mesh) {
  const P = mesh.positions, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < P.length; v += 3) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], P[v + a]); mx[a] = Math.max(mx[a], P[v + a]); }
  return { min: mn, max: mx, size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
}

// full pipeline: volume -> cleaned mesh. Base sits at y = 0, centred on x/z.
// light 3x3x3 blur of the signed field: removes the ambiguous single-voxel specks that make
// pinched (non-manifold) spots in the mesh
export function blurField(F) {
  const { f, X, Y, Z } = F, g = new Float32Array(f.length);
  const tmp = new Float32Array(f.length);
  const pass = (src, dst, sx, sy, sz) => {
    for (let k = 0; k < Z; k++) for (let j = 0; j < Y; j++) for (let i = 0; i < X; i++) {
      const a = (k * Y + j) * X + i;
      const i0 = Math.max(0, i - sx), i1 = Math.min(X - 1, i + sx), j0 = Math.max(0, j - sy), j1 = Math.min(Y - 1, j + sy), k0 = Math.max(0, k - sz), k1 = Math.min(Z - 1, k + sz);
      let s = 0, c = 0;
      for (let kk = k0; kk <= k1; kk++) for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) { s += src[(kk * Y + jj) * X + ii]; c++; }
      dst[a] = s / c;
    }
  };
  pass(f, tmp, 1, 0, 0); pass(tmp, g, 0, 1, 0); pass(g, tmp, 0, 0, 1);
  return { ...F, f: tmp };
}

// count edges not shared by exactly two triangles (0 = watertight and manifold)
export function badEdges(mesh) {
  const em = new Map(), I = mesh.indices;
  for (let t = 0; t < I.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = I[t + k], b = I[t + (k + 1) % 3], key = a < b ? a * 4194304 + b : b * 4194304 + a;
    em.set(key, (em.get(key) || 0) + 1);
  }
  let bad = 0;
  for (const v of em.values()) if (v !== 2) bad++;
  return bad;
}

export function buildMesh(volume, { fillHidden = true, smoothness = 4 } = {}) {
  let m = surfaceNets(blurField(volume.field(fillHidden)));
  if (!m.indices.length) return null;
  m = largestPiece(m);
  m = smooth(m, smoothness);
  // flat base exactly on the cut line, object centred on x/z
  for (let v = 1; v < m.positions.length; v += 3) if (m.positions[v] < 0) m.positions[v] = 0;
  const b = bounds(m), cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  for (let v = 0; v < m.positions.length; v += 3) { m.positions[v] -= cx; m.positions[v + 1] -= b.min[1]; m.positions[v + 2] -= cz; }
  m.normals = vertexNormals(m);
  return m;
}

// Wavefront OBJ text. Units: 'mm' | 'cm' | 'm' (OBJ itself has no units; noted in a comment).
export function toOBJ(mesh, { units = 'mm', name = 'scan' } = {}) {
  const s = units === 'mm' ? 1000 : units === 'cm' ? 100 : 1;
  const dec = units === 'mm' ? 2 : units === 'cm' ? 3 : 5;
  const P = mesh.positions, N = mesh.normals || vertexNormals(mesh), I = mesh.indices;
  const b = bounds(mesh);
  const out = [];
  out.push('# Sculpt Scan export');
  out.push(`# units: ${units} (1 unit = 1 ${units})`);
  out.push(`# size (W x H x D): ${(b.size[0] * s).toFixed(dec)} x ${(b.size[1] * s).toFixed(dec)} x ${(b.size[2] * s).toFixed(dec)} ${units}`);
  out.push(`# vertices: ${P.length / 3}, triangles: ${I.length / 3}`);
  out.push('# Y is up; the base of the object sits at y = 0');
  out.push(`o ${name}`);
  for (let v = 0; v < P.length; v += 3) out.push(`v ${(P[v] * s).toFixed(dec)} ${(P[v + 1] * s).toFixed(dec)} ${(P[v + 2] * s).toFixed(dec)}`);
  for (let v = 0; v < N.length; v += 3) out.push(`vn ${N[v].toFixed(4)} ${N[v + 1].toFixed(4)} ${N[v + 2].toFixed(4)}`);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] + 1, bb = I[t + 1] + 1, c = I[t + 2] + 1;
    out.push(`f ${a}//${a} ${bb}//${bb} ${c}//${c}`);
  }
  return out.join('\n') + '\n';
}
