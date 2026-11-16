import * as THREE from 'three';

// Uniforms shared by every patched material. The same {value} objects are
// referenced everywhere, so updating U.x.value once updates all shaders.
export const U = {
  uTime: { value: 0 },
  uLightDir: { value: new THREE.Vector3(0.4, 0.4, -0.3).normalize() }, // moon (or twilight sun), points TO the light
  uLightCol: { value: new THREE.Color(1, 1, 1) },
  uMoonDir: { value: new THREE.Vector3(0.4, 0.4, -0.3).normalize() },
  uZenith: { value: new THREE.Color(0.005, 0.01, 0.03) },
  uHorizon: { value: new THREE.Color(0.03, 0.05, 0.09) },
  uMoonGlow: { value: new THREE.Color(0.1, 0.12, 0.16) },
  uGround: { value: new THREE.Color(0.05, 0.06, 0.08) },
  uFogDensity: { value: 0.0004 },
  uAurGlow: { value: new THREE.Color(0.02, 0.08, 0.05) }, // aurora light bleeding into the northern horizon haze
  // aurora
  uAurora: { value: 1.0 }, // overall brightness
  uAurCol1: { value: new THREE.Color(0.1, 1.0, 0.45) }, // lower edge
  uAurCol2: { value: new THREE.Color(0.1, 0.8, 0.6) }, // middle
  uAurCol3: { value: new THREE.Color(0.6, 0.2, 0.8) }, // upper fringe
  uAurSpeed: { value: 1.0 },
  uAurTime: { value: 0 }, // integrated time so speed changes don't jump
  uSurge: { value: 0 },
  uRippleDir: { value: new THREE.Vector3(0, 0.5, 1).normalize() },
  uRippleT: { value: 100 },
  uStars: { value: 1.0 },
  uMilky: { value: 1.0 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6).normalize() },
  uWindAmp: { value: 1.0 },
  uGust: { value: 0 },
  uEnvPass: { value: 0 },
  uHFInner: { value: null as THREE.Texture | null },
  uHFOuter: { value: null as THREE.Texture | null },
  uHFInnerRect: { value: new THREE.Vector4(-1, -1, 2, 2) },
  uHFOuterRect: { value: new THREE.Vector4(-1, -1, 2, 2) },
  uDSInner: { value: null as THREE.Texture | null },
  uDSOuter: { value: null as THREE.Texture | null },
};

// Night atmosphere used by the sky dome and by the fog in every material.
export const ATMO_GLSL = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uMoonGlow;
uniform vec3 uMoonDir;
uniform vec3 uGround;
uniform vec3 uAurGlow;
uniform float uFogDensity;

vec3 atmosphere(vec3 dir) {
  float y = dir.y;
  float up = clamp(y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.7, pow(up, 0.6)));
  sky += uHorizon * 0.25 * exp(-abs(y) * 18.0);
  float md = max(dot(dir, normalize(uMoonDir)), 0.0);
  sky += uMoonGlow * (pow(md, 6.0) * 0.5 + pow(md, 60.0) * 0.8);
  // the aurora sits in the north (+z): its light tints the haze low over that horizon
  float north = smoothstep(-0.3, 0.9, dir.z);
  sky += uAurGlow * north * (exp(-up * 5.0) * 0.9 + 0.15);
  if (y < 0.0) sky = mix(sky, uGround, clamp(-y * 3.0, 0.0, 1.0));
  return sky;
}
`;

// GLSL for sampling the heightfields from any patched material.
const HF_SAMPLE_GLSL = /* glsl */ `
uniform sampler2D uHFInner;
uniform sampler2D uHFOuter;
uniform vec4 uHFInnerRect;
uniform vec4 uHFOuterRect;
float hfInnerWeight(vec2 p) {
  vec2 ui = (p - uHFInnerRect.xy) / uHFInnerRect.zw;
  vec2 e = min(ui, 1.0 - ui);
  return smoothstep(0.0, 0.07, min(e.x, e.y));
}
vec4 hfLod(vec2 p, float lod) {
  vec4 o = textureLod(uHFOuter, (p - uHFOuterRect.xy) / uHFOuterRect.zw, lod);
  vec4 i = textureLod(uHFInner, (p - uHFInnerRect.xy) / uHFInnerRect.zw, lod);
  return mix(o, i, hfInnerWeight(p));
}
float hfHeight(vec2 p) { return hfLod(p, 0.0).x; }
vec3 hfNormalFrom(vec4 s) { return vec3(s.y, sqrt(max(0.0, 1.0 - s.y * s.y - s.z * s.z)), s.z); }

// Baked terrain shadow (see landshadow.ts), refreshed when the light moves.
uniform sampler2D uDSInner;
uniform sampler2D uDSOuter;
float landShadowAt(vec2 p) {
  float o = textureLod(uDSOuter, (p - uHFOuterRect.xy) / uHFOuterRect.zw, 0.0).r;
  float i = textureLod(uDSInner, (p - uHFInnerRect.xy) / uHFInnerRect.zw, 0.0).r;
  return mix(o, i, hfInnerWeight(p));
}

