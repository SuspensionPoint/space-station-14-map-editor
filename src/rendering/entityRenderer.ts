import type { CardinalDirection, TileGrid } from '../types';
import type { IPrototypeRegistry, ResolvedTile, SpriteLayerInfo } from '../loaders/registryTypes';
import type { ImportedEntity } from '../import/mapImporter';
import type { SpriteDrawInfo } from '../loaders/rsiLoader';
import { loadSprite } from '../loaders/rsiLoader';
import { Camera } from './camera';
import { getCell } from '../state/editorState';
import { markSceneDirty } from './dirtyFlags';
import { spatialGetAt, spatialGetInRect, spatialGeneration, tileKey } from './spatialIndex';
import { statsSetVisibleEntities, statsSetLodActive, statsAddDrawCalls } from './renderStats';

const TILE_SIZE = 32;

export interface CenteredSpriteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Scale a sprite from source pixels to screen pixels and center it on its entity tile. */
export function getCenteredSpriteRect(
  screenX: number,
  screenY: number,
  tileScreenSize: number,
  spriteWidth: number,
  spriteHeight: number,
): CenteredSpriteRect {
  const width = tileScreenSize * (spriteWidth / TILE_SIZE);
  const height = tileScreenSize * (spriteHeight / TILE_SIZE);
  return {
    x: screenX + (tileScreenSize - width) / 2,
    y: screenY + (tileScreenSize - height) / 2,
    width,
    height,
  };
}

// ---- DrawDepth values (from Content.Shared/DrawDepth/DrawDepth.cs) ----

const DRAW_DEPTH_VALUES: Record<string, number> = {
  LowFloors: -22,
  ThickPipe: -21,
  ThickWire: -20,
  ThinPipeAlt4: -19,
  ThinPipeAlt3: -18,
  ThinPipeAlt2: -17,
  ThinPipeAlt1: -16,
  ThinPipe: -15,
  ThinWire: -14,
  BelowFloor: -13,
  FloorTiles: -12,
  FloorObjects: -11,
  Puddles: -10,
  HighFloorObjects: -5,
  DeadMobs: -4,
  SmallMobs: -3,
  Walls: -2,
  WallTops: -1,
  Objects: 0,
  SmallObjects: 1,
  WallMountedItems: 2,
  LargeObjects: 3,
  Items: 4,
  BelowMobs: 5,
  Mobs: 6,
  OverMobs: 7,
  Doors: 8,
  BlastDoors: 9,
  Overdoors: 10,
  Effects: 11,
  Ghosts: 12,
  Overlays: 13,
};

/** Resolve a DrawDepth string to its numeric value. */
function getDrawDepthValue(drawDepth: string | undefined): number {
  if (!drawDepth) return DRAW_DEPTH_VALUES.Objects; // default
  return DRAW_DEPTH_VALUES[drawDepth] ?? DRAW_DEPTH_VALUES.Objects;
}

// ---- Layer group filtering ----

export interface LayerVisibility {
  subfloor: boolean;     // DrawDepth -22 to -13 (cables, pipes)
  floorObjects: boolean; // DrawDepth -12 to -5
  structures: boolean;   // DrawDepth -2 to -1 (walls, windows)
  objects: boolean;       // DrawDepth 0 to +7 (furniture, machines, wall mounts)
  doors: boolean;        // DrawDepth +8 to +10
  markers: boolean;      // Spawn points and mapping helpers
  decals: boolean;       // Decal overlays (floor markings, arrows, etc.)
}

export const DEFAULT_LAYER_VISIBILITY: LayerVisibility = {
  subfloor: true,
  floorObjects: true,
  structures: true,
  objects: true,
  doors: true,
  markers: true,
  decals: true,
};

// ---- Pre-computed prototype category flags ----

interface PrototypeFlags {
  isMarker: boolean;
  placeholderCategory: 'spawn' | 'cable' | 'pipe' | 'generic';
}

const prototypeFlagCache = new Map<string, PrototypeFlags>();

export function getPrototypeFlags(prototype: string): PrototypeFlags {
  const cached = prototypeFlagCache.get(prototype);
  if (cached) return cached;

  const isMarker = prototype.includes('Spawn') || prototype.includes('Marker') || prototype.includes('Spawner');
  let placeholderCategory: PrototypeFlags['placeholderCategory'] = 'generic';
  if (prototype.includes('Spawn') || prototype.includes('Marker') || prototype.includes('Spawner')) {
    placeholderCategory = 'spawn';
  } else if (prototype.includes('Cable')) {
    placeholderCategory = 'cable';
  } else if (prototype.includes('Pipe') || prototype.includes('Gas')) {
    placeholderCategory = 'pipe';
  }

  const flags = { isMarker, placeholderCategory };
  prototypeFlagCache.set(prototype, flags);
  return flags;
}

export function clearPrototypeFlags(): void {
  prototypeFlagCache.clear();
}

const PLACEHOLDER_COLORS: Record<PrototypeFlags['placeholderCategory'], string> = {
  spawn: 'rgba(0, 220, 0, 0.5)',
  cable: 'rgba(255, 150, 0, 0.5)',
  pipe: 'rgba(0, 180, 220, 0.5)',
  generic: 'rgba(200, 100, 200, 0.4)',
};

