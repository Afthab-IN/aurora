import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Shot {
  name: string;
  duration: number;
  at(t: number): { pos: THREE.Vector3; look: THREE.Vector3 };
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const ease = (t: number) => t * t * (3 - 2 * t);
const pingpong = (t: number) => (t < 0.5 ? ease(t * 2) : ease(2 - t * 2));

export function makeShots(fire: THREE.Vector3): Shot[] {
  return [
    {
      name: 'Across the ice',
      duration: 40,
      at(t) {
        const e = pingpong(t);
        const pos = v(-38 + 62 * e, 2.0 + 0.6 * Math.sin(e * 3.1), -14 + 46 * e);
        return { pos, look: pos.clone().add(v(18, 42, 100)) };
      },
    },
    {
      name: 'Lakeside drift',
      duration: 60,
      at(t) {
        const e = pingpong(t);
        const pos = v(-72 + 144 * e, 5.5, -26 + 7 * Math.sin(e * Math.PI));
        return { pos, look: v(pos.x * 0.35, 48, 170) };
      },
    },
    {
      name: 'Sky gaze',
      duration: 50,
      at(t) {
        const e = pingpong(t);
        const ang = 0.18 + e * 1.15; // elevation of the gaze
        const yaw = -0.25 + e * 0.5;
        const pos = v(4, 1.8, 6);
        return { pos, look: pos.clone().add(v(Math.sin(yaw) * Math.cos(ang), Math.sin(ang), Math.cos(yaw) * Math.cos(ang)).multiplyScalar(50)) };
      },
    },
    {
      name: 'High valley',
      duration: 120,
      at(t) {
        const a = t * Math.PI * 2 - Math.PI / 2;
        return { pos: v(Math.cos(a) * 190, 85, 10 + Math.sin(a) * 150), look: v(0, 25, 30) };
      },
    },
    {
      name: 'Fireside',
      duration: 45,
      at(t) {
        const e = pingpong(t);
        const pos = fire.clone().add(v(-3.8 + 2.4 * e, 1.5, -3.2 + 0.6 * e));
        return { pos, look: pos.clone().add(v(10 - 18 * e, 22, 60)) };
      },
    },
    {
      name: 'Along the pines',
      duration: 55,
      at(t) {
        const e = pingpong(t);
        const a = -0.75 + 1.5 * e;
        const pos = v(Math.cos(a) * 92, 3.6, 10 + Math.sin(a) * 46);
        const tangent = v(-Math.sin(a) * 92, 0, Math.cos(a) * 46).normalize();
        return { pos, look: pos.clone().add(tangent.multiplyScalar(30)).add(v(-12, 22, 30)) };
      },
    },
  ];
}

export class CameraRig {
  controls: OrbitControls;
  shot: Shot | null = null;
  shotTime = 0;
  blend = 1;
  private fromPos = new THREE.Vector3();
  private fromLook = new THREE.Vector3();
  onShotEnd: (() => void) | null = null;

  constructor(public camera: THREE.PerspectiveCamera, dom: HTMLElement, private groundAt: (x: number, z: number) => number) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.target.set(8, 34, 60);
    this.controls.minDistance = 4;
    this.controls.maxDistance = 700;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.72; // allow looking up at the sky
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    this.controls.panSpeed = 0.8;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('start', () => {
      if (this.shot) { this.shot = null; this.onShotEnd?.(); }
    });
  }

  play(shot: Shot | null) {
    this.shot = shot;
    this.shotTime = 0;
    this.blend = 0;
    this.fromPos.copy(this.camera.position);
    this.fromLook.copy(this.controls.target);
  }

  update(dt: number) {
    if (this.shot) {
      this.shotTime += dt;
      const t = (this.shotTime / this.shot.duration) % 1;
      const { pos, look } = this.shot.at(t);
      this.blend = Math.min(1, this.blend + dt / 2.5);
      const b = ease(this.blend);
      this.camera.position.lerpVectors(this.fromPos, pos, b);
      const lk = new THREE.Vector3().lerpVectors(this.fromLook, look, b);
      this.controls.target.copy(lk);
      this.camera.lookAt(lk);
    } else {
      this.controls.update();
    }
    const g = this.groundAt(this.camera.position.x, this.camera.position.z) + 1.4;
    if (this.camera.position.y < g) this.camera.position.y = g;
  }
}
