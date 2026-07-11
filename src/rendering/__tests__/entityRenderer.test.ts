import { describe, it, expect, beforeEach } from 'vitest';
import { Camera } from '../camera';
import {
  calculateCornerFills, calculateCardinalMask,
  clearCornerFillCache, clearCardinalMaskCache,
  clearSmoothInfoCache,
  buildSmoothKeyGrid,
  getTintedCacheSize, TINTED_CACHE_MAX,
  clearPipeColorCache,
  getPrototypeFlags, clearPrototypeFlags,
  hasSubFloorHide,
  hasCableConnectionAt,
  getCenteredSpriteRect,
} from '../entityRenderer';
import { rebuildSpatialIndex, clearSpatialIndex, spatialGeneration, tileKey } from '../spatialIndex';
import type { ImportedEntity } from '../../import/mapImporter';
import type { IPrototypeRegistry } from '../../loaders/registryTypes';

describe('entity fractional position rendering', () => {
  it('camera produces different screen positions for fractional vs floored coordinates', () => {
    const camera = new Camera();
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    const canvasW = 800;
    const canvasH = 600;

    const fractionalX = 5.3;
    const fractionalY = 7.8;
    const flooredX = Math.floor(fractionalX); // 5
    const flooredY = Math.floor(fractionalY); // 7

    const screenFracX = camera.worldToScreenX(fractionalX, canvasW);
    const screenFloorX = camera.worldToScreenX(flooredX, canvasW);
    const screenFracY = camera.worldToScreenY(fractionalY, canvasH);
    const screenFloorY = camera.worldToScreenY(flooredY, canvasH);

    expect(screenFracX).not.toBe(screenFloorX);
    expect(screenFracY).not.toBe(screenFloorY);
  });

  it('pixel offset matches expected fractional tile difference', () => {
    const camera = new Camera();
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 2;
    const canvasW = 800;
    const canvasH = 600;
    const TILE_SIZE = 32;

    const fractionalX = 5.3;
    const fractionalY = 7.8;

    const screenFracX = camera.worldToScreenX(fractionalX, canvasW);
    const screenFloorX = camera.worldToScreenX(Math.floor(fractionalX), canvasW);
    const screenFracY = camera.worldToScreenY(fractionalY, canvasH);
    const screenFloorY = camera.worldToScreenY(Math.floor(fractionalY), canvasH);

    // X offset: 0.3 tiles * 32px * zoom=2 = 19.2px
    const expectedOffsetX = 0.3 * TILE_SIZE * camera.zoom;
    expect(screenFracX - screenFloorX).toBeCloseTo(expectedOffsetX, 5);

    // Y offset: 0.8 tiles * 32px * zoom=2 = 51.2px (negative because Y is inverted)
    const expectedOffsetY = 0.8 * TILE_SIZE * camera.zoom;
    expect(screenFloorY - screenFracY).toBeCloseTo(expectedOffsetY, 5);
  });
});

describe('entity draw position (center to top-left conversion)', () => {
  it('tile-center entity (5.5, 7.5) draws at same position as old Math.floor behavior', () => {
    const camera = new Camera();
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    const canvasW = 800;
    const canvasH = 600;

    // Old code: floor(5.5)=5, worldToScreenX(5) → top-left of tile 5
    // New code: worldToScreenX(5.5 - 0.5) = worldToScreenX(5.0) → same result
    const oldScreenX = camera.worldToScreenX(Math.floor(5.5), canvasW);
    const newScreenX = camera.worldToScreenX(5.5 - 0.5, canvasW);
    expect(newScreenX).toBe(oldScreenX);

    const oldScreenY = camera.worldToScreenY(Math.floor(7.5), canvasH);
    const newScreenY = camera.worldToScreenY(7.5 - 0.5, canvasH);
    expect(newScreenY).toBe(oldScreenY);
  });

  it('fractional entity (5.3, 7.8) draws offset from tile center', () => {
    const camera = new Camera();
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 2;
    const canvasW = 800;
    const canvasH = 600;

    // Entity at (5.3, 7.8): draw origin at (4.8, 7.3)
    // vs tile-center entity (5.5, 7.5): draw origin at (5.0, 7.0)
    const fractionalDrawX = camera.worldToScreenX(5.3 - 0.5, canvasW);
    const centerDrawX = camera.worldToScreenX(5.5 - 0.5, canvasW);
    // Difference: (4.8 - 5.0) = -0.2 tiles = -12.8px at zoom 2
    expect(fractionalDrawX - centerDrawX).toBeCloseTo(-0.2 * 32 * 2, 5);
  });
});