/** Check if an entity's DrawDepth falls in a visible layer group. */
export function isLayerVisible(drawDepthValue: number, prototype: string, layers: LayerVisibility): boolean {
  if (drawDepthValue <= -13) return layers.subfloor;
  if (drawDepthValue <= -5) return layers.floorObjects;
  if (drawDepthValue <= -1) return layers.structures;
  if (drawDepthValue <= 7) {
    if (getPrototypeFlags(prototype).isMarker) return layers.markers;
    return layers.objects;
  }
  if (drawDepthValue <= 10) return layers.doors;
  return layers.objects; // effects, ghosts, overlays
}

// ---- SubFloor filtering ----

/** Prototypes with SubFloorHide component (infrastructure hidden under floors). */
const SUBFLOOR_PREFIXES = [
  'Cable', 'GasPipe', 'DisposalPipe', 'DisposalJunction', 'DisposalYJunction',
  'DisposalBend', 'DisposalTrunk',
];

const subFloorCache = new Map<string, boolean>();

/** Exported for testing */
export function hasSubFloorHide(prototype: string, registry: IPrototypeRegistry): boolean {
  if (subFloorCache.has(prototype)) return subFloorCache.get(prototype)!;
  let result = false;
  for (const prefix of SUBFLOOR_PREFIXES) {
    if (prototype.startsWith(prefix)) { result = true; break; }
  }
  if (!result) {
    const entity = registry.getEntity(prototype);
    if (entity) result = entity.components.some(c => c.type === 'SubFloorHide');
  }
  subFloorCache.set(prototype, result);
  return result;
}

function isTileSubfloor(grid: TileGrid, worldX: number, worldY: number, registry: IPrototypeRegistry): boolean {
  const cell = getCell(grid, worldX, worldY);
  if (!cell) return true; // Space is subfloor-ish
  const tile = registry.getTile(cell.tileId);
  return tile ? tile.isSubfloor : true;
}

// ---- Cable connection mask ----

/** Cable state prefix mapping: prototype prefix → RSI state prefix */
const CABLE_STATE_PREFIXES: Record<string, string> = {
  CableHV: 'hvcable_',
  CableMV: 'mvcable_',
  CableApcExtension: 'lvcable_',
};

/** Get the cable state prefix for a prototype, or null if not a cable. */
function getCableStatePrefix(prototype: string): string | null {
  for (const [prefix, statePrefix] of Object.entries(CABLE_STATE_PREFIXES)) {
    if (prototype.startsWith(prefix)) return statePrefix;
  }
  return null;
}

// ---- Cable connection mask (uses spatial index) ----

/**
 * Prototypes that act as cable connection points (e.g., CableTerminal connects to HV/MV).
 * Cables visually connect to these even though they aren't the same prototype.
 */
const CABLE_CONNECTOR_PROTOTYPES = new Set([
  'CableTerminal',
  'CableTerminalUncuttable',
]);

/** Exported for testing */
export function hasCableConnectionAt(x: number, y: number, proto: string): boolean {
  const entities = spatialGetAt(x, y);
  for (const e of entities) {
    if (e.prototype === proto) return true;
    // CableTerminal connects to HV and MV cables
    if (CABLE_CONNECTOR_PROTOTYPES.has(e.prototype) &&
      (proto === 'CableHV' || proto === 'CableMV')) return true;
  }
  return false;
}

function getCableConnectionMask(entity: ImportedEntity): number {
  const ex = Math.floor(entity.position.x);
  const ey = Math.floor(entity.position.y);
  const proto = entity.prototype;

  let mask = 0;
  if (hasCableConnectionAt(ex, ey + 1, proto)) mask |= 1;  // North
  if (hasCableConnectionAt(ex, ey - 1, proto)) mask |= 2;  // South
  if (hasCableConnectionAt(ex + 1, ey, proto)) mask |= 4;  // East
  if (hasCableConnectionAt(ex - 1, ey, proto)) mask |= 8;  // West
  return mask;
}

// ---- IconSmooth corner rendering ----

interface SmoothInfo {
  key: string;
  base: string;
  mode: 'Corners' | 'CardinalFlags' | 'Diagonal';
}

const smoothInfoCache = new Map<string, SmoothInfo | null>();

function getSmoothInfo(prototype: string, registry: IPrototypeRegistry): SmoothInfo | null {
  if (smoothInfoCache.has(prototype)) return smoothInfoCache.get(prototype)!;
  const spriteInfo = registry.getSpriteInfo(prototype);
  const result = spriteInfo?.iconSmoothKey && spriteInfo?.iconSmoothBase
    ? { key: spriteInfo.iconSmoothKey, base: spriteInfo.iconSmoothBase, mode: spriteInfo.iconSmoothMode ?? 'Corners' }
    : null;
  smoothInfoCache.set(prototype, result);
  return result;
}

export function clearSmoothInfoCache(): void {
  smoothInfoCache.clear();
}

// ---- Batch smooth key grid (pre-resolve neighbor lookups) ----

/**
 * Build a temporary grid mapping tile positions to their smooth key.
 * Each tile is resolved once, replacing per-entity per-neighbor spatial lookups.
 */
