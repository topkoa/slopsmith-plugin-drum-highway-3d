// 3D Drum Highway — pure visual mockup.
//
// Exploratory sibling of highway_3d. Renders an 8-lane drum highway (7 lanes
// for hand pieces + a full-width kick bar) populated from a hardcoded demo
// pattern that loops indefinitely. No song-data wiring: bundle.notes /
// bundle.chords / bundle.currentTime are ignored. The viz still plugs into
// slopsmith's setRenderer contract so it appears in the player viz picker
// alongside the guitar highway.
//
// Reuses verbatim from highway_3d: Three.js loader, palette arrays, world
// scale (K), fog, lights — so the two highways feel like the same family
// even though they render different geometry.

(function () {
    'use strict';

    /* ======================================================================
     *  Verbatim from highway_3d — keep these in sync if upstream tweaks them
     * ====================================================================== */

    const THREE_URL = '/static/vendor/three/three.module.min.js';
    const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.min.js';

    const PALETTES = {
        default: [
            0xff2828, 0xffd400, 0x2080ff, 0xff8020,
            0x30d040, 0xa040ff, 0xff6bd5, 0x6bffe6,
        ],
        neon: [
            0xff0030, 0xffe800, 0x0080ff, 0xff8030,
            0x40ff50, 0xb050ff, 0xff40d0, 0x40ffd0,
        ],
        pastel: [
            0xe89aa0, 0xefdf90, 0x9adfee, 0xefb898,
            0xa6e0a8, 0xc4a6e0, 0xe0a6c8, 0xa6e0d8,
        ],
    };
    const PALETTE_IDS = Object.keys(PALETTES);

    const SCALE = 2.25;
    const K = SCALE / 300;

    const FOG_COLOR = 0x1a1a2e;
    const FOG_START = 200 * K;
    const FOG_END = 670 * K;

    let T = null;
    let threeLoadPromise = null;
    function loadThree() {
        if (!threeLoadPromise) {
            threeLoadPromise = import(THREE_URL)
                .then(mod => { T = mod; return mod; })
                .catch(() => import(THREE_CDN)
                    .then(mod => { T = mod; return mod; })
                    .catch(e => {
                        console.error('[Drum-Hwy] Three.js load failed:', e);
                        threeLoadPromise = null;
                        throw e;
                    }));
        }
        return threeLoadPromise;
    }

    /* ======================================================================
     *  Drum-specific constants
     * ====================================================================== */

    // World scroll speed (units / second). Matches highway_3d so the two
    // viz feel like they belong in the same scene.
    const TS = 130 * K;

    // Lane geometry. 7 hand lanes + 1 full-width kick bar.
    //   lane 0: hi-hat   (cymbal)
    //   lane 1: snare    (drum)
    //   lane 2: high tom (drum)
    //   lane 3: mid tom  (drum)
    //   lane 4: floor tom(drum)
    //   lane 5: crash    (cymbal)
    //   lane 6: ride     (cymbal)
    //   lane 7: kick     (full-width bar)
    const LANE_COUNT = 7;
    const LANE_GAP = 12 * K;                       // X spacing between lane centers
    const LANE_X0 = -((LANE_COUNT - 1) / 2) * LANE_GAP; // lane 0 center

    // Each lane carries a kind and palette index. Palette index drives note
    // color via S_COL[i] (currently selected palette).
    //   kind: 'cymbal' | 'drum' | 'kick'
    //   label: shown on the kit-silhouette backboard
    //   subKind (drums): 'snare' applies a snare-wire stripe; others plain disc
    //   subKind (cymbals): 'hihat' | 'crash' | 'ride'
    const LANES = [
        { kind: 'cymbal', subKind: 'hihat', label: 'HH',  paletteIdx: 7 }, // cyan
        { kind: 'drum',   subKind: 'snare', label: 'SNR', paletteIdx: 0 }, // red
        { kind: 'drum',   subKind: 'tom',   label: 'TM1', paletteIdx: 4 }, // green
        { kind: 'drum',   subKind: 'tom',   label: 'TM2', paletteIdx: 2 }, // blue
        { kind: 'drum',   subKind: 'tom',   label: 'FT',  paletteIdx: 5 }, // purple
        { kind: 'cymbal', subKind: 'crash', label: 'CR',  paletteIdx: 1 }, // yellow
        { kind: 'cymbal', subKind: 'ride',  label: 'RD',  paletteIdx: 3 }, // orange
        // lane 7 — kick — uses paletteIdx 6 (pink) which we override with amber.
        { kind: 'kick',   subKind: 'kick',  label: 'KICK', paletteIdx: 6 },
    ];
    const KICK_COLOR = 0xffa030;                   // amber regardless of palette

    // Note dimensions (world units). All keyed to K so scale changes
    // propagate.
    const DISC_R_BASE = 3.6 * K;                   // drum disc radius
    const DISC_H = 1.2 * K;                        // drum disc thickness
    const CYMBAL_R = 3.0 * K;                      // cymbal gem radius
    const CYMBAL_H = 1.6 * K;                      // cymbal gem height
    const KICK_W = LANE_COUNT * LANE_GAP + 2 * K;  // kick bar width (spans lanes)
    const KICK_H = 1.4 * K;                        // kick bar thickness
    const KICK_D = 4.0 * K;                        // kick bar depth (along scroll)

    // Variant size multipliers.
    const GHOST_SCALE = 0.65;
    const ACCENT_SCALE = 1.25;
    const FLAM_GRACE_OFFSET = 0.08;                // seconds before main note
    const FLAM_GRACE_SCALE = 0.55;

    // How many seconds of upcoming notes are visible at once.
    const AHEAD = 3.2;
    const BEHIND = 0.4;

    /* ======================================================================
     *  Demo patterns — hardcoded, loop indefinitely
     * ====================================================================== */

    // Each pattern: { length: seconds, notes: [{ t, lane, variant? }] }
    // lane is the LANES index. variant is optional and recognised values are
    // 'accent' | 'ghost' | 'flam' | 'bell' (bell only meaningful on ride lane).
    //
    // Times are in seconds within the loop. The renderer schedules each note
    // at every loop cycle (t, t+length, t+2*length, …) within the active
    // window, so notes recycle naturally without bookkeeping.

    const DEMO_PATTERNS = {
        // Classic rock backbeat: kick on 1+3, snare on 2+4, hi-hat 8ths,
        // crash on the downbeat of bar 1. 4-bar loop at ~120 BPM (2s/bar).
        rock_backbeat: {
            length: 8.0,
            notes: (() => {
                const out = [];
                for (let bar = 0; bar < 4; bar++) {
                    const b = bar * 2.0;
                    // hi-hat 8ths
                    for (let i = 0; i < 8; i++) out.push({ t: b + i * 0.25, lane: 0 });
                    // kick on 1 and 3
                    out.push({ t: b + 0.0, lane: 7 });
                    out.push({ t: b + 1.0, lane: 7 });
                    // snare on 2 and 4
                    out.push({ t: b + 0.5, lane: 1 });
                    out.push({ t: b + 1.5, lane: 1 });
                    // crash on bar-1 downbeat
                    if (bar === 0) out.push({ t: b + 0.0, lane: 5, variant: 'accent' });
                }
                return out;
            })(),
        },

        // Jazz swing — ride pattern, ghost-note snare comping, soft kick.
        jazz_swing: {
            length: 8.0,
            notes: (() => {
                const out = [];
                for (let bar = 0; bar < 4; bar++) {
                    const b = bar * 2.0;
                    // ride: ding ding-a ding ding-a (swing 8ths)
                    for (let beat = 0; beat < 4; beat++) {
                        const onBeat = b + beat * 0.5;
                        out.push({ t: onBeat, lane: 6, variant: beat === 0 ? 'bell' : undefined });
                        // swing "and" — closer to the next beat
                        if (beat === 1 || beat === 3) {
                            out.push({ t: onBeat + 0.33, lane: 6 });
                        }
                    }
                    // hi-hat foot on 2 and 4
                    out.push({ t: b + 0.5, lane: 0 });
                    out.push({ t: b + 1.5, lane: 0 });
                    // snare ghost comping
                    out.push({ t: b + 0.75, lane: 1, variant: 'ghost' });
                    out.push({ t: b + 1.25, lane: 1, variant: 'ghost' });
                    // soft kick on 1
                    out.push({ t: b + 0.0, lane: 7 });
                }
                return out;
            })(),
        },

        // Showcase every variant: ghost, accent, flam, bell — plus every
        // lane fires at least once. Designed to read each visual element
        // clearly without flipping settings.
        fill_showcase: {
            length: 8.0,
            notes: [
                // Bar 1 — basic groove to set the stage
                { t: 0.00, lane: 7 },                        // kick
                { t: 0.00, lane: 0 },                        // hh
                { t: 0.00, lane: 5, variant: 'accent' },     // crash accent (lane 5)
                { t: 0.25, lane: 0 },
                { t: 0.50, lane: 1 },                        // snare
                { t: 0.50, lane: 0 },
                { t: 0.75, lane: 0 },
                { t: 1.00, lane: 7 },
                { t: 1.00, lane: 0 },
                { t: 1.25, lane: 0 },
                { t: 1.50, lane: 1 },
                { t: 1.50, lane: 0 },
                { t: 1.75, lane: 0 },
                // Bar 2 — ghost note showcase on snare
                { t: 2.00, lane: 7 },
                { t: 2.00, lane: 0 },
                { t: 2.125, lane: 1, variant: 'ghost' },
                { t: 2.25, lane: 0 },
                { t: 2.375, lane: 1, variant: 'ghost' },
                { t: 2.50, lane: 1 },
                { t: 2.50, lane: 0 },
                { t: 2.625, lane: 1, variant: 'ghost' },
                { t: 2.75, lane: 0 },
                { t: 3.00, lane: 7 },
                { t: 3.50, lane: 1, variant: 'accent' },     // snare accent
                // Bar 3 — flam showcase + ride
                { t: 4.00, lane: 7 },
                { t: 4.00, lane: 6 },                        // ride
                { t: 4.50, lane: 1, variant: 'flam' },       // snare flam
                { t: 5.00, lane: 6, variant: 'bell' },       // ride bell
                { t: 5.50, lane: 1, variant: 'flam' },       // snare flam
                // Bar 4 — tom roll down the kit
                { t: 6.00, lane: 7 },
                { t: 6.00, lane: 2 },                        // hi tom
                { t: 6.25, lane: 2 },
                { t: 6.50, lane: 3 },                        // mid tom
                { t: 6.75, lane: 3 },
                { t: 7.00, lane: 4 },                        // floor tom
                { t: 7.25, lane: 4 },
                { t: 7.50, lane: 5, variant: 'accent' },     // crash accent
                { t: 7.50, lane: 7 },                        // kick under crash
            ],
        },
    };

    /* ======================================================================
     *  Settings hydration — palette/pattern/camera-angle live in localStorage.
     * ====================================================================== */

    const LS_KEYS = {
        palette: 'drum_h3d_palette',
        pattern: 'drum_h3d_pattern',
        cameraAngle: 'drum_h3d_camera_angle',
    };

    function readSettings() {
        let palette = 'default';
        let pattern = 'rock_backbeat';
        let cameraAngle = 0.35; // 0 = looking down the lanes, 1 = top-down
        try {
            const p = localStorage.getItem(LS_KEYS.palette);
            if (p && PALETTES[p]) palette = p;
            const pat = localStorage.getItem(LS_KEYS.pattern);
            if (pat && DEMO_PATTERNS[pat]) pattern = pat;
            const ca = parseFloat(localStorage.getItem(LS_KEYS.cameraAngle));
            if (Number.isFinite(ca)) cameraAngle = Math.min(1, Math.max(0, ca));
        } catch (_) { /* localStorage unavailable — use defaults */ }
        return { palette, pattern, cameraAngle };
    }

    // Expose setters so settings.html can poke a live preview without a
    // reload. Setters update localStorage and broadcast a CustomEvent that
    // the renderer subscribes to.
    window.drumH3dSetPalette = function (id) {
        if (!PALETTES[id]) return;
        try { localStorage.setItem(LS_KEYS.palette, id); } catch (_) {}
        window.dispatchEvent(new CustomEvent('drum_h3d:settings', { detail: { palette: id } }));
    };
    window.drumH3dSetPattern = function (id) {
        if (!DEMO_PATTERNS[id]) return;
        try { localStorage.setItem(LS_KEYS.pattern, id); } catch (_) {}
        window.dispatchEvent(new CustomEvent('drum_h3d:settings', { detail: { pattern: id } }));
    };
    window.drumH3dSetCameraAngle = function (v) {
        const c = Math.min(1, Math.max(0, Number(v) || 0));
        try { localStorage.setItem(LS_KEYS.cameraAngle, String(c)); } catch (_) {}
        window.dispatchEvent(new CustomEvent('drum_h3d:settings', { detail: { cameraAngle: c } }));
    };

    /* ======================================================================
     *  Renderer factory
     * ====================================================================== */

    function createFactory() {
        // Per-instance state (per-panel under splitscreen).
        let highwayCanvas = null;
        let scene = null;
        let cam = null;
        let ren = null;
        let lights = null;

        // Settings snapshot — mutated by 'drum_h3d:settings' event.
        let settings = readSettings();
        let activePalette = PALETTES[settings.palette];

        // Scene groups / pooled meshes.
        let laneGroup = null;       // lane stripes + dividers
        let kitMapGroup = null;     // top-of-highway kit silhouette
        let notesGroup = null;      // all currently-visible notes (recreated each frame)

        // Cached materials — palette-driven, rebuilt on palette swap.
        let mDrumByLane = null;     // Mesh material per lane (drum lanes)
        let mCymbalByLane = null;   // Mesh material per lane (cymbal lanes)
        let mKick = null;           // Kick bar material
        let mAccentRing = null;     // Halo material for accents
        let mGhostRing = null;      // Hollow ring material for ghost notes
        let mSnareStripe = null;    // White snare wire material
        let mBellDot = null;        // Bright dot for ride bell hits

        // Geometry — shared across notes.
        let gDrumDisc = null;
        let gCymbalGem = null;
        let gKickBar = null;
        let gAccentRing = null;
        let gGhostRing = null;
        let gSnareStripe = null;
        let gBellDot = null;
        let gFlamGrace = null;

        // Demo loop clock — anchored to performance.now() so animation
        // proceeds regardless of audio playback state.
        const t0 = performance.now() / 1000;

        let _isReady = false;
        let _settingsHandler = null;

        function applySettings(detail) {
            if (!detail) return;
            if (detail.palette && PALETTES[detail.palette]) {
                settings.palette = detail.palette;
                activePalette = PALETTES[detail.palette];
                rebuildPaletteMaterials();
                rebuildKitMap();
            }
            if (detail.pattern && DEMO_PATTERNS[detail.pattern]) {
                settings.pattern = detail.pattern;
            }
            if (typeof detail.cameraAngle === 'number') {
                settings.cameraAngle = Math.min(1, Math.max(0, detail.cameraAngle));
                positionCamera();
            }
        }

        function rebuildPaletteMaterials() {
            disposeMaterialArray(mDrumByLane);
            disposeMaterialArray(mCymbalByLane);
            mDrumByLane = new Array(LANES.length).fill(null);
            mCymbalByLane = new Array(LANES.length).fill(null);
            for (let i = 0; i < LANES.length; i++) {
                const lane = LANES[i];
                const color = lane.kind === 'kick' ? KICK_COLOR : activePalette[lane.paletteIdx];
                if (lane.kind === 'drum') {
                    mDrumByLane[i] = new T.MeshStandardMaterial({
                        color,
                        emissive: color,
                        emissiveIntensity: 0.45,
                        roughness: 0.55,
                        metalness: 0.1,
                    });
                } else if (lane.kind === 'cymbal') {
                    mCymbalByLane[i] = new T.MeshStandardMaterial({
                        color,
                        emissive: color,
                        emissiveIntensity: 0.55,
                        roughness: 0.25,
                        metalness: 0.7,
                        transparent: true,
                        opacity: 0.92,
                    });
                }
            }
            if (mKick) mKick.dispose();
            mKick = new T.MeshStandardMaterial({
                color: KICK_COLOR,
                emissive: KICK_COLOR,
                emissiveIntensity: 0.6,
                roughness: 0.4,
                metalness: 0.2,
            });
        }

        function disposeMaterialArray(arr) {
            if (!arr) return;
            for (const m of arr) if (m) m.dispose();
        }

        /* -- one-time scene setup --------------------------------------- */

        function initScene() {
            scene = new T.Scene();
            scene.background = new T.Color(FOG_COLOR);
            scene.fog = new T.Fog(FOG_COLOR, FOG_START, FOG_END);

            cam = new T.PerspectiveCamera(60, 16 / 9, 0.1, 1000 * K);
            positionCamera();

            lights = new T.Group();
            const ambient = new T.AmbientLight(0xffffff, 0.4);
            const dir = new T.DirectionalLight(0xffffff, 1.0);
            dir.position.set(-50 * K, 200 * K, 200 * K);
            lights.add(ambient);
            lights.add(dir);
            scene.add(lights);

            // Floor plane — wide darkened quad under the lanes.
            const floorW = LANE_COUNT * LANE_GAP + 8 * K;
            const floorD = (AHEAD + BEHIND + 0.5) * TS + 60 * K;
            const gFloor = new T.PlaneGeometry(floorW, floorD);
            const mFloor = new T.MeshStandardMaterial({
                color: 0x0a0e1a,
                roughness: 0.95,
                metalness: 0.0,
            });
            const floor = new T.Mesh(gFloor, mFloor);
            floor.rotation.x = -Math.PI / 2;
            floor.position.set(0, -0.3 * K, -floorD / 2 + BEHIND * TS);
            scene.add(floor);

            // Build lane stripes / dividers (static).
            buildLanes(floorW, floorD);

            // Build the kit silhouette backboard.
            kitMapGroup = new T.Group();
            scene.add(kitMapGroup);
            rebuildKitMap();

            // Hit-line bar in front of the camera, perpendicular to scroll.
            const gHit = new T.BoxGeometry(floorW, 0.6 * K, 0.6 * K);
            const mHit = new T.MeshStandardMaterial({
                color: 0xffffff,
                emissive: 0xffffff,
                emissiveIntensity: 0.9,
                roughness: 0.3,
                metalness: 0.6,
            });
            const hitBar = new T.Mesh(gHit, mHit);
            hitBar.position.set(0, 0.3 * K, 0);
            scene.add(hitBar);

            // Notes group is rebuilt every frame — pooling could come later
            // but at <100 visible notes per frame the GC cost is negligible.
            notesGroup = new T.Group();
            scene.add(notesGroup);

            // Shared geometry.
            gDrumDisc = new T.CylinderGeometry(DISC_R_BASE, DISC_R_BASE, DISC_H, 32);
            gCymbalGem = new T.CylinderGeometry(CYMBAL_R * 0.15, CYMBAL_R, CYMBAL_H, 8, 1, false);
            gKickBar = new T.BoxGeometry(KICK_W, KICK_H, KICK_D);
            gAccentRing = new T.RingGeometry(DISC_R_BASE * 1.15, DISC_R_BASE * 1.4, 32);
            gGhostRing = new T.RingGeometry(DISC_R_BASE * 0.55, DISC_R_BASE * 0.75, 24);
            gSnareStripe = new T.BoxGeometry(DISC_R_BASE * 1.9, 0.25 * K, 0.4 * K);
            gBellDot = new T.CircleGeometry(CYMBAL_R * 0.3, 16);
            gFlamGrace = new T.CylinderGeometry(
                DISC_R_BASE * FLAM_GRACE_SCALE,
                DISC_R_BASE * FLAM_GRACE_SCALE,
                DISC_H,
                24,
            );

            // Halo and ghost ring materials — additive emissive, palette-agnostic.
            mAccentRing = new T.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.85,
                side: T.DoubleSide,
            });
            mGhostRing = new T.MeshBasicMaterial({
                color: 0xffffff,
                transparent: true,
                opacity: 0.55,
                side: T.DoubleSide,
            });
            mSnareStripe = new T.MeshStandardMaterial({
                color: 0xffffff,
                emissive: 0xffffff,
                emissiveIntensity: 0.5,
                roughness: 0.3,
            });
            mBellDot = new T.MeshBasicMaterial({
                color: 0xffeecc,
                transparent: true,
                opacity: 0.95,
                side: T.DoubleSide,
            });

            rebuildPaletteMaterials();
        }

        function positionCamera() {
            // cameraAngle: 0 = down the lanes (low + forward), 1 = top-down.
            const a = settings.cameraAngle;
            // Camera height ramps from low-ish to high; depth pulls back as we
            // tilt down so the lanes still fit the frame.
            const h = (45 + 180 * a) * K;
            const d = (60 + 60 * (1 - a)) * K;
            cam.position.set(0, h, d);
            cam.lookAt(0, 0, -AHEAD * TS * 0.45);
        }

        function buildLanes(_floorW, floorD) {
            laneGroup = new T.Group();
            // Alternating lane stripes for the 7 hand lanes (same teal/blue
            // as highway_3d, but a notch darker so the brighter discs pop).
            const colors = [0x2d5476, 0x42759d];
            for (let i = 0; i < LANE_COUNT; i++) {
                const x = LANE_X0 + i * LANE_GAP;
                const g = new T.PlaneGeometry(LANE_GAP * 0.96, floorD);
                const m = new T.MeshBasicMaterial({
                    color: colors[i % 2],
                    transparent: true,
                    opacity: 0.32,
                });
                const stripe = new T.Mesh(g, m);
                stripe.rotation.x = -Math.PI / 2;
                stripe.position.set(x, -0.25 * K, -floorD / 2 + BEHIND * TS);
                laneGroup.add(stripe);
            }
            scene.add(laneGroup);
        }

        function rebuildKitMap() {
            // Clear existing children.
            while (kitMapGroup.children.length) {
                const c = kitMapGroup.children.pop();
                if (c.geometry) c.geometry.dispose();
                if (c.material) {
                    if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
                    else c.material.dispose();
                }
            }

            // Backboard plane far down the highway where guitar's fretboard
            // would terminate. Each lane's piece silhouette sits over its
            // lane's X position so the kit reads as a top-down map.
            const farZ = -AHEAD * TS - 10 * K;
            const boardW = LANE_COUNT * LANE_GAP + 6 * K;
            const boardH = 28 * K;
            const gBoard = new T.PlaneGeometry(boardW, boardH);
            const mBoard = new T.MeshBasicMaterial({
                color: 0x0a1422,
                transparent: true,
                opacity: 0.85,
            });
            const board = new T.Mesh(gBoard, mBoard);
            board.position.set(0, boardH / 2 + 2 * K, farZ);
            kitMapGroup.add(board);

            // Per-piece silhouettes — circle outlines (drums/cymbals) and a
            // wide rectangle for the kick across the base.
            for (let i = 0; i < LANES.length - 1; i++) {
                const lane = LANES[i];
                const color = activePalette[lane.paletteIdx];
                const x = LANE_X0 + i * LANE_GAP;
                const r = lane.kind === 'cymbal' ? 3.2 * K : 2.6 * K;
                const segs = lane.kind === 'cymbal' ? 8 : 32;
                const gOutline = new T.RingGeometry(r * 0.92, r, segs);
                const mOutline = new T.MeshBasicMaterial({
                    color,
                    transparent: true,
                    opacity: 0.85,
                    side: T.DoubleSide,
                });
                const ring = new T.Mesh(gOutline, mOutline);
                ring.position.set(x, boardH * 0.55 + 2 * K, farZ + 0.1 * K);
                kitMapGroup.add(ring);
            }
            // Kick rectangle along the base of the backboard.
            const kickG = new T.PlaneGeometry(boardW * 0.86, 2.0 * K);
            const kickM = new T.MeshBasicMaterial({
                color: KICK_COLOR,
                transparent: true,
                opacity: 0.85,
            });
            const kick = new T.Mesh(kickG, kickM);
            kick.position.set(0, boardH * 0.18 + 2 * K, farZ + 0.1 * K);
            kitMapGroup.add(kick);
        }

        /* -- per-frame note rendering ----------------------------------- */

        function buildNoteMesh(lane, variant) {
            const laneCfg = LANES[lane];
            const group = new T.Group();

            if (laneCfg.kind === 'kick') {
                const bar = new T.Mesh(gKickBar, mKick);
                if (variant === 'accent') bar.scale.setScalar(ACCENT_SCALE);
                group.add(bar);
                if (variant === 'accent') {
                    // Bright leading edge bar (a thin white strip on the
                    // camera-facing edge of the kick). Geometry + material
                    // are per-note — flag both as transient so disposeMeshTree
                    // releases them when the note recycles.
                    const edgeGeo = new T.BoxGeometry(KICK_W * 0.96, KICK_H * 1.05, 0.6 * K);
                    const edgeMat = new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
                    edgeGeo.userData.transient = true;
                    edgeMat.userData.transient = true;
                    const edge = new T.Mesh(edgeGeo, edgeMat);
                    edge.position.set(0, 0, KICK_D * 0.5);
                    group.add(edge);
                }
                return group;
            }

            if (laneCfg.kind === 'drum') {
                let scale = 1.0;
                if (variant === 'ghost') scale = GHOST_SCALE;
                else if (variant === 'accent') scale = ACCENT_SCALE;

                if (variant === 'ghost') {
                    // Hollow ring instead of disc — easier to read as "quiet".
                    // Material is per-note (palette-tinted but transparent) —
                    // flag it transient so disposeMeshTree releases it.
                    const ghostMat = new T.MeshBasicMaterial({
                        color: activePalette[laneCfg.paletteIdx],
                        transparent: true,
                        opacity: 0.75,
                        side: T.DoubleSide,
                    });
                    ghostMat.userData.transient = true;
                    const ring = new T.Mesh(gGhostRing, ghostMat);
                    ring.rotation.x = -Math.PI / 2;
                    ring.scale.setScalar(scale);
                    group.add(ring);
                } else {
                    const disc = new T.Mesh(gDrumDisc, mDrumByLane[lane]);
                    disc.scale.set(scale, 1, scale);
                    group.add(disc);
                }

                if (laneCfg.subKind === 'snare' && variant !== 'ghost') {
                    const stripe = new T.Mesh(gSnareStripe, mSnareStripe);
                    stripe.position.set(0, DISC_H * 0.55, 0);
                    stripe.scale.set(scale, 1, scale);
                    group.add(stripe);
                }

                if (variant === 'accent') {
                    const halo = new T.Mesh(gAccentRing, mAccentRing);
                    halo.rotation.x = -Math.PI / 2;
                    halo.position.y = DISC_H * 0.6;
                    halo.scale.setScalar(scale);
                    group.add(halo);
                }
                return group;
            }

            if (laneCfg.kind === 'cymbal') {
                // Cymbal "gem" — flattened bipyramid (truncated cone). The
                // top-radius/bottom-radius ratio gives a faceted gem look.
                let scale = 1.0;
                if (variant === 'ghost') scale = GHOST_SCALE;
                else if (variant === 'accent') scale = ACCENT_SCALE;

                const gem = new T.Mesh(gCymbalGem, mCymbalByLane[lane]);
                gem.scale.setScalar(scale);
                group.add(gem);

                if (laneCfg.subKind === 'hihat') {
                    // Open-hat hint: a thin ring around the gem (closed-hat
                    // is the bare gem). For the mockup we don't differentiate
                    // open/closed yet — TODO: drive from variant.
                }
                if (laneCfg.subKind === 'ride' && variant === 'bell') {
                    const dot = new T.Mesh(gBellDot, mBellDot);
                    dot.rotation.x = -Math.PI / 2;
                    dot.position.y = CYMBAL_H * 0.55;
                    group.add(dot);
                }
                if (variant === 'accent') {
                    const halo = new T.Mesh(gAccentRing, mAccentRing);
                    halo.rotation.x = -Math.PI / 2;
                    halo.position.y = CYMBAL_H * 0.55;
                    halo.scale.setScalar(scale * 1.05);
                    group.add(halo);
                }
                return group;
            }

            return group;
        }

        function rebuildNotes() {
            // Clear the existing notes group — for a mockup with <100 notes
            // per frame the GC churn is fine and the code stays simple.
            while (notesGroup.children.length) {
                const c = notesGroup.children.pop();
                disposeMeshTree(c);
            }

            const pat = DEMO_PATTERNS[settings.pattern];
            if (!pat) return;
            const now = performance.now() / 1000 - t0;
            const phase = now % pat.length;

            // Render notes whose offset-from-now is within [-BEHIND, AHEAD].
            // Walk the pattern at the current loop (phase) and also the
            // previous/next loops since notes near the loop boundary need
            // to be drawn from the adjacent cycle.
            for (let cycle = -1; cycle <= 1; cycle++) {
                const cycleBase = cycle * pat.length;
                for (const note of pat.notes) {
                    const dt = note.t + cycleBase - phase;
                    if (dt < -BEHIND || dt > AHEAD) continue;
                    placeNote(note, dt);
                }
            }
        }

        function placeNote(note, dt) {
            const laneCfg = LANES[note.lane];
            if (!laneCfg) return;

            const z = -dt * TS;            // dt > 0 → upstream (negative Z)
            const x = laneCfg.kind === 'kick' ? 0 : (LANE_X0 + note.lane * LANE_GAP);
            const y = laneCfg.kind === 'kick' ? 0 : DISC_H * 0.5;

            const mesh = buildNoteMesh(note.lane, note.variant);
            mesh.position.set(x, y, z);

            // Brighten emissive as the note approaches the hit line.
            // 0 at AHEAD, peak at 0, then linger briefly past it.
            const proximity = Math.max(0, 1 - Math.abs(dt) / 0.6);
            if (laneCfg.kind === 'drum' && note.variant !== 'ghost' && mDrumByLane[note.lane]) {
                // Subtle pulse via emissiveIntensity — palette-driven base + pulse.
                mDrumByLane[note.lane].emissiveIntensity = 0.45 + proximity * 0.35;
            } else if (laneCfg.kind === 'cymbal' && mCymbalByLane[note.lane]) {
                mCymbalByLane[note.lane].emissiveIntensity = 0.55 + proximity * 0.35;
            } else if (laneCfg.kind === 'kick' && mKick) {
                mKick.emissiveIntensity = 0.6 + proximity * 0.5;
            }

            // Slight scale-up as notes near the hit line gives the eye a
            // "this is the moment" cue. Capped so it doesn't overshoot.
            const approach = 1.0 + Math.max(0, 1 - Math.abs(dt) / 0.3) * 0.12;
            mesh.scale.multiplyScalar(approach);

            notesGroup.add(mesh);

            // Flam grace note — small auxiliary disc slightly before the main.
            if (note.variant === 'flam' && laneCfg.kind === 'drum') {
                const graceDt = dt + FLAM_GRACE_OFFSET;
                if (graceDt >= -BEHIND && graceDt <= AHEAD) {
                    const grace = new T.Mesh(gFlamGrace, mDrumByLane[note.lane]);
                    grace.position.set(x - DISC_R_BASE * 0.9, y, -graceDt * TS);
                    notesGroup.add(grace);
                }
            }
        }

        function disposeMeshTree(node) {
            // Shared geometries/materials (gDrumDisc, mDrumByLane[i], etc.)
            // are owned by the renderer and disposed in teardown(). Per-note
            // ephemeral geometries/materials are flagged with
            // .userData.transient = true at construction time — dispose those.
            node.traverse((child) => {
                if (!child.isMesh) return;
                if (child.geometry && child.geometry.userData && child.geometry.userData.transient) {
                    child.geometry.dispose();
                }
                if (child.material && child.material.userData && child.material.userData.transient) {
                    child.material.dispose();
                }
            });
        }

        /* -- size handling ---------------------------------------------- */

        function applySize(w, h) {
            if (!ren || !cam || !highwayCanvas) return;
            const W = Math.max(1, Math.round(w || highwayCanvas.clientWidth || highwayCanvas.width || 1));
            const H = Math.max(1, Math.round(h || highwayCanvas.clientHeight || highwayCanvas.height || 1));
            ren.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            ren.setSize(W, H, false);
            cam.aspect = W / H;
            cam.updateProjectionMatrix();
        }

        /* -- teardown --------------------------------------------------- */

        function teardown() {
            if (_settingsHandler) {
                window.removeEventListener('drum_h3d:settings', _settingsHandler);
                _settingsHandler = null;
            }
            if (notesGroup) {
                while (notesGroup.children.length) {
                    disposeMeshTree(notesGroup.children.pop());
                }
            }
            if (kitMapGroup) {
                while (kitMapGroup.children.length) {
                    const c = kitMapGroup.children.pop();
                    if (c.geometry) c.geometry.dispose();
                    if (c.material) c.material.dispose();
                }
            }
            disposeMaterialArray(mDrumByLane);
            disposeMaterialArray(mCymbalByLane);
            if (mKick) mKick.dispose();
            if (mAccentRing) mAccentRing.dispose();
            if (mGhostRing) mGhostRing.dispose();
            if (mSnareStripe) mSnareStripe.dispose();
            if (mBellDot) mBellDot.dispose();
            if (gDrumDisc) gDrumDisc.dispose();
            if (gCymbalGem) gCymbalGem.dispose();
            if (gKickBar) gKickBar.dispose();
            if (gAccentRing) gAccentRing.dispose();
            if (gGhostRing) gGhostRing.dispose();
            if (gSnareStripe) gSnareStripe.dispose();
            if (gBellDot) gBellDot.dispose();
            if (gFlamGrace) gFlamGrace.dispose();
            if (ren) ren.dispose();
            scene = cam = ren = lights = laneGroup = kitMapGroup = notesGroup = null;
            mDrumByLane = mCymbalByLane = mKick = null;
            mAccentRing = mGhostRing = mSnareStripe = mBellDot = null;
            gDrumDisc = gCymbalGem = gKickBar = null;
            gAccentRing = gGhostRing = gSnareStripe = gBellDot = gFlamGrace = null;
            _isReady = false;
        }

        /* -- setRenderer contract --------------------------------------- */

        return {
            contextType: 'webgl2',

            init(canvas, _bundle) {
                if (_isReady) teardown();
                highwayCanvas = canvas;
                settings = readSettings();
                activePalette = PALETTES[settings.palette];

                loadThree().then(() => {
                    if (!highwayCanvas) return; // destroyed before load resolved
                    try {
                        ren = new T.WebGLRenderer({
                            canvas: highwayCanvas,
                            antialias: true,
                            alpha: false,
                        });
                        ren.setClearColor(FOG_COLOR, 1);
                    } catch (e) {
                        console.error('[Drum-Hwy] WebGL2 init failed:', e);
                        return;
                    }
                    initScene();
                    applySize(highwayCanvas.clientWidth, highwayCanvas.clientHeight);

                    _settingsHandler = (ev) => applySettings(ev && ev.detail);
                    window.addEventListener('drum_h3d:settings', _settingsHandler);

                    _isReady = true;
                });
            },

            draw(_bundle) {
                if (!_isReady || !ren || !scene || !cam) return;
                rebuildNotes();
                ren.render(scene, cam);
            },

            resize(w, h) {
                if (!_isReady) return;
                applySize(w, h);
            },

            destroy() {
                teardown();
                highwayCanvas = null;
            },
        };
    }

    /* ======================================================================
     *  Register
     * ====================================================================== */

    window.slopsmithViz_drum_highway_3d = createFactory;
    // Static contextType so core can read it for canvas-swap decisions
    // before constructing a throwaway renderer instance.
    window.slopsmithViz_drum_highway_3d.contextType = 'webgl2';
    // No matchesArrangement — this is a manual-pick mockup. Auto-mode
    // should not select it for guitar/bass charts.
})();
