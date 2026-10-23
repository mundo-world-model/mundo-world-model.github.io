// Looping hero overview, one live 3D world throughout: the photos → points flying out of them → the agent's boxes → the proxy world,
// over which the generated arrival video wipes in → back to the proxy and a hop through it to the robot's first view → its video.
// The proxy is drawn live under the panel from the video's own camera, so a wipe only ever reveals or hides the generated frames.
import * as THREE from 'three';
import {seekVideo, videoPlayback} from './media.js?v=20261023-mobile-all-2';
import {LineSegments2} from './vendor/LineSegments2.js';
import {LineSegmentsGeometry} from './vendor/LineSegmentsGeometry.js';
import {LineMaterial} from './vendor/LineMaterial.js';
import {loadStory, loadStoryLayout, cvToThree, projectionFromK, partGeometry, pointGeometry, boxColor, PALETTE} from './world.js';

const section = document.getElementById('story');
const stage = section.querySelector('.stage');
const canvas = document.getElementById('storyCanvas');
const panel = document.getElementById('storyPanel');
const veil = document.getElementById('storyVeil');
const labelLayer = document.getElementById('storyLabels');
const flow = document.getElementById('storyFlow');
const flowItems = [...flow.querySelectorAll('li')];
const capLeft = panel.querySelector('.cap-left'), capRight = panel.querySelector('.cap-right');
const divider = panel.querySelector('.divider');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp01 = x => Math.min(1, Math.max(0, x));
const ease = x => (x = clamp01(x), x * x * (3 - 2 * x));
const glide = x => (x = clamp01(x), x * x * x * (x * (x * 6 - 15) + 10));   // camera flights: no jolt at either end
const span = (t, a, b) => ease((t - a) / (b - a));
const lerp = THREE.MathUtils.lerp;
const INK = new THREE.Color('#161615');
const PAPER = new THREE.Color('#f5f4f0');
const UP = new THREE.Vector3(0, 0, 1);
const ROOM = new THREE.Vector3(-0.9, 5.7, 0.4);   // the middle of the suite (bedroom, bathroom, entrance)
const D0 = 0.65;          // photo plane distance in front of each input camera
const FPS = 24;
// Overview orbit: start angle, total turn over the build-up, elevation and distance at its start and end.
const VIEW = {theta: -1.75, turn: 1.15, el: [.5, .82], dist: [10.8, 13.5]};

// The proxy as the hero draws it: a lit clay model, materials told apart by value only (the generated videos were conditioned on the
// flat proxy), so the robot's orange is the one colour in it. The agent's boxes keep each object's hue, muted and translucent, and
// settle into the clay as the camera flies in.
const CLAY = {wall: '#eceae5', ceiling: '#f4f3ef', floor: '#d9d4cb', bed: '#fbfaf7', curtain: '#e8e5df', toilet: '#f3f2ee', shower: '#f3f2ee',
  window: '#e5eaeb', glass_door: '#e5eaeb', mirror: '#e5eaeb', door: '#ddd5c9', desk: '#e2dbcf', cabinet: '#e2dbcf', vanity: '#e2dbcf',
  bedside_table: '#e2dbcf', side_table: '#e2dbcf', chair: '#d6d1c8', armchair: '#d6d1c8', picture: '#cdc8bf', television: '#9e9c97', object: '#ebe8e2'};
const clayColor = p => new THREE.Color(CLAY[p.layer] ?? CLAY[p.category] ?? CLAY.object);
const tintColor = p => {
  const c = boxColor(p.category), hsl = {};
  c.getHSL(hsl);
  return c.setHSL(hsl.h, hsl.s * .38, Math.min(.74, hsl.l + .08));
};