export function buildSmoothKeyGrid(
  minX: number, minY: number, maxX: number, maxY: number,
  registry: IPrototypeRegistry,
): Map<number, string> {
  const grid = new Map<number, string>();
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const entities = spatialGetAt(x, y);
      for (const e of entities) {
        const info = getSmoothInfo(e.prototype, registry);
        if (info) {
          grid.set(tileKey(x, y), info.key);
          // Limitation: breaking after the first smooth entity means only one smooth
          // key is stored per tile. If a tile had two entities with DIFFERENT smooth
          // keys (e.g., wall with key "walls" and carpet with key "carpets"), only the
          // first would be recorded. In practice this doesn't occur in SS14 maps,
          // entities sharing a tile typically share the same smooth key.
          break;
        }
      }
    }
  }
  return grid;
}

// ---- IconSmooth neighbor queries (uses spatial index) ----

/** Check if any entity at (x,y) has the given smoothKey. */
function hasSmoothKeyAt(x: number, y: number, smoothKey: string, registry: IPrototypeRegistry): boolean {
  const entities = spatialGetAt(x, y);
  for (const e of entities) {
    const info = getSmoothInfo(e.prototype, registry);
    if (info && info.key === smoothKey) return true;
  }
  return false;
}

// ---- Generation-keyed caches for smooth calculations ----

const cornerFillCache = new Map<string, { gen: number; fills: Array<{ fill: number; direction: CardinalDirection }> }>();
const cardinalMaskCache = new Map<string, { gen: number; mask: number }>();

export function clearCornerFillCache(): void { cornerFillCache.clear(); }
export function clearCardinalMaskCache(): void { cardinalMaskCache.clear(); }

/**
 * Calculate cardinal direction bitmask for CardinalFlags mode.
 * N=1, S=2, E=4, W=8 (matching SS14's CardinalConnectDirs enum).
 */
export function calculateCardinalMask(
  ex: number, ey: number,
  smoothKey: string,
  registry: IPrototypeRegistry,
  smoothGrid?: Map<number, string>,
): number {
  const cacheKey = `${ex},${ey},${smoothKey}`;
  const gen = spatialGeneration();
  const cached = cardinalMaskCache.get(cacheKey);
  if (cached && cached.gen === gen) return cached.mask;

  let mask = 0;
  if (smoothGrid) {
    if (smoothGrid.get(tileKey(ex, ey + 1)) === smoothKey) mask |= 1;  // North
    if (smoothGrid.get(tileKey(ex, ey - 1)) === smoothKey) mask |= 2;  // South
    if (smoothGrid.get(tileKey(ex + 1, ey)) === smoothKey) mask |= 4;  // East
    if (smoothGrid.get(tileKey(ex - 1, ey)) === smoothKey) mask |= 8;  // West
  } else {
    if (hasSmoothKeyAt(ex, ey + 1, smoothKey, registry)) mask |= 1;  // North
    if (hasSmoothKeyAt(ex, ey - 1, smoothKey, registry)) mask |= 2;  // South
    if (hasSmoothKeyAt(ex + 1, ey, smoothKey, registry)) mask |= 4;  // East
    if (hasSmoothKeyAt(ex - 1, ey, smoothKey, registry)) mask |= 8;  // West
  }

  cardinalMaskCache.set(cacheKey, { gen, mask });
  return mask;
}

/**
 * Calculate the 4 corner fill values for an IconSmooth entity.
 * Each corner checks 2 cardinal neighbors + 1 diagonal, producing a 3-bit value (0-7).
 *
 * SS14 CornerFill bits (from IconSmoothSystem.cs):
 *   CounterClockwise = 1 (bit 0), the cardinal going CCW around the corner
 *   Diagonal          = 2 (bit 1), the diagonal neighbor for this corner
 *   Clockwise         = 4 (bit 2), the cardinal going CW around the corner
 *
 * Corner-to-direction mapping (via DirectionOffset in SS14):
 *   SE corner → South (0), NE corner → East (2), NW corner → North (1), SW corner → West (3)
 *
 * Per-corner cardinal assignments:
 *   NE: N=CCW(1), E=CW(4), NE=Diag(2)
 *   SE: E=CCW(1), S=CW(4), SE=Diag(2)
 *   SW: S=CCW(1), W=CW(4), SW=Diag(2)
 *   NW: W=CCW(1), N=CW(4), NW=Diag(2)
 */
