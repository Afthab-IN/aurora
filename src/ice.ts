import * as THREE from 'three';
import { patchMaterial } from './shaderlib';
import { ICE_LEVEL } from './heightfield';
import { PlanarReflection } from './reflection';
import { mulberry32 } from './noise';

// Ice covers this rectangle (x, z, width, depth); the shader cuts it to the shoreline.
export const ICE_RECT = new THREE.Vector4(-105, -45, 210, 110);

// ---------------------------------------------------------------------------
// Cracks you make by clicking. Segments are grown outward over ~1 s and drawn
// into a render target that the ice shader reads (sharp line + blurred glow).
// ---------------------------------------------------------------------------
interface Seg { ax: number; az: number; bx: number; bz: number; d: number; w: number; }
interface CrackEvent { x: number; z: number; t0: number; segs: Seg[]; drawn: number; }

export class CrackLayer {
  rt: THREE.WebGLRenderTarget;
  private scene = new THREE.Scene();
  private cam: THREE.OrthographicCamera;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private lines: THREE.Mesh;
  private across: Float32Array;
  private width: Float32Array;
  private events: CrackEvent[] = [];
  private rnd = mulberry32(99);
  recent: THREE.Vector4[] = [0, 1, 2, 3].map(() => new THREE.Vector4(0, 0, -100, 0)); // x, z, birth time, unused
  private slot = 0;
  static MAX = 4096;

