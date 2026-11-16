import * as THREE from 'three';
import { U, COMMON_GLSL } from './shaderlib';

// ---------------------------------------------------------------------------
// Sky dome: night gradient, stars, Milky Way, moon, and the aurora, which is
// ray-marched through a slab of "sky altitude" so its curtains have real
// vertical rays, folds and a bright lower edge.
// ---------------------------------------------------------------------------
const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position = p.xyww;
}
`;

export const AURORA_GLSL = /* glsl */ `
uniform sampler2D uNoiseTex;
uniform float uAurSteps;
// one texture fetch instead of four hashes: bilinear value noise from a 256^2 tile
float tn(vec2 p) { return textureLod(uNoiseTex, (p + 0.5) / 256.0, 0.0).r; }
uniform float uAurora;
uniform float uAurTime;
uniform float uSurge;
uniform vec3 uAurCol1;
uniform vec3 uAurCol2;
uniform vec3 uAurCol3;
uniform vec3 uRippleDir;
uniform float uRippleT;

float curtainZ(float x, float t, float base) {
  return base
    + 0.55 * sin(x * 0.30 + t * 0.11 + base * 1.7)
    + 0.32 * sin(x * 0.74 - t * 0.17 + base)
    + 0.7 * (tn(vec2(x * 0.22 + t * 0.045, base * 3.1)) - 0.5);
}

vec3 aurora(vec3 rd, float dither) {
  if (rd.y < 0.012) return vec3(0.0);
  float t = uAurTime;
  // a ripple running outward from where you pressed on the sky
  float ang = acos(clamp(dot(rd, uRippleDir), -1.0, 1.0));
  float rip = sin(ang * 24.0 - uRippleT * 7.5) * exp(-ang * 2.6) * exp(-uRippleT * 0.55) * smoothstep(0.0, 0.25, uRippleT);
  vec3 acc = vec3(0.0);
  const int NMAX = 28;
  int N = int(uAurSteps);
  for (int i = 0; i < NMAX; i++) {
    if (i >= N) break;
    float fi = (float(i) + dither) / float(N);
    float h = 1.0 + fi * 2.6;
    vec2 p = rd.xz * (h / rd.y);
    float b = 0.0;
    for (int k = 0; k < 4; k++) {
      float kk = float(k);
      float base = (k == 0) ? 1.5 : 1.3 + kk * 2.1;
      float zc = curtainZ(p.x, t, base) + rip * 0.7;
      float dz = p.y - zc;
      float thick = 0.06 + 0.035 * kk;
      float c = exp(-dz * dz / (thick * thick));
      if (c < 0.002) continue;
      float ray = 0.18 + 0.82 * pow(tn(vec2(p.x * 3.3 + kk * 7.0, t * 0.55 + kk)), 2.6);
      ray *= 0.55 + 0.45 * tn(vec2(p.x * 10.5 + kk * 3.0, t * 1.4));
      float w = (k == 0) ? 0.55 : 1.0 - (kk - 1.0) * 0.22;
      // curtains brighten and fade along their length
      float seg = 0.25 + 0.75 * smoothstep(0.25, 0.75, tn(vec2(p.x * 0.16 + kk * 5.0, t * 0.035 + kk * 2.0)));
      b += c * ray * w * seg;
    }
    // bright, fairly sharp lower edge; long soft fade upward
    float prof = smoothstep(0.0, 0.035, fi) * (exp(-fi * 2.4) + 0.9 * exp(-fi * 16.0));
    vec3 hc = mix(uAurCol1, uAurCol2, smoothstep(0.04, 0.32, fi));
    hc = mix(hc, uAurCol3, smoothstep(0.32, 0.9, fi));
    acc += hc * b * prof;
  }
  acc *= (4.2 / float(N)) * uAurora * (1.0 + uSurge * 1.6);
  acc *= smoothstep(0.012, 0.16, rd.y);
  return acc;
}
`;

const SKY_FRAG = /* glsl */ `
varying vec3 vDir;
${COMMON_GLSL}
${AURORA_GLSL}
uniform float uEnvPass;
uniform float uAurUseRT;
uniform sampler2D tAurora;
uniform vec2 uRes;
uniform float uStars;
uniform float uMilky;
uniform vec3 uMoonDisc;

float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
vec3 h33(vec3 p) { return vec3(h31(p), h31(p + 17.3), h31(p + 41.7)); }