describe('natural sprite sizing', () => {
  it('keeps a 32x32 sprite aligned to one tile', () => {
    expect(getCenteredSpriteRect(160, 320, 32, 32, 32)).toEqual({
      x: 160,
      y: 320,
      width: 32,
      height: 32,
    });
  });

  it('centers a 64x64 sprite across two tiles', () => {
    expect(getCenteredSpriteRect(160, 320, 32, 64, 64)).toEqual({
      x: 144,
      y: 304,
      width: 64,
      height: 64,
    });
  });

  it('preserves non-square sprite dimensions', () => {
    expect(getCenteredSpriteRect(160, 320, 64, 64, 96)).toEqual({
      x: 128,
      y: 256,
      width: 128,
      height: 192,
    });
  });
});

// ---- Corner fill / cardinal mask caching tests ----

function makeWallEntity(uid: number, x: number, y: number): ImportedEntity {
  return {
    uid,
    prototype: 'WallSolid',
    position: { x: x + 0.5, y: y + 0.5 },
    rotation: 0,
    components: [],
  };
}

/** Minimal mock registry that returns smooth info for WallSolid prototypes. */
function makeSmoothRegistry(): IPrototypeRegistry {
  return {
    getTile: () => null,
    getEntity: () => null,
    getAllTiles: () => [],
    getAllEntities: () => [],
    getEntitiesByCategory: () => [],
    getCategories: () => [],
    getSpriteInfo: (id: string) => {
      if (id === 'WallSolid') {
        return {
          rsiPath: 'Structures/Walls/solid.rsi',
          baseState: 'state_',
          iconSmoothKey: 'walls',
          iconSmoothBase: 'state_',
          iconSmoothMode: 'Corners' as const,
          layers: [{ state: 'state_0' }],
        };
      }
      return null;
    },
    tileCount: 0,
    entityCount: 0,
    getDecal: () => null,
    getAllDecals: () => [],
    decalCount: 0,
  };
}

describe('calculateCornerFills cache', () => {
  beforeEach(() => {
    clearSpatialIndex();
    clearCornerFillCache();
    clearCardinalMaskCache();
    clearSmoothInfoCache();
  });

  it('returns cached result for same position and generation', () => {
    const registry = makeSmoothRegistry();
    // Place a wall at (5,5) with neighbors N and E
    const entities = [
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6), // north neighbor
      makeWallEntity(3, 6, 5), // east neighbor
    ];
    rebuildSpatialIndex(entities);

    const result1 = calculateCornerFills(5, 5, 'walls', registry);
    const result2 = calculateCornerFills(5, 5, 'walls', registry);

    // Should return the exact same array reference (cached)
    expect(result2).toBe(result1);
  });

  it('invalidates cache when spatial generation changes', () => {
    const registry = makeSmoothRegistry();
    const entities = [
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6), // north
    ];
    rebuildSpatialIndex(entities);

    const result1 = calculateCornerFills(5, 5, 'walls', registry);
    const gen1 = spatialGeneration();

    // Rebuild bumps generation
    rebuildSpatialIndex([
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6),
      makeWallEntity(3, 6, 5), // added east neighbor
    ]);
    expect(spatialGeneration()).toBeGreaterThan(gen1);

    const result2 = calculateCornerFills(5, 5, 'walls', registry);
    // Should NOT be the same reference (cache invalidated)
    expect(result2).not.toBe(result1);

    // NE corner fill should now include E neighbor
    const neCorner = result2.find(c => c.direction === 'east')!;
    // NE: N=CCW(1), E=CW(4) → fill should have bits 1 and 4 = 5
    expect(neCorner.fill).toBe(5);
  });

  it('returns correct corner fills for isolated entity', () => {
    const registry = makeSmoothRegistry();
    rebuildSpatialIndex([makeWallEntity(1, 5, 5)]);

    const fills = calculateCornerFills(5, 5, 'walls', registry);
    // No neighbors → all fills should be 0
    for (const corner of fills) {
      expect(corner.fill).toBe(0);
    }
  });
});