// Soft shadow cast by the land itself (ray-march toward the light). Reaches
// far enough for mountain shadows to cross the valley under a low moon.
float hfShadow(vec3 p, vec3 L) {
  if (L.y <= 0.002) return 0.0;
  float res = 1.0;
  float t = 1.5;
  for (int i = 0; i < 44; i++) {
    vec3 q = p + L * t;
    if (q.y > 900.0) break;
    float h = hfLod(q.xz, 1.0).x;
    res = min(res, 9.0 * (q.y - h) / t);
    if (res < -0.02) break;
    t += max(1.2, t * 0.22);
  }
  return clamp(res, 0.0, 1.0);
}
`;

export const COMMON_GLSL = /* glsl */ `
uniform float uTime;
uniform vec3 uLightDir;
uniform vec3 uLightCol;
uniform vec2 uWindDir;
uniform float uWindAmp;
uniform float uGust;
${ATMO_GLSL}
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm3(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
float fbm5(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
${HF_SAMPLE_GLSL}
`;

export const FOG_APPLY_GLSL = /* glsl */ `
{
  vec3 fogRay = vWPos - cameraPosition;
  float fogDist = length(fogRay);
  vec3 fogDir = fogRay / max(fogDist, 1e-4);
  float hAvg = max(0.0, (vWPos.y + cameraPosition.y) * 0.5);
  float dens = uFogDensity * (0.3 + 0.7 * exp(-hAvg * 0.004));
  float fogAmt = 1.0 - exp(-fogDist * dens);
  vec3 fogCol = atmosphere(normalize(vec3(fogDir.x, max(fogDir.y, 0.0) * 0.35 + 0.015, fogDir.z)));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, clamp(fogAmt, 0.0, 1.0));
}
`;

const WIND_FN = /* glsl */ `
#ifdef USE_WIND
attribute float aSway;
#ifdef USE_KICK
attribute float aKick; // time a tree was last shaken
#endif
vec3 windOffset(vec3 wp, float sway, vec3 origin) {
  float ph = dot(origin.xz, vec2(0.071, 0.053));
  float gust = 0.55 + 0.35 * sin(uTime * 0.31 + origin.x * 0.011 + origin.z * 0.008) + uGust * 1.6;
  float w = sin(uTime * 0.9 + ph) * 0.5 + sin(uTime * 2.0 + ph * 1.7 + wp.y * 0.3) * 0.2;
  float flutter = sin(uTime * 5.5 + wp.x * 2.1 + wp.z * 1.7) * 0.04 * (1.0 + uGust * 2.0);
  vec3 d = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec3 off = (d * (w * gust + 0.3 * gust) + vec3(0.0, flutter, 0.0)) * sway * uWindAmp;
  #ifdef USE_KICK
  float kt = uTime - aKick;
  if (kt > 0.0 && kt < 4.0) {
    float k = sin(kt * 11.0) * exp(-kt * 2.2);
    off += vec3(k, -abs(k) * 0.3, k * 0.6) * sway * 0.9;
  }
  #endif
  return off;
}
#endif
`;

const PROJECT_REPLACE = /* glsl */ `
vec4 oWP = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  oWP = batchingMatrix * oWP;
#endif
#ifdef USE_INSTANCING
  oWP = instanceMatrix * oWP;
#endif
oWP = modelMatrix * oWP;
#ifdef USE_WIND
{
  vec4 io = vec4(0.0, 0.0, 0.0, 1.0);
  #ifdef USE_INSTANCING
    io = instanceMatrix * io;
  #endif
  io = modelMatrix * io;
  oWP.xyz += windOffset(oWP.xyz, aSway, io.xyz);
}
#endif
vWPos = oWP.xyz;
vec4 mvPosition = viewMatrix * oWP;
gl_Position = projectionMatrix * mvPosition;
`;

export interface PatchOpts {
  key: string;
  wind?: boolean;
  kick?: boolean;
  fog?: boolean;
  vertexHead?: string;
  vertexAfterProject?: string;
  fragHead?: string;
  fragAfterMaps?: string;
  fragAfterLights?: string;
  fragBeforeFog?: string;
  extraUniforms?: Record<string, THREE.IUniform>;
  vsReplace?: Array<[string, string]>;
  fsReplace?: Array<[string, string]>;
  defines?: Record<string, string | number | boolean>;
  noLandShadow?: boolean;
}

export function patchMaterial<T extends THREE.Material>(mat: T, o: PatchOpts): T {
  const fog = o.fog !== false;
  const defs: Record<string, any> = { ...(mat as any).defines };
  if (o.wind) defs.USE_WIND = '';
  if (o.kick) defs.USE_KICK = '';
  Object.assign(defs, o.defines || {});
  (mat as any).defines = defs;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, U, o.extraUniforms || {});
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', `#include <common>\n${COMMON_GLSL}\n${WIND_FN}\nvarying vec3 vWPos;\n${o.vertexHead || ''}`);
    for (const [inc, code] of o.vsReplace || []) vs = vs.replace(inc, `${inc}\n${code}`);
    vs = vs.replace('#include <project_vertex>', PROJECT_REPLACE + (o.vertexAfterProject || ''));
    shader.vertexShader = vs;

    let fs = shader.fragmentShader;
    fs = fs.replace('#include <common>', `#include <common>\n${COMMON_GLSL}\nvarying vec3 vWPos;\n${o.fragHead || ''}`);
    for (const [inc, code] of o.fsReplace || []) fs = fs.replace(inc, `${inc}\n${code}`);
    if (o.fragAfterMaps) fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${o.fragAfterMaps}`);
    const ds = o.noLandShadow ? '' : 'float ds = landShadowAt(vWPos.xz);\nreflectedLight.directDiffuse *= ds;\nreflectedLight.directSpecular *= ds;\ndirectLight.color *= ds;\n';
    fs = fs.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${ds}${o.fragAfterLights || ''}`);
    fs = fs.replace('#include <fog_fragment>', `${o.fragBeforeFog || ''}\n${fog ? FOG_APPLY_GLSL : ''}`);
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'aurora-' + o.key;
  return mat;
}

export function windDepthMaterial(key: string, map?: THREE.Texture | null, alphaTest = 0, kick = false): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: map || null, alphaTest });
  return patchMaterial(m, { key: 'depth-' + key, wind: true, kick, fog: false });
}
