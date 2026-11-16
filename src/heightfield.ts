import * as THREE from 'three';
import { U } from './shaderlib';

// The whole landscape comes from one GLSL height function, evaluated on the GPU
// into two textures (a sharp inner one around the lake, a wide outer one).
// Channels: R = height (m), G = normal.x, B = normal.z, A = lake distance d
// (d = 1 on the shore, < 1 over the ice). The CPU reads back small float
// copies for placing trees, hit-testing clicks and keeping the camera up.

export const ICE_LEVEL = 0.0;

export const HEIGHT_GLSL = /* glsl */ `
uniform vec2 uSeed;
vec3 permute3(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
float sfbm(vec2 p, int oct) {
  float s = 0.0, a = 1.0, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    s += a * snoise(p); n += a; a *= 0.5; p = p * 2.02 + vec2(13.7, -7.1);
  }
  return s / n;
}
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float smax(float a, float b, float k) { return -smin(-a, -b, k); }

float ridged(vec2 p, int oct) {
  float s = 0.0, a = 0.5, w = 1.0;
  for (int i = 0; i < 7; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(snoise(p));
    n = pow(n, 1.45);
    s += n * a * w;
    w = clamp(n * 1.6, 0.0, 1.0);
    a *= 0.5;
    p = p * 2.07 + vec2(19.1, -7.3);
  }
  return s;
}

// The lake: d = 1 on the shore, < 1 over the ice. Long axis runs east-west.
float lakeDist(vec2 p) {
  vec2 q = (p - vec2(0.0, 10.0)) * vec2(0.48, 1.0);
  float r = length(q);
  float a = atan(q.y, q.x);
  vec2 c = vec2(cos(a), sin(a));
  float R = 36.0 * (1.0 + 0.15 * snoise(c * 1.3 + uSeed * 0.3 + 2.0) + 0.07 * snoise(c * 3.1 + uSeed * 0.2 + 9.0));
  return r / R;
}

float mountains(vec2 p) {
  vec2 s = uSeed;
  vec2 w = p + 220.0 * vec2(sfbm(p * 0.0009 + s, 3), sfbm(p * 0.0009 + vec2(7.0, -3.0) + s, 3));
  float m = ridged(w * 0.00072 + s * 0.1, 7);
  float r = length(p * vec2(0.8, 1.0));
  // a ring of peaks well back from the valley, a little taller to the north;
  // broad massifs come and go so the skyline isn't a row of teeth
  float ring = smoothstep(520.0, 1500.0, r);
  float north = 0.75 + 0.35 * smoothstep(-400.0, 1200.0, p.y);
  north *= 0.55 + 0.6 * smoothstep(-0.4, 0.5, sfbm(p * 0.00045 + s + 3.0, 2));
  // fade out before the edge of the world so the mesh never ends in a cliff
  float edge = smoothstep(3150.0, 2350.0, r);
  return (m * 330.0 * ring * north + 55.0 * smoothstep(250.0, 800.0, r) * (0.5 + 0.5 * sfbm(p * 0.002 + s, 3))) * edge;
}

float heightAt(vec2 p) {
  float d = lakeDist(p);
  // flat lake bed under the ice
  float bed = -2.2 * smoothstep(1.0, 0.75, d);
  // snowy bank and rolling forest hills
  float hills = 9.0 * sfbm(p * 0.0075 + uSeed, 4) + 2.2 * sfbm(p * 0.03 + uSeed, 3);
  float bank = smoothstep(0.96, 1.25, d) * 0.6 + max(d - 1.0, 0.0) * 3.2;
  float near = bed + bank + hills * smoothstep(1.15, 3.0, d);
  // valley walls lift into the mountains
  return near + mountains(p) * smoothstep(1.6, 5.0, d);
}
`;

