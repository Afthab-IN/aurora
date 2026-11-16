import * as THREE from 'three';
import { patchMaterial, windDepthMaterial } from './shaderlib';
import { mulberry32 } from './noise';

// ---------------------------------------------------------------------------
// Needle card texture: a spruce twig fan, drawn on a canvas, with a
// coverage-preserving mip chain so distant trees stay dense.
// ---------------------------------------------------------------------------
function coverageMips(src: Uint8ClampedArray, W: number, H: number, fill: [number, number, number], flip = true) {
  const base = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = flip ? H - 1 - y : y;
    for (let x = 0; x < W; x++) {
      const si = (sy * W + x) * 4, di = (y * W + x) * 4;
      const a = src[si + 3];
      if (a < 8) { base[di] = fill[0]; base[di + 1] = fill[1]; base[di + 2] = fill[2]; base[di + 3] = 0; }
      else { base[di] = src[si]; base[di + 1] = src[si + 1]; base[di + 2] = src[si + 2]; base[di + 3] = a; }
    }
  }
  const TH = 0.4 * 255;
  const coverage = (d: Uint8Array, s = 1) => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] * s > TH) n++; return n / (d.length / 4); };
  const c0 = coverage(base);
  const mips: { data: Uint8Array; width: number; height: number }[] = [{ data: base, width: W, height: H }];
  let raw = base, w = W, h = H;
  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
    const next = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0, ws = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = (Math.min(h - 1, y * 2 + dy) * w + Math.min(w - 1, x * 2 + dx)) * 4;
        const wa = raw[i + 3] + 1;
        r += raw[i] * wa; g += raw[i + 1] * wa; b += raw[i + 2] * wa; a += raw[i + 3]; ws += wa;
      }
      const o = (y * nw + x) * 4;
      next[o] = r / ws; next[o + 1] = g / ws; next[o + 2] = b / ws; next[o + 3] = a / 4;
    }
    let lo = 1, hi = 6;
    for (let it = 0; it < 12; it++) { const mid = (lo + hi) / 2; if (coverage(next, mid) < c0) lo = mid; else hi = mid; }
    const out = new Uint8Array(next);
    for (let i = 3; i < out.length; i += 4) out[i] = Math.min(255, out[i] * hi);
    mips.push({ data: out, width: nw, height: nh });
    raw = next; w = nw; h = nh;
  }
  const tex = new THREE.DataTexture(base, W, H, THREE.RGBAFormat);
  tex.mipmaps = mips as any;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function needleTexture(): THREE.DataTexture {
  const W = 256, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(31);
  const needle = (x: number, y: number, ang: number, len: number, light: number) => {
    g.strokeStyle = `hsl(${150 + rnd() * 18}, ${22 + rnd() * 18}%, ${light}%)`;
    g.lineWidth = 1.1 + rnd() * 0.8;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    g.stroke();
  };
  // twig: x across the card, y along it (canvas y down = toward the branch tip after flip)
  const twig = (x0: number, y0: number, ang: number, len: number, depth: number) => {
    const steps = Math.floor(len / 3);
    let x = x0, y = y0;
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const nx = x + Math.cos(ang) * 3, ny = y + Math.sin(ang) * 3;
      g.strokeStyle = '#2a2018';
      g.lineWidth = Math.max(0.8, 3 * (1 - t) * (depth ? 0.5 : 1));
      g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
      // needles all round the twig, slanted toward its tip
      const nl = (depth ? 9 : 12) * (1 - t * 0.4) * (0.8 + rnd() * 0.4);
      for (let k = 0; k < 3; k++) {
        const side = rnd() < 0.5 ? -1 : 1;
        needle(x, y, ang + side * (0.6 + rnd() * 0.6), nl, 12 + rnd() * 14);
      }
      if (depth === 0 && i % 3 === 1 && t < 0.85) {
        const side = (i % 6 === 1) ? -1 : 1;
        twig(x, y, ang + side * (0.75 + rnd() * 0.3), len * (0.42 - t * 0.3), 1);
      }
      x = nx; y = ny;
    }
  };
  twig(W / 2, H - 4, -Math.PI / 2, H - 20, 0);
  const img = g.getImageData(0, 0, W, H).data;
  return coverageMips(img, W, H, [22, 40, 32]);
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------
export interface PineSpec { height: number; seed: number; lod: 0 | 1; }

