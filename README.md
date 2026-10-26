# Sculpt Scan

Scan a real object with a **Meta Quest 3 / 3S** or an **Android phone** and download it as a **Wavefront OBJ** 3D model, ready for sculpting, carving or 3D printing.

**Open:** https://sghosh37.github.io/sculpt-scan/ (Quest Browser or Chrome on Android) and install it as an app from the browser menu.
Try the review screen without a headset: https://sghosh37.github.io/sculpt-scan/?demo=1

## How it works

1. **Tap the table** next to the object, then **tap the object**. A box appears; make it just fit. The bottom of the box is the cut line, so the table is left out.
2. **Scan** — walk slowly around the object. The ring on the floor turns green as each side is covered.
3. **Review** — spin the model, set smoothness, choose units, and **Download OBJ**.

| Device | Where the 3D data comes from |
|---|---|
| Meta Quest 3 / 3S | WebXR hit-testing on the headset's depth sensor: a 12×12 fan of rays from your head (plus the controller pointers) |
| Android phone (Chrome) | WebXR Depth Sensing (ARCore Depth), read on the CPU and back-projected with the camera's projection |
| iPhone / iPad | Not possible: Safari has no WebXR, so the page explains this |

Samples are fused into a signed-distance voxel grid (about 96 cells across the box). Space the sensor looked through is marked as air; anything enclosed and never seen (the inside, the hidden underside) is filled solid. The surface is extracted with Surface Nets, cleaned (largest piece only, Taubin smoothing) and exported.

## What's in the OBJ

OBJ is plain text. This app writes:

```
# Sculpt Scan export
# units: mm (1 unit = 1 mm)
# size (W x H x D): 160.02 x 159.87 x 159.73 mm
o sculpt_scan
v 12.31 0.00 -40.12      <- vertex position (x y z)
vn 0.1021 -0.9940 0.0398 <- vertex normal
f 1//1 2//2 3//3         <- triangle: vertex//normal indices, counting from 1
```

- **Units:** OBJ has no units of its own, so the unit (mm by default, or cm / m) is written in the header comment.
- **Axes:** Y is up; the base of the object sits at y = 0, centred on x/z.
- **Closed solid:** with *Fill hidden parts* on, every edge is shared by exactly two triangles (watertight, outward normals), which is what slicers and sculpting tools expect.
- **No colour/texture:** no `.mtl` or texture image is written; for a sculpture the shape is what matters.

## Limits

- Detail is roughly 5–10 mm (headset/phone depth sensors are coarse). Good for overall form, not fine texture.
- Shiny, transparent, very dark or very thin objects scan poorly.
- Parts never seen (e.g. the underside) are filled in, not measured.

## Files

- `index.html` — the app (UI, WebXR session, Quest panel / phone overlay, review viewer)
- `scan-core.js` — fusion, meshing, clean-up and OBJ writer (no dependencies)
- `manifest.webmanifest`, `sw.js`, `icons/` — install as an app, works offline

Built with [three.js](https://threejs.org/) r170.
