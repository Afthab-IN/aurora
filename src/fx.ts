import * as THREE from 'three';
import { U } from './shaderlib';

// ---------------------------------------------------------------------------
// Falling snow: flakes live in a box that wraps around the camera, so there is
// always snow near you without simulating a whole valley of it.
// ---------------------------------------------------------------------------
export class Snowfall {
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
  density = 0; // 0..1, eased
  target = 0;
  static N = 14000;

  constructor() {
    const N = Snowfall.N;
    const seed = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      seed[i * 4] = Math.random(); seed[i * 4 + 1] = Math.random(); seed[i * 4 + 2] = Math.random(); seed[i * 4 + 3] = i / N;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: U.uTime, uWindDir: U.uWindDir, uGust: U.uGust,
        uCam: { value: new THREE.Vector3() }, uDensity: { value: 0 }, uPx: { value: 1 },
        uLightCol: U.uLightCol, uAmb: { value: new THREE.Color(0.3, 0.35, 0.45) },
      },
      vertexShader: /* glsl */ `
        attribute vec4 aSeed;
        uniform float uTime, uDensity, uPx, uGust;
        uniform vec2 uWindDir;
        uniform vec3 uCam;
        varying float vA;
        const vec3 BOX = vec3(70.0, 36.0, 70.0);
        void main() {
          if (aSeed.w > uDensity) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vA = 0.0; return; }
          float fall = 0.9 + aSeed.x * 0.8;
          vec3 drift = vec3(uWindDir.x, 0.0, uWindDir.y) * (0.6 + uGust * 6.0);
          vec3 p = aSeed.xyz * BOX + vec3(0.0, -fall, 0.0) * uTime + drift * uTime;
          p.x += sin(uTime * (0.7 + aSeed.y) + aSeed.z * 30.0) * 0.6;
          p.z += cos(uTime * (0.6 + aSeed.x) + aSeed.y * 30.0) * 0.6;
          // wrap into a box centred on the camera
          p = mod(p - uCam + BOX * 0.5, BOX) - BOX * 0.5 + uCam;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vA = smoothstep(0.5, 2.0, d) * (1.0 - smoothstep(BOX.x * 0.3, BOX.x * 0.5, d));
          gl_PointSize = (0.6 + aSeed.z * 0.9) * uPx * 30.0 / max(d, 0.5);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        uniform vec3 uLightCol, uAmb;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.1, d) * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4((uAmb + uLightCol * 0.25) * 0.9, a * 0.9);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 30;
  }

  update(dt: number, cam: THREE.Camera, px: number) {
    this.density += (this.target - this.density) * (1 - Math.exp(-dt * 0.8));
    this.mat.uniforms.uDensity.value = this.density;
    this.mat.uniforms.uCam.value.copy(cam.position);
    this.mat.uniforms.uPx.value = px;
    this.points.visible = this.density > 0.002;
  }
}

// ---------------------------------------------------------------------------
// One pooled CPU particle system for everything that bursts: snow knocked off
// trees, ice chips from a crack, sparks when the fire flares.
// ---------------------------------------------------------------------------
interface Part { x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; age: number; size: number; r: number; g: number; b: number; drag: number; grav: number; glow: number; }

export class Bursts {
  points: THREE.Points;
  private parts: Part[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  static MAX = 5000;

  constructor() {
    const M = Bursts.MAX;
    this.pos = new Float32Array(M * 3);
    this.col = new Float32Array(M * 4);
    this.size = new Float32Array(M);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aCol', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uPx: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec4 aCol;
        attribute float aSize;
        uniform float uPx;
        varying vec4 vCol;
        void main() {
          vCol = aCol;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uPx * 40.0 / max(-mv.z, 0.3);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec4 vCol;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.15, d) * vCol.a;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vCol.rgb, a);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 31;
  }

  emit(p: Partial<Part> & { x: number; y: number; z: number }) {
    if (this.parts.length >= Bursts.MAX) this.parts.shift();
    this.parts.push({ vx: 0, vy: 0, vz: 0, life: 2, age: 0, size: 0.15, r: 0.85, g: 0.9, b: 0.97, drag: 1.5, grav: 2.5, glow: 0, ...p });
  }

  update(dt: number, px: number, light: THREE.Color) {
    const keep: Part[] = [];
    for (const q of this.parts) {
      q.age += dt;
      if (q.age >= q.life) continue;
      const k = Math.exp(-q.drag * dt);
      q.vx *= k; q.vy = q.vy * k - q.grav * dt; q.vz *= k;
      q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
      keep.push(q);
    }
    this.parts = keep;
    const n = keep.length;
    const amb = 0.35;
    for (let i = 0; i < n; i++) {
      const q = keep[i];
      this.pos[i * 3] = q.x; this.pos[i * 3 + 1] = q.y; this.pos[i * 3 + 2] = q.z;
      const fade = Math.min(1, (q.life - q.age) / 0.6) * Math.min(1, q.age / 0.05);
      const lit = q.glow > 0 ? q.glow : amb + Math.max(light.r, light.g, light.b) * 0.3;
      this.col[i * 4] = q.r * lit; this.col[i * 4 + 1] = q.g * lit; this.col[i * 4 + 2] = q.b * lit; this.col[i * 4 + 3] = fade;
      this.size[i] = q.size;
    }
    this.geo.setDrawRange(0, n);
    for (const a of ['position', 'aCol', 'aSize']) (this.geo.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
    this.mat.uniforms.uPx.value = px;
  }
}