describe('calculateCardinalMask cache', () => {
  beforeEach(() => {
    clearSpatialIndex();
    clearCornerFillCache();
    clearCardinalMaskCache();
    clearSmoothInfoCache();
  });

  it('returns cached result for same position and generation', () => {
    const registry = makeSmoothRegistry();
    const entities = [
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6), // north
    ];
    rebuildSpatialIndex(entities);

    const result1 = calculateCardinalMask(5, 5, 'walls', registry);
    const result2 = calculateCardinalMask(5, 5, 'walls', registry);

    expect(result2).toBe(result1);
    // N=1 bit set
    expect(result1).toBe(1);
  });

  it('invalidates cache when spatial generation changes', () => {
    const registry = makeSmoothRegistry();
    rebuildSpatialIndex([
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6), // north
    ]);

    const mask1 = calculateCardinalMask(5, 5, 'walls', registry);
    expect(mask1).toBe(1); // N only

    // Add east neighbor
    rebuildSpatialIndex([
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6),
      makeWallEntity(3, 6, 5), // east
    ]);

    const mask2 = calculateCardinalMask(5, 5, 'walls', registry);
    expect(mask2).toBe(5); // N(1) + E(4) = 5
  });

  it('returns 0 for isolated entity', () => {
    const registry = makeSmoothRegistry();
    rebuildSpatialIndex([makeWallEntity(1, 5, 5)]);

    expect(calculateCardinalMask(5, 5, 'walls', registry)).toBe(0);
  });

  it('returns 15 for fully surrounded entity', () => {
    const registry = makeSmoothRegistry();
    rebuildSpatialIndex([
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6), // N
      makeWallEntity(3, 5, 4), // S
      makeWallEntity(4, 6, 5), // E
      makeWallEntity(5, 4, 5), // W
    ]);

    expect(calculateCardinalMask(5, 5, 'walls', registry)).toBe(15);
  });
});

describe('smooth key grid batch lookup', () => {
  beforeEach(() => {
    clearSpatialIndex();
    clearCornerFillCache();
    clearCardinalMaskCache();
    clearSmoothInfoCache();
  });

  it('buildSmoothKeyGrid identifies tiles with smooth entities', () => {
    const registry = makeSmoothRegistry();
    rebuildSpatialIndex([
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6),
    ]);
    const grid = buildSmoothKeyGrid(0, 0, 10, 10, registry);
    expect(grid.get(tileKey(5, 5))).toBe('walls');
    expect(grid.get(tileKey(5, 6))).toBe('walls');
    expect(grid.has(tileKey(3, 3))).toBe(false);
  });

  it('calculateCornerFills with grid matches without grid', () => {
    const registry = makeSmoothRegistry();
    const entities = [
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6), // N
      makeWallEntity(3, 6, 5), // E
      makeWallEntity(4, 6, 6), // NE diagonal
    ];
    rebuildSpatialIndex(entities);

    // Without grid
    const fillsNoGrid = calculateCornerFills(5, 5, 'walls', registry);

    // Clear cache so grid version recalculates
    clearCornerFillCache();

    // With grid
    const grid = buildSmoothKeyGrid(3, 3, 8, 8, registry);
    const fillsWithGrid = calculateCornerFills(5, 5, 'walls', registry, grid);

    // Results should match
    expect(fillsWithGrid.map(f => ({ fill: f.fill, direction: f.direction })))
      .toEqual(fillsNoGrid.map(f => ({ fill: f.fill, direction: f.direction })));
  });

  it('calculateCardinalMask with grid matches without grid', () => {
    const registry = makeSmoothRegistry();
    rebuildSpatialIndex([
      makeWallEntity(1, 5, 5),
      makeWallEntity(2, 5, 6), // N
      makeWallEntity(3, 6, 5), // E
    ]);

    const maskNoGrid = calculateCardinalMask(5, 5, 'walls', registry);
    clearCardinalMaskCache();

    const grid = buildSmoothKeyGrid(3, 3, 8, 8, registry);
    const maskWithGrid = calculateCardinalMask(5, 5, 'walls', registry, grid);

    expect(maskWithGrid).toBe(maskNoGrid);
    expect(maskWithGrid).toBe(5); // N(1) + E(4)
  });
});

