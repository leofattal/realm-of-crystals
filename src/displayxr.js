// DisplayXR glasses-free 3D integration (inline-3d web SDK).
//
// On the DisplayXR Browser with a spatial display attached, the game canvas becomes a woven 3D
// window: the runtime hands us one view per eye each frame and we render the scene twice into
// the two halves of a double-width canvas. Everywhere else `createInline3D()` reports
// `supported: false` and the game keeps its ordinary 2D render loop.
//
// Rig choice (see @displayxr/inline3d docs): an RTS camera moves through a world, so we use a
// CAMERA rig, with the "attach" pattern (eye cameras parented under the app camera) so the
// stereo never trails the camera by a frame. Convergence and eye separation come from the SDK's
// groundPlaneRig(): the ground at the centre of the view sits on the glass, the near edge comes
// slightly forward and the far edge recedes, and zoom-in is limited before tall things at the
// bottom of the screen pop out uncomfortably.
import { createInline3D } from '@displayxr/inline3d';
import { EyeCamera, cameraRigFromCamera } from '@displayxr/inline3d/three';
import { groundPlaneRig } from '@displayxr/inline3d/depth';

export async function startDisplayXR({ THREE, renderer, scene, camera, rtsCam, canvas, frame, onLost }) {
  let wall;
  try {
    wall = await createInline3D({ lazy: false });
  } catch (err) {
    console.info('[DisplayXR] not available:', err?.message || err);
    return null;
  }
  if (!wall || !wall.supported) return null;

  const ctl = { active: false, wall, handle: null };
  scene.add(camera); // eye cameras hang off the app camera: it must be in the scene graph
  const eyes = [new EyeCamera(THREE), new EyeCamera(THREE)];
  for (const e of eyes) camera.add(e.camera);
  const rig = {};
  const good = [0, 1].map(() => ({ proj: new Float32Array(16), pose: new Float32Array(16), x: 0, y: 0, width: 0, height: 0 }));
  let haveGood = false;
  let metrics = null;
  let ipd = 1;
  let last = performance.now();
  let lastNear = 0, lastFar = 0;

  // Per-eye size the way a native DisplayXR app does it: window device px x the display's
  // recommended view scale (0.5 x 0.5 on a Leia panel: the weave shows no more per view). Until
  // the display info arrives, CSS px x devicePixelRatio capped at 2. Then shrink both axes by one
  // factor to fit the GL limits AND the browser's drawing-buffer area cap. The old
  // clientWidth x dpr x 2 was 15360x4320 full screen on an 8K panel at 300%: the browser silently
  // drew it at 10861x3054, getViewport() still split canvas.width, and one eye showed both images.
  // The view scale from display info: wall.displayInfo is available synchronously (SDK 1.59+). It
  // is the last answer this origin read, so on a reload the very first 3D frame is already final
  // size, with no intermediate step. getDisplayInfo() below then confirms or corrects it.
  const readViewScale = (info) => {
    const x = info?.recommendedViewScaleX, y = info?.recommendedViewScaleY;
    return x > 0 && x <= 1 && y > 0 && y <= 1 ? [x, y] : null;
  };
  let viewScale = readViewScale(wall.displayInfo);
  let glLimit = null;
  const MAX_AREA = 33_000_000; // measured browser cap ~33.17 Mpx
  const storeSize = () => {
    const dpr = window.devicePixelRatio || 1;
    let w, h;
    if (viewScale) {
      w = canvas.clientWidth * dpr * viewScale[0];
      h = canvas.clientHeight * dpr * viewScale[1];
    } else {
      const d = Math.min(dpr, 2);
      w = canvas.clientWidth * d;
      h = canvas.clientHeight * d;
    }
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (glLimit === null) {
      const gl = renderer.getContext();
      const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      glLimit = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), vp[0], vp[1]);
    }
    const s = Math.min(1, glLimit / (2 * w), glLimit / h, Math.sqrt(MAX_AREA / (2 * w * h)));
    if (s < 1) { w = Math.floor(w * s); h = Math.floor(h * s); }
    return { w, h };
  };

  const sizeSBS = () => {
    const { w, h } = storeSize();
    if (canvas.width === w * 2 && canvas.height === h) return;
    renderer.setSize(w * 2, h, false);
    // The box's aspect, not the eye buffer's: they differ on a display whose view scale is not
    // the same on both axes, and each eye's image always spans the whole box.
    camera.aspect = canvas.clientWidth > 0 && canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : w / h;
    camera.updateProjectionMatrix();
    replay();
  };

  // getViewport() splits canvas.width; if the browser ever drew a smaller buffer anyway, map the
  // viewports onto the real drawing buffer so the eyes can never land off-centre.
  const toBuffer = (vp) => {
    const gl = renderer.getContext();
    const sx = canvas.width ? gl.drawingBufferWidth / canvas.width : 1;
    const sy = canvas.height ? gl.drawingBufferHeight / canvas.height : 1;
    if (sx === 1 && sy === 1) return vp;
    return { x: Math.round(vp.x * sx), y: Math.round(vp.y * sy), width: Math.round(vp.width * sx), height: Math.round(vp.height * sy) };
  };

  const rigParams = () => {
    const g = groundPlaneRig({
      height: rtsCam.height,
      tiltDeg: rtsCam.tiltDeg,
      fovDeg: camera.fov,
      tileHeightM: metrics?.canvasSizeM?.[1],
      viewerM: metrics?.nominalViewerM,
      objectHeight: 4, // a keep/tree at the bottom edge of the screen
    });
    if (!g) return { convergence: rtsCam.viewDistance, ipd: 1 };
    // World units are ~metres but the camera sits tens of metres up, so a physical 63 mm
    // baseline would look flat: spend the display's comfort budget instead.
    let want = g.ipdFactorForBudget ?? 1;
    const viewerM = metrics?.nominalViewerM || 0.6;
    const maxByRule = (0.9 * g.convergence) / viewerM; // ipd x m2v x (1/conv) x N <= 0.9
    want = Math.max(1, Math.min(want * 0.85, maxByRule));
    ipd += (want - ipd) * 0.1; // ease: depth never jumps while zooming
    if (g.minHeight) rtsCam.minHeight = Math.max(10, g.minHeight);
    return { convergence: g.convergence, ipd };
  };

  const pushRig = () => {
    const p = rigParams();
    ctl.handle.setViewRig(cameraRigFromCamera(THREE, camera, { convergence: p.convergence, ipdFactor: p.ipd, attach: true, out: rig }));
  };

  function replay() {
    if (!ctl.active) return;
    renderer.setScissorTest(false);
    renderer.clear();
    if (!haveGood) return;
    renderer.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      const g = good[i];
      renderer.setViewport(g.x, g.y, g.width, g.height);
      renderer.setScissor(g.x, g.y, g.width, g.height);
      eyes[i].setLocalFromMatrices(g.proj, g.pose);
      renderer.render(scene, eyes[i].camera);
    }
    renderer.setScissorTest(false);
  }

  function onFrame(views, layer) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frame(dt); // game simulation + camera, unchanged from the 2D path
    // A rig drives the NEXT frame's views: push it before validating this frame.
    try { pushRig(); } catch (e) { /* session tearing down */ }
    if (camera.near !== lastNear || camera.far !== lastFar) {
      try { wall.session.updateRenderState({ depthNear: camera.near, depthFar: camera.far }); lastNear = camera.near; lastFar = camera.far; } catch (e) { /* ignore */ }
    }
    if (!views || views.length < 2 || !layer) return replay();
    const vps = views.map((v) => { const vp = layer.getViewport(v); return vp && toBuffer(vp); });
    if (vps.some((vp) => !vp || vp.width <= 0 || vp.height <= 0)) return replay();
    scene.updateMatrixWorld();
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    for (let i = 0; i < 2; i++) {
      const vp = vps[i], g = good[i];
      renderer.setViewport(vp.x, vp.y, vp.width, vp.height);
      renderer.setScissor(vp.x, vp.y, vp.width, vp.height);
      eyes[i].setLocalFromView(views[i]);
      renderer.render(scene, eyes[i].camera);
      g.proj.set(views[i].projectionMatrix);
      g.pose.set(views[i].transform.matrix);
      g.x = vp.x; g.y = vp.y; g.width = vp.width; g.height = vp.height;
    }
    renderer.setScissorTest(false);
    haveGood = true;
  }

  // Woven path: pixel ratio 1 (viewports are already backing-store pixels), manual clears.
  const prev = { pr: renderer.getPixelRatio(), autoClear: renderer.autoClear };
  renderer.setPixelRatio(1);
  renderer.autoClear = false;
  renderer.xr.enabled = false;
  ctl.active = true;
  sizeSBS();
  try {
    ctl.handle = wall.addScene(canvas, onFrame, {
      viewRig: cameraRigFromCamera(THREE, camera, { convergence: rtsCam.viewDistance, attach: true, out: rig }),
      onResize: () => sizeSBS(),
      onLayerLost: () => {
        // back to an ordinary flat canvas, drawn by the 2D loop
        ctl.active = false;
        renderer.autoClear = prev.autoClear;
        renderer.setPixelRatio(prev.pr);
        onLost?.();
      },
    });
  } catch (err) {
    console.warn('[DisplayXR] addScene failed, staying in 2D:', err);
    ctl.active = false;
    renderer.setPixelRatio(prev.pr);
    renderer.autoClear = prev.autoClear;
    return null;
  }
  ctl.handle.displayMetrics?.().then((m) => { metrics = m; }).catch(() => {});
  ctl.handle.getDisplayInfo?.().then((info) => {
    const v = readViewScale(info);
    if (v) { viewScale = v; sizeSBS(); }
  }).catch(() => {});
  window.addEventListener('resize', () => ctl.handle.displayMetrics?.().then((m) => { metrics = m; }).catch(() => {}));
  return ctl;
}
