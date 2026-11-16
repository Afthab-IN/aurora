import * as THREE from 'three';
import { U, COMMON_GLSL } from './shaderlib';

// Bakes the land's own soft shadows (mountains, hills) into two textures (inner + outer, matching
// the heightfields). Re-baked only when the light direction changes, so the
// per-pixel cost is a single texture fetch.
export class LandShadow {
  inner = new THREE.WebGLRenderTarget(1024, 1024, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  outer = new THREE.WebGLRenderTarget(1024, 1024, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
  private mat: THREE.ShaderMaterial;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private last = new THREE.Vector3(9, 9, 9);

  constructor(private renderer: THREE.WebGLRenderer) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...U, uRect: { value: new THREE.Vector4() } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform vec4 uRect;
        ${COMMON_GLSL}
        void main() {
          vec2 p = uRect.xy + vUv * uRect.zw;
          vec4 s = hfLod(p, 0.0);
          vec3 n = hfNormalFrom(s);
          float sh = hfShadow(vec3(p.x, s.x, p.y) + n * 0.3, uLightDir);
          gl_FragColor = vec4(sh, sh, sh, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    q.frustumCulled = false;
    this.scene.add(q);
    U.uDSInner.value = this.inner.texture;
    U.uDSOuter.value = this.outer.texture;
  }

  /** returns true if it re-baked */
  update(force = false): boolean {
    const L = U.uLightDir.value;
    if (!force && L.distanceToSquared(this.last) < 1e-7) return false;
    this.last.copy(L);
    const prev = this.renderer.getRenderTarget();
    this.mat.uniforms.uRect.value.copy(U.uHFInnerRect.value);
    this.renderer.setRenderTarget(this.inner);
    this.renderer.render(this.scene, this.cam);
    this.mat.uniforms.uRect.value.copy(U.uHFOuterRect.value);
    this.renderer.setRenderTarget(this.outer);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prev);
    return true;
  }
}
