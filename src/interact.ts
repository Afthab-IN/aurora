import * as THREE from 'three';
import type { TreeInstance } from './pines';

export type PickKind = 'fire' | 'tree' | 'ice' | 'snow' | 'sky';
export interface Pick { kind: PickKind; point: THREE.Vector3; dir: THREE.Vector3; tree?: TreeInstance; dist: number; }

// CPU picking against the heightfield, the ice, the trees (as cones) and the fire.
export class Picker {
  private ray = new THREE.Raycaster();
  constructor(
    private camera: THREE.PerspectiveCamera,
    private sample: (x: number, z: number) => [number, number, number, number],
    private trees: TreeInstance[],
    private firePos: THREE.Vector3,
  ) {}

  pick(ndc: THREE.Vector2): Pick {
    this.ray.setFromCamera(ndc, this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    let best = Infinity;
    let res: Pick = { kind: 'sky', point: o.clone().addScaledVector(d, 1000), dir: d.clone(), dist: Infinity };

    // fire: a sphere around the flames
    {
      const c = this.firePos.clone().add(new THREE.Vector3(0, 0.7, 0));
      const oc = o.clone().sub(c);
      const b = oc.dot(d), cc = oc.lengthSq() - 1.5 * 1.5;
      const disc = b * b - cc;
      if (disc > 0) {
        const t = -b - Math.sqrt(disc);
        if (t > 0 && t < best) { best = t; res = { kind: 'fire', point: o.clone().addScaledVector(d, t), dir: d.clone(), dist: t }; }
      }
    }
    // trees: closest approach to each trunk axis, tested against the crown cone
    const den = d.x * d.x + d.z * d.z;
    if (den > 1e-6) {
      for (const tr of this.trees) {
        const t = ((tr.x - o.x) * d.x + (tr.z - o.z) * d.z) / den;
        if (t <= 0 || t > 600 || t > best) continue;
        const py = o.y + d.y * t;
        if (py < tr.y || py > tr.y + tr.height) continue;
        const hx = o.x + d.x * t - tr.x, hz = o.z + d.z * t - tr.z;
        const R = 0.28 * (tr.y + tr.height - py) + 0.25;
        if (hx * hx + hz * hz < R * R) { best = t; res = { kind: 'tree', point: new THREE.Vector3(o.x + d.x * t, py, o.z + d.z * t), dir: d.clone(), tree: tr, dist: t }; }
      }
    }
    // ground or ice: march, then refine
    const groundAt = (x: number, z: number) => { const s = this.sample(x, z); return s[3] < 1 ? Math.max(s[0], 0) : s[0]; };
    let tPrev = 0, t = 0.3;
    while (t < Math.min(best, 2500)) {
      const p = o.clone().addScaledVector(d, t);
      if (p.y < groundAt(p.x, p.z)) {
        let a = tPrev, b = t;
        for (let i = 0; i < 10; i++) {
          const m = (a + b) / 2;
          const q = o.clone().addScaledVector(d, m);
          if (q.y < groundAt(q.x, q.z)) b = m; else a = m;
        }
        const hit = o.clone().addScaledVector(d, b);
        const s = this.sample(hit.x, hit.z);
        const ice = s[3] < 0.985 && hit.y < 0.15;
        if (b < best) res = { kind: ice ? 'ice' : 'snow', point: hit, dir: d.clone(), dist: b };
        break;
      }
      tPrev = t;
      t += 0.25 + t * 0.02;
    }
    return res;
  }
}
