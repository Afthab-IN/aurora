import * as THREE from 'three';
import { U } from './shaderlib';
import { buildHeightfields } from './heightfield';
import { buildTerrain } from './terrain';
import { buildSkyDome, NightState, SkyEnvironment, NIGHT_PRESETS, AURORA_PALETTES, AuroraPass } from './sky';
import { LandShadow } from './landshadow';
import { PlanarReflection } from './reflection';
import { CrackLayer, buildIce } from './ice';
import { buildPineMaterials, buildForest, makePineSpecs, TreeInstance } from './pines';
import { Campfire } from './fire';
import { Snowfall, Bursts } from './fx';
import { Sound } from './audio';
import { Picker } from './interact';
import { buildPost, GRADE_PRESETS } from './post';
import { CameraRig, makeShots } from './camera';
import { Toolbar } from './ui';
import { mulberry32, makeSimplex } from './noise';

const SNOW_LEVELS = [
  { name: 'Clear', density: 0 },
  { name: 'Flurries', density: 0.25 },
  { name: 'Snowfall', density: 1 },
];

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
const maxDpr = Math.min(window.devicePixelRatio || 1, 2);
let dpr = Math.min(maxDpr, 1.25);
renderer.setPixelRatio(dpr);
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.5;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.3, 8000);
camera.position.set(-4, 4.5, -56);