  constructor(private renderer: THREE.WebGLRenderer) {
    this.rt = new THREE.WebGLRenderTarget(4096, 2048, {
      depthBuffer: false,
      generateMipmaps: true,
      anisotropy: 8,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    const r = ICE_RECT;
    this.cam = new THREE.OrthographicCamera(r.x, r.x + r.z, r.y + r.w, r.y, -10, 10);
    // identity view: segments are stored as (x, z, 0), so world x/z map straight to rt u/v
    this.cam.matrixAutoUpdate = false;
    this.cam.matrixWorld.identity();
    this.cam.matrixWorldInverse.identity();
    this.cam.projectionMatrix.makeOrthographic(r.x, r.x + r.z, r.y + r.w, r.y, -10, 10);
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();

    // each segment is a thin quad; "across" runs -1..1 over its width for a soft edge
    this.pos = new Float32Array(CrackLayer.MAX * 4 * 3);
    this.across = new Float32Array(CrackLayer.MAX * 4);
    this.width = new Float32Array(CrackLayer.MAX * 4);
    const idx = new Uint32Array(CrackLayer.MAX * 6);
    for (let i = 0; i < CrackLayer.MAX; i++) {
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
      this.across.set([-1, 1, -1, 1], i * 4);
    }
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAcross', new THREE.BufferAttribute(this.across, 1));
    this.geo.setAttribute('aW', new THREE.BufferAttribute(this.width, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setDrawRange(0, 0);
    const lineMat = new THREE.ShaderMaterial({
      vertexShader: 'attribute float aAcross; attribute float aW; varying float vA; varying float vW; void main(){ vA = aAcross; vW = aW; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'varying float vA; varying float vW; void main(){ float a = 1.0 - smoothstep(0.15, 1.0, abs(vA)); gl_FragColor = vec4(vec3(a * vW), 1.0); }',
      transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, depthTest: false, depthWrite: false,
    });
    this.lines = new THREE.Mesh(this.geo, lineMat) as any;
    this.lines.frustumCulled = false;
    this.scene.add(this.lines);
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.setRenderTarget(null);
  }

  /** Start a crack at world (x, z). */
  crack(x: number, z: number, now: number, inside: (x: number, z: number) => boolean) {
    const segs: Seg[] = [];
    const rnd = this.rnd;
    const grow = (x0: number, z0: number, ang: number, len: number, d0: number, depth: number) => {
      let x = x0, z = z0, a = ang, d = d0;
      const steps = Math.floor(len / 0.45);
      for (let i = 0; i < steps; i++) {
        a += (rnd() - 0.5) * 0.55;
        const l = 0.3 + rnd() * 0.35;
        const nx = x + Math.cos(a) * l, nz = z + Math.sin(a) * l;
        if (!inside(nx, nz)) break;
        segs.push({ ax: x, az: z, bx: nx, bz: nz, d, w: Math.max(0.03, 0.09 - depth * 0.02 - d * 0.0015) });
        d += l;
        x = nx; z = nz;
        if (depth < 3 && rnd() < 0.07) grow(x, z, a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.7), len * (0.25 + rnd() * 0.35), d, depth + 1);
      }
    };
    const arms = 5 + Math.floor(rnd() * 4);
    const off = rnd() * Math.PI * 2;
    for (let i = 0; i < arms; i++) {
      grow(x, z, off + (i / arms) * Math.PI * 2 + (rnd() - 0.5) * 0.5, 8 + rnd() * 22, 0, 0);
    }
    // a small star of micro-fractures at the impact
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2, l = 0.3 + rnd() * 0.9;
      segs.push({ ax: x, az: z, bx: x + Math.cos(a) * l, bz: z + Math.sin(a) * l, d: 0, w: 0.035 });
    }
    segs.sort((p, q) => p.d - q.d);
    this.events.push({ x, z, t0: now, segs, drawn: 0 });
    this.recent[this.slot].set(x, z, now, 0);
    this.slot = (this.slot + 1) % this.recent.length;
  }

  /** Draw any segments that have grown since last frame. */
  update(now: number) {
    let n = 0;
    for (const ev of this.events) {
      const reach = (now - ev.t0) * 38; // metres per second
      while (ev.drawn < ev.segs.length && ev.segs[ev.drawn].d <= reach && n < CrackLayer.MAX) {
        const s = ev.segs[ev.drawn++];
        // perpendicular, widened a little so joints overlap without gaps
        let px = -(s.bz - s.az), pz = s.bx - s.ax;
        const l = Math.hypot(px, pz) || 1;
        px = (px / l) * s.w; pz = (pz / l) * s.w;
        const ex = ((s.bx - s.ax) / l) * s.w * 0.5, ez = ((s.bz - s.az) / l) * s.w * 0.5;
        const o = n * 12;
        this.pos.set([s.ax - ex + px, s.az - ez + pz, 0, s.ax - ex - px, s.az - ez - pz, 0, s.bx + ex + px, s.bz + ez + pz, 0, s.bx + ex - px, s.bz + ez - pz, 0], o);
        const bright = 0.75 + 0.25 * Math.min(1, s.w / 0.06);
        this.width.set([bright, bright, bright, bright], n * 4);
        n++;
      }
    }
    this.events = this.events.filter((e) => e.drawn < e.segs.length);
    if (!n) return;
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aW as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, n * 6);
    const prevAuto = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(null);
    this.renderer.autoClear = prevAuto;
  }

  clear() {
    this.events = [];
    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear();
    this.renderer.setRenderTarget(null);
    this.recent.forEach((r) => r.set(0, 0, -100, 0));
  }
}

// ---------------------------------------------------------------------------
// The ice surface
// ---------------------------------------------------------------------------
export function buildIce(reflection: PlanarReflection, cracks: CrackLayer) {
  const uniforms = {
    tRefl: { value: reflection.rt.texture },
    uTexMat: { value: reflection.textureMatrix },
    tCrack: { value: cracks.rt.texture },
    uIceRect: { value: ICE_RECT },
    uCrackEv: { value: cracks.recent },
    uSnowOnIce: { value: 0.35 },
    uFireLight: { value: new THREE.Vector4(0, 0, 0, 0) },
  };
  const r = ICE_RECT;
  const geo = new THREE.PlaneGeometry(r.z, r.w, 1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(r.x + r.z / 2, ICE_LEVEL, r.y + r.w / 2);

  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0 });
  patchMaterial(mat, {
    key: 'ice',
    extraUniforms: uniforms,
    vertexHead: 'uniform mat4 uTexMat; varying vec4 vReflUv;',
    vertexAfterProject: 'vReflUv = uTexMat * vec4(vWPos, 1.0);',
    fragHead: /* glsl */ `
      uniform sampler2D tRefl;
      uniform sampler2D tCrack;
      uniform vec4 uIceRect;
      uniform vec4 uCrackEv[4];
      uniform float uSnowOnIce;
      varying vec4 vReflUv;
      vec2 h22(vec2 p) { return vec2(h21(p), h21(p + 19.19)); }
      // distance to the nearest Voronoi edge: the ice's natural fracture planes
      float voroEdge(vec2 p) {
        vec2 n = floor(p), f = fract(p);
        vec2 mg, mr; float md = 8.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 g = vec2(float(i), float(j));
          vec2 o = h22(n + g);
          vec2 r = g + o - f;
          float d = dot(r, r);
          if (d < md) { md = d; mr = r; mg = g; }
        }
        md = 8.0;
        for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
          vec2 g = mg + vec2(float(i), float(j));
          vec2 o = h22(n + g);
          vec2 r = g + o - f;
          if (dot(mr - r, mr - r) > 0.0001) md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
        }
        return md;
      }
      float bubbles(vec2 p, float k) {
        vec2 c = floor(p), f = fract(p) - 0.5;
        float hsh = h21(c + k * 13.1);
        // bubbles gather in columns and drifts, not evenly
        float density = smoothstep(0.35, 0.75, vnoise(c * 0.13 + k));
        if (hsh > 0.35 + 0.6 * (1.0 - density)) return 0.0;
        vec2 o = (h22(c + k) - 0.5) * 0.5;
        float rad = 0.07 + 0.16 * h21(c + 7.7 + k);
        float d = length(f - o);
        float disc = smoothstep(rad, rad * 0.55, d);
        float rim = smoothstep(rad * 0.55, rad * 0.9, d) * disc;
        return disc * 0.55 + rim * 0.6;
      }
    `,
    fragAfterMaps: /* glsl */ `
      vec2 P = vWPos.xz;
      vec4 hs = hfLod(P, 0.0);
      if (hs.x > ${ICE_LEVEL.toFixed(2)} + 0.03 || hs.w > 1.02) discard;
      float ld = hs.w;
      vec3 Vw = normalize(cameraPosition - vWPos);
      float dist = length(cameraPosition - vWPos);
      vec2 cuv = (P - uIceRect.xy) / uIceRect.zw;

      // snow lying on the ice: wind-streaked drifts, thicker near the shore
      vec2 wd = normalize(vec2(0.8, 0.6));
      vec2 sp = vec2(dot(P, wd) * 0.035, dot(P, vec2(-wd.y, wd.x)) * 0.12);
      float drift = fbm3(sp * 3.0) * 0.62 + vnoise(P * 0.4) * 0.26 + vnoise(P * 2.3) * 0.12;
      // crisp drift edges, like wind-packed snow on ice
      float snow = smoothstep(0.66 - uSnowOnIce * 0.4, 0.69 - uSnowOnIce * 0.4, drift + smoothstep(0.82, 1.0, ld) * 0.45);
      float thin = smoothstep(0.52 - uSnowOnIce * 0.3, 0.6 - uSnowOnIce * 0.3, drift) * (1.0 - snow) * 0.6;

      // looking into clear black ice: bubbles at three depths, faint fracture planes
      vec3 refr = refract(-Vw, vec3(0.0, 1.0, 0.0), 0.76);
      float down = max(-refr.y, 0.25);
      float bub = 0.0;
      for (int k = 0; k < 3; k++) {
        float dk = 0.12 + float(k) * 0.22;
        vec2 bp = P + refr.xz * (dk / down);
        bub += bubbles(bp * (2.6 + float(k) * 0.9), float(k)) * (0.9 - float(k) * 0.22);
      }
      bub *= 1.0 - smoothstep(25.0, 70.0, dist);
      vec2 fp = P + refr.xz * (0.35 / down);
      float fr = 1.0 - smoothstep(0.0, 0.035, voroEdge(fp * 0.16));
      fr *= 0.35 * smoothstep(0.3, 0.7, vnoise(fp * 0.05)) * (1.0 - smoothstep(30.0, 90.0, dist));

      // clicked cracks: sharp line at the surface, a deeper refracted copy, and a soft glow
      float cr = texture(tCrack, cuv).r;
      vec2 cuv2 = (P + refr.xz * (0.3 / down) - uIceRect.xy) / uIceRect.zw;
      float cr2 = texture(tCrack, cuv2).r * 0.6;
      float crGlow = textureLod(tCrack, cuv, 3.0).r;
      float flash = 0.0;
      for (int i = 0; i < 4; i++) {
        float age = uTime - uCrackEv[i].z;
        if (age >= 0.0 && age < 6.0) flash += exp(-age * 1.3) * exp(-length(P - uCrackEv[i].xy) * 0.05);
      }

      vec3 deep = vec3(0.0035, 0.011, 0.018) * (0.8 + 0.4 * vnoise(P * 0.03));
      vec3 iceCol = deep + vec3(0.55, 0.7, 0.85) * bub * 0.22 + vec3(0.6, 0.75, 0.9) * fr * 0.25;
      iceCol += vec3(0.7, 0.85, 1.0) * (cr * 0.55 + cr2 * 0.35);
      vec3 snowCol = vec3(0.82, 0.87, 0.95) * (0.92 + 0.08 * vnoise(P * 0.7));
      vec3 frostCol = vec3(0.35, 0.42, 0.5);
      diffuseColor.rgb = mix(mix(iceCol, frostCol, thin * 0.45), snowCol, snow);
      roughnessFactor = mix(mix(0.05, 0.3, thin), 0.8, snow);
      // crack lines catch light like edges of glass
      roughnessFactor = mix(roughnessFactor, 0.25, cr);
      vec3 nW = vec3(0.0, 1.0, 0.0);
      // tiny surface imperfections so reflections shimmer a little
      vec2 gq = P * 1.7;
      float n0 = vnoise(gq), nx = vnoise(gq + vec2(0.05, 0.0)), nz = vnoise(gq + vec2(0.0, 0.05));
      nW = normalize(nW + vec3(nx - n0, 0.0, nz - n0) * 0.035 * (1.0 - snow));
      normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
      float fres = mix(0.03, 1.0, pow(1.0 - clamp(dot(nW, Vw), 0.0, 1.0), 5.0));
      float clearIce = (1.0 - snow) * (1.0 - thin * 0.7);
    `,
    fragAfterLights: /* glsl */ `
      {
        vec4 ruv = vReflUv;
        ruv.xy += nW.xz * ruv.w * 0.004;
        vec3 refl = texture2DProj(tRefl, ruv).rgb;
        float f = fres * clearIce;
        reflectedLight.indirectSpecular = mix(reflectedLight.indirectSpecular * 0.3, refl, clearIce) * max(f, 0.06 * clearIce);
        reflectedLight.directDiffuse *= (1.0 - f);
        // fresh cracks glow cold blue, then settle into white lines
        reflectedLight.indirectDiffuse += vec3(0.25, 0.6, 1.0) * (crGlow * 0.8 + cr * 1.6) * flash * 1.6;
        reflectedLight.indirectDiffuse += vec3(0.5, 0.7, 0.95) * crGlow * 0.04;
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'ice';
  return { mesh, uniforms };
}