export function calculateCornerFills(
  ex: number, ey: number,
  smoothKey: string,
  registry: IPrototypeRegistry,
  smoothGrid?: Map<number, string>,
): Array<{ fill: number; direction: CardinalDirection }> {
  const cacheKey = `${ex},${ey},${smoothKey}`;
  const gen = spatialGeneration();
  const cached = cornerFillCache.get(cacheKey);
  if (cached && cached.gen === gen) return cached.fills;

  // Check 8 neighbors, use pre-built grid when available, fall back to spatial queries
  let n: boolean, s: boolean, e: boolean, w: boolean;
  let ne: boolean, nw: boolean, se: boolean, sw: boolean;
  if (smoothGrid) {
    n = smoothGrid.get(tileKey(ex, ey + 1)) === smoothKey;
    s = smoothGrid.get(tileKey(ex, ey - 1)) === smoothKey;
    e = smoothGrid.get(tileKey(ex + 1, ey)) === smoothKey;
    w = smoothGrid.get(tileKey(ex - 1, ey)) === smoothKey;
    ne = smoothGrid.get(tileKey(ex + 1, ey + 1)) === smoothKey;
    nw = smoothGrid.get(tileKey(ex - 1, ey + 1)) === smoothKey;
    se = smoothGrid.get(tileKey(ex + 1, ey - 1)) === smoothKey;
    sw = smoothGrid.get(tileKey(ex - 1, ey - 1)) === smoothKey;
  } else {
    n = hasSmoothKeyAt(ex, ey + 1, smoothKey, registry);
    s = hasSmoothKeyAt(ex, ey - 1, smoothKey, registry);
    e = hasSmoothKeyAt(ex + 1, ey, smoothKey, registry);
    w = hasSmoothKeyAt(ex - 1, ey, smoothKey, registry);
    ne = hasSmoothKeyAt(ex + 1, ey + 1, smoothKey, registry);
    nw = hasSmoothKeyAt(ex - 1, ey + 1, smoothKey, registry);
    se = hasSmoothKeyAt(ex + 1, ey - 1, smoothKey, registry);
    sw = hasSmoothKeyAt(ex - 1, ey - 1, smoothKey, registry);
  }

  // NE corner (RSI direction = East): N=CCW(1), NE=Diag(2), E=CW(4)
  let neFill = 0;
  if (n) neFill |= 1;
  if (ne) neFill |= 2;
  if (e) neFill |= 4;

  // SE corner (RSI direction = South): E=CCW(1), SE=Diag(2), S=CW(4)
  let seFill = 0;
  if (e) seFill |= 1;
  if (se) seFill |= 2;
  if (s) seFill |= 4;

  // SW corner (RSI direction = West): S=CCW(1), SW=Diag(2), W=CW(4)
  let swFill = 0;
  if (s) swFill |= 1;
  if (sw) swFill |= 2;
  if (w) swFill |= 4;

  // NW corner (RSI direction = North): W=CCW(1), NW=Diag(2), N=CW(4)
  let nwFill = 0;
  if (w) nwFill |= 1;
  if (nw) nwFill |= 2;
  if (n) nwFill |= 4;

  const fills = [
    { fill: neFill, direction: 'east' as CardinalDirection },
    { fill: seFill, direction: 'south' as CardinalDirection },
    { fill: swFill, direction: 'west' as CardinalDirection },
    { fill: nwFill, direction: 'north' as CardinalDirection },
  ];

  cornerFillCache.set(cacheKey, { gen, fills });
  return fills;
}

// ---- Sprite cache ----

const entitySpriteCache = new Map<string, SpriteDrawInfo | null>();
const loadingSet = new Set<string>();

export function clearEntitySpriteCache(): void {
  entitySpriteCache.clear();
  loadingSet.clear();
}

// ---- Direction helpers ----

/**
 * Convert a rotation in radians to the nearest cardinal direction.
 * SS14 rotations: 0 = south, pi/2 = east, pi = north, 3pi/2 = west.
 */
function rotationToDirection(rotation: number): CardinalDirection {
  const TWO_PI = 2 * Math.PI;
  const norm = ((rotation % TWO_PI) + TWO_PI) % TWO_PI;
  if (norm < Math.PI / 4 || norm >= 7 * Math.PI / 4) return 'south';
  if (norm < 3 * Math.PI / 4) return 'east';
  if (norm < 5 * Math.PI / 4) return 'north';
  return 'west';
}

// ---- Sprite loading ----

export function getEntitySprite(
  prototype: string,
  direction: CardinalDirection,
  registry: IPrototypeRegistry,
  stateOverride?: string,
): SpriteDrawInfo | null | undefined {
  const cacheKey = stateOverride
    ? `${prototype}:${direction}:${stateOverride}`
    : `${prototype}:${direction}`;

  if (entitySpriteCache.has(cacheKey)) {
    return entitySpriteCache.get(cacheKey)!;
  }

  if (!loadingSet.has(cacheKey)) {
    loadingSet.add(cacheKey);

    const spriteInfo = registry.getSpriteInfo(prototype);
    if (!spriteInfo) {
      entitySpriteCache.set(cacheKey, null);
      loadingSet.delete(cacheKey);
      return null;
    }

    loadSprite(spriteInfo, direction, 0, stateOverride)
      .then((drawInfo) => {
        entitySpriteCache.set(cacheKey, drawInfo);
        markSceneDirty();
      })
      .catch(() => {
        entitySpriteCache.set(cacheKey, null);
      })
      .finally(() => {
        loadingSet.delete(cacheKey);
      });
  }

  return undefined;
}

// ---- Extra layer loading (for multi-layer sprites like spawners) ----

const extraLayerCache = new Map<string, SpriteDrawInfo[] | null>();
const extraLayerLoadingSet = new Set<string>();

/**
 * Get extra sprite layers for an entity (layers beyond the base layer).
 * Returns cached layers, null (no extra layers or failed), or undefined (still loading).
 */
