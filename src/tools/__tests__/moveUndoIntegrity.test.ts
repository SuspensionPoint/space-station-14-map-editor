/**
 * Comprehensive move + undo integrity tests.
 *
 * Verifies that after move → undo, the ENTIRE state (entity array, spatial index,
 * tile grid) returns to exactly the initial state. Covers both EntitySelectTool
 * and SelectTool.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EntitySelectTool } from '../entitySelectTool';
import { SelectTool } from '../selectTool';
import type { ToolContext } from '../toolTypes';
import type { TileChange } from '../../types';
import { createInitialState, setCell, getCell } from '../../state/editorState';
import { editorReducer } from '../../state/editorReducer';
import type { EditorState } from '../../state/editorState';
import type { ImportedEntity } from '../../import/mapImporter';
import type { IPrototypeRegistry } from '../../loaders/registryTypes';
import type { GridData } from '../../state/gridData';
import {
  rebuildSpatialIndex,
  spatialGetAt,
  spatialGetInRect,
  spatialSize,
  spatialGetByUid,
} from '../../rendering/spatialIndex';

/** Create test state with entities/grid/containedEntities properly synced to grids[0] */
function syncGrids(state: EditorState): EditorState {
  const activeGrid = state.grids[state.activeGridIndex];
  const updated: GridData = {
    ...activeGrid,
    grid: state.grid,
    entities: state.entities,
    containedEntities: state.containedEntities,
  };
  return {
    ...state,
    grids: state.grids.map((g, i) => i === state.activeGridIndex ? updated : g),
  };
}

function makeEntity(uid: number, proto: string, x: number, y: number, rotation = 0): ImportedEntity {
  return {
    uid,
    prototype: proto,
    position: { x: x + 0.5, y: y + 0.5 },
    rotation,
    components: [{ type: 'Transform', properties: {} }],
  };
}