vec3 starLayer(vec3 dir, float scale, float thresh, float gain) {
  vec3 sp = dir * scale;
  vec3 ci = floor(sp);
  vec3 cf = fract(sp) - 0.5;
  float h = h31(ci);
  if (h < thresh) return vec3(0.0);
  vec3 off = (h33(ci) - 0.5) * 0.6;
  float d = length(cf - off);
  float px = max(length(fwidth(sp)), 1e-4);
  float sig = max(0.55 * px, 0.035);
  float b = pow(h31(ci + 3.7), 7.0) * gain + 0.06 * gain;
  float tw = 0.75 + 0.25 * sin(uTime * (2.0 + 3.0 * h31(ci + 9.1)) + h * 60.0);
  vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), h31(ci + 5.5));
  return tint * b * tw * exp(-d * d / (2.0 * sig * sig)) * (0.035 * 0.035) / (sig * sig);
}

void main() {
  vec3 dir = normalize(vDir);
  vec3 col = atmosphere(dir);
  float up = clamp(dir.y, 0.0, 1.0);

  if (dir.y > -0.02) {
    // Milky Way: a soft band along a great circle with dark dust lanes
    vec3 mwN = normalize(vec3(0.42, 0.5, -0.76));
    float bd = dot(dir, mwN);
    vec3 e1 = normalize(cross(mwN, vec3(0.0, 1.0, 0.0)));
    vec3 e2 = cross(mwN, e1);
    vec2 q = vec2(atan(dot(dir, e2), dot(dir, e1)) * 2.0, bd * 6.0);
    float band = exp(-pow(bd / 0.2, 2.0));
    float dust = smoothstep(0.42, 0.7, fbm5(q * 2.2 + 3.0)) * exp(-pow(bd / 0.07, 2.0));
    float mw = band * (0.55 + 0.45 * fbm5(q * 3.0)) * (1.0 - dust * 0.85);
    col += vec3(0.5, 0.55, 0.7) * mw * 0.045 * uMilky * smoothstep(0.0, 0.25, up);
    // stars, denser along the band; faded near the horizon
    float horizonFade = smoothstep(0.0, 0.18, up);
    vec3 st = starLayer(dir, 300.0, 0.985 - band * 0.012, 1.4) + starLayer(dir, 110.0, 0.992, 5.0);
    col += st * uStars * horizonFade * (1.0 - uEnvPass);
    // moon
    float md = dot(dir, normalize(uMoonDir));
    float disc = smoothstep(0.99955, 0.99968, md);
    float mare = 0.8 + 0.2 * vnoise(dir.xy * 900.0) - 0.15 * smoothstep(0.4, 0.7, vnoise(dir.zx * 420.0));
    col += uMoonDisc * disc * mare * (1.0 - uEnvPass * 0.7);
    // aurora: the main view reads it from the half-resolution pass; reflections
    // and the environment map march it directly with fewer steps
    if (uAurUseRT > 0.5) {
      col += texture(tAurora, gl_FragCoord.xy / uRes).rgb;
    } else {
      vec2 fc = gl_FragCoord.xy + vec2(5.588, 7.123) * float(int(uTime * 60.0) % 64);
      float dither = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
      col += aurora(dir, uEnvPass > 0.5 ? 0.5 : dither);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

function noiseTexture(): THREE.DataTexture {
  const N = 256;
  const d = new Uint8Array(N * N * 4);
  let a = 1234567;
  for (let i = 0; i < N * N; i++) {
    a = (a * 1664525 + 1013904223) >>> 0;
    const v = a >>> 24;
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const NOISE = noiseTexture();

// The aurora for the main view, marched once per frame at half resolution.
export class AuroraPass {
  rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  mat: THREE.ShaderMaterial;
  constructor() {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...U, uNoiseTex: { value: NOISE }, uAurSteps: { value: 26 }, uCamWorld: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() }, uFrame: { value: 0 } },
      vertexShader: 'varying vec2 vNdc; void main(){ vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec2 vNdc;
        uniform mat4 uCamWorld;
        uniform mat4 uProjInv;
        uniform float uFrame;
        uniform float uTime;
        ${AURORA_GLSL}
        void main() {
          vec4 v = uProjInv * vec4(vNdc, 1.0, 1.0);
          vec3 dir = normalize((uCamWorld * vec4(v.xyz / v.w, 0.0)).xyz);
          vec2 fc = gl_FragCoord.xy + vec2(5.588, 7.123) * mod(uFrame, 64.0);
          float dither = fract(52.9829189 * fract(dot(fc, vec2(0.06711056, 0.00583715))));
          gl_FragColor = vec4(aurora(dir, dither), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    q.frustumCulled = false;
    this.scene.add(q);
  }
  setSize(w: number, h: number) { this.rt.setSize(Math.max(2, Math.ceil(w / 2)), Math.max(2, Math.ceil(h / 2))); }
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera) {
    this.mat.uniforms.uCamWorld.value.copy(camera.matrixWorld);
    this.mat.uniforms.uProjInv.value.copy(camera.projectionMatrixInverse);
    this.mat.uniforms.uFrame.value = (this.mat.uniforms.uFrame.value + 1) % 64;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }
}

export function buildSkyDome(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    uniforms: { ...U, uMoonDisc: { value: new THREE.Color(3, 3.1, 3.3) }, uNoiseTex: { value: NOISE }, uAurSteps: { value: 12 }, uAurUseRT: { value: 0 }, tAurora: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  mesh.name = 'sky';
  return mesh;
}

// ---------------------------------------------------------------------------
// Night presets. Every value eases toward the chosen preset.
// ---------------------------------------------------------------------------
export interface NightPreset {
  name: string;
  zenith: string; horizon: string; moonGlow: string; ground: string;
  moonElev: number; moonAz: number; // degrees; az 0 = north (+z), 90 = east (+x)
  light: 'moon' | 'aurora' | 'twilight';
  lightCol: string; lightI: number;
  moonDisc: number;
  aurora: number; stars: number; milky: number;
  fog: number; env: number; exposure: number;
}

export const NIGHT_PRESETS: NightPreset[] = [
  { name: 'Aurora night', zenith: '#02040b', horizon: '#0a1220', moonGlow: '#1c2638', ground: '#0a0d14', moonElev: 15, moonAz: 150, light: 'moon', lightCol: '#a9bde8', lightI: 2.4, moonDisc: 3.2, aurora: 1.0, stars: 1.0, milky: 0.55, fog: 0.00035, env: 1.0, exposure: 1.65 },
  { name: 'Moonless', zenith: '#010208', horizon: '#060b16', moonGlow: '#000000', ground: '#06080d', moonElev: -30, moonAz: 180, light: 'aurora', lightCol: '#4dff9a', lightI: 0.12, moonDisc: 0, aurora: 1.25, stars: 1.35, milky: 1.0, fog: 0.0003, env: 0.3, exposure: 1.45 },
  { name: 'Full moon', zenith: '#06101f', horizon: '#18253a', moonGlow: '#33445e', ground: '#121822', moonElev: 34, moonAz: 175, light: 'moon', lightCol: '#c2d2f2', lightI: 3.4, moonDisc: 3.6, aurora: 0.6, stars: 0.45, milky: 0.15, fog: 0.0004, env: 0.9, exposure: 1.3 },
  { name: 'Polar twilight', zenith: '#08132e', horizon: '#3a3352', moonGlow: '#6a4a5a', ground: '#141420', moonElev: -6, moonAz: 190, light: 'twilight', lightCol: '#8a9ad8', lightI: 1.0, moonDisc: 0, aurora: 0.45, stars: 0.35, milky: 0.05, fog: 0.0005, env: 1.0, exposure: 1.35 },
];

export interface AuroraPalette { name: string; c1: string; c2: string; c3: string; }
export const AURORA_PALETTES: AuroraPalette[] = [
  { name: 'Green veil', c1: '#44ff8e', c2: '#22e0a6', c3: '#6a4cff' },
  { name: 'Green + pink', c1: '#ff4fa8', c2: '#3dff8c', c3: '#8b5cff' },
  { name: 'Violet storm', c1: '#5effb4', c2: '#7c5cff', c3: '#ff3d8f' },
  { name: 'Crimson crown', c1: '#5dff95', c2: '#ff4646', c3: '#a8205e' },
];

const tmp = new THREE.Color();
function approach(c: THREE.Color, hex: string, k: number, scale = 1) {
  tmp.set(hex).multiplyScalar(scale);
  c.lerp(tmp, k);
}
const dirFrom = (elev: number, az: number) => {
  const e = THREE.MathUtils.degToRad(elev), a = THREE.MathUtils.degToRad(az);
  return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
};

export class NightState {
  preset = NIGHT_PRESETS[0];
  palette = AURORA_PALETTES[0];
  activity = 1.0; // user slider, 0.2 .. 2
  // smoothed values
  exposure = 1.5;
  env = 1.0;
  lightI = 0.9;
  lightCol = new THREE.Color('#a9bde8');
  moonDir = dirFrom(13, 150);
  moonDisc = 3.2;
  surge = 0; // 0..1 while you hold on the sky
  changed = true;
  private envClock = 0;

  constructor(public light: THREE.DirectionalLight, private skyMat: THREE.ShaderMaterial) {
    this.snap();
  }

  snap() {
    const p = this.preset;
    U.uZenith.value.set(p.zenith); U.uHorizon.value.set(p.horizon);
    U.uMoonGlow.value.set(p.moonGlow); U.uGround.value.set(p.ground);
    U.uFogDensity.value = p.fog;
    U.uStars.value = p.stars; U.uMilky.value = p.milky;
    U.uAurora.value = p.aurora * this.activity;
    this.moonDir.copy(dirFrom(p.moonElev, p.moonAz));
    this.moonDisc = p.moonDisc;
    this.exposure = p.exposure; this.env = p.env; this.lightI = p.lightI; this.lightCol.set(p.lightCol);
    U.uAurCol1.value.set(this.palette.c1); U.uAurCol2.value.set(this.palette.c2); U.uAurCol3.value.set(this.palette.c3);
    this.apply(0);
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt * 1.4);
    const p = this.preset;
    approach(U.uZenith.value, p.zenith, k);
    approach(U.uHorizon.value, p.horizon, k);
    approach(U.uMoonGlow.value, p.moonGlow, k);
    approach(U.uGround.value, p.ground, k);
    U.uFogDensity.value += (p.fog - U.uFogDensity.value) * k;
    U.uStars.value += (p.stars - U.uStars.value) * k;
    U.uMilky.value += (p.milky - U.uMilky.value) * k;
    const aTarget = p.aurora * this.activity;
    U.uAurora.value += (aTarget - U.uAurora.value) * k;
    this.moonDir.lerp(dirFrom(p.moonElev, p.moonAz), k).normalize();
    this.moonDisc += (p.moonDisc - this.moonDisc) * k;
    this.exposure += (p.exposure - this.exposure) * k;
    this.env += (p.env - this.env) * k;
    this.lightI += (p.lightI - this.lightI) * k;
    this.lightCol.lerp(tmp.set(p.lightCol), k);
    approach(U.uAurCol1.value, this.palette.c1, k);
    approach(U.uAurCol2.value, this.palette.c2, k);
    approach(U.uAurCol3.value, this.palette.c3, k);
    this.apply(dt);
    this.envClock += dt;
    // the aurora is always moving, so the ambient light it casts is refreshed a few times a second
    if (this.envClock > 0.35) { this.envClock = 0; this.changed = true; }
  }

  private apply(dt: number) {
    const p = this.preset;
    U.uAurSpeed.value = 0.6 + this.activity * 0.5 + this.surge * 2.0;
    U.uAurTime.value += dt * U.uAurSpeed.value;
    U.uSurge.value += (this.surge - U.uSurge.value) * (1 - Math.exp(-dt * 3.0));
    U.uRippleT.value += dt;
    U.uMoonDir.value.copy(this.moonDir);
    (this.skyMat.uniforms.uMoonDisc.value as THREE.Color).setRGB(1, 1.03, 1.1).multiplyScalar(this.moonDisc);
    // aurora light bleeding into the northern haze
    const auroraLight = U.uAurora.value * (1 + U.uSurge.value * 1.6);
    tmp.copy(U.uAurCol1.value).lerp(U.uAurCol2.value, 0.5).multiplyScalar(0.018 * auroraLight);
    U.uAurGlow.value.copy(tmp);

    // the one shadow-casting light: the moon, or the aurora itself on moonless nights
    let L: THREE.Vector3;
    let col: THREE.Color;
    if (p.light === 'aurora') {
      L = new THREE.Vector3(0.1, 0.62, 0.78).normalize();
      col = tmp.copy(U.uAurCol1.value).lerp(U.uAurCol2.value, 0.6);
      col.multiplyScalar(this.lightI * auroraLight);
    } else if (p.light === 'twilight') {
      L = new THREE.Vector3(-0.15, 0.35, -0.92).normalize();
      col = tmp.copy(this.lightCol).multiplyScalar(this.lightI);
    } else {
      L = this.moonDir.y > 0.03 ? this.moonDir.clone() : new THREE.Vector3(this.moonDir.x, 0.03, this.moonDir.z).normalize();
      col = tmp.copy(this.lightCol).multiplyScalar(this.lightI * THREE.MathUtils.clamp(this.moonDir.y * 8, 0, 1));
    }
    if (U.uLightDir.value.distanceToSquared(L) > 1e-8) this.changed = true;
    U.uLightDir.value.lerp(L, dt > 0 ? 1 - Math.exp(-dt * 1.4) : 1).normalize();
    const I = Math.max(col.r, col.g, col.b);
    this.light.color.copy(I > 0 ? col.clone().multiplyScalar(1 / I) : col);
    this.light.intensity = I;
    U.uLightCol.value.copy(col);
  }
}

// Environment lighting from the sky (stars and moon disc suppressed).
export class SkyEnvironment {
  pmrem: THREE.PMREMGenerator;
  scene = new THREE.Scene();
  rt: THREE.WebGLRenderTarget | null = null;
  constructor(renderer: THREE.WebGLRenderer, skyMat: THREE.Material) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), skyMat);
    m.frustumCulled = false;
    this.scene.add(m);
  }
  update(): THREE.Texture {
    U.uEnvPass.value = 1;
    const old = this.rt;
    this.rt = this.pmrem.fromScene(this.scene, 0, 0.1, 100, { size: 64 } as any);
    U.uEnvPass.value = 0;
    if (old) old.dispose();
    return this.rt.texture;
  }
}