function getExtraLayers(
  prototype: string,
  direction: CardinalDirection,
  registry: IPrototypeRegistry,
): SpriteDrawInfo[] | null | undefined {
  const cacheKey = `${prototype}:${direction}:layers`;

  if (extraLayerCache.has(cacheKey)) {
    return extraLayerCache.get(cacheKey)!;
  }

  if (extraLayerLoadingSet.has(cacheKey)) return undefined;

  const spriteInfo = registry.getSpriteInfo(prototype);
  if (!spriteInfo || spriteInfo.layers.length <= 1) {
    extraLayerCache.set(cacheKey, null);
    return null;
  }

  // Load all layers beyond the first (base layer is already rendered)
  extraLayerLoadingSet.add(cacheKey);
  const layerPromises: Promise<SpriteDrawInfo | null>[] = [];

  for (let i = 1; i < spriteInfo.layers.length; i++) {
    const layer = spriteInfo.layers[i];
    if (layer.visible === false || !layer.state) continue;

    // Layer can override the RSI path
    const layerSpriteInfo = {
      ...spriteInfo,
      rsiPath: layer.sprite ?? spriteInfo.rsiPath,
      baseState: layer.state,
    };

    layerPromises.push(loadSprite(layerSpriteInfo, direction, 0));
  }

  Promise.all(layerPromises)
    .then(results => {
      const validLayers = results.filter((r): r is SpriteDrawInfo => r !== null);
      extraLayerCache.set(cacheKey, validLayers.length > 0 ? validLayers : null);
      markSceneDirty();
    })
    .catch(() => {
      extraLayerCache.set(cacheKey, null);
    })
    .finally(() => {
      extraLayerLoadingSet.delete(cacheKey);
    });

  return undefined;
}

export function clearExtraLayerCache(): void {
  extraLayerCache.clear();
  extraLayerLoadingSet.clear();
}

// ---- Placeholder drawing ----

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  tileScreenSize: number,
  prototype: string,
  forLod = false,
): void {
  // Skip placeholders when zoomed out (they clutter the view), unless in LOD mode
  if (!forLod && tileScreenSize < 8) return;

  const cx = screenX + tileScreenSize / 2;
  const cy = screenY + tileScreenSize / 2;
  const r = Math.max(0.5, tileScreenSize * 0.2);

  ctx.fillStyle = PLACEHOLDER_COLORS[getPrototypeFlags(prototype).placeholderCategory];
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
}

// ---- Pipe color extraction (cached) ----

const pipeColorCache = new Map<number, string | null>();

function getAtmosPipeColor(entity: ImportedEntity): string | null {
  if (pipeColorCache.has(entity.uid)) return pipeColorCache.get(entity.uid)!;
  let result: string | null = null;
  for (const comp of entity.components) {
    if ((comp as Record<string, unknown>).type === 'AtmosPipeColor') {
      const color = (comp as Record<string, unknown>).color;
      if (typeof color === 'string') result = color;
      break;
    }
  }
  pipeColorCache.set(entity.uid, result);
  return result;
}

export function clearPipeColorCache(): void {
  pipeColorCache.clear();
  tintedSpriteCache.clear();
}

// ---- Sprite color tinting (layer-level and component-level) ----

const spriteColorCache = new Map<string, string | null>();

/**
 * Get the effective tint color for an entity's base sprite.
 * Priority: first layer's color > component-level color > null (no tint).
 */
function getSpriteColor(prototype: string, registry: IPrototypeRegistry): string | null {
  if (spriteColorCache.has(prototype)) return spriteColorCache.get(prototype)!;
  const spriteInfo = registry.getSpriteInfo(prototype);
  let color: string | null = null;
  if (spriteInfo) {
    // Check first layer's color (e.g., ComfyChair layers[0].color = "#767e82")
    if (spriteInfo.layers.length > 0 && spriteInfo.layers[0].color) {
      color = spriteInfo.layers[0].color;
    }
    // Component-level color (e.g., Puddle color = "#FFFFFF80")
    if (!color && spriteInfo.color) {
      color = spriteInfo.color;
    }
  }
  spriteColorCache.set(prototype, color);
  return color;
}

export function clearSpriteColorCache(): void {
  spriteColorCache.clear();
}

// ---- Tinted sprite cache (offscreen canvas) with LRU eviction ----

export const TINTED_CACHE_MAX = 512;

const tintedSpriteCache = new Map<string, HTMLCanvasElement>();

export function getTintedCacheSize(): number {
  return tintedSpriteCache.size;
}