const GEN_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec4 uRect; // min.xy, size.zw
uniform float uEps;
${HEIGHT_GLSL}
void main() {
  vec2 p = uRect.xy + vUv * uRect.zw;
  float h = heightAt(p);
  float hx0 = heightAt(p - vec2(uEps, 0.0));
  float hx1 = heightAt(p + vec2(uEps, 0.0));
  float hz0 = heightAt(p - vec2(0.0, uEps));
  float hz1 = heightAt(p + vec2(0.0, uEps));
  vec3 n = normalize(vec3(hx0 - hx1, 2.0 * uEps, hz0 - hz1));
  gl_FragColor = vec4(h, n.x, n.z, lakeDist(p));
}
`;

const GEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export interface HeightfieldSet {
  inner: THREE.WebGLRenderTarget;
  outer: THREE.WebGLRenderTarget;
  innerRect: THREE.Vector4;
  outerRect: THREE.Vector4;
  /** CPU sample: [height, nx, nz, d] (bilinear) */
  sample(x: number, z: number): [number, number, number, number];
  height(x: number, z: number): number;
}

export const INNER_HALF = 320;
export const OUTER_HALF = 3200;

export function buildHeightfields(renderer: THREE.WebGLRenderer, seed = new THREE.Vector2(0, 0)): HeightfieldSet {
  const mat = new THREE.ShaderMaterial({
    vertexShader: GEN_VERT,
    fragmentShader: GEN_FRAG,
    uniforms: {
      uRect: { value: new THREE.Vector4() },
      uEps: { value: 0.2 },
      uSeed: { value: seed },
    },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const innerRect = new THREE.Vector4(-INNER_HALF, -INNER_HALF, INNER_HALF * 2, INNER_HALF * 2);
  const outerRect = new THREE.Vector4(-OUTER_HALF, -OUTER_HALF, OUTER_HALF * 2, OUTER_HALF * 2);

  const makeGpuRT = (size: number) =>
    new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });

  const render = (rt: THREE.WebGLRenderTarget, rect: THREE.Vector4, size: number) => {
    mat.uniforms.uRect.value.copy(rect);
    // half a texel, but never coarser than 1 m, so crests stay crisp
    mat.uniforms.uEps.value = Math.min(1.0, Math.max(0.08, (rect.z / size) * 0.5));
    renderer.setRenderTarget(rt);
    renderer.render(scene, cam);
    renderer.setRenderTarget(null);
  };

  const inner = makeGpuRT(2048);
  const outer = makeGpuRT(2048);
  render(inner, innerRect, 2048);
  render(outer, outerRect, 2048);

  // CPU copies (full float) for placement and camera collision
  const readCPU = (rect: THREE.Vector4, size: number) => {
    const rt = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });
    // texel i holds the world point rect.x + (i + 0.5) * rect.z / size
    render(rt, rect, size);
    const buf = new Float32Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
    rt.dispose();
    return buf;
  };
  const CPU_IN = 1024;
  const CPU_OUT = 512;
  const inBuf = readCPU(innerRect, CPU_IN);
  const outBuf = readCPU(outerRect, CPU_OUT);

  const out: [number, number, number, number] = [0, 0, 0, 0];
  const bilinear = (buf: Float32Array, size: number, rect: THREE.Vector4, x: number, z: number) => {
    let fx = ((x - rect.x) / rect.z) * size - 0.5;
    let fz = ((z - rect.y) / rect.w) * size - 0.5;
    fx = Math.min(size - 1.001, Math.max(0, fx));
    fz = Math.min(size - 1.001, Math.max(0, fz));
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const i00 = (iz * size + ix) * 4;
    const i10 = i00 + 4;
    const i01 = i00 + size * 4;
    const i11 = i01 + 4;
    for (let c = 0; c < 4; c++) {
      const a = buf[i00 + c] * (1 - tx) + buf[i10 + c] * tx;
      const b = buf[i01 + c] * (1 - tx) + buf[i11 + c] * tx;
      out[c] = a * (1 - tz) + b * tz;
    }
    return out;
  };

  const sample = (x: number, z: number): [number, number, number, number] => {
    if (Math.abs(x) < INNER_HALF * 0.98 && Math.abs(z) < INNER_HALF * 0.98) return bilinear(inBuf, CPU_IN, innerRect, x, z).slice() as any;
    return bilinear(outBuf, CPU_OUT, outerRect, x, z).slice() as any;
  };
  const height = (x: number, z: number) => sample(x, z)[0];

  mat.dispose();
  quad.geometry.dispose();

  // share with every patched material
  U.uHFInner.value = inner.texture;
  U.uHFOuter.value = outer.texture;
  U.uHFInnerRect.value.copy(innerRect);
  U.uHFOuterRect.value.copy(outerRect);

  return { inner, outer, innerRect, outerRect, sample, height };
}