class GB {
  pos: number[] = []; nrm: number[] = []; uv: number[] = []; sway: number[] = []; idx: number[] = [];
  v(p: THREE.Vector3, n: THREE.Vector3, u: number, w: number, s: number) {
    this.pos.push(p.x, p.y, p.z); this.nrm.push(n.x, n.y, n.z); this.uv.push(u, w); this.sway.push(s);
    return this.pos.length / 3 - 1;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aSway', new THREE.Float32BufferAttribute(this.sway, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

function buildPine(spec: PineSpec) {
  const rnd = mulberry32(spec.seed);
  const H = spec.height;
  const trunk = new GB();
  const br = new GB();
  // trunk: a slim cone
  const R0 = 0.05 + H * 0.016;
  const radial = spec.lod ? 5 : 7, segs = spec.lod ? 2 : 5;
  const rows: number[][] = [];
  for (let j = 0; j <= segs; j++) {
    const s = j / segs;
    const r = R0 * (1 - s * 0.92);
    const row: number[] = [];
    for (let i = 0; i <= radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const n = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      row.push(trunk.v(new THREE.Vector3(n.x * r, s * H, n.z * r), n, i / radial, s * H * 0.5, 0.02 * s * s * H / 10));
    }
    rows.push(row);
  }
  for (let j = 0; j < segs; j++) for (let i = 0; i < radial; i++) {
    const a = rows[j][i], b = rows[j][i + 1], c = rows[j + 1][i], d = rows[j + 1][i + 1];
    trunk.idx.push(a, c, b, b, c, d);
  }

  // branch tiers
  const gap = spec.lod ? 1.5 : 0.72;
  const y0 = 0.6 + rnd() * 0.6;
  const golden = Math.PI * (3 - Math.sqrt(5));
  let tier = 0;
  for (let y = y0; y < H * 0.97; y += gap * (0.85 + rnd() * 0.3), tier++) {
    const rel = y / H;
    const n = spec.lod ? 4 : (rel > 0.8 ? 4 : rel > 0.55 ? 5 : 6);
    const L = Math.min(4.6, (H - y) * 0.34 + 0.3) * (0.85 + rnd() * 0.3);
    for (let b = 0; b < n; b++) {
      const phi = tier * golden + (b / n) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
      const hd = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
      const lat = new THREE.Vector3(-Math.sin(phi), 0, Math.cos(phi));
      const droop = 0.22 + 0.25 * (L / 4.5) + rnd() * 0.1;
      const tipUp = 0.18 + rnd() * 0.1;
      const base = new THREE.Vector3(0, y, 0).add(hd.clone().multiplyScalar(R0 * (1 - rel)));
      const P = (s: number) => base.clone()
        .add(hd.clone().multiplyScalar(L * s))
        .add(new THREE.Vector3(0, -droop * L * s + tipUp * L * s * s, 0));
      const M = spec.lod ? 1 : 2;
      const W = L * (0.7 + rnd() * 0.15);
      const rowsB: number[][] = [];
      for (let k = 0; k <= M; k++) {
        const s = k / M;
        const p = P(s);
        const T = P(Math.min(1, s + 0.05)).sub(P(Math.max(0, s - 0.05))).normalize();
        const Nf = new THREE.Vector3().crossVectors(T, lat).normalize();
        if (Nf.y < 0) Nf.negate();
        const w = W * (0.18 + 0.82 * Math.sin(Math.PI * Math.min(1, 0.12 + s * 0.88)) * (1 - s * 0.35));
        const radialN = p.clone().setY(0).normalize();
        const n3 = Nf.clone().multiplyScalar(0.6).add(radialN.multiplyScalar(0.4)).normalize();
        const sway = (0.04 + Math.pow(s, 1.3) * 0.22 * (L / 3)) * (0.4 + rel);
        const row: number[] = [];
        for (const o of [-1, 0, 1]) {
          const q = p.clone().add(lat.clone().multiplyScalar(o * w * 0.5)).add(Nf.clone().multiplyScalar(-Math.abs(o) * w * 0.12));
          row.push(br.v(q, n3, 0.5 + o * 0.5, s, sway));
        }
        rowsB.push(row);
      }
      for (let k = 0; k < M; k++) for (let i = 0; i < 2; i++) {
        const a = rowsB[k][i], b2 = rowsB[k][i + 1], c = rowsB[k + 1][i], d = rowsB[k + 1][i + 1];
        // wound so the front face is the top side (it collects snow)
        br.idx.push(a, b2, c, b2, d, c);
      }
    }
  }
  // the leader: a small upright cross at the very top
  for (let q = 0; q < 2; q++) {
    const a = q * Math.PI / 2;
    const lat = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const hgt = Math.min(1.6, H * 0.12);
    const n = new THREE.Vector3(-lat.z, 0.3, lat.x).normalize();
    const v0 = br.v(new THREE.Vector3(0, H * 0.94, 0).add(lat.clone().multiplyScalar(-0.35)), n, 0, 0, 0.3);
    const v1 = br.v(new THREE.Vector3(0, H * 0.94, 0).add(lat.clone().multiplyScalar(0.35)), n, 1, 0, 0.3);
    const v2 = br.v(new THREE.Vector3(0, H * 0.94 + hgt, 0).add(lat.clone().multiplyScalar(-0.05)), n, 0, 1, 0.4);
    const v3 = br.v(new THREE.Vector3(0, H * 0.94 + hgt, 0).add(lat.clone().multiplyScalar(0.05)), n, 1, 1, 0.4);
    br.idx.push(v0, v1, v2, v1, v3, v2);
  }
  return { trunk: trunk.build(), branches: br.build() };
}

// ---------------------------------------------------------------------------
// Materials and instancing
// ---------------------------------------------------------------------------
export function buildPineMaterials() {
  const tex = needleTexture();
  const branchMat = new THREE.MeshStandardMaterial({
    map: tex, alphaTest: 0.4, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
  });
  patchMaterial(branchMat, {
    key: 'pine',
    wind: true,
    kick: true,
    vertexHead: 'attribute float aSnow; attribute float aSeed; varying float vSnow; varying float vSeed; varying vec3 vNW;',
    vertexAfterProject: 'vSnow = aSnow; vSeed = aSeed; vNW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);',
    fragHead: 'varying float vSnow; varying float vSeed; varying vec3 vNW;',
    fsReplace: [['#include <normal_fragment_maps>', 'normal = normalize(vNormal);']],
    fragAfterMaps: /* glsl */ `
      {
        // snow sits on the upper faces of the branches, in clumps
        float top = gl_FrontFacing ? 1.0 : 0.0;
        float up = smoothstep(0.15, 0.75, vNW.y);
        vec2 suv = vMapUv * vec2(5.0, 9.0) + vSeed * 17.0;
        float clump = smoothstep(0.32, 0.6, vnoise(suv) * 0.7 + vnoise(suv * 2.7) * 0.3);
        float s = top * up * vSnow * mix(0.55, 1.0, clump);
        s = max(s, top * vSnow * 0.35 * smoothstep(0.55, 0.9, vMapUv.y));
        vec3 snowCol = vec3(0.82, 0.87, 0.95);
        diffuseColor.rgb = mix(diffuseColor.rgb, snowCol, clamp(s, 0.0, 1.0));
        roughnessFactor = mix(roughnessFactor, 0.7, s);
      }
    `,
    fragAfterLights: /* glsl */ `
      reflectedLight.indirectDiffuse *= 1.15;
    `,
  });
  const branchDepth = windDepthMaterial('pine', tex, 0.4, true);

  const barkMat = new THREE.MeshStandardMaterial({ color: 0x2a211a, roughness: 0.95, metalness: 0 });
  patchMaterial(barkMat, { key: 'pinebark', wind: true, kick: true });
  const barkDepth = windDepthMaterial('pinebark', null, 0, true);
  return { branchMat, branchDepth, barkMat, barkDepth };
}

export interface TreeInstance {
  x: number; y: number; z: number; rotY: number; scale: number; variant: number; far: boolean;
  height: number; // world height after scale
  mesh?: THREE.InstancedMesh; trunkMesh?: THREE.InstancedMesh; slot?: number;
  snow: number;
}

export function makePineSpecs(): PineSpec[] {
  const hs = [6, 8, 9.5, 11, 13, 15, 17.5, 20];
  const near = hs.map((h, i) => ({ height: h, seed: 400 + i * 13, lod: 0 as const }));
  const far = hs.map((h, i) => ({ height: h, seed: 400 + i * 13, lod: 1 as const }));
  return [...near, ...far];
}

export function buildForest(specs: PineSpec[], trees: TreeInstance[], mats: ReturnType<typeof buildPineMaterials>) {
  const group = new THREE.Group();
  group.name = 'forest';
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  specs.forEach((spec, vi) => {
    const list = trees.filter((t) => t.variant === vi);
    if (!list.length) return;
    const geo = buildPine(spec);
    const count = list.length;
    // per-tree attributes: snow load, last shake time, random seed
    const snow = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1).setUsage(THREE.DynamicDrawUsage);
    const kick = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(-100), 1).setUsage(THREE.DynamicDrawUsage);
    const seed = new THREE.InstancedBufferAttribute(new Float32Array(count).map(() => Math.random()), 1);
    geo.branches.setAttribute('aSnow', snow);
    geo.branches.setAttribute('aKick', kick);
    geo.branches.setAttribute('aSeed', seed);
    geo.trunk.setAttribute('aKick', kick);
    const bm = new THREE.InstancedMesh(geo.branches, mats.branchMat, count);
    const tm = new THREE.InstancedMesh(geo.trunk, mats.barkMat, count);
    bm.customDepthMaterial = mats.branchDepth;
    tm.customDepthMaterial = mats.barkDepth;
    list.forEach((t, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t.rotY);
      sc.setScalar(t.scale);
      p.set(t.x, t.y, t.z);
      m.compose(p, q, sc);
      bm.setMatrixAt(i, m);
      tm.setMatrixAt(i, m);
      t.mesh = bm; t.trunkMesh = tm; t.slot = i;
      snow.setX(i, t.snow);
    });
    for (const im of [bm, tm]) {
      im.castShadow = !spec.lod;
      im.receiveShadow = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      group.add(im);
    }
  });
  return group;
}