async function init() {
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  // ---- land + sky ----
  const hf = buildHeightfields(renderer, new THREE.Vector2(1.3, 4.1));
  const groundAt = (x: number, z: number) => hf.height(x, z);
  const terrain = buildTerrain();
  scene.add(terrain);
  const sky = buildSkyDome();
  scene.add(sky);
  const skyMat = sky.material as THREE.ShaderMaterial;

  const moon = new THREE.DirectionalLight(0xffffff, 1);
  moon.castShadow = true;
  moon.shadow.mapSize.set(4096, 4096);
  const sc = moon.shadow.camera as THREE.OrthographicCamera;
  sc.left = -230; sc.right = 230; sc.top = 230; sc.bottom = -230; sc.near = 1; sc.far = 1600;
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.08;
  moon.shadow.radius = 2;
  moon.target.position.set(0, 0, 15);
  scene.add(moon, moon.target);
  const night = new NightState(moon, skyMat);
  const landShadow = new LandShadow(renderer);
  const env = new SkyEnvironment(renderer, skyMat);
  scene.environment = env.update();

  // ---- ice ----
  const reflection = new PlanarReflection(window.innerWidth * dpr, window.innerHeight * dpr);
  // the main view samples a half-res aurora pass; the reflection marches its own, cheaply
  const auroraPass = new AuroraPass();
  skyMat.uniforms.tAurora.value = auroraPass.rt.texture;
  reflection.onBefore = () => { skyMat.uniforms.uAurUseRT.value = 0; };
  reflection.onAfter = () => { skyMat.uniforms.uAurUseRT.value = 1; };
  skyMat.uniforms.uAurUseRT.value = 1;
  const cracks = new CrackLayer(renderer);
  const ice = buildIce(reflection, cracks);
  scene.add(ice.mesh);

  // ---- forest ----
  const rnd = mulberry32(777);
  const nz = makeSimplex(21);
  // the fire sits on the south shore, a little west
  const firePos = new THREE.Vector3();
  {
    const dir = new THREE.Vector2(-0.28, -1).normalize();
    for (let t = 10; t < 120; t += 0.25) {
      const x = dir.x * t, z = 10 + dir.y * t;
      if (hf.sample(x, z)[3] > 1.13) { firePos.set(x, groundAt(x, z), z); break; }
    }
  }
  const trees: TreeInstance[] = [];
  const grid = new Map<string, { x: number; z: number; r: number }[]>();
  const CELL = 8;
  const clear = (x: number, z: number, r: number) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      for (const p of grid.get(`${cx + i},${cz + j}`) || []) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (p.r + r) ** 2) return false;
    }
    return true;
  };
  const occupy = (x: number, z: number, r: number) => {
    const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push({ x, z, r });
  };
  const specs = makePineSpecs();
  const scatterTrees = (count: number, rMin: number, rMax: number, spacing: number, far: boolean) => {
    let tries = count * 60, n = 0;
    while (n < count && tries-- > 0) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rMin * rMin + rnd() * (rMax * rMax - rMin * rMin));
      const x = Math.cos(a) * r, z = 10 + Math.sin(a) * r;
      const s = hf.sample(x, z);
      const ny = Math.sqrt(Math.max(0, 1 - s[1] * s[1] - s[2] * s[2]));
      if (s[3] < 1.12 || ny < (far ? 0.86 : 0.82) || s[0] > (far ? 170 : 70)) continue;
      // clearings, a thinner shore, an open patch where you start, room round the fire
      const dens = nz(x * 0.018, z * 0.018) * 0.6 + nz(x * 0.05, z * 0.05) * 0.4;
      if (dens < -0.15) continue;
      if (s[3] < 1.3 && rnd() < 0.55) continue;
      if (((x + 12) / 42) ** 2 + ((z + 44) / 17) ** 2 < 1) continue;
      if ((x - firePos.x) ** 2 + (z - firePos.z) ** 2 < 11 * 11) continue;
      if (!clear(x, z, spacing)) continue;
      occupy(x, z, spacing);
      const vi = Math.min(7, Math.floor(Math.pow(rnd(), 0.8) * 8));
      const scale = 0.8 + rnd() * 0.45;
      trees.push({
        x, y: s[0] - 0.15, z, rotY: rnd() * Math.PI * 2, scale, variant: vi + (far ? 8 : 0), far,
        height: specs[vi].height * scale, snow: 0.7 + rnd() * 0.3,
      });
      n++;
    }
  };
  scatterTrees(820, 30, 330, 1.7, false);
  scatterTrees(650, 330, 950, 3.2, true);
  const pineMats = buildPineMaterials();
  const forest = buildForest(specs, trees, pineMats);
  scene.add(forest);

  // ---- fire, snow, bursts ----
  const fire = new Campfire(firePos, groundAt);
  scene.add(fire.group);
  const snowfall = new Snowfall();
  scene.add(snowfall.points);
  snowfall.points.layers.set(1);
  const bursts = new Bursts();
  scene.add(bursts.points);
  bursts.points.layers.set(1);
  camera.layers.enable(1);
  const sound = new Sound();

  // ---- post + camera ----
  const post = buildPost(renderer, scene, camera, window.innerWidth, window.innerHeight);
  post.setPreset(GRADE_PRESETS[0]);
  const rig = new CameraRig(camera, canvas, groundAt);
  rig.controls.update();
  const shots = makeShots(firePos);
  const picker = new Picker(camera, hf.sample, trees.filter((t) => !t.far || true), firePos);

  // ---- interactions ----
  const touched = new Set<TreeInstance>();
  const shakeTree = (tr: TreeInstance) => {
    const bm = tr.mesh!, tm = tr.trunkMesh!, i = tr.slot!;
    const kick = bm.geometry.getAttribute('aKick') as THREE.InstancedBufferAttribute;
    kick.setX(i, U.uTime.value);
    kick.needsUpdate = true;
    const before = tr.snow;
    tr.snow = Math.min(tr.snow, 0.12);
    touched.add(tr);
    // snow falling from the crown
    const H = tr.height, n = Math.round(380 * before);
    for (let k = 0; k < n; k++) {
      const h = tr.y + 0.8 + (H - 0.8) * Math.pow(rnd(), 0.75);
      const R = 0.28 * (tr.y + H - h) * Math.sqrt(rnd());
      const a = rnd() * Math.PI * 2;
      bursts.emit({
        x: tr.x + Math.cos(a) * R, y: h, z: tr.z + Math.sin(a) * R,
        vx: Math.cos(a) * (0.4 + rnd()), vy: rnd() * 0.6, vz: Math.sin(a) * (0.4 + rnd()),
        life: 1.6 + rnd() * 1.8, size: 0.06 + rnd() * 0.2, drag: 1.4, grav: 3.2,
      });
    }
    void tm;
    setTimeout(() => sound.whump(), 350);
  };
  const crackIce = (p: THREE.Vector3) => {
    cracks.crack(p.x, p.z, U.uTime.value, (x, z) => hf.sample(x, z)[3] < 0.985);
    for (let k = 0; k < 45; k++) {
      const a = rnd() * Math.PI * 2, s = 1 + rnd() * 3;
      bursts.emit({ x: p.x, y: 0.05, z: p.z, vx: Math.cos(a) * s, vy: 2 + rnd() * 3, vz: Math.sin(a) * s, life: 0.8 + rnd() * 0.6, size: 0.04 + rnd() * 0.06, grav: 9.8, drag: 0.6, r: 0.75, g: 0.9, b: 1, glow: 0.9 });
    }
    sound.crack(0.8 + rnd() * 0.4);
    shake = 0.35;
  };
  const toggleFire = () => {
    fire.toggle();
    if (fire.target > 0.5) {
      for (let k = 0; k < 90; k++) {
        const a = rnd() * Math.PI * 2, s = 0.5 + rnd() * 2.5;
        bursts.emit({ x: firePos.x, y: firePos.y + 0.5, z: firePos.z, vx: Math.cos(a) * s * 0.5, vy: 3 + rnd() * 5, vz: Math.sin(a) * s * 0.5, life: 0.8 + rnd() * 1.2, size: 0.03 + rnd() * 0.05, grav: -0.6, drag: 1.2, r: 1, g: 0.45, b: 0.1, glow: 5 });
      }
      sound.whoosh();
    }
  };
  const puffSnow = (p: THREE.Vector3) => {
    for (let k = 0; k < 40; k++) {
      const a = rnd() * Math.PI * 2, s = 0.3 + rnd() * 1.2;
      bursts.emit({ x: p.x, y: p.y + 0.05, z: p.z, vx: Math.cos(a) * s, vy: 0.8 + rnd() * 1.5, vz: Math.sin(a) * s, life: 0.8 + rnd() * 0.8, size: 0.05 + rnd() * 0.1, grav: 2.5, drag: 2.2 });
    }
    sound.crunch();
  };

  let shake = 0;
  let downAt = { x: 0, y: 0, t: 0, sky: false };
  let holding = false;
  let holdTimer = 0;
  let rippleTimer = 0;
  const ndc = new THREE.Vector2();
  const toNdc = (e: PointerEvent) => ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  let lastPick = 0;
  let firstTouch = true;
  canvas.addEventListener('pointerdown', (e) => {
    sound.start();
    if (firstTouch) { firstTouch = false; hint.classList.add('done'); }
    if (e.button !== 0) return;
    const pk = picker.pick(toNdc(e));
    downAt = { x: e.clientX, y: e.clientY, t: performance.now(), sky: pk.kind === 'sky' };
    if (pk.kind === 'sky') {
      holdTimer = window.setTimeout(() => {
        holding = true;
        night.surge = 1;
        U.uRippleDir.value.copy(pk.dir);
        U.uRippleT.value = 0;
        rippleTimer = 0;
        rig.controls.enabled = false;
      }, 170);
    }
  });
  const endHold = () => {
    clearTimeout(holdTimer);
    if (holding) { holding = false; night.surge = 0; rig.controls.enabled = true; }
  };
  canvas.addEventListener('pointermove', (e) => {
    if (downAt.t && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 6 && !holding) clearTimeout(holdTimer);
    if (holding) {
      // the ripple follows your pointer across the sky
      const pk = picker.pick(toNdc(e));
      if (pk.kind === 'sky') U.uRippleDir.value.lerp(pk.dir, 0.25).normalize();
    }
    const now = performance.now();
    if (now - lastPick > 60 && !e.buttons) {
      lastPick = now;
      const k = picker.pick(toNdc(e)).kind;
      canvas.style.cursor = k === 'fire' || k === 'tree' || k === 'ice' ? 'pointer' : k === 'sky' ? 'crosshair' : '';
    }
  });
  window.addEventListener('pointerup', (e) => {
    const wasHold = holding;
    endHold();
    if (!downAt.t || e.button !== 0) return;
    const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
    const quick = performance.now() - downAt.t < 400;
    downAt.t = 0;
    if (wasHold || moved > 6 || !quick || e.target !== canvas) return;
    const pk = picker.pick(toNdc(e));
    if (pk.kind === 'tree' && pk.tree) shakeTree(pk.tree);
    else if (pk.kind === 'ice') crackIce(pk.point);
    else if (pk.kind === 'fire') toggleFire();
    else if (pk.kind === 'snow') puffSnow(pk.point);
    else if (pk.kind === 'sky') { U.uRippleDir.value.copy(pk.dir); U.uRippleT.value = 0; }
  });

  let gustT = 0;
  const gust = () => {
    gustT = 3.0;
    sound.start();
    // spindrift: snow lifted off the open ground around you
    for (let k = 0; k < 500; k++) {
      const a = rnd() * Math.PI * 2, r = 4 + rnd() * 30;
      const x = camera.position.x + Math.cos(a) * r, z = camera.position.z + Math.sin(a) * r;
      const w = U.uWindDir.value;
      bursts.emit({ x, y: groundAt(x, z) + rnd() * 0.6, z, vx: w.x * (4 + rnd() * 6), vy: 0.5 + rnd() * 1.5, vz: w.y * (4 + rnd() * 6), life: 1.5 + rnd() * 2, size: 0.04 + rnd() * 0.08, grav: 0.8, drag: 0.5 });
    }
  };

  // ---- UI ----
  const shotNames = ['Off', ...shots.map((s) => s.name)];
  const ui = new Toolbar(
    [
      { id: 'grade', label: 'Grade', options: GRADE_PRESETS.map((g) => g.name), value: 0, onPick: (i) => post.setPreset(GRADE_PRESETS[i]) },
      { id: 'sky', label: 'Sky', options: NIGHT_PRESETS.map((p) => p.name), value: 0, onPick: (i) => { night.preset = NIGHT_PRESETS[i]; } },
      { id: 'aurora', label: 'Aurora', options: AURORA_PALETTES.map((p) => p.name), value: 0, onPick: (i) => { night.palette = AURORA_PALETTES[i]; } },
      { id: 'snow', label: 'Snow', options: SNOW_LEVELS.map((s) => s.name), value: 1, onPick: (i) => { snowfall.target = SNOW_LEVELS[i].density; } },
      { id: 'shot', label: 'Shot', options: shotNames, value: 0, onPick: (i) => rig.play(i === 0 ? null : shots[i - 1]) },
      { id: 'sound', label: 'Sound', options: ['On', 'Off'], value: 0, onPick: (i) => { sound.start(); sound.setEnabled(i === 0); } },
    ],
    [
      { id: 'act', label: 'Aurora activity', min: 0.2, max: 2, step: 0.01, value: 1, onInput: (v) => { night.activity = v; } },
      { id: 'grain', label: 'Film grain', min: 0, max: 1, step: 0.01, value: 0.3, onInput: (v) => ((post.grade.uniforms as any).uGrain.value = v) },
    ],
  );
  (post.grade.uniforms as any).uGrain.value = 0.3;
  snowfall.target = SNOW_LEVELS[1].density;
  rig.onShotEnd = () => ui.setValue('shot', 0);
  const brand = document.createElement('div');
  brand.className = 'brand';
  brand.innerHTML = 'Aurora<span>A frozen lake in three.js</span>';
  document.body.appendChild(brand);
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = 'Click the ice, a tree or the fire. Press and hold on the sky.<span>Space for a gust of wind</span>';
  document.body.appendChild(hint);
  setTimeout(() => hint.classList.add('done'), 11000);

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (k === 'h') ui.toggleHidden();
    else if (k === ' ') { e.preventDefault(); gust(); }
    else if (k >= '0' && k <= '6') { const i = parseInt(k, 10); rig.play(i === 0 ? null : shots[i - 1]); ui.setValue('shot', i); }
  });

  // ---- resize ----
  const onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    post.composer.setPixelRatio(dpr);
    post.setSize(w, h);
    reflection.setSize(w * dpr, h * dpr);
    auroraPass.setSize(Math.floor(w * dpr), Math.floor(h * dpr));
    skyMat.uniforms.uRes.value.set(Math.floor(w * dpr), Math.floor(h * dpr));
  };
  window.addEventListener('resize', onResize);
  onResize();

  // ---- loop ----
  const clock = new THREE.Timer();
  let envTimer = 0;
  let frames = 0, acc = 0, slowFor = 0, fastFor = 0, lockedUp = false, shadowTick = 0;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  const stats = { fps: 0, ms: 0, dpr };
  const dbg = { nopost: false, noRefl: false };
  const camBase = new THREE.Vector3();
  const frame = () => {
    clock.update();
    const dt = Math.min(clock.getDelta(), 0.1);
    U.uTime.value += dt;
    const time = U.uTime.value;

    night.update(dt);
    if (holding) {
      rippleTimer += dt;
      if (rippleTimer > 1.3) { rippleTimer = 0; U.uRippleT.value = 0; }
    }
    envTimer -= dt;
    if (night.changed && envTimer <= 0) {
      skyMat.uniforms.uAurUseRT.value = 0;
      scene.environment = env.update();
      skyMat.uniforms.uAurUseRT.value = 1;
      night.changed = false;
      envTimer = 0.3;
    }
    scene.environmentIntensity = night.env;
    renderer.toneMappingExposure = night.exposure;
    if (landShadow.update()) renderer.shadowMap.needsUpdate = true;
    moon.position.copy(moon.target.position).addScaledVector(U.uLightDir.value, 700);

    // gusts
    gustT = Math.max(0, gustT - dt);
    const g = gustT > 0 ? Math.min(1, gustT / 0.6) * Math.min(1, (3.0 - gustT) / 0.3 + 0.2) : 0;
    U.uGust.value += (g - U.uGust.value) * (1 - Math.exp(-dt * 4));

    // trees slowly re-gather snow while it is snowing
    if (touched.size) {
      for (const tr of touched) {
        const attr = tr.mesh!.geometry.getAttribute('aSnow') as THREE.InstancedBufferAttribute;
        const cur = attr.getX(tr.slot!);
        const goal = tr.snow;
        const next = cur + (goal - cur) * (1 - Math.exp(-dt * 6));
        attr.setX(tr.slot!, next);
        attr.needsUpdate = true;
        tr.snow = Math.min(1, tr.snow + dt * 0.004 * snowfall.density);
        if (Math.abs(next - goal) < 0.002 && snowfall.density < 0.01) touched.delete(tr);
      }
    }

    rig.update(dt);
    // a short shudder when the ice cracks
    if (shake > 0) {
      shake = Math.max(0, shake - dt);
      camBase.set((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(shake * 0.12);
      camera.position.add(camBase);
    }
    camera.updateMatrixWorld();

    cracks.update(time);
    fire.update(dt, time, renderer.getPixelRatio());
    snowfall.update(dt, camera, renderer.getPixelRatio());
    bursts.update(dt, renderer.getPixelRatio(), U.uLightCol.value);
    sound.update(dt, U.uGust.value, fire.lit, camera.position.distanceTo(firePos), U.uSurge.value);

    shadowTick++;
    if (shadowTick % 2 === 0) renderer.shadowMap.needsUpdate = true;
    auroraPass.render(renderer, camera);
    if (!dbg.noRefl) reflection.render(renderer, scene, camera, [ice.mesh]);
    (post.grade.uniforms as any).uTime.value = time;
    if (dbg.nopost) { renderer.setRenderTarget(null); renderer.render(scene, camera); }
    else post.composer.render(dt);
    if (shake > 0) camera.position.sub(camBase);

    frames++; acc += dt;
    if (acc >= 1) {
      stats.fps = frames / acc;
      stats.ms = (acc / frames) * 1000;
      if (stats.fps < 45 && dpr > 1) { slowFor++; fastFor = 0; if (slowFor >= 2) { dpr = Math.max(1, dpr - 0.25); stats.dpr = dpr; onResize(); slowFor = 0; lockedUp = true; } }
      else if (stats.fps > 58 && dpr < maxDpr && !lockedUp) { fastFor++; slowFor = 0; if (fastFor >= 3) { dpr = Math.min(maxDpr, dpr + 0.25); stats.dpr = dpr; onResize(); fastFor = 0; } }
      else { slowFor = 0; fastFor = 0; }
      frames = 0; acc = 0;
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.getElementById('loader')?.classList.add('done');

  (window as any).__scene = {
    auroraPass, U, renderer, scene, camera, rig, hf, stats, post, ui, night, fire, trees, firePos, cracks, ice, forest, terrain, sky, dbg, snowfall,
    setDpr: (v: number) => { dpr = v; stats.dpr = v; onResize(); },
    shakeTree, crackIce, toggleFire, gust, picker,
    surge: (on: boolean, dir?: number[]) => { night.surge = on ? 1 : 0; if (dir) U.uRippleDir.value.set(dir[0], dir[1], dir[2]).normalize(); U.uRippleT.value = 0; },
    counts: { trees: trees.length },
  };
}

init().catch((e) => {
  console.error(e);
  const l = document.getElementById('loader');
  if (l) l.innerHTML = `<div class="ld-word">Aurora</div><div class="ld-sub">Could not start: ${String(e?.message || e)}</div>`;
});