function makeMockRegistry(): IPrototypeRegistry {
  return {
    getTile: () => null,
    getEntity: (id) => ({
      id,
      name: id,
      description: '',
      suffix: '',
      abstract: false,
      categories: [],
      placement: {},
      components: [],
      spriteInfo: null,
      sourceCategory: 'Other',
      raw: { type: 'entity' as const, id },
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

function makeGrid(width: number, height: number, offsetX = 0, offsetY = 0) {
  const cells = new Array(width * height);
  for (let i = 0; i < cells.length; i++) cells[i] = { tileId: 'Space' };
  return { width, height, offsetX, offsetY, cells };
}

/** Snapshot entity state for comparison. */
function snapshotEntities(entities: ImportedEntity[]) {
  return entities
    .map(e => ({ uid: e.uid, proto: e.prototype, x: e.position.x, y: e.position.y, rot: e.rotation }))
    .sort((a, b) => a.uid - b.uid);
}

/** Snapshot spatial index contents for the area around test entities. */
function snapshotSpatialIndex(minX: number, minY: number, maxX: number, maxY: number) {
  const result: { uid: number; proto: string; cellKey: string }[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const entities = spatialGetAt(x, y);
      for (const e of entities) {
        result.push({ uid: e.uid, proto: e.prototype, cellKey: `${x},${y}` });
      }
    }
  }
  return result.sort((a, b) => a.uid - b.uid);
}

describe('Move + Undo Integrity', () => {
  describe('EntitySelectTool', () => {
    it('move + undo restores entity array to exact initial state', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'WallSolid', 5, 5);
      const e2 = makeEntity(2, 'APCBasic', 6, 5);
      const e3 = makeEntity(3, 'GasVentPump', 10, 10); // not moved

      rebuildSpatialIndex([e1, e2, e3]);
      let state: EditorState = syncGrids({
        ...createInitialState(),
        entities: [e1, e2, e3],
        selectedEntityUids: [1, 2],
        nextEntityId: 4,
        registry: makeMockRegistry(),
      });

      // Snapshot initial state
      const initialEntities = snapshotEntities(state.entities);
      const initialSpatial = snapshotSpatialIndex(0, 0, 20, 20);
      const initialSpatialSize = spatialSize();

      // Wire up dispatch to go through real reducer
      const ctx: ToolContext = {
        state,
        dispatch: (action: any) => {
          state = editorReducer(state, action);
          ctx.state = state;
        },
        camera: { tileScreenSize: 32 } as any,
        canvasW: 800,
        canvasH: 600,
        paletteItem: null,
        shiftHeld: false,
        ctrlHeld: false,
      };

      // Move entities from (5,5)/(6,5) to (8,8)/(9,8) via drag
      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseMove(ctx, 8, 8);
      tool.onMouseUp(ctx, 8, 8);

      // Verify move happened
      expect(state.entities.find(e => e.uid === 1)!.position).toEqual({ x: 8.5, y: 8.5 });
      expect(state.entities.find(e => e.uid === 2)!.position).toEqual({ x: 9.5, y: 8.5 });
      expect(state.entities).toHaveLength(3); // 2 moved + e3
      expect(state.undoStack).toHaveLength(1);

      // Undo
      state = editorReducer(state, { type: 'UNDO' });

      // Verify entity array matches initial state exactly
      const afterUndoEntities = snapshotEntities(state.entities);
      expect(afterUndoEntities).toEqual(initialEntities);
      expect(state.entities).toHaveLength(3);

      // Verify spatial index matches initial state exactly
      const afterUndoSpatial = snapshotSpatialIndex(0, 0, 20, 20);
      expect(afterUndoSpatial).toEqual(initialSpatial);
      expect(spatialSize()).toBe(initialSpatialSize);

      // Verify each entity is findable by UID in spatial index
      expect(spatialGetByUid(1)).toBeDefined();
      expect(spatialGetByUid(2)).toBeDefined();
      expect(spatialGetByUid(3)).toBeDefined();

      // Verify moved UIDs are NOT in spatial index
      for (let uid = 4; uid <= 10; uid++) {
        expect(spatialGetByUid(uid)).toBeUndefined();
      }

      // Verify spatialGetInRect returns correct entities
      const visibleEntities = spatialGetInRect(4, 4, 7, 7);
      const visibleUids = visibleEntities.map(e => e.uid).sort();
      expect(visibleUids).toEqual([1, 2]); // originals at (5,5) and (6,5)

      // Verify no entities at the moved-to positions
      const movedAreaEntities = spatialGetInRect(7, 7, 10, 10);
      const movedAreaUids = movedAreaEntities.map(e => e.uid).sort();
      expect(movedAreaUids).toEqual([3]); // only e3 at (10,10)
    });

    it('move + undo + redo + undo cycle preserves integrity', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'WallSolid', 5, 5);
      const e2 = makeEntity(2, 'APCBasic', 6, 5);

      rebuildSpatialIndex([e1, e2]);
      let state: EditorState = syncGrids({
        ...createInitialState(),
        entities: [e1, e2],
        selectedEntityUids: [1, 2],
        nextEntityId: 3,
        registry: makeMockRegistry(),
      });

      const initialEntities = snapshotEntities(state.entities);
      const initialSpatialSize = spatialSize();

      const ctx: ToolContext = {
        state,
        dispatch: (action: any) => {
          state = editorReducer(state, action);
          ctx.state = state;
        },
        camera: { tileScreenSize: 32 } as any,
        canvasW: 800,
        canvasH: 600,
        paletteItem: null,
        shiftHeld: false,
        ctrlHeld: false,
      };

      // Move
      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseMove(ctx, 8, 8);
      tool.onMouseUp(ctx, 8, 8);

      // Undo
      state = editorReducer(state, { type: 'UNDO' });
      expect(snapshotEntities(state.entities)).toEqual(initialEntities);
      expect(spatialSize()).toBe(initialSpatialSize);

      // Redo
      state = editorReducer(state, { type: 'REDO' });
      expect(state.entities.find(e => e.uid === 1)!.position).toEqual({ x: 8.5, y: 8.5 });
      expect(state.entities.find(e => e.uid === 2)!.position).toEqual({ x: 9.5, y: 8.5 });
      expect(state.entities).toHaveLength(2);
      expect(spatialSize()).toBe(2);

      // Undo again
      state = editorReducer(state, { type: 'UNDO' });
      expect(snapshotEntities(state.entities)).toEqual(initialEntities);
      expect(spatialSize()).toBe(initialSpatialSize);
    });

    it('multiple moves + multiple undos restore to initial state', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'WallSolid', 5, 5);

      rebuildSpatialIndex([e1]);
      let state: EditorState = syncGrids({
        ...createInitialState(),
        entities: [e1],
        selectedEntityUids: [1],
        nextEntityId: 2,
        registry: makeMockRegistry(),
      });

      const initialEntities = snapshotEntities(state.entities);

      const ctx: ToolContext = {
        state,
        dispatch: (action: any) => {
          state = editorReducer(state, action);
          ctx.state = state;
          // Update selection to track new UIDs after move
          if (action.type === 'SELECT_ENTITY') {
            state.selectedEntityUids = action.uids;
          }
        },
        camera: { tileScreenSize: 32 } as any,
        canvasW: 800,
        canvasH: 600,
        paletteItem: null,
        shiftHeld: false,
        ctrlHeld: false,
      };

      // Move #1: (5,5) → (8,8)
      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseMove(ctx, 8, 8);
      tool.onMouseUp(ctx, 8, 8);
      const afterMove1Uid = state.entities[0].uid;

      // Update selection to new UID for next move
      state = { ...state, selectedEntityUids: [afterMove1Uid] };
      ctx.state = state;

      // Move #2: (8,8) → (12,12)
      tool.onMouseDown(ctx, 8, 8, 0);
      tool.onMouseMove(ctx, 12, 12);
      tool.onMouseUp(ctx, 12, 12);

      expect(state.undoStack).toHaveLength(2);
      expect(state.entities).toHaveLength(1);

      // Undo #2
      state = editorReducer(state, { type: 'UNDO' });
      expect(state.entities).toHaveLength(1);
      expect(state.entities[0].uid).toBe(afterMove1Uid);
      expect(spatialSize()).toBe(1);

      // Undo #1
      state = editorReducer(state, { type: 'UNDO' });
      expect(snapshotEntities(state.entities)).toEqual(initialEntities);
      expect(spatialSize()).toBe(1);
      expect(spatialGetByUid(1)).toBeDefined();
    });
  });

  describe('SelectTool', () => {
    it('move + undo restores entities and tiles to exact initial state', () => {
      const tool = new SelectTool();
      const e1 = makeEntity(10, 'WallSolid', 3, 3);
      const e2 = makeEntity(11, 'DoorNormal', 4, 4);
      const e3 = makeEntity(12, 'APCBasic', 10, 10); // outside selection

      rebuildSpatialIndex([e1, e2, e3]);
      let state: EditorState = syncGrids({
        ...createInitialState(),
        grid: makeGrid(20, 20, 0, 0),
        entities: [e1, e2, e3],
        nextEntityId: 13,
        registry: makeMockRegistry(),
      });

      // Set up tiles
      setCell(state.grid, 3, 3, { tileId: 'Plating' });
      setCell(state.grid, 4, 4, { tileId: 'FloorSteel' });
      // Re-sync after direct grid mutation
      state = syncGrids(state);

      // Snapshot initial state
      const initialEntities = snapshotEntities(state.entities);
      const initialSpatialSize = spatialSize();
      const initialTile33 = { ...getCell(state.grid, 3, 3)! };
      const initialTile44 = { ...getCell(state.grid, 4, 4)! };

      const ctx: ToolContext = {
        state,
        dispatch: (action: any) => {
          state = editorReducer(state, action);
          ctx.state = state;
        },
        camera: { tileScreenSize: 32 } as any,
        canvasW: 800,
        canvasH: 600,
        paletteItem: null,
        shiftHeld: false,
        ctrlHeld: false,
      };

      // Select 3,3 to 5,5
      tool.onMouseDown(ctx, 3, 3, 0);
      tool.onMouseMove(ctx, 5, 5);
      tool.onMouseUp(ctx);

      // Move selection by (+2, +3)
      tool.onMouseDown(ctx, 4, 4, 0);
      tool.onMouseMove(ctx, 6, 7);
      tool.onMouseUp(ctx);

      // Verify move happened
      expect(state.undoStack).toHaveLength(1);
      expect(state.entities.find(e => e.uid === 10)!.position).toEqual({ x: 5.5, y: 6.5 });
      expect(state.entities.find(e => e.uid === 11)!.position).toEqual({ x: 6.5, y: 7.5 });

      // Source tiles should be Space now
      expect(getCell(state.grid, 3, 3)!.tileId).toBe('Space');
      expect(getCell(state.grid, 4, 4)!.tileId).toBe('Space');

      // Dest tiles should have the moved values
      expect(getCell(state.grid, 5, 6)!.tileId).toBe('Plating');
      expect(getCell(state.grid, 6, 7)!.tileId).toBe('FloorSteel');

      // Undo
      state = editorReducer(state, { type: 'UNDO' });

      // Verify entities restored exactly
      const afterUndoEntities = snapshotEntities(state.entities);
      expect(afterUndoEntities).toEqual(initialEntities);
      expect(state.entities).toHaveLength(3);
      expect(spatialSize()).toBe(initialSpatialSize);

      // Verify spatial index restored
      expect(spatialGetByUid(10)).toBeDefined();
      expect(spatialGetByUid(11)).toBeDefined();
      expect(spatialGetByUid(12)).toBeDefined();

      // Verify moved UIDs are NOT in spatial index
      for (let uid = 13; uid <= 20; uid++) {
        expect(spatialGetByUid(uid)).toBeUndefined();
      }

      // Verify tiles restored
      expect(getCell(state.grid, 3, 3)!.tileId).toBe(initialTile33.tileId);
      expect(getCell(state.grid, 4, 4)!.tileId).toBe(initialTile44.tileId);

      // Verify no entities at moved-to positions in spatial index
      const atMovedWall = spatialGetAt(5, 6);
      expect(atMovedWall.find(e => e.prototype === 'WallSolid')).toBeUndefined();
      const atMovedDoor = spatialGetAt(6, 7);
      expect(atMovedDoor.find(e => e.prototype === 'DoorNormal')).toBeUndefined();
    });
  });

  /**
   * React 18 StrictMode calls reducers twice with the same input state to detect
   * impure reducers. If the reducer has non-idempotent side effects on the spatial
   * index (e.g., spatialInsert called twice = duplicate cell entries), the second
   * invocation corrupts the index, causing phantom entities to render at old positions.
   *
   * These tests simulate double-invoke by calling the reducer twice with the same
   * input and verifying the spatial index is identical either way.
   */
  describe('StrictMode Double-Invoke Safety', () => {
    it('APPLY_COMMAND: double-invoke produces identical spatial index', () => {
      const e1 = makeEntity(1, 'WallSolid', 5, 5);
      const e2 = makeEntity(2, 'APCBasic', 6, 5);

      rebuildSpatialIndex([e1, e2]);
      const baseState: EditorState = syncGrids({
        ...createInitialState(),
        entities: [e1, e2],
        selectedEntityUids: [1, 2],
        nextEntityId: 3,
        registry: makeMockRegistry(),
      });

      const moveCommand = {
        label: 'Move entities',
        tileChanges: [] as TileChange[],
        entityChanges: [
          { action: 'remove' as const, entity: e1 },
          { action: 'add' as const, entity: makeEntity(3, 'WallSolid', 8, 8) },
          { action: 'remove' as const, entity: e2 },
          { action: 'add' as const, entity: makeEntity(4, 'APCBasic', 9, 8) },
        ],
      };

      // First invoke (React uses this result)
      rebuildSpatialIndex([e1, e2]); // reset to pre-dispatch state
      const result1 = editorReducer(baseState, { type: 'APPLY_COMMAND', command: moveCommand });

      // Snapshot spatial index after first invoke
      const spatialAfter1 = snapshotSpatialIndex(0, 0, 20, 20);
      const sizeAfter1 = spatialSize();

      // Second invoke (StrictMode purity check, same input state, spatial index already mutated)
      const result2 = editorReducer(baseState, { type: 'APPLY_COMMAND', command: moveCommand });

      // Spatial index must be identical after second invoke
      const spatialAfter2 = snapshotSpatialIndex(0, 0, 20, 20);
      const sizeAfter2 = spatialSize();

      expect(spatialAfter2).toEqual(spatialAfter1);
      expect(sizeAfter2).toBe(sizeAfter1);
      expect(sizeAfter2).toBe(2); // only the 2 moved entities

      // No entities at old positions
      expect(spatialGetAt(5, 5)).toHaveLength(0);
      expect(spatialGetAt(6, 5)).toHaveLength(0);

      // Entities at new positions (exactly one each, no duplicates)
      expect(spatialGetAt(8, 8)).toHaveLength(1);
      expect(spatialGetAt(9, 8)).toHaveLength(1);
    });

    it('UNDO: double-invoke produces identical spatial index', () => {
      const e1 = makeEntity(1, 'WallSolid', 5, 5);
      const e2 = makeEntity(2, 'APCBasic', 6, 5);
      const e3 = makeEntity(3, 'WallSolid', 8, 8);
      const e4 = makeEntity(4, 'APCBasic', 9, 8);

      const moveCommand = {
        label: 'Move entities',
        tileChanges: [] as TileChange[],
        entityChanges: [
          { action: 'remove' as const, entity: e1 },
          { action: 'add' as const, entity: e3 },
          { action: 'remove' as const, entity: e2 },
          { action: 'add' as const, entity: e4 },
        ],
      };

      // State after a move (entities at new positions, command on undo stack)
      rebuildSpatialIndex([e3, e4]);
      const postMoveState: EditorState = syncGrids({
        ...createInitialState(),
        entities: [e3, e4],
        nextEntityId: 5,
        undoStack: [moveCommand],
        registry: makeMockRegistry(),
      });

      // First UNDO invoke
      rebuildSpatialIndex([e3, e4]); // reset
      const result1 = editorReducer(postMoveState, { type: 'UNDO' });

      const spatialAfter1 = snapshotSpatialIndex(0, 0, 20, 20);
      const sizeAfter1 = spatialSize();

      // Second UNDO invoke (StrictMode double-invoke, same input, spatial already mutated)
      const result2 = editorReducer(postMoveState, { type: 'UNDO' });

      const spatialAfter2 = snapshotSpatialIndex(0, 0, 20, 20);
      const sizeAfter2 = spatialSize();

      expect(spatialAfter2).toEqual(spatialAfter1);
      expect(sizeAfter2).toBe(sizeAfter1);
      expect(sizeAfter2).toBe(2); // only the 2 restored entities

      // Entities restored to original positions (exactly one each)
      expect(spatialGetAt(5, 5)).toHaveLength(1);
      expect(spatialGetAt(6, 5)).toHaveLength(1);

      // No entities at moved-to positions
      expect(spatialGetAt(8, 8)).toHaveLength(0);
      expect(spatialGetAt(9, 8)).toHaveLength(0);
    });

    it('REDO: double-invoke produces identical spatial index', () => {
      const e1 = makeEntity(1, 'WallSolid', 5, 5);
      const e2 = makeEntity(2, 'APCBasic', 6, 5);
      const e3 = makeEntity(3, 'WallSolid', 8, 8);
      const e4 = makeEntity(4, 'APCBasic', 9, 8);

      const moveCommand = {
        label: 'Move entities',
        tileChanges: [] as TileChange[],
        entityChanges: [
          { action: 'remove' as const, entity: e1 },
          { action: 'add' as const, entity: e3 },
          { action: 'remove' as const, entity: e2 },
          { action: 'add' as const, entity: e4 },
        ],
      };

      // State after undo (originals restored, command on redo stack)
      rebuildSpatialIndex([e1, e2]);
      const postUndoState: EditorState = syncGrids({
        ...createInitialState(),
        entities: [e1, e2],
        nextEntityId: 5,
        redoStack: [moveCommand],
        registry: makeMockRegistry(),
      });

      // First REDO invoke
      rebuildSpatialIndex([e1, e2]); // reset
      editorReducer(postUndoState, { type: 'REDO' });
      const spatialAfter1 = snapshotSpatialIndex(0, 0, 20, 20);
      const sizeAfter1 = spatialSize();

      // Second REDO invoke (double-invoke)
      editorReducer(postUndoState, { type: 'REDO' });
      const spatialAfter2 = snapshotSpatialIndex(0, 0, 20, 20);
      const sizeAfter2 = spatialSize();

      expect(spatialAfter2).toEqual(spatialAfter1);
      expect(sizeAfter2).toBe(sizeAfter1);
      expect(sizeAfter2).toBe(2);

      // Moved entities at new positions, no duplicates
      expect(spatialGetAt(8, 8)).toHaveLength(1);
      expect(spatialGetAt(9, 8)).toHaveLength(1);
      expect(spatialGetAt(5, 5)).toHaveLength(0);
      expect(spatialGetAt(6, 5)).toHaveLength(0);
    });

    it('repeated moves: double-invoke does not accumulate orphans (stamping bug)', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'WallSolid', 5, 5);

      rebuildSpatialIndex([e1]);
      let state: EditorState = syncGrids({
        ...createInitialState(),
        entities: [e1],
        selectedEntityUids: [1],
        nextEntityId: 2,
        registry: makeMockRegistry(),
      });

      // Simulate dispatch that calls reducer TWICE (like StrictMode)
      const ctx: ToolContext = {
        state,
        dispatch: (action: any) => {
          // First invoke
          const result1 = editorReducer(state, action);
          // Second invoke (StrictMode), same input state, spatial already mutated
          const result2 = editorReducer(state, action);
          // React uses second result
          state = result2;
          ctx.state = state;
        },
        camera: { tileScreenSize: 32 } as any,
        canvasW: 800,
        canvasH: 600,
        paletteItem: null,
        shiftHeld: false,
        ctrlHeld: false,
      };

      // Move #1
      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseMove(ctx, 8, 8);
      tool.onMouseUp(ctx, 8, 8);

      // After move: exactly 1 entity, no orphans
      expect(spatialSize()).toBe(1);
      const allAfterMove1 = spatialGetInRect(-100, -100, 100, 100);
      expect(allAfterMove1).toHaveLength(1);

      // Update selection for next move
      const movedUid = state.entities[0].uid;
      state = { ...state, selectedEntityUids: [movedUid] };
      ctx.state = state;

      // Move #2 (the "stamping" scenario)
      tool.onMouseDown(ctx, 8, 8, 0);
      tool.onMouseMove(ctx, 12, 12);
      tool.onMouseUp(ctx, 12, 12);

      // After move #2: still exactly 1 entity
      expect(spatialSize()).toBe(1);
      const allAfterMove2 = spatialGetInRect(-100, -100, 100, 100);
      expect(allAfterMove2).toHaveLength(1);

      // No orphans at any previous position
      expect(spatialGetAt(5, 5)).toHaveLength(0);
      expect(spatialGetAt(8, 8)).toHaveLength(0);
    });
  });

  describe('Spatial Index Cell Integrity', () => {
    it('no orphaned entities in spatial index cells after move+undo', () => {
      const tool = new EntitySelectTool();
      const entities = [
        makeEntity(1, 'WallSolid', 5, 5),
        makeEntity(2, 'APCBasic', 6, 5),
        makeEntity(3, 'GasVentPump', 7, 5),
      ];

      rebuildSpatialIndex(entities);
      let state: EditorState = syncGrids({
        ...createInitialState(),
        entities: [...entities],
        selectedEntityUids: [1, 2, 3],
        nextEntityId: 4,
        registry: makeMockRegistry(),
      });

      const ctx: ToolContext = {
        state,
        dispatch: (action: any) => {
          state = editorReducer(state, action);
          ctx.state = state;
        },
        camera: { tileScreenSize: 32 } as any,
        canvasW: 800,
        canvasH: 600,
        paletteItem: null,
        shiftHeld: false,
        ctrlHeld: false,
      };

      // Move all 3 entities
      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseMove(ctx, 15, 15);
      tool.onMouseUp(ctx, 15, 15);

      // Undo
      state = editorReducer(state, { type: 'UNDO' });

      // Comprehensive cell scan: collect ALL entities from ALL cells
      const allCellEntities = spatialGetInRect(-100, -100, 100, 100);
      const cellUids = allCellEntities.map(e => e.uid).sort();
      const arrayUids = state.entities.map(e => e.uid).sort();

      // Must match exactly, no orphans
      expect(cellUids).toEqual(arrayUids);
      expect(spatialSize()).toBe(state.entities.length);

      // Verify each entity's cell position matches its actual position
      for (const entity of state.entities) {
        const tileX = Math.floor(entity.position.x);
        const tileY = Math.floor(entity.position.y);
        const atTile = spatialGetAt(tileX, tileY);
        expect(atTile.find(e => e.uid === entity.uid)).toBeDefined();
      }
    });
  });
});