function getTintedSprite(sprite: SpriteDrawInfo, color: string): HTMLCanvasElement {
  const key = `${sprite.image.src}:${sprite.sx},${sprite.sy}:${color}`;

  const cached = tintedSpriteCache.get(key);
  if (cached) {
    // Move to end (most recently used) by re-inserting
    tintedSpriteCache.delete(key);
    tintedSpriteCache.set(key, cached);
    return cached;
  }

  // Strip alpha from color for the multiply tint (alpha handled by globalAlpha in caller)
  const rgbColor = color.length === 9 ? color.slice(0, 7) : color;

  const w = sprite.sw;
  const h = sprite.sh;
  const offscreen = document.createElement('canvas');
  offscreen.width = w;
  offscreen.height = h;
  const octx = offscreen.getContext('2d')!;

  // Draw the original sprite
  octx.drawImage(sprite.image, sprite.sx, sprite.sy, w, h, 0, 0, w, h);

  // Skip multiply for pure white (no tint needed, only alpha matters)
  if (rgbColor !== '#FFFFFF' && rgbColor !== '#ffffff') {
    // Multiply tint
    octx.globalCompositeOperation = 'multiply';
    octx.fillStyle = rgbColor;
    octx.fillRect(0, 0, w, h);

    // Restore alpha from original sprite
    octx.globalCompositeOperation = 'destination-in';
    octx.drawImage(sprite.image, sprite.sx, sprite.sy, w, h, 0, 0, w, h);
  }

  // Evict oldest if over capacity
  if (tintedSpriteCache.size >= TINTED_CACHE_MAX) {
    const oldest = tintedSpriteCache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = tintedSpriteCache.get(oldest);
      if (evicted) { evicted.width = 0; evicted.height = 0; } // release GPU backing store
      tintedSpriteCache.delete(oldest);
    }
  }

  tintedSpriteCache.set(key, offscreen);
  return offscreen;
}

// ---- noRot cache ----

const noRotCache = new Map<string, boolean>();

export function isNoRot(prototype: string, registry: IPrototypeRegistry): boolean {
  if (noRotCache.has(prototype)) return noRotCache.get(prototype)!;
  const spriteInfo = registry.getSpriteInfo(prototype);
  const result = spriteInfo?.noRot === true;
  noRotCache.set(prototype, result);
  return result;
}

export function clearNoRotCache(): void {
  noRotCache.clear();
}

// ---- Sorting cache ----

const drawDepthCache = new Map<string, number>();

export function getCachedDrawDepth(prototype: string, registry: IPrototypeRegistry): number {
  if (drawDepthCache.has(prototype)) return drawDepthCache.get(prototype)!;
  const spriteInfo = registry.getSpriteInfo(prototype);
  const value = getDrawDepthValue(spriteInfo?.drawDepth);
  drawDepthCache.set(prototype, value);
  return value;
}

export function clearDrawDepthCache(): void {
  drawDepthCache.clear();
}

// ---- Cached visible list for sort skip ----

let prevEntitiesRef: ImportedEntity[] | null = null;
let prevCameraX = NaN;
let prevCameraY = NaN;
let prevCameraZoom = NaN;
let prevCanvasW = 0;
let prevCanvasH = 0;
let prevSubFloorMode = true;
let prevLayers: LayerVisibility | null = null;
let prevSpatialGen = -1;
let cachedVisible: { entity: ImportedEntity; depth: number; dimmed: boolean }[] = [];
let cachedSmoothGrid: Map<number, string> = new Map();

// ---- Main render function ----