describe('tinted sprite cache LRU eviction', () => {
  it('exports TINTED_CACHE_MAX as 512', () => {
    expect(TINTED_CACHE_MAX).toBe(512);
  });

  it('getTintedCacheSize returns current cache size', () => {
    clearPipeColorCache(); // clears tintedSpriteCache too
    expect(getTintedCacheSize()).toBe(0);
  });
});

describe('prototype flag cache', () => {
  beforeEach(() => clearPrototypeFlags());

  it('identifies marker prototypes', () => {
    expect(getPrototypeFlags('SpawnPointLatejoin').isMarker).toBe(true);
    expect(getPrototypeFlags('RandomSpawner').isMarker).toBe(true);
    expect(getPrototypeFlags('MarkerBase').isMarker).toBe(true);
  });

  it('identifies non-marker prototypes', () => {
    expect(getPrototypeFlags('TableWood').isMarker).toBe(false);
    expect(getPrototypeFlags('WallSolid').isMarker).toBe(false);
  });

  it('identifies cable prototypes', () => {
    expect(getPrototypeFlags('CableHV').placeholderCategory).toBe('cable');
    expect(getPrototypeFlags('CableMV').placeholderCategory).toBe('cable');
    expect(getPrototypeFlags('CableApcExtension').placeholderCategory).toBe('cable');
  });

  it('identifies pipe prototypes', () => {
    expect(getPrototypeFlags('GasPipeHalf').placeholderCategory).toBe('pipe');
    expect(getPrototypeFlags('GasVentPump').placeholderCategory).toBe('pipe');
  });

  it('identifies spawn placeholders', () => {
    expect(getPrototypeFlags('SpawnPointLatejoin').placeholderCategory).toBe('spawn');
    expect(getPrototypeFlags('MarkerBase').placeholderCategory).toBe('spawn');
    expect(getPrototypeFlags('RandomSpawner').placeholderCategory).toBe('spawn');
  });

  it('defaults to generic for unknown prototype', () => {
    expect(getPrototypeFlags('TableWood').placeholderCategory).toBe('generic');
  });

  it('caches results (same reference on second call)', () => {
    const flags1 = getPrototypeFlags('WallSolid');
    const flags2 = getPrototypeFlags('WallSolid');
    expect(flags2).toBe(flags1);
  });

  it('handles multi-keyword prototypes correctly', () => {
    // Contains both "Spawn" and "Marker", should still be marker+spawn
    expect(getPrototypeFlags('SpawnMarkerTest').isMarker).toBe(true);
    expect(getPrototypeFlags('SpawnMarkerTest').placeholderCategory).toBe('spawn');
  });

  it('handles prototypes with partial keyword matches', () => {
    // "GasPipeStraight" contains both "Gas" and "Pipe"
    expect(getPrototypeFlags('GasPipeStraight').placeholderCategory).toBe('pipe');
    // "CableTerminal" contains "Cable"
    expect(getPrototypeFlags('CableTerminal').placeholderCategory).toBe('cable');
  });

  it('is case-sensitive (matching SS14 prototype naming)', () => {
    // Lowercase versions should NOT match
    expect(getPrototypeFlags('spawnpoint').isMarker).toBe(false);
    expect(getPrototypeFlags('cablehv').placeholderCategory).toBe('generic');
    expect(getPrototypeFlags('gaspipe').placeholderCategory).toBe('generic');
  });
});