// Beats on the story clock t (seconds).
const B = {
  photos: [0.1, 1.4],                                   // the photos come in one after another
  fly: [2.0, 3.8], photosOut: [4.4, 5.2],               // the points fly out of them
  boxer: [4.45, 4.8], boxerOut: [5.5, 5.95], agent: [4.8, 6.4], dim: [4.8, 5.9], labels: [5.2, 5.7],
  labelsOut: [7.15, 7.45], flyIn: [7.3, 8.6], solid: [7.4, 8.35], shell: [7.95, 8.55], ptsOut: [7.4, 8.1],
  wipeA: [8.75, 9.35],                                  // the arrival's generated video over its proxy
  unwipeA: [9.65, 10.1], hop: [9.95, 11.05], bot: [10.05, 10.65], wipeB: [11.15, 11.65],
};
// Autoplay: each step moves the clock from a to b over `move` seconds, then holds. The build-up takes 8.6 s; each video then plays
// once in full (the holds of 04 and 05 are set from their lengths below).
const FLOW = [
  {a: 0, b: 2.0, move: 2.0, hold: 0},
  {a: 2.0, b: 4.4, move: 2.4, hold: 0},
  {a: 4.4, b: 7.3, move: 2.9, hold: 0},
  {a: 7.3, b: 9.5, move: 2.2, hold: 5.6},   // b stays below 05's start: holding at b, 04 must not count as 05
  {a: 9.6, b: 11.65, move: 2.05, hold: 12.3},
];

function fallback() {
  canvas.hidden = true;
  section.querySelector('.story-fallback').hidden = false;
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({canvas, antialias: true});
} catch (e) {
  fallback();
}
if (renderer) init().catch(e => { console.error(e); fallback(); });