export function renderEntities(
  ctx: CanvasRenderingContext2D,
  entities: ImportedEntity[],
  camera: Camera,
  canvasW: number,
  canvasH: number,
  registry: IPrototypeRegistry | null,
  grid?: TileGrid,
  showSubFloor?: boolean,
  layerVisibility?: LayerVisibility,
): void {
  if (!registry || entities.length === 0) return;

  const tileScreenSize = camera.tileScreenSize;
  const layers = layerVisibility ?? DEFAULT_LAYER_VISIBILITY;
  const subFloorMode = showSubFloor ?? true;

  // Check if we can reuse the cached visible list and indexes
  const cameraChanged = camera.x !== prevCameraX || camera.y !== prevCameraY ||
    camera.zoom !== prevCameraZoom || canvasW !== prevCanvasW || canvasH !== prevCanvasH;
  const entitiesChanged = entities !== prevEntitiesRef;
  const curSpatialGen = spatialGeneration();
  const spatialChanged = curSpatialGen !== prevSpatialGen;
  const filtersChanged = subFloorMode !== prevSubFloorMode || layers !== prevLayers;

  const needsRebuild = cameraChanged || entitiesChanged || spatialChanged || filtersChanged;

  if (needsRebuild) {
    // Visible bounds in world coordinates (with margin)
    const topLeft = camera.screenToTile(0, 0, canvasW, canvasH);
    const bottomRight = camera.screenToTile(canvasW, canvasH, canvasW, canvasH);
    const visMinX = Math.floor(Math.min(topLeft.x, bottomRight.x)) - 1;
    const visMaxX = Math.ceil(Math.max(topLeft.x, bottomRight.x)) + 1;
    const visMinY = Math.floor(Math.min(topLeft.y, bottomRight.y)) - 1;
    const visMaxY = Math.ceil(Math.max(topLeft.y, bottomRight.y)) + 1;

    // Spatial query: O(visible tiles) instead of O(all entities)
    const candidates = spatialGetInRect(visMinX, visMinY, visMaxX, visMaxY);

    // Filter by layer visibility and subfloor
    const visible: { entity: ImportedEntity; depth: number; dimmed: boolean }[] = [];

    for (const entity of candidates) {
      const { position, prototype } = entity;
      const depth = getCachedDrawDepth(prototype, registry);

      // Layer visibility filtering
      if (!isLayerVisible(depth, prototype, layers)) continue;

      // SubFloor filtering: dim infrastructure under non-subfloor tiles when T-Ray is off
      let dimmed = false;
      if (!subFloorMode && grid && hasSubFloorHide(prototype, registry)) {
        const tileX = Math.floor(position.x);
        const tileY = Math.floor(position.y);
        if (!isTileSubfloor(grid, tileX, tileY, registry)) {
          dimmed = true;
        }
      }

      visible.push({ entity, depth, dimmed });
    }

    // Sort by DrawDepth (lower = behind), then by UID as tiebreaker
    visible.sort((a, b) => a.depth - b.depth || a.entity.uid - b.entity.uid);

    // Build smooth key grid with 1-tile margin for neighbor lookups
    cachedSmoothGrid = buildSmoothKeyGrid(visMinX - 1, visMinY - 1, visMaxX + 1, visMaxY + 1, registry);

    cachedVisible = visible;
    prevCameraX = camera.x;
    prevCameraY = camera.y;
    prevCameraZoom = camera.zoom;
    prevCanvasW = canvasW;
    prevCanvasH = canvasH;
    prevSubFloorMode = subFloorMode;
    prevLayers = layers;
    prevSpatialGen = curSpatialGen;
  }

  if (entitiesChanged) {
    prevEntitiesRef = entities;
  }

  const visible = cachedVisible;
  statsSetVisibleEntities(visible.length);

  // Opacity for subfloor entities dimmed by T-Ray off
  const SUBFLOOR_DIM_OPACITY = 0.3;

  // LOD: when zoomed out far, skip sprite loading and draw colored dots
  if (tileScreenSize < 6) {
    statsSetLodActive(true);
    let draws = 0;
    for (const { entity, dimmed } of visible) {
      if (dimmed) { ctx.globalAlpha = SUBFLOOR_DIM_OPACITY; }
      const tileX = Math.floor(entity.position.x);
      const tileY = Math.floor(entity.position.y);
      const screenX = camera.worldToScreenX(tileX, canvasW);
      const screenY = camera.worldToScreenY(tileY, canvasH);
      drawPlaceholder(ctx, screenX, screenY, tileScreenSize, entity.prototype, true);
      if (dimmed) { ctx.globalAlpha = 1; }
      draws++;
    }
    statsAddDrawCalls(draws);
    return;
  }
  statsSetLodActive(false);

  // Render sorted entities
  let drawCalls = 0;
  for (const { entity, dimmed } of visible) {
    const { position, rotation, prototype } = entity;

    // Dim subfloor entities when T-Ray is off
    if (dimmed) { ctx.globalAlpha = SUBFLOOR_DIM_OPACITY; }

    // Entity position is the center; subtract 0.5 to get top-left draw origin
    const screenX = camera.worldToScreenX(position.x - 0.5, canvasW);
    const screenY = camera.worldToScreenY(position.y - 0.5, canvasH);
    const tileX = Math.floor(position.x);
    const tileY = Math.floor(position.y);

    // noRot: true = don't apply canvas rotation, but DO use entity rotation for direction frame selection
    const entityNoRot = isNoRot(prototype, registry);
    const direction = rotationToDirection(rotation);

    // IconSmooth rendering (tables, carpets, walls, windows, puddles)
    // Diagonal mode entities (WallSolidDiagonal, WindowDiagonal) use a pre-rendered
    // diagonal sprite and should render as normal entities with canvas rotation.
    const smoothInfo = getSmoothInfo(prototype, registry);
    if (smoothInfo && smoothInfo.mode !== 'Diagonal') {
      // Color tinting for smooth entities
      const spriteColor = getSpriteColor(prototype, registry);
      const hasAlpha = spriteColor && spriteColor.length === 9;
      if (hasAlpha) {
        const alpha = parseInt(spriteColor!.slice(7, 9), 16) / 255;
        ctx.save();
        ctx.globalAlpha *= alpha;
      }

      if (smoothInfo.mode === 'CardinalFlags') {
        // CardinalFlags mode: single full-tile sprite selected by 4-bit cardinal bitmask (0-15)
        const mask = calculateCardinalMask(tileX, tileY, smoothInfo.key, registry, cachedSmoothGrid);
        const cardinalState = `${smoothInfo.base}${mask}`;
        const cardinalSprite = getEntitySprite(prototype, 'south', registry, cardinalState);

        if (cardinalSprite === undefined) {
          drawPlaceholder(ctx, screenX, screenY, tileScreenSize, prototype);
        } else if (cardinalSprite !== null) {
          if (spriteColor && !hasAlpha) {
            const tinted = getTintedSprite(cardinalSprite, spriteColor);
            ctx.drawImage(tinted, screenX, screenY, tileScreenSize, tileScreenSize);
          } else {
            ctx.drawImage(
              cardinalSprite.image,
              cardinalSprite.sx, cardinalSprite.sy, cardinalSprite.sw, cardinalSprite.sh,
              screenX, screenY, tileScreenSize, tileScreenSize,
            );
          }
        }
      } else {
        // Corners mode: 4 quarter-tile sprites, one per corner
        const corners = calculateCornerFills(tileX, tileY, smoothInfo.key, registry, cachedSmoothGrid);
        let allCornersLoaded = true;

        for (const corner of corners) {
          const cornerState = `${smoothInfo.base}${corner.fill}`;
          const cornerSprite = getEntitySprite(prototype, corner.direction, registry, cornerState);
          if (cornerSprite === undefined) {
            allCornersLoaded = false;
            continue;
          }
          if (cornerSprite === null) continue;

          if (spriteColor && !hasAlpha) {
            const tinted = getTintedSprite(cornerSprite, spriteColor);
            ctx.drawImage(tinted, screenX, screenY, tileScreenSize, tileScreenSize);
          } else {
            ctx.drawImage(
              cornerSprite.image,
              cornerSprite.sx, cornerSprite.sy, cornerSprite.sw, cornerSprite.sh,
              screenX, screenY, tileScreenSize, tileScreenSize,
            );
          }
        }

        if (!allCornersLoaded) {
          drawPlaceholder(ctx, screenX, screenY, tileScreenSize, prototype);
        }
      }

      if (hasAlpha) {
        ctx.restore();
      }
      continue;
    }

    // State override priority: cable connection state > entity sprite state override
    let stateOverride: string | undefined;
    const cablePrefix = getCableStatePrefix(prototype);
    if (cablePrefix) {
      const mask = getCableConnectionMask(entity);
      stateOverride = `${cablePrefix}${mask}`;
    } else if (entity.spriteStateOverride) {
      stateOverride = entity.spriteStateOverride;
    }

    const sprite = getEntitySprite(prototype, direction, registry, stateOverride);

    if (sprite === undefined || sprite === null) {
      drawPlaceholder(ctx, screenX, screenY, tileScreenSize, prototype);
      continue;
    }

    // Check if we need canvas rotation for single-direction sprites
    // noRot entities never get canvas rotation
    const needsCanvasRotation = !entityNoRot && rotation !== 0 && sprite.sh === sprite.image.height;

    if (needsCanvasRotation) {
      const cx = screenX + tileScreenSize / 2;
      const cy = screenY + tileScreenSize / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-rotation);
      ctx.translate(-cx, -cy);
    }

    // Color tinting, pipe color, layer color, or component color
    const pipeColor = getAtmosPipeColor(entity);
    const spriteColor = !pipeColor ? getSpriteColor(prototype, registry) : null;
    const tintColor = pipeColor ?? spriteColor;

    // Handle alpha from color (e.g., "#FFFFFF80" = 50% opacity)
    const hasAlpha = tintColor && tintColor.length === 9; // #RRGGBBAA format
    if (hasAlpha) {
      const alpha = parseInt(tintColor!.slice(7, 9), 16) / 255;
      ctx.save();
      ctx.globalAlpha *= alpha;
    }

    // Sprites larger than one tile (64x64 vehicles etc.) draw at their native
    // RSI size centered on the tile, matching in-game rendering, instead of
    // being squeezed into a single tile.
    const spriteRect = getCenteredSpriteRect(
      screenX, screenY, tileScreenSize, sprite.sw, sprite.sh,
    );

    const tinted = tintColor ? getTintedSprite(sprite, tintColor) : null;

    if (tinted) {
      ctx.drawImage(
        tinted,
        spriteRect.x, spriteRect.y, spriteRect.width, spriteRect.height,
      );
    } else {
      ctx.drawImage(
        sprite.image,
        sprite.sx, sprite.sy, sprite.sw, sprite.sh,
        spriteRect.x, spriteRect.y, spriteRect.width, spriteRect.height,
      );
    }

    if (hasAlpha) {
      ctx.restore();
    }

    // Draw extra sprite layers (e.g., spawner entity preview over the X marker)
    if (!cablePrefix) {
      const extraLayers = getExtraLayers(prototype, direction, registry);
      if (extraLayers) {
        for (const layerSprite of extraLayers) {
          const layerRect = getCenteredSpriteRect(
            screenX, screenY, tileScreenSize, layerSprite.sw, layerSprite.sh,
          );
          ctx.drawImage(
            layerSprite.image,
            layerSprite.sx, layerSprite.sy, layerSprite.sw, layerSprite.sh,
            layerRect.x, layerRect.y, layerRect.width, layerRect.height,
          );
        }
      }
    }

    if (needsCanvasRotation) {
      ctx.restore();
    }
    if (dimmed) { ctx.globalAlpha = 1; }
    drawCalls++;
  }
  statsAddDrawCalls(drawCalls);
}

// ---- Hit testing ----

/**
 * Find all entities at a given world tile position, sorted by DrawDepth (topmost first).
 * Uses the persistent spatial index for O(1) lookup instead of O(N) scan.
 */
export function getEntitiesAtTile(
  worldX: number,
  worldY: number,
  _entities: ImportedEntity[],
  registry: IPrototypeRegistry,
): ImportedEntity[] {
  const atTile = spatialGetAt(worldX, worldY);
  if (atTile.length === 0) return [];

  const results: { entity: ImportedEntity; depth: number }[] = [];
  for (const entity of atTile) {
    const depth = getCachedDrawDepth(entity.prototype, registry);
    results.push({ entity, depth });
  }

  // Sort topmost first (highest DrawDepth)
  results.sort((a, b) => b.depth - a.depth || b.entity.uid - a.entity.uid);
  return results.map(r => r.entity);
}