describe('hasSubFloorHide', () => {
  function makeRegistry(components: { type: string }[]): IPrototypeRegistry {
    return {
      getTile: () => null,
      getEntity: () => ({
        id: 'test', name: 'test', description: '', suffix: '', abstract: false,
        categories: [], placement: {}, components,
        spriteInfo: null, sourceCategory: 'Other',
        raw: { type: 'entity' as const, id: 'test' },
      }),
      getAllTiles: () => [],
      getAllEntities: () => [],
      getEntitiesByCategory: () => [],
      getCategories: () => [],
      getSpriteInfo: () => null,
      tileCount: 0,
      entityCount: 0,
      getDecal: () => null,
      getAllDecals: () => [],
      decalCount: 0,
    };
  }

  it('returns true for Cable-prefixed prototypes', () => {
    const reg = makeRegistry([]);
    expect(hasSubFloorHide('CableHV', reg)).toBe(true);
    expect(hasSubFloorHide('CableMV', reg)).toBe(true);
    expect(hasSubFloorHide('CableApcExtension', reg)).toBe(true);
  });

  it('returns true for GasPipe-prefixed prototypes', () => {
    const reg = makeRegistry([]);
    expect(hasSubFloorHide('GasPipeStraight', reg)).toBe(true);
    expect(hasSubFloorHide('GasPipeBend', reg)).toBe(true);
  });

  it('returns true for DisposalPipe-prefixed prototypes', () => {
    const reg = makeRegistry([]);
    expect(hasSubFloorHide('DisposalPipe', reg)).toBe(true);
    expect(hasSubFloorHide('DisposalJunction', reg)).toBe(true);
    expect(hasSubFloorHide('DisposalBend', reg)).toBe(true);
  });

  it('returns true for entities with SubFloorHide component', () => {
    const reg = makeRegistry([{ type: 'SubFloorHide' }]);
    expect(hasSubFloorHide('GasVentPump', reg)).toBe(true);
  });

  it('returns false for entities without SubFloorHide and non-matching prefix', () => {
    const reg = makeRegistry([{ type: 'Sprite' }, { type: 'Transform' }]);
    expect(hasSubFloorHide('TableWood', reg)).toBe(false);
    expect(hasSubFloorHide('APCBasic', reg)).toBe(false);
  });
});

describe('hasCableConnectionAt (CableTerminal support)', () => {
  function makeEntity(uid: number, proto: string, x: number, y: number): ImportedEntity {
    return { uid, prototype: proto, position: { x: x + 0.5, y: y + 0.5 }, rotation: 0, components: [] };
  }

  it('matches same cable prototype at tile', () => {
    rebuildSpatialIndex([makeEntity(1, 'CableHV', 5, 5)]);
    expect(hasCableConnectionAt(5, 5, 'CableHV')).toBe(true);
  });

  it('does not match different cable prototype', () => {
    rebuildSpatialIndex([makeEntity(1, 'CableMV', 5, 5)]);
    expect(hasCableConnectionAt(5, 5, 'CableHV')).toBe(false);
  });

  it('CableTerminal connects to CableHV', () => {
    rebuildSpatialIndex([makeEntity(1, 'CableTerminal', 5, 5)]);
    expect(hasCableConnectionAt(5, 5, 'CableHV')).toBe(true);
  });

  it('CableTerminal connects to CableMV', () => {
    rebuildSpatialIndex([makeEntity(1, 'CableTerminal', 5, 5)]);
    expect(hasCableConnectionAt(5, 5, 'CableMV')).toBe(true);
  });

  it('CableTerminal does NOT connect to CableApcExtension (LV)', () => {
    rebuildSpatialIndex([makeEntity(1, 'CableTerminal', 5, 5)]);
    expect(hasCableConnectionAt(5, 5, 'CableApcExtension')).toBe(false);
  });

  it('CableTerminalUncuttable also connects to CableHV', () => {
    rebuildSpatialIndex([makeEntity(1, 'CableTerminalUncuttable', 5, 5)]);
    expect(hasCableConnectionAt(5, 5, 'CableHV')).toBe(true);
  });

  it('returns false for empty tile', () => {
    rebuildSpatialIndex([]);
    expect(hasCableConnectionAt(5, 5, 'CableHV')).toBe(false);
  });

  it('returns false for non-cable entities', () => {
    rebuildSpatialIndex([makeEntity(1, 'SMESBasic', 5, 5)]);
    expect(hasCableConnectionAt(5, 5, 'CableHV')).toBe(false);
  });
});