async function init() {
  // the hero starts on the layout and the photos; the points (the larger download) are asked for once the photo atlas is in, so
  // they do not hold it up, and are needed from 02
  const data = await loadStoryLayout();
  const {story} = data;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));   // layers of translucent boxes, points and photos: keep the fill rate down
  renderer.setClearColor(PAPER, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.matrixAutoUpdate = false;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xe2ddd4, 2.3));   // a pale bounce, so the clay's shaded faces stay light
  const sun = new THREE.DirectionalLight(0xffffff, 1.3);
  sun.position.set(-3, -6, 10);
  scene.add(sun);

  // ── the photos (the same dozen-odd from start to end), each with its frustum ──
  const [IW, IH] = story.image_size, {cols} = story.atlas, rows = Math.ceil(story.cameras.length / cols);
  const cams = story.cameras.map(c => ({M: new THREE.Matrix4().set(...c.c2w.flat()), K: c.K}));
  const shown = story.photos;
  const atlas = new THREE.TextureLoader().load('story/frames-atlas.jpg', () => loadStory().then(addPoints).catch(e => console.error(e)));
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  const corner = (cam, u, v) => new THREE.Vector3((u - cam.K[0][2]) / cam.K[0][0] * D0, (v - cam.K[1][2]) / cam.K[1][1] * D0, D0).applyMatrix4(cam.M);
  const photos = shown.map((i, j) => {
    const cam = cams[i], C = new THREE.Vector3().setFromMatrixPosition(cam.M);
    const cs = [corner(cam, 0, 0), corner(cam, IW, 0), corner(cam, IW, IH), corner(cam, 0, IH)];
    const col = i % cols, row = Math.floor(i / cols);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cs.flatMap(p => [p.x, p.y, p.z]), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([[0, 0], [1, 0], [1, 1], [0, 1]].flatMap(([a, b]) => [(col + a) / cols, 1 - (row + b) / rows]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const quad = new THREE.Mesh(g, new THREE.MeshBasicMaterial({map: atlas, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false}));
    const f = [];
    for (let k = 0; k < 4; k++) f.push(C, cs[k], cs[k], cs[(k + 1) % 4]);
    const frustum = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(f), new THREE.LineBasicMaterial({color: INK, transparent: true, opacity: 0}));
    scene.add(quad, frustum);
    return {quad, frustum, at: lerp(B.photos[0], B.photos[1], j / Math.max(1, shown.length - 1))};
  });

  // ── points, each flying out of the photo it was assigned to; the few no photo sees fade in where they are ──
  let points = null;
  const addPoints = d => {
    const n = story.points.count, P = d.positions, start = new Float32Array(n * 3), delay = new Float32Array(n), free = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = d.frames[i];
      if (j === 255) {
        start.set(P.subarray(3 * i, 3 * i + 3), 3 * i);
        delay[i] = .6 + Math.random() * .4;
        free[i] = 1;
        continue;
      }
      const e = cams[shown[j]].M.elements;
      const dx = P[3 * i] - e[12], dy = P[3 * i + 1] - e[13], dz = P[3 * i + 2] - e[14];
      const s = D0 / Math.max(dx * e[8] + dy * e[9] + dz * e[10], 1e-3);
      start[3 * i] = e[12] + dx * s; start[3 * i + 1] = e[13] + dy * s; start[3 * i + 2] = e[14] + dz * s;
      delay[i] = j / Math.max(1, shown.length - 1) * .6 + Math.random() * .4;
    }
    const ptGeo = pointGeometry(d);
    ptGeo.setAttribute('start', new THREE.BufferAttribute(start, 3));
    ptGeo.setAttribute('delay', new THREE.BufferAttribute(delay, 1));
    ptGeo.setAttribute('free', new THREE.BufferAttribute(free, 1));
    points = new THREE.Points(ptGeo, ptMat);
    points.frustumCulled = false;
    scene.add(points);
    warmed = false;   // the next frame draws them once unseen (warmUp), so 02 does not stall on their first draw
  };
  const ptMat = new THREE.ShaderMaterial({
    vertexColors: true, transparent: true, depthWrite: false,
    uniforms: {uFly: {value: 0}, uOpacity: {value: 0}, uFocal: {value: 800}, uDpr: {value: renderer.getPixelRatio()}},
    vertexShader: `attribute vec3 start; attribute float delay, free; uniform float uFly, uFocal, uDpr, uOpacity; varying vec3 vColor; varying float vA;
      void main(){
        float k = clamp((uFly - delay * .55) / .45, 0., 1.); k = k * k * (3. - 2. * k);
        vec3 p = mix(start, position, k); p.z += sin(k * 3.14159) * .18 * (1. - free);
        vec4 mv = modelViewMatrix * vec4(p, 1.); gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(.017 * uFocal / max(-mv.z, .05), 1.1, 4.5) * uDpr; vColor = color;
        // a point shows as it leaves its photo, not parked in front of it first; one not yet out is dropped before rasterizing
        vA = uOpacity * mix(smoothstep(0., .2, k), k, free);
        if (vA < .004) { gl_Position = vec4(2., 2., 2., 1.); gl_PointSize = 0.; } }`,
    fragmentShader: `varying vec3 vColor; varying float vA;
      void main(){ vec2 c = gl_PointCoord - .5; if (dot(c, c) > .25 || vA < .004) discard; gl_FragColor = vec4(vColor, vA); }`,
  });

  // ── detector proposals (dashed) and the agent's parts ──
  const boxer = new THREE.Group();
  const dashMat = new THREE.LineDashedMaterial({color: INK, dashSize: .07, gapSize: .05, transparent: true, opacity: 0});
  for (const p of data.boxer) {
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(partGeometry(p), 28), dashMat);
    l.computeLineDistances();
    boxer.add(l);
  }
  scene.add(boxer);
  const parts = data.geometry.map(p => {
    const g = partGeometry(p).toNonIndexed();
    g.computeBoundingBox();
    const centre = g.boundingBox.getCenter(new THREE.Vector3()), size = g.boundingBox.getSize(new THREE.Vector3());
    g.translate(-centre.x, -centre.y, -centre.z);
    g.computeVertexNormals();
    const tint = tintColor(p), soft = clayColor(p);
    const face = new THREE.Mesh(g, new THREE.MeshLambertMaterial({color: tint.clone(), transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1}));
    // edges as screen-space lines: thin over the translucent boxes, a firmer pencil line once they are the clay proxy
    const edge = new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(g, 28)),
      new LineMaterial({color: tint.clone(), transparent: true, opacity: 0, linewidth: 1}));
    const group = new THREE.Group();
    group.position.copy(centre);
    group.add(face, edge);
    scene.add(group);
    return {p, group, face, edge, tint, soft, tintEdge: tint.clone().multiplyScalar(.68), softEdge: soft.clone().multiplyScalar(.4),
      volume: size.x * size.y * size.z, top: new THREE.Vector3(centre.x, centre.y, g.boundingBox.max.z + centre.z), appear: 0};
  });
  const objects = parts.filter(x => x.p.layer === 'objects').sort((a, b) => b.volume - a.volume);
  objects.forEach((x, i) => x.appear = lerp(B.agent[0], B.agent[1] - .25, i / (objects.length - 1)));
  parts.filter(x => x.p.layer !== 'objects').forEach(x => x.appear = B.agent[0]);
  const KEY = {bed: 'bed', desk: 'desk', lounge_chair: 'armchair', television: 'tv', toilet: 'toilet', vanity: 'vanity', entry_door: 'door',
    luggage_cabinet: 'cabinet'};
  const labels = parts.filter(x => KEY[x.p.object_id]).map(x => {
    const el = document.createElement('span');
    el.textContent = KEY[x.p.object_id];
    labelLayer.append(el);
    return {x, el};
  });

  // ── the G1 and its bag as rigid parts posed per frame (exported from the MuJoCo simulation), loaded after the rest ──
  const g1 = story.paths.g1, bot = new THREE.Group(), botParts = [];
  bot.visible = false;
  scene.add(bot);
  let botPoses = null, botAsked = false;
  const loadBot = () => botAsked || (botAsked = true, fetch('story/g1-anim.bin').then(r => r.arrayBuffer()).then(async buf => {
    const nv = g1.parts.reduce((a, p) => a + p.vertices, 0), nt = g1.parts.reduce((a, p) => a + p.triangles, 0);
    const V = new Float32Array(buf, 0, nv * 3), T = new Uint32Array(buf, nv * 12, nt * 3);
    const mats = {robot: new THREE.MeshLambertMaterial({color: PALETTE.new_object, transparent: true}), bag: new THREE.MeshLambertMaterial({color: '#fbfbf9', transparent: true})};
    const lines = {robot: new THREE.LineBasicMaterial({color: new THREE.Color(PALETTE.new_object).multiplyScalar(.72), transparent: true}),
      bag: new THREE.LineBasicMaterial({color: new THREE.Color('#fbfbf9').multiplyScalar(.7), transparent: true})};
    let vo = 0, to = 0, slice = performance.now();
    for (const p of g1.parts) {
      // a few parts per task: all 53 (their normals and edges) at once held a frame for about 0.1 s just as 03's boxes came in
      if (performance.now() - slice > 8) { await new Promise(r => setTimeout(r)); slice = performance.now(); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(V.slice(vo * 3, (vo + p.vertices) * 3), 3));
      g.setIndex(new THREE.BufferAttribute(T.slice(to * 3, (to + p.triangles) * 3), 1));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, mats[p.kind]);
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 35), lines[p.kind]));
      bot.add(mesh);
      botParts.push(mesh);
      vo += p.vertices;
      to += p.triangles;
    }
    bot.userData.mats = [...Object.values(mats), ...Object.values(lines)];
    renderer.compileAsync(bot, camera, scene).catch(() => {});
    botPoses = new Float32Array(buf, (nv + nt) * 12, g1.frames * g1.parts.length * 7);
  }).catch(e => console.error(e)));   // asked for once 03 starts: the robot is first seen in 05
  const poseBot = f => {
    if (!botPoses) return;
    const np = botParts.length;
    botParts.forEach((m, k) => {
      const o = (f * np + k) * 7;
      m.position.set(botPoses[o], botPoses[o + 1], botPoses[o + 2]);
      m.quaternion.set(botPoses[o + 3], botPoses[o + 4], botPoses[o + 5], botPoses[o + 6]);
    });
  };

  // ── the generated videos (the proxy under them is the live 3D world) ──
  const media = panel.querySelector('.panel-media');
  const makeCase = (dir, path, loop) => {
    const gen = document.createElement('video');
    Object.assign(gen, {muted: true, loop, playsInline: true, preload: 'none', src: `media/${dir}/output.mp4`});
    gen.className = 'panel-gen';
    gen.hidden = true;
    media.insertBefore(gen, divider);
    if ('requestVideoFrameCallback' in gen) {
      const cb = (_, md) => { gen._t = md.mediaTime; gen.requestVideoFrameCallback(cb); };
      gen.requestVideoFrameCallback(cb);
    }
    return {gen, path, poses: path.poses.map(cvToThree)};
  };
  const cases = {arrival: makeCase('hero-arrival', story.paths.arrival, false), g1: makeCase('hero-g1', g1, false)};
  // the page's first video load sets up its media pipeline, which held a frame for about 0.1 s as 03 began (where warm() asks for
  // the arrival): set it up here, before the first frame, on the metadata only; the video itself still downloads from 03
  cases.arrival.gen.preload = 'metadata';
  // each video plays once, from the beat its camera is reached on, and holds its last frame a moment
  FLOW[3].hold = (B.flyIn[1] - FLOW[3].a) + story.paths.arrival.frames / FPS - FLOW[3].move + .3;
  FLOW[4].hold = (B.hop[1] - FLOW[4].a) + g1.frames / FPS - FLOW[4].move + .3;
  let active = null;
  let playingCase = null;
  const playback = videoPlayback(media, () => active ? [active.gen] : []);
  const setCase = c => {
    if (active === c) return;
    for (const k of Object.values(cases)) {
      k.gen.hidden = k !== c;
      if (k !== c) k.gen.pause();
    }
    active = c;
    playback.reset();
  };
  const warm = c => { if (c.gen.preload !== 'auto') { c.gen.preload = 'auto'; c.gen.load(); } };
  const play = c => {
    if (playingCase !== c) { playingCase = c; playback.reset(); }
    if (c.gen.paused && !c.gen.ended) playback.play();
  };
  const rewind = c => { c.gen.pause(); if (c.gen.currentTime > 0) seekVideo(c.gen, 0); c.gen._t = 0; };
  const frameOf = c => Math.min(c.path.frames - 1, Math.max(0, Math.round((c.gen._t ?? c.gen.currentTime) * FPS)));
  setCase(cases.arrival);

  // ── layout ──
  let W = 1, H = 1, rect = {x: 0, y: 0, w: 640, h: 480}, over = {f: 800, cx: 0, cy: 0};
  function layout() {
    W = stage.clientWidth; H = stage.clientHeight;
    renderer.setSize(W, H, false);
    for (const x of parts ?? []) x.edge.material.resolution.set(W, H);   // fat lines are sized in CSS pixels
    const narrow = W < 900, gutter = Math.min(64, Math.max(20, W * .05));
    if (narrow) {
      const w = W - 32;
      rect = {x: 16, y: 64, w, h: w * .75};
      over = {f: W * 1.05, cx: W / 2, cy: rect.y + rect.h * .5};
    } else {
      // Text column on the left (matches .hero-text); panel, captions and step bar on the right.
      const left = gutter + Math.min(480, W * .36) + 56, avail = W - left - gutter;
      const w = Math.min(avail, (H - 240) * 4 / 3, 880);
      rect = {x: left + (avail - w) / 2, y: (H - w * .75) / 2 - 30, w, h: w * .75};
      over = {f: H * 1.0, cx: rect.x + w / 2, cy: rect.y + rect.h * .5};
    }
    Object.assign(panel.style, {left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px'});
    Object.assign(flow.style, {left: rect.x + 'px', width: rect.w + 'px', top: rect.y + rect.h + (narrow ? 14 : 56) + 'px'});
  }
  layout();
  new ResizeObserver(layout).observe(stage);

  const panelProjection = K => {
    const s = rect.w / 640;
    return projectionFromK(K[0][0] * s, K[1][1] * s, rect.x + K[0][2] * s, rect.y + K[1][2] * s, W, H);
  };
  // Look at the photographs first, then at the room they reconstruct, turning slowly round it.
  const camCentre = shown.reduce((c, i) => c.add(new THREE.Vector3().setFromMatrixPosition(cams[i].M)), new THREE.Vector3()).divideScalar(shown.length);
  const look = new THREE.Vector3(), eye = new THREE.Vector3();
  const overviewPose = (t, time) => {
    const k = ease(t / 7.3);
    const TARGET = look.lerpVectors(camCentre, ROOM, span(t, 1.4, 4.6));
    const theta = VIEW.theta + VIEW.turn * ease(t / 7.6) + (reduced ? 0 : time * .018);
    const el = lerp(...VIEW.el, k), dist = lerp(...VIEW.dist, k);
    eye.set(TARGET.x + dist * Math.cos(el) * Math.cos(theta), TARGET.y + dist * Math.cos(el) * Math.sin(theta), TARGET.z + dist * Math.sin(el));
    return new THREE.Matrix4().lookAt(eye, TARGET, UP).setPosition(eye);
  };
  const pa = new THREE.Vector3(), pb = new THREE.Vector3(), qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), sc = new THREE.Vector3();
  const blendPose = (A, Bm, u, lift = 0) => {   // `lift`: how far the path rises at its middle, so a hop clears what it passes
    A.decompose(pa, qa, sc); Bm.decompose(pb, qb, sc);
    pa.lerp(pb, u).z += lift * Math.sin(Math.PI * u);
    return new THREE.Matrix4().compose(pa, qa.slerp(qb, u), sc.set(1, 1, 1));
  };
  const blendMatrix = (A, Bm, u) => {
    const m = new THREE.Matrix4();
    for (let i = 0; i < 16; i++) m.elements[i] = lerp(A.elements[i], Bm.elements[i], u);
    return m;
  };

  // ── per-frame update ──
  const v3 = new THREE.Vector3();
  // 05's hop starts from the arrival's last camera: autoplay reaches it before 05, and a click into 05 passes through the paper fade
  const handoff = story.paths.arrival.frames - 1;
  function update(t, time, flash) {
    const inB = t >= FLOW[4].a, robotPlays = t >= B.hop[1];
    const arrivalPlays = !inB && t >= B.flyIn[1] - .02;
    const c = robotPlays || t >= B.wipeB[0] - .3 ? cases.g1 : cases.arrival;
    if (t > 4.4) { warm(cases.arrival); loadBot(); }
    if (t > 7.3) warm(cases.g1);
    setCase(c);
    if (!arrivalPlays && !inB) rewind(cases.arrival);
    if (arrivalPlays) play(cases.arrival); else cases.arrival.gen.pause();
    const ag = cases.arrival.gen;   // after a click into 05 the arrival shows its last frame, where the hop starts
    if (inB && !robotPlays && ag.readyState >= 1 && ag.currentTime < ag.duration - .06) ag.currentTime = ag.duration - .03;
    if (!robotPlays) rewind(cases.g1); else play(cases.g1);
    if (!arrivalPlays && !robotPlays && playingCase) { playingCase = null; playback.reset(); }

    // camera: the orbit, the flight into the arrival's first view, its video's cameras, the hop to the robot's view, its cameras
    const overP = projectionFromK(over.f, over.f, over.cx, over.cy, W, H);
    const u = glide((t - B.flyIn[0]) / (B.flyIn[1] - B.flyIn[0]));
    let M, Pm;
    if (robotPlays) {
      M = cases.g1.poses[frameOf(cases.g1)];
      Pm = panelProjection(g1.K);
    } else if (inB) {
      M = blendPose(cases.arrival.poses[handoff], cases.g1.poses[0], glide((t - B.hop[0]) / (B.hop[1] - B.hop[0])), .45);
      Pm = panelProjection(g1.K);
    } else {
      const pose = arrivalPlays ? cases.arrival.poses[frameOf(cases.arrival)] : cases.arrival.poses[0];
      M = u > 0 ? (u < 1 ? blendPose(overviewPose(t, time), pose, u) : pose) : overviewPose(t, time);
      Pm = u > 0 ? blendMatrix(overP, panelProjection(story.paths.arrival.K), u) : overP;
    }
    camera.matrix.copy(M);
    camera.matrixWorldNeedsUpdate = true;
    camera.updateMatrixWorld();
    camera.projectionMatrix.copy(Pm);
    camera.projectionMatrixInverse.copy(Pm).invert();

    // photos and frusta: each comes in on its own beat, and all leave together once the boxes arrive
    const out = 1 - span(t, ...B.photosOut);
    for (const ph of photos) {
      const a = span(t, ph.at, ph.at + .35) * out;
      ph.quad.material.opacity = a;
      ph.frustum.material.opacity = .4 * a;
      ph.quad.visible = ph.frustum.visible = a > .005;
    }

    // points
    const ptA = (1 - .62 * span(t, ...B.dim)) * (1 - span(t, ...B.ptsOut));
    ptMat.uniforms.uOpacity.value = ptA;
    ptMat.uniforms.uFly.value = clamp01((t - B.fly[0]) / (B.fly[1] - B.fly[0]));
    ptMat.uniforms.uFocal.value = Pm.elements[5] * H / 2;
    if (points) points.visible = ptA > .005 && t >= B.fly[0];

    // boxes: translucent and muted while the reconstruction is shown, opaque clay as the proxy; walls and ceiling close in last
    dashMat.opacity = .6 * span(t, ...B.boxer) * (1 - span(t, ...B.boxerOut));
    boxer.visible = dashMat.opacity > .005;
    const solid = span(t, ...B.solid), shell = span(t, ...B.shell);
    for (const x of parts) {
      const a = span(t, x.appear, x.appear + .3), layer = x.p.layer;
      const pop = lerp(.92, 1, a);
      x.group.scale.set(pop, pop, pop);
      let faceA, edgeA;
      if (layer === 'wall' || layer === 'ceiling') { faceA = shell; edgeA = .7 * shell; }
      else if (layer === 'floor') { faceA = lerp(.3 * a, 1, solid); edgeA = lerp(.4 * a, .6, solid); }
      else { faceA = lerp(.26 * a, 1, solid); edgeA = lerp(.9 * a, .9, solid); }
      x.face.material.opacity = faceA;
      x.face.material.depthWrite = faceA > .99;
      x.face.visible = faceA > .005;
      x.face.material.color.copy(x.tint).lerp(x.soft, solid);
      x.edge.material.opacity = edgeA;
      x.edge.material.color.copy(x.tintEdge).lerp(x.softEdge, solid);
      x.edge.material.linewidth = lerp(1, layer === 'objects' ? 1.8 : 1.5, Math.max(solid, shell));
      x.edge.visible = edgeA > .005;
    }

    // labels
    const labelA = span(t, ...B.labels) * (1 - span(t, ...B.labelsOut));
    for (const {x, el} of labels) {
      const show = labelA * span(t, x.appear, x.appear + .3);
      el.style.opacity = show.toFixed(3);
      if (show > 0) {
        v3.copy(x.top).project(camera);
        el.style.transform = `translate(${((v3.x + 1) / 2 * W).toFixed(1)}px, ${((1 - v3.y) / 2 * H - 14).toFixed(1)}px)`;
      }
    }

    // the robot: it comes into the proxy during the hop and moves with its video
    const botA = inB ? span(t, ...B.bot) : 0;
    bot.visible = botA > .005 && botPoses !== null;
    if (bot.visible) {
      for (const mat of bot.userData.mats) mat.opacity = botA;
      poseBot(robotPlays ? frameOf(cases.g1) : 0);
    }

    // panel: only the generated frames, wiped in over (and back off) the live proxy
    const wipe = inB ? (t < B.wipeB[0] ? 1 - span(t, ...B.unwipeA) : span(t, ...B.wipeB)) : span(t, ...B.wipeA);
    panel.style.opacity = t >= B.flyIn[1] - .02 ? '1' : '0';
    active.gen.style.clipPath = `inset(0 ${(100 - wipe * 100).toFixed(2)}% 0 0)`;
    divider.style.left = (wipe * 100).toFixed(2) + '%';
    divider.style.opacity = wipe > .002 && wipe < .998 ? '1' : '0';
    panel.classList.toggle('framed', wipe > .002);
    capLeft.textContent = wipe > .02 ? 'Generated' : '';
    capRight.textContent = `frame ${String(frameOf(active) + 1).padStart(3, '0')} / ${active.path.frames}`;
    veil.style.opacity = flash.toFixed(3);
  }

  let onScreen = true;
  new IntersectionObserver(([e]) => {
    onScreen = e.isIntersecting;
    if (!onScreen) for (const k of Object.values(cases)) k.gen.pause();
  }).observe(section);
  // Jumps (clicks, arrows, the loop back to the start) pass through a soft paper fade.
  let step = 0, stepTime = 0, jump = null, last = performance.now();
  const goto = i => { if (!jump) jump = {to: (i + FLOW.length) % FLOW.length, s: 0}; };
  flowItems.forEach((li, i) => li.querySelector('button').addEventListener('click', () => goto(i)));
  flow.querySelectorAll('[data-dir]').forEach(b => b.addEventListener('click', () => goto(step + Number(b.dataset.dir))));
  flow.hidden = false;
  const IN = .35, OUT = .55;
  // The first draw of each material in its blend and depth state builds its GPU pipeline, which held a frame for 0.1–0.2 s as the
  // boxes came in. So the first frame draws the boxes, edges, proposals and points once (translucent, then the proxy's opaque faces)
  // from the overview, before the real frame that replaces it in the same task.
  let warmed = false;
  const warmUp = () => {
    camera.matrix.copy(overviewPose(6, 0));
    camera.matrixWorldNeedsUpdate = true;
    camera.updateMatrixWorld();
    camera.projectionMatrix.copy(projectionFromK(over.f, over.f, over.cx, over.cy, W, H));
    boxer.visible = true;
    if (points) points.visible = true;
    dashMat.opacity = ptMat.uniforms.uOpacity.value = .5;
    for (const opaque of [false, true]) {
      for (const x of parts) {
        x.face.visible = x.edge.visible = true;
        x.face.material.opacity = opaque ? 1 : .5;
        x.face.material.depthWrite = opaque;
        x.edge.material.opacity = .5;
      }
      renderer.render(scene, camera);
    }
  };

  function tick(now) {
    requestAnimationFrame(tick);
    const dt = Math.min(.1, (now - last) / 1000);
    last = now;
    if (!onScreen || document.hidden) return;
    stepTime += dt;
    if (!jump && stepTime >= FLOW[step].move + FLOW[step].hold && (step > 0 || points)) {   // 01 holds until the points are in
      if (step + 1 < FLOW.length) { step++; stepTime = 0; } else goto(0);
    }
    if (!warmed) { warmUp(); warmed = true; }
    let flash = 0;
    if (jump) {
      jump.s += dt;
      if (jump.to !== null && jump.s >= IN) { step = jump.to; stepTime = 0; jump.to = null; }
      flash = jump.s < IN ? ease(jump.s / IN) : 1 - ease((jump.s - IN) / OUT);
      if (jump.s >= IN + OUT) jump = null;
    }
    const f = FLOW[step], t = f.a + (f.b - f.a) * clamp01(stepTime / f.move);
    flowItems.forEach((li, i) => {
      li.classList.toggle('on', i === step);
      li.style.setProperty('--p', (i < step ? 100 : i > step ? 0 : 100 * Math.min(1, stepTime / (f.move + f.hold))).toFixed(1) + '%');
    });
    update(t, now / 1000, flash);
    renderer.render(scene, camera);
  }
  // every shader up front (three compiles hidden objects too): compiling on first sight stalled a frame for 0.1 s as the boxes came in
  renderer.compileAsync(scene, camera).catch(() => {});
  requestAnimationFrame(tick);
  canvas.classList.add('ready');
  window.storyDebug = {goto, cases, VIEW, seek: (i, s) => { step = i; stepTime = s; }};
}
