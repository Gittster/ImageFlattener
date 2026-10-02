# Image Flattener

[![Deploy to GitHub Pages](https://github.com/Gittster/ImageFlattener/actions/workflows/deploy.yml/badge.svg)](https://github.com/Gittster/ImageFlattener/actions/workflows/deploy.yml)
[![CI](https://github.com/Gittster/ImageFlattener/actions/workflows/ci.yml/badge.svg)](https://github.com/Gittster/ImageFlattener/actions/workflows/ci.yml)

Turn a raster image into:

1. a **flattened N-color PNG**,
2. a **layered SVG in real millimetres**, ready for multi-color 3D printing (one shape per filament color), and
3. a **ready-to-slice 3MF for Bambu Studio** with one solid part per color and the filament colors pre-assigned.

Everything runs in your browser. The image is never uploaded anywhere; there is no backend.

**Live app:** `https://<user>.github.io/<repo>/`. For this repository that is
<https://gittster.github.io/ImageFlattener/>.

---

## Running locally

Requires Node 20 (see `.nvmrc`; `nvm use` picks it up). Newer Node versions work too.

```sh
npm ci            # install exact dependency versions from package-lock.json
npm run dev       # dev server with hot reload (http://localhost:5173)
npm run typecheck # strict TypeScript check
npm test          # unit tests (Vitest)
npm run build     # production build into dist/
npm run preview   # serve the production build (http://localhost:4173)
```

The build uses `base: './'`, so `dist/` works from any folder or subpath. You can copy it anywhere and serve it statically.

## How it works

```
image ─► downscale (≤1500 px) ─► optional blur ─► k-means in CIELAB ─► palette merges
      ─► mode filter ─► despeckle ─► trace shared boundary edges ─► simplify + Bézier fit
      ─► assemble per-color shapes (stacked or cutout) ─► SVG / PNG / ZIP / JSON
```

* All heavy work (clustering, cleanup, tracing, PNG encoding) runs in a **Web Worker**, so the UI stays responsive. Each stage is cached, so changing a later setting doesn't redo earlier stages.
* **Tracing** is a topology-preserving approach written for this app, not Potrace:
  * Boundaries are traced along the pixel-edge grid and split into *edges* between junctions, the points where three or more regions meet.
  * Each edge is simplified (Douglas-Peucker) and fitted with cubic Béziers **once**. Every region's outline is then assembled from those shared edges.
  * Neighbouring colors therefore agree exactly on their common border. Cutout shapes tile with no slivers or gaps, and stacked unions reuse the same geometry.
  * Tracing each color independently (as per-color Potrace does) can't guarantee this.
* Holes are emitted as proper compound paths: holes wind opposite to outer boundaries and the paths use `fill-rule="nonzero"`.

## Settings

### Colors
| Setting | What it does |
|---|---|
| **Number of colors** (2–12) | Target palette size (*k* in k-means). If the image has fewer distinct colors, it uses that many and tells you. |
| **Pre-blur** (0–3 px) | Gaussian blur before clustering. Reduces noise and grain in photos, giving cleaner regions. Use 0 for flat artwork. |
| **Re-cluster (new seed)** | k-means++ uses a fixed seed, so results are reproducible. This picks a new seed for a different clustering. It also resets merges and overrides. |

Clustering happens in **CIELAB**, so colors are grouped by perceived similarity. Pixels with alpha < 128 are treated as transparent: they are excluded from clustering and from every layer.

### Palette
* Each swatch shows the hex color and its **coverage %** after cleanup.
* **Click a swatch** to override its output color. This only changes the color written to the PNG and SVG; it doesn't move pixels between colors. ↺ reverts it.
* **Merge selected:** tick two or more swatches and merge them into one color (the pixel-weighted Lab average).
* **Reset** undoes merges and overrides.
* **Force darkest/lightest to pure black/white** pins those two clusters to `#000000` and `#FFFFFF` unless you've overridden them.

### Cleanup
| Setting | What it does |
|---|---|
| **Smooth edges (mode filter)** | 0–3 passes of a 3×3 majority filter. Rounds jagged edges and removes single-pixel noise. |
| **Despeckle** | Removes connected regions smaller than the given size (in **mm**, as a square of that side at the chosen print size). Each speck is merged into the neighbour it shares the longest border with. By default the size equals the min feature size. |
| **Thin-feature warning** | After cleanup, reports how many features are still narrower than the min feature size: regions that a disk of that diameter can't reach. **Highlight thin features** marks them in magenta on the raster preview. Fix them with more smoothing, a larger print, merging colors, or fewer colors. |

### Print size
| Setting | What it does |
|---|---|
| **Print width** (mm) | Final width of the print. Height follows the aspect ratio. Sets the SVG's real-world size. |
| **Nozzle diameter** (mm) | Default 0.4. |
| **Min feature size** (× nozzle) | Default 1.5× → 0.6 mm. Drives despeckle and the thin-feature warning. |

The panel also shows the resulting mm-per-pixel resolution. It warns when a pixel is bigger than your nozzle.

### Vector
| Setting | What it does |
|---|---|
| **Simplification tolerance** (px) | Douglas-Peucker tolerance. Higher values give fewer nodes and smoother but less exact outlines. |
| **Smooth curves** | Fit cubic Béziers (default) or keep straight polylines. Sharp corners are kept either way. |

### Export
* **Mode**
  * **Stacked**: each layer is its own color's region **plus the regions of every color stacked on top of it**, so each layer continues underneath the layers above it. The bottom layer is the full silhouette. Painting (or printing) the layers bottom-to-top reproduces the image. Layers overlap, which is the most forgiving option for printing and extrusion.
  * **Cutout**: non-overlapping shapes that tile the image exactly, for flush multi-material prints. **Bleed / overlap** (0–0.2 mm) grows every shape slightly into its neighbours, so slicer rounding can't open hairline gaps.
* **Stack order**: drag (or use ↑/↓) to reorder. The list shows the top of the stack first. The default puts the largest-coverage color at the bottom.
* **Sort dark → light** reorders the stack with the darkest color at the bottom, the usual order for HueForge-style prints.
* **3D model heights** (used by the 3MF export):
  * **Stacked:** the bottom color is a **base** slab (default 0.64 mm = 8 layers at 0.08 mm). Each further color adds a band (default **0.32 mm** = 4 layers). A color's part fills its band only where that color or any color above it appears. So parts never overlap, and from above every pixel shows its own color. The stack list shows each color's height band.
  * **Cutout:** every part has the same **thickness** (default 1.2 mm) for a flush print.
* **Background rect**: optionally adds a full-size `<rect id="background">` behind the layers.

| Button | Output |
|---|---|
| **Bambu Studio 3MF** | A 3MF with **one object made of one solid part per color**, extruded to the heights above, and each part tagged with its color. Bambu Studio turns those colors into filament slots on import (see below). No printer or filament presets are included, so your own profiles apply. Cutout bleed is not applied to the 3MF: its parts already share exact borders. |
| **Layered SVG** | One SVG with one `<g id="color-N-#RRGGBB" fill="#RRGGBB">` per color, in stack order (N = 1 is the bottom). No strokes. `width`/`height` are in mm with a matching `viewBox` (1 unit = 1 mm). The groups are also Inkscape layers. |
| **Per-color SVGs (.zip)** | One SVG per color, all with identical size and viewBox, so they line up perfectly when imported separately. Also includes `settings.json`. |
| **Flattened PNG** | The label map scaled nearest-neighbour to the original image resolution (capped at 8192 px on the long edge), with exactly N colors plus transparency. |
| **Settings (.json)** | Palette (colors, cluster colors, coverage, stack position, SVG group id), stack order, and every setting, so you can reproduce the result. |

### Preview
* Left pane: the original image. Right pane: the result, as **Raster** (label map) or **Vector** (the actual SVG).
* Scroll to zoom and drag to pan. The two panes stay in sync. Double-click or **Fit** resets the view.
* Transparent areas show a checkerboard.
* Load images with **Open image…**, drag and drop, or paste (Ctrl/Cmd+V). The **Load sample** menu has a flat logo, a photo, and an image with transparency.

## Importing into a slicer

### Bambu Studio: 3MF with colors already assigned (recommended)

1. Choose **Stacked** or **Cutout**, set the stack order and heights, and click **Bambu Studio 3MF**.
2. Open the file in Bambu Studio (drag it onto the window, or **File → Open Project / Import**).
3. Bambu Studio says the 3MF "is not from Bambu Lab" and loads its geometry and color data, then shows the **color-mapping dialog**. Its default action adds one new filament per color, set to that exact color, and assigns each part to it. Click **OK**.
   * The colors in this file are **all distinct**, so the dialog never merges them (its automatic clustering keeps every distinct color when there are 32 or fewer).
   * To reuse filaments you already have loaded (for example the spools in your AMS), use the dialog's **approximate match** option instead of adding new filaments.
4. Pick your printer, process (a 0.08 mm layer profile suits stacked prints) and filament types, then **Slice**.

**Version notes** (checked against Bambu Studio's source code):
* **2.08.02 and newer**: each part is assigned to its filament directly, keeping part boundaries exact.
* **2.05 to 2.08.01**: the same dialog appears, but colors are applied by painting each part's surfaces. The result looks the same.
* **Older than 2.05**: there is no color import. You get one object with one part per color, each named `N #RRGGBB`. Assign a filament to each part in the object list: one click per color, not per island, because all islands of a color are a single part.

If the model lands off the plate (for example on an A1 mini), press **A** (Arrange).

### Bambu Studio / OrcaSlicer: from SVG
Menu names differ slightly between versions, but the workflow is the same:

1. Unzip the per-color SVGs.
2. **File → Import → Import 3MF/STL/STEP/SVG/OBJ…** (Ctrl+I) and select **all** the per-color SVGs at once.
3. When asked *"Load these files as a single object with multiple parts?"*, choose **Yes**. Each color becomes a **part** of one object, already aligned because all files share the same viewBox.
4. In the object list, select each part and **assign a filament**.
5. Set each part's height (scale Z, or the size fields in the object panel):
   * **Stacked** export: give lower layers in the stack less height. For example, bottom = 1.0 mm, next = 1.4 mm, next = 1.8 mm. Each color then shows on top where it belongs; overlapping parts are fine in a single multi-part object.
   * **Cutout** export: give every part the same height for a flush print, and use a small bleed (0.05–0.1 mm) if you see gaps between colors.

### CAD (Fusion 360, Onshape, FreeCAD, OpenSCAD)
Every layer is a set of closed, non-self-intersecting profiles in millimetres, so you can extrude each one to its own height.

* **Fusion 360:** *Insert → Insert SVG* onto a sketch plane. Check that the scale is 1.0 (the SVG declares mm). Then **Extrude** each color's profiles. Insert per-color files one at a time for separate bodies.
* **FreeCAD:** *File → Import* an SVG as *SVG as geometry*, then use *Part → Extrude* on the faces (with *Create solid* enabled).
* **Onshape:** convert each SVG to DXF (for example with Inkscape, *Save As → DXF*, units mm). Then use *Insert DXF/DWG* in a sketch and extrude.
* **OpenSCAD** (exact, scriptable):

  ```openscad
  // Stacked export: lower layers are thinner so upper colors stand proud.
  linear_extrude(1.0) import("01-color-1-1D3557.svg");
  linear_extrude(1.4) import("02-color-2-FFFFFF.svg");
  linear_extrude(1.8) import("03-color-3-F4A261.svg");
  ```

  Export each color as its own STL/3MF and load them as parts of one object in your slicer.

## Deploying

The site is static and is built and deployed by GitHub Actions (`.github/workflows/deploy.yml`).

1. Push this repository to GitHub.
2. **One-time manual step:** in the repository, go to **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**.
3. Push to `main` (or open **Actions → Deploy to GitHub Pages → Run workflow** to trigger it manually). The workflow runs `npm ci`, `npm run typecheck`, `npm test` and `npm run build`. If the typecheck or any test fails, nothing is published.
4. The site appears at **`https://<user>.github.io/<repo>/`**, for example <https://gittster.github.io/ImageFlattener/>. The deploy job's summary links to it.

Pull requests run the same typecheck, tests and build (`.github/workflows/ci.yml`) without deploying.

The app works under any subpath:
* Vite builds with `base: './'`, so all asset URLs are relative.
* Sample images are bundled through `?url` imports.
* The worker is created with `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
* There are no runtime CDN dependencies (the ZIP library, fflate, is bundled), so the app keeps working offline once loaded.
* `public/.nojekyll` stops GitHub Pages from running Jekyll.

## Project layout

```
src/
  core/          pure, DOM-free processing (unit tested)
    color.ts       sRGB <-> CIELAB
    quantize.ts    histogram + seeded k-means++ in Lab
    blur.ts        alpha-aware Gaussian pre-blur
    palette.ts     merges, overrides, black/white pinning
    cleanup.ts     mode filter, despeckle, connected components, EDT, thin features
    trace.ts       shared-edge tracing, simplification, Bézier fitting, loop assembly, bleed
    svg.ts         stacked/cutout layer sets and SVG document writer
    mesh.ts        Bézier flattening, hole grouping, earcut triangulation, extrusion
    model3d.ts     height bands and one extruded part per color
    threemf.ts     3MF package writer (color group + one part per color)
  worker.ts      cached pipeline running in a Web Worker
  main.ts        UI
samples/         sample images (bundled via ?url imports)
tests/           Vitest unit tests
```
