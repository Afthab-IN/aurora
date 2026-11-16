import * as THREE from 'three';
import { patchMaterial } from './shaderlib';

// Two meshes share one snow shader:
//  - an inner grid around the lake, dense where you stand (sub-metre at the centre)
//  - a polar ring for the mountains, dense along the circle so ridgelines seen
//    from the valley stay smooth against the bright aurora sky.
// They overlap in a thin band; both shade from the same textures, so the
// overlap is invisible.
const SEAM = 365;

function innerGrid(): THREE.BufferGeometry {
  const N = 300, S = 385, a = 0.15;
  const map = (s: number) => S * (a * s + (1 - a) * s * s * s);
  const pos = new Float32Array((N + 1) * (N + 1) * 3);
  let k = 0;
  for (let j = 0; j <= N; j++) {
    const z = map((j / N) * 2 - 1);
    for (let i = 0; i <= N; i++) {
      pos[k++] = map((i / N) * 2 - 1); pos[k++] = 0; pos[k++] = z;
    }
  }
  const idx = new Uint32Array(N * N * 6);
  k = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const v0 = j * (N + 1) + i, v1 = v0 + 1, v2 = v0 + N + 1, v3 = v2 + 1;
    if ((i + j) & 1) { idx[k++] = v0; idx[k++] = v2; idx[k++] = v1; idx[k++] = v1; idx[k++] = v2; idx[k++] = v3; }
    else { idx[k++] = v0; idx[k++] = v2; idx[k++] = v3; idx[k++] = v0; idx[k++] = v3; idx[k++] = v1; }
  }
  return finish(pos, idx);
}

function polarRing(): THREE.BufferGeometry {
  const A = 960; // segments around
  const r0 = SEAM - 15, r1 = 3200, grow = 1.012;
  const radii: number[] = [];
  for (let r = r0; r < r1; r *= grow) radii.push(r);
  radii.push(r1);
  const R = radii.length;
  const pos = new Float32Array(R * A * 3);
  let k = 0;
  for (let j = 0; j < R; j++) for (let i = 0; i < A; i++) {
    const t = (i / A) * Math.PI * 2;
    pos[k++] = Math.cos(t) * radii[j]; pos[k++] = 0; pos[k++] = Math.sin(t) * radii[j];
  }
  const idx = new Uint32Array((R - 1) * A * 6);
  k = 0;
  for (let j = 0; j < R - 1; j++) for (let i = 0; i < A; i++) {
    const i2 = (i + 1) % A;
    const v0 = j * A + i, v1 = j * A + i2, v2 = (j + 1) * A + i, v3 = (j + 1) * A + i2;
    idx[k++] = v0; idx[k++] = v2; idx[k++] = v1; idx[k++] = v1; idx[k++] = v2; idx[k++] = v3;
  }
  return finish(pos, idx);
}

function finish(pos: Float32Array, idx: Uint32Array) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 5000);
  return geo;
}

function snowMaterial(zone: 0 | 1) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, metalness: 0 });
  patchMaterial(mat, {
    key: 'snow' + zone,
    defines: { ZONE: zone },
    vsReplace: [
      ['#include <beginnormal_vertex>', 'vec4 hfV = hfLod(position.xz, 0.0);\nobjectNormal = hfNormalFrom(hfV);'],
      ['#include <begin_vertex>', 'transformed.y = hfV.x;'],
    ],
    fragAfterMaps: /* glsl */ `
      vec2 P = vWPos.xz;
      {
        float rr = length(P);
        #if ZONE == 0
          if (rr > ${(SEAM + 6).toFixed(1)}) discard;
        #else
          if (rr < ${(SEAM - 6).toFixed(1)}) discard;
        #endif
      }
      vec4 hs = mix(
        texture(uHFOuter, (P - uHFOuterRect.xy) / uHFOuterRect.zw),
        texture(uHFInner, (P - uHFInnerRect.xy) / uHFInnerRect.zw),
        hfInnerWeight(P));
      vec3 nW = normalize(hfNormalFrom(hs));
      float ld = hs.w;
      float camDist = length(vWPos - cameraPosition);

      // sastrugi: soft wind-carved ridges on the open snow
      vec2 wd = normalize(vec2(0.8, 0.6));
      float warp = 1.3 * vnoise(P * 0.08) + 0.5 * vnoise(P * 0.37);
      float rw = (dot(P, wd) + warp) / 1.7;
      float fw = fwidth(rw);
      float rippleFade = (1.0 - smoothstep(0.2, 0.6, fw)) * smoothstep(0.86, 0.97, nW.y) * smoothstep(1.08, 1.3, ld);
      float ph = rw * 6.2831853;
      float g = (cos(ph) + 0.45 * cos(2.0 * ph + 0.9)) * 0.11 * rippleFade * (0.35 + 0.65 * vnoise(P * 0.035));
      nW = normalize(nW - vec3(wd.x, 0.0, wd.y) * g);

      // snow, with dark rock showing through on the steepest faces
      float slope = 1.0 - nW.y;
      float rn = vnoise(P * 0.07) * 0.6 + vnoise(P * 0.29) * 0.4;
      float rock = smoothstep(0.34, 0.5, slope + (rn - 0.5) * 0.28);
      float ledge = smoothstep(0.5, 0.78, vnoise(P * 0.6 + vWPos.y * 0.25));
      rock *= 1.0 - ledge * 0.65;
      vec3 snowCol = vec3(0.86, 0.9, 0.97) * (0.93 + 0.07 * vnoise(P * 0.18));
      vec3 rockCol = mix(vec3(0.05, 0.05, 0.06), vec3(0.14, 0.13, 0.13), rn);
      diffuseColor.rgb = mix(snowCol, rockCol, rock);
      roughnessFactor = mix(0.7, 0.92, rock);
      normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
    `,
    fragAfterLights: /* glsl */ `
      {
        // snow scatters light under its surface: soften the terminator
        vec3 Lw = uLightDir;
        float ndl = dot(nW, Lw);
        float wrap = clamp((ndl + 0.35) / 1.35, 0.0, 1.0) - max(ndl, 0.0);
        reflectedLight.directDiffuse += diffuseColor.rgb * directLight.color * wrap * 0.35 / 3.14159 * vec3(0.8, 0.9, 1.1);
        // glitter: ice crystals that flash as you move
        vec3 Vd = normalize(cameraPosition - vWPos);
        vec2 cell = floor(P * 34.0);
        float view = dot(Vd, vec3(5.1, 3.7, 4.3)) * 3.2;
        float sp = step(0.991, h21(cell + floor(view)));
        float fade = smoothstep(2.0, 8.0, camDist) * (1.0 - smoothstep(30.0, 90.0, camDist));
        reflectedLight.directSpecular += directLight.color * sp * max(ndl, 0.0) * fade * 2.2 * (1.0 - rock);
      }
    `,
  });
  return mat;
}

export function buildTerrain(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'terrain';
  const inner = new THREE.Mesh(innerGrid(), snowMaterial(0));
  const ring = new THREE.Mesh(polarRing(), snowMaterial(1));
  for (const m of [inner, ring]) {
    m.frustumCulled = false;
    m.receiveShadow = true;
    m.castShadow = false;
    group.add(m);
  }
  return group;
}
