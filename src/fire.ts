import * as THREE from 'three';
import { patchMaterial } from './shaderlib';
import { makeSimplex, mulberry32 } from './noise';

// A campfire on the shore: stone ring, logs, flame cards, rising embers and a
// flickering warm light. lit (0..1) fades in and out when you click it.
export class Campfire {
  group = new THREE.Group();
  light: THREE.PointLight;
  lit = 1;
  target = 1;
  private flameMat: THREE.ShaderMaterial;
  private emberMat: THREE.ShaderMaterial;
  private glowMat: THREE.SpriteMaterial;
  private glow: THREE.Sprite;
  private n = makeSimplex(5);

  constructor(public pos: THREE.Vector3, groundAt: (x: number, z: number) => number) {
    this.group.position.copy(pos);
    this.group.name = 'fire';
    const rnd = mulberry32(12);

    // stones
    const stoneGeo = new THREE.IcosahedronGeometry(0.28, 2);
    const sp = stoneGeo.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < sp.count; i++) {
      v.fromBufferAttribute(sp, i);
      v.multiplyScalar(1 + 0.25 * this.n(v.x * 3, v.y * 3 + v.z * 2));
      v.y *= 0.6;
      sp.setXYZ(i, v.x, v.y, v.z);
    }
    stoneGeo.computeVertexNormals();
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    patchMaterial(stoneMat, {
      key: 'stone',
      fragAfterMaps: /* glsl */ `
        {
          vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float snowTop = smoothstep(0.55, 0.85, wn.y) * smoothstep(0.35, 0.6, vnoise(vWPos.xz * 6.0));
          vec3 c = mix(vec3(0.07, 0.065, 0.06), vec3(0.16, 0.15, 0.14), vnoise(vWPos.xz * 9.0 + vWPos.y * 4.0));
          diffuseColor.rgb = mix(c, vec3(0.8, 0.85, 0.93), snowTop);
        }
      `,
    });
    const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, 11);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + rnd() * 0.2;
      const r = 0.95 + rnd() * 0.12;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const gy = groundAt(pos.x + x, pos.z + z) - pos.y;
      m.compose(new THREE.Vector3(x, gy + 0.05, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd(), rnd() * 6, rnd())), new THREE.Vector3(1, 1, 1).multiplyScalar(0.8 + rnd() * 0.5));
      stones.setMatrixAt(i, m);
    }
    stones.castShadow = true;
    stones.receiveShadow = true;
    this.group.add(stones);

    // logs: a teepee plus a bench log to sit on
    const logMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 });
    const fireLitU = { value: 1 };
    this.fireLitU = fireLitU;
    patchMaterial(logMat, {
      key: 'log',
      fragAfterMaps: /* glsl */ `
        {
          float g = vnoise(vec2(vWPos.y * 30.0, atan(vWPos.x, vWPos.z) * 4.0));
          vec3 c = mix(vec3(0.09, 0.06, 0.04), vec3(0.2, 0.14, 0.09), g);
          // charred and glowing near the flames
          float d = length(vWPos.xz - uFirePos.xz);
          float char = 1.0 - smoothstep(0.2, 0.7, vWPos.y - uFirePos.y + d * 0.4);
          diffuseColor.rgb = mix(c, vec3(0.02), char * 0.85);
          // snow lying along the top of the logs, melted away near the flames
          vec3 wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          float snowTop = smoothstep(0.45, 0.8, wn.y) * smoothstep(1.2, 2.2, d) * smoothstep(0.3, 0.55, vnoise(vWPos.xz * 7.0 + vWPos.y));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.87, 0.95), snowTop);
          totalEmissiveRadiance += vec3(1.0, 0.3, 0.05) * char * smoothstep(0.5, 0.8, vnoise(vWPos.xz * 18.0 + uTime * 0.6)) * 2.5 * uFireLit;
        }
      `,
      fragHead: 'uniform vec3 uFirePos; uniform float uFireLit;',
      extraUniforms: { uFirePos: { value: pos }, uFireLit: fireLitU },
    });
    const logGeo = new THREE.CylinderGeometry(0.07, 0.09, 1.3, 7);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const log = new THREE.Mesh(logGeo, logMat);
      log.position.set(Math.cos(a) * 0.28, 0.42, Math.sin(a) * 0.28);
      log.rotation.set(0, -a, 0);
      log.rotateZ(0.55);
      log.castShadow = true;
      this.group.add(log);
    }
    const bench = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 2.6, 10), logMat);
    const bx = -2.4, bz = 0.6;
    bench.position.set(bx, groundAt(pos.x + bx, pos.z + bz) - pos.y + 0.15, bz);
    bench.rotation.set(0, 0.4, Math.PI / 2);
    bench.castShadow = true;
    bench.receiveShadow = true;
    this.group.add(bench);
    // flames: crossed cards with an animated additive shader
    this.flameMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLit: { value: 1 }, uSeed: { value: 0 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform float uTime, uLit, uSeed;
        float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * n2(p); p *= 2.1; a *= 0.5; } return s; }
        void main() {
          vec2 uv = vUv;
          float t = uTime * 1.6 + uSeed * 10.0;
          float y = uv.y / max(uLit, 0.05);
          float n = fbm(vec2(uv.x * 4.0 + uSeed * 3.0, uv.y * 3.0 - t * 2.2));
          float w = 0.5 - abs(uv.x - 0.5 + (n - 0.5) * 0.25 * uv.y);
          float shape = smoothstep(0.0, 0.35, w) * (1.0 - smoothstep(0.15, 0.95, y + (n - 0.5) * 0.5));
          float core = smoothstep(0.12, 0.42, w) * (1.0 - smoothstep(0.0, 0.45, y + (n - 0.5) * 0.4));
          float f = clamp(shape * (0.6 + n), 0.0, 1.0);
          vec3 col = mix(vec3(1.0, 0.18, 0.02), vec3(1.0, 0.62, 0.18), f);
          col = mix(col, vec3(1.0, 0.92, 0.6), core);
          float a = f * uLit;
          gl_FragColor = vec4(col * a * 2.6, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const flameGeo = new THREE.PlaneGeometry(1.1, 1.9);
    flameGeo.translate(0, 0.95, 0);
    for (let i = 0; i < 3; i++) {
      const mat = this.flameMat.clone();
      mat.uniforms.uSeed.value = i * 0.37;
      mat.uniforms.uTime = this.flameMat.uniforms.uTime;
      mat.uniforms.uLit = this.flameMat.uniforms.uLit;
      const f = new THREE.Mesh(flameGeo, mat);
      f.rotation.y = (i / 3) * Math.PI;
      f.position.y = 0.12;
      f.renderOrder = 20;
      this.group.add(f);
    }

    // soft glow halo
    const gc = document.createElement('canvas');
    gc.width = gc.height = 128;
    const gg = gc.getContext('2d')!;
    const grad = gg.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,170,80,1)');
    grad.addColorStop(0.3, 'rgba(255,110,30,0.35)');
    grad.addColorStop(1, 'rgba(255,80,10,0)');
    gg.fillStyle = grad;
    gg.fillRect(0, 0, 128, 128);
    this.glowMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(gc), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
    this.glow = new THREE.Sprite(this.glowMat);
    this.glow.scale.setScalar(4.5);
    this.glow.position.y = 0.7;
    this.glow.renderOrder = 21;
    this.group.add(this.glow);

    // embers: positions computed on the GPU from a seed and the time
    const N = 160;
    const seeds = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { seeds[i * 3] = rnd(); seeds[i * 3 + 1] = rnd(); seeds[i * 3 + 2] = rnd(); }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    eg.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    this.emberMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uLit: { value: 1 }, uPx: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute vec3 aSeed;
        uniform float uTime, uLit, uPx;
        varying float vA;
        void main() {
          float life = 2.2 + aSeed.x * 2.0;
          float t = mod(uTime + aSeed.y * 10.0, life) / life;
          vec3 p = vec3((aSeed.z - 0.5) * 0.6, 0.3, (aSeed.x - 0.5) * 0.6);
          p.y += t * (2.5 + aSeed.y * 3.5);
          p.x += sin(t * 6.0 + aSeed.y * 20.0) * 0.35 * t;
          p.z += cos(t * 5.0 + aSeed.z * 20.0) * 0.35 * t;
          vA = (1.0 - t) * smoothstep(0.0, 0.08, t) * uLit;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (1.5 + aSeed.z * 2.0) * uPx * 18.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d) * vA;
          gl_FragColor = vec4(vec3(1.0, 0.45, 0.1) * a * 6.0, 1.0);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const embers = new THREE.Points(eg, this.emberMat);
    embers.frustumCulled = false;
    embers.renderOrder = 22;
    this.group.add(embers);

    this.light = new THREE.PointLight(0xff8a3a, 40, 45, 2);
    this.light.position.set(0, 0.9, 0);
    this.group.add(this.light);
  }
  private fireLitU = { value: 1 };

  toggle() { this.target = this.target > 0.5 ? 0 : 1; }

  update(dt: number, time: number, pxRatio: number) {
    this.lit += (this.target - this.lit) * (1 - Math.exp(-dt * (this.target > this.lit ? 2.5 : 1.6)));
    const flick = 0.82 + 0.12 * this.n(time * 3.1, 0.5) + 0.08 * this.n(time * 9.3, 4.1);
    this.light.intensity = 32 * this.lit * flick;
    this.light.position.x = 0.08 * this.n(time * 2.0, 9.0);
    this.light.position.z = 0.08 * this.n(time * 2.0, 3.0);
    this.flameMat.uniforms.uTime.value = time;
    this.flameMat.uniforms.uLit.value = this.lit;
    this.emberMat.uniforms.uTime.value = time;
    this.emberMat.uniforms.uLit.value = this.lit;
    this.emberMat.uniforms.uPx.value = pxRatio;
    this.glowMat.opacity = this.lit * flick * 0.32;
    this.glow.scale.setScalar(3.2 * (0.9 + 0.1 * flick));
    this.fireLitU.value = this.lit; // glowing coals in the log shader
  }
}
