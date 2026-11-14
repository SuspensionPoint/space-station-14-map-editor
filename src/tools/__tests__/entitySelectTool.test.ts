import { describe, it, expect, beforeEach } from 'vitest';
import { EntitySelectTool } from '../entitySelectTool';
import type { ToolContext } from '../toolTypes';
import { createInitialState } from '../../state/editorState';
import { editorReducer } from '../../state/editorReducer';
import type { EditorState } from '../../state/editorState';
import type { ImportedEntity } from '../../import/mapImporter';
import type { EntityChange, DecalChange } from '../../types';
import type { DecalInstance } from '../../import/decalParser';
import type { IPrototypeRegistry } from '../../loaders/registryTypes';
import type { LayerVisibility } from '../../rendering/entityRenderer';
import { DEFAULT_LAYER_VISIBILITY, clearDrawDepthCache } from '../../rendering/entityRenderer';
import { rebuildSpatialIndex, spatialInsert, spatialRemove } from '../../rendering/spatialIndex';
import { setClipboard, getClipboard } from '../../state/clipboard';

function makeEntity(uid: number, proto: string, x: number, y: number, rotation = 0): ImportedEntity {
  return { uid, prototype: proto, position: { x: x + 0.5, y: y + 0.5 }, rotation, components: [] };
}

function makeDecal(id: number, protoId: string, x: number, y: number): DecalInstance {
  return { id, prototypeId: protoId, position: { x: x + 0.5, y: y + 0.5 }, color: null, angle: 0, zIndex: 0, cleanable: false };
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
    getSpriteInfo: (id: string) => {
      // Return appropriate drawDepth for layer filtering tests
      if (id.includes('Wall') || id.includes('Window')) return { rsiPath: 'test.rsi', baseState: 'base', layers: [], drawDepth: 'WallTops' } as any;
      if (id.includes('Cable') || id.includes('Pipe')) return { rsiPath: 'test.rsi', baseState: 'base', layers: [], drawDepth: 'ThickPipe' } as any;
      if (id.includes('Airlock') || id.includes('Door')) return { rsiPath: 'test.rsi', baseState: 'base', layers: [], drawDepth: 'Doors' } as any;
      return null;
    },
    tileCount: 0,
    entityCount: 0,
    getDecal: () => null,
    getAllDecals: () => [],
    decalCount: 0,
  };
}

function makeToolContext(
  entities: ImportedEntity[],
  selectedUids: number[] = [],
  opts?: { decals?: DecalInstance[]; selectedDecalIds?: number[]; layerVisibility?: LayerVisibility },
): { ctx: ToolContext; dispatched: any[] } {
  rebuildSpatialIndex(entities);
  const dispatched: any[] = [];
  const state: any = {
    ...createInitialState(),
    entities,
    selectedEntityUids: selectedUids,
    selectedDecalIds: opts?.selectedDecalIds ?? [],
    registry: makeMockRegistry(),
  };
  // Inject decals into active grid
  if (opts?.decals) {
    state.grids[0].decals = {
      decals: [...opts.decals],
      nextDecalId: Math.max(0, ...opts.decals.map(d => d.id)) + 1,
    };
  }
  const ctx: ToolContext = {
    state,
    dispatch: (action: any) => {
      dispatched.push(action);
      if (action.type === 'SELECT_ENTITY') {
        state.selectedEntityUids = action.uids;
      }
      if (action.type === 'SELECT_DECAL') {
        state.selectedDecalIds = action.ids;
      }
      if (action.type === 'TOGGLE_SELECT_ENTITY') {
        const idx = state.selectedEntityUids.indexOf(action.uid);
        if (idx >= 0) {
          state.selectedEntityUids = state.selectedEntityUids.filter((u: number) => u !== action.uid);
        } else {
          state.selectedEntityUids = [...state.selectedEntityUids, action.uid];
        }
      }
      if (action.type === 'TOGGLE_SELECT_DECAL') {
        const idx = state.selectedDecalIds.indexOf(action.id);
        if (idx >= 0) {
          state.selectedDecalIds = state.selectedDecalIds.filter((id: number) => id !== action.id);
        } else {
          state.selectedDecalIds = [...state.selectedDecalIds, action.id];
        }
      }
      if (action.type === 'ADD_SELECT_ENTITIES') {
        state.selectedEntityUids = [
          ...state.selectedEntityUids,
          ...action.uids.filter((u: number) => !state.selectedEntityUids.includes(u)),
        ];
      }
      if (action.type === 'ADD_SELECT_DECALS') {
        state.selectedDecalIds = [
          ...state.selectedDecalIds,
          ...action.ids.filter((id: number) => !state.selectedDecalIds.includes(id)),
        ];
      }
      if (action.type === 'REMOVE_SELECT_DECALS') {
        const removeSet = new Set(action.ids);
        state.selectedDecalIds = state.selectedDecalIds.filter((id: number) => !removeSet.has(id));
      }
      if (action.type === 'APPLY_COMMAND') {
        for (const ec of action.command.entityChanges) {
          if (ec.action === 'remove') {
            const idx = state.entities.findIndex((e: any) => e.uid === ec.entity.uid);
            if (idx >= 0) state.entities.splice(idx, 1);
            spatialRemove(ec.entity.uid);
          }
          if (ec.action === 'add') {
            state.entities.push(ec.entity);
            spatialInsert(ec.entity);
          }
        }
        // Apply decal changes
        if (action.command.decalChanges) {
          for (const dc of action.command.decalChanges) {
            const grid = state.grids[state.activeGridIndex];
            if (dc.action === 'remove') {
              grid.decals.decals = grid.decals.decals.filter((d: any) => d.id !== dc.decal.id);
            }
            if (dc.action === 'add') {
              grid.decals.decals.push(dc.decal);
            }
            if (dc.action === 'update') {
              const idx = grid.decals.decals.findIndex((d: any) => d.id === dc.decal.id);
              if (idx >= 0) grid.decals.decals[idx] = dc.decal;
            }
          }
        }
      }
    },
    camera: { tileScreenSize: 32 } as any,
    canvasW: 800,
    canvasH: 600,
    paletteItem: null,
    shiftHeld: false,
    ctrlHeld: false,
    layerVisibility: opts?.layerVisibility,
  };
  return { ctx, dispatched };
}

describe('EntitySelectTool', () => {
  it('selects topmost entity on left click', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const { ctx, dispatched } = makeToolContext([e1, e2]);

    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseUp(ctx, 5, 5);

    // Click on entity: first clears selection, then selects on mouse-up
    const selectAction = dispatched.filter(a => a.type === 'SELECT_ENTITY').pop();
    expect(selectAction).toBeDefined();
    expect(selectAction.uids).toHaveLength(1);
  });

  it('deselects on right click', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const { ctx, dispatched } = makeToolContext([e1]);

    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseUp(ctx, 5, 5);
    tool.onMouseDown(ctx, 5, 5, 2);

    const deselectAction = dispatched.filter(a => a.type === 'SELECT_ENTITY').pop();
    expect(deselectAction?.uids).toEqual([]);
  });

  it('deselects on click in empty space', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const { ctx, dispatched } = makeToolContext([e1]);

    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseUp(ctx, 5, 5);

    tool.onMouseDown(ctx, 10, 10, 0);
    tool.onMouseUp(ctx, 10, 10);

    // First deselects (empty space clears), then starts box select
    const lastSelect = dispatched.filter(a => a.type === 'SELECT_ENTITY').pop();
    expect(lastSelect?.uids).toEqual([]);
  });

  it('moves entity via drag (must be selected first)', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const { ctx, dispatched } = makeToolContext([e1]);

    // First click to select the entity
    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseUp(ctx, 5, 5);

    // Now click+drag the selected entity to move it
    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseMove(ctx, 7, 8);
    tool.onMouseUp(ctx, 7, 8);

    const moveCmd = dispatched.find(a =>
      a.type === 'APPLY_COMMAND' && a.command.label.includes('Move'),
    );
    expect(moveCmd).toBeDefined();
    const addedEntity = moveCmd.command.entityChanges.find((ec: any) => ec.action === 'add');
    expect(addedEntity.entity.position.x).toBeCloseTo(7.5);
    expect(addedEntity.entity.position.y).toBeCloseTo(8.5);
  });

  it('box-selects when dragging from an unselected entity', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 7, 7);
    const { ctx, dispatched } = makeToolContext([e1, e2]);

    // Click on entity at (5,5) and drag to (8,8), should box-select, not move
    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseMove(ctx, 8, 8);
    tool.onMouseUp(ctx, 8, 8);

    // Should NOT have a Move command
    const moveCmd = dispatched.find(a =>
      a.type === 'APPLY_COMMAND' && a.command.label.includes('Move'),
    );
    expect(moveCmd).toBeUndefined();

    // Should have selected both entities via box select
    const selectAction = dispatched.filter(a => a.type === 'SELECT_ENTITY').pop();
    expect(selectAction).toBeDefined();
    expect(selectAction.uids).toContain(1);
    expect(selectAction.uids).toContain(2);
  });

  it('rotates selected entities CW (default)', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 5, 5);
    const { ctx, dispatched } = makeToolContext([e1]);

    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseUp(ctx, 5, 5);
    tool.rotateSelected(ctx, 'cw');

    const rotateCmd = dispatched.find(a =>
      a.type === 'APPLY_COMMAND' && a.command.label.includes('Rotate'),
    );
    expect(rotateCmd).toBeDefined();
    const added = rotateCmd.command.entityChanges.find((ec: any) => ec.action === 'add');
    // CW rotation from 0: 0 - π/2 normalized = 3π/2
    expect(added.entity.rotation).toBeCloseTo(3 * Math.PI / 2);
    // UID should be preserved
    expect(added.entity.uid).toBe(1);
    // Label indicates direction
    expect(rotateCmd.command.label).toContain('CW');
  });

  it('rotates selected entities CCW', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 5, 5);
    const { ctx, dispatched } = makeToolContext([e1]);

    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseUp(ctx, 5, 5);
    tool.rotateSelected(ctx, 'ccw');

    const rotateCmd = dispatched.find(a =>
      a.type === 'APPLY_COMMAND' && a.command.label.includes('Rotate'),
    );
    expect(rotateCmd).toBeDefined();
    const added = rotateCmd.command.entityChanges.find((ec: any) => ec.action === 'add');
    // CCW rotation from 0: 0 + π/2 = π/2
    expect(added.entity.rotation).toBeCloseTo(Math.PI / 2);
    expect(added.entity.uid).toBe(1);
    expect(rotateCmd.command.label).toContain('CCW');
  });

  it('deletes selected entities', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 5, 5);
    const { ctx, dispatched } = makeToolContext([e1]);

    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseUp(ctx, 5, 5);
    tool.deleteSelected(ctx);

    const deleteCmd = dispatched.find(a =>
      a.type === 'APPLY_COMMAND' && a.command.label.includes('Delete'),
    );
    expect(deleteCmd).toBeDefined();
    expect(deleteCmd.command.entityChanges[0].action).toBe('remove');

    const lastSelect = dispatched.filter(a => a.type === 'SELECT_ENTITY').pop();
    expect(lastSelect?.uids).toEqual([]);
  });

  it('shift+click toggles entity in selection', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 5, 5);
    const e2 = makeEntity(2, 'Table', 8, 8);
    const { ctx, dispatched } = makeToolContext([e1, e2]);

    // Select first entity
    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseUp(ctx, 5, 5);

    // Shift+click second entity
    tool.onMouseDownWithShift(ctx, 8, 8, 0);
    tool.onMouseUp(ctx, 8, 8);

    const toggleAction = dispatched.find(a => a.type === 'TOGGLE_SELECT_ENTITY');
    expect(toggleAction).toBeDefined();
    expect(toggleAction.uid).toBe(2);
  });

  it('box select captures entities in rectangle', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 3, 3);
    const e2 = makeEntity(2, 'Table', 5, 5);
    const e3 = makeEntity(3, 'Chair', 20, 20); // outside box
    const { ctx, dispatched } = makeToolContext([e1, e2, e3]);

    // Click empty space and drag a box from (2,2) to (6,6)
    tool.onMouseDown(ctx, 2, 2, 0);
    tool.onMouseMove(ctx, 6, 6);
    tool.onMouseUp(ctx, 6, 6);

    const selectAction = dispatched.filter(a => a.type === 'SELECT_ENTITY').pop();
    expect(selectAction).toBeDefined();
    expect(selectAction.uids).toContain(1);
    expect(selectAction.uids).toContain(2);
    expect(selectAction.uids).not.toContain(3);
  });

  it('multi-move moves all selected entities', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 5, 5);
    const e2 = makeEntity(2, 'Table', 6, 5);
    const { ctx, dispatched } = makeToolContext([e1, e2], [1, 2]);

    // Click on selected entity and drag
    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseMove(ctx, 8, 8);
    tool.onMouseUp(ctx, 8, 8);

    const moveCmd = dispatched.find(a =>
      a.type === 'APPLY_COMMAND' && a.command.label.includes('Move'),
    );
    expect(moveCmd).toBeDefined();
    expect(moveCmd.command.label).toContain('2 entities');
    // Should have 2 removes + 2 adds
    expect(moveCmd.command.entityChanges).toHaveLength(4);
  });

  it('move keeps UIDs and undo restores entities correctly', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 6, 5);

    // Use real reducer to test undo
    rebuildSpatialIndex([e1, e2]);
    let state: EditorState = {
      ...createInitialState(),
      entities: [e1, e2],
      selectedEntityUids: [1, 2],
      nextEntityId: 3,
      registry: makeMockRegistry(),
    };

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

    // Move entities from (5,5)/(6,5) to (8,8)/(9,8)
    tool.onMouseDown(ctx, 5, 5, 0);
    tool.onMouseMove(ctx, 8, 8);
    tool.onMouseUp(ctx, 8, 8);

    // After move: the same entities at new positions
    expect(state.entities).toHaveLength(2);
    expect(state.entities.map(e => e.uid).sort()).toEqual([1, 2]);

    const movedWall = state.entities.find(e => e.prototype === 'WallSolid')!;
    expect(movedWall.position.x).toBeCloseTo(8.5);
    expect(movedWall.position.y).toBeCloseTo(8.5);

    // Now undo
    state = editorReducer(state, { type: 'UNDO' });

    // After undo: original entities should be restored at original positions
    expect(state.entities).toHaveLength(2);
    const restoredWall = state.entities.find(e => e.prototype === 'WallSolid')!;
    expect(restoredWall).toBeDefined();
    expect(restoredWall.uid).toBe(1);
    expect(restoredWall.position.x).toBeCloseTo(5.5);
    expect(restoredWall.position.y).toBeCloseTo(5.5);

    const restoredAPC = state.entities.find(e => e.prototype === 'APC')!;
    expect(restoredAPC).toBeDefined();
    expect(restoredAPC.uid).toBe(2);
    expect(restoredAPC.position.x).toBeCloseTo(6.5);
    expect(restoredAPC.position.y).toBeCloseTo(5.5);
  });

  // --- Stack picker tests ---

  it('opens picker on scroll over selected tile with 2+ entities', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const { ctx } = makeToolContext([e1, e2], [1]); // e1 is selected

    const handled = tool.onWheel!(ctx, 5, 5, 1);
    expect(handled).toBe(true);

    const picker = tool.getPickerState();
    expect(picker.open).toBe(true);
    expect(picker.entities).toHaveLength(2);
    expect(picker.tileX).toBe(5);
    expect(picker.tileY).toBe(5);
  });

  it('does not open picker on unselected tile', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const { ctx } = makeToolContext([e1, e2]); // nothing selected

    const handled = tool.onWheel!(ctx, 5, 5, 1);
    expect(handled).toBe(false);
    expect(tool.getPickerState().open).toBe(false);
  });

  it('does not open picker on tile with 0 or 1 entity', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const { ctx } = makeToolContext([e1], [1]); // selected but only 1 entity

    const handled1 = tool.onWheel!(ctx, 5, 5, 1);
    expect(handled1).toBe(false);
    expect(tool.getPickerState().open).toBe(false);

    // Empty tile
    const handled2 = tool.onWheel!(ctx, 10, 10, 1);
    expect(handled2).toBe(false);
    expect(tool.getPickerState().open).toBe(false);
  });

  it('does not open picker when hovering different tile than selected', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const e3 = makeEntity(3, 'Table', 8, 8);
    const e4 = makeEntity(4, 'Chair', 8, 8);
    const { ctx } = makeToolContext([e1, e2, e3, e4], [1]); // selected at (5,5)

    // Hover over (8,8) which has 2 entities but none selected
    const handled = tool.onWheel!(ctx, 8, 8, 1);
    expect(handled).toBe(false);
    expect(tool.getPickerState().open).toBe(false);
  });

  it('cycles picker index on repeated scroll', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const e3 = makeEntity(3, 'Table', 5, 5);
    const { ctx } = makeToolContext([e1, e2, e3], [1]);

    tool.onWheel!(ctx, 5, 5, 1); // opens, index goes to 1
    expect(tool.getPickerState().index).toBe(1);

    tool.onWheel!(ctx, 5, 5, 1); // index 2
    expect(tool.getPickerState().index).toBe(2);

    tool.onWheel!(ctx, 5, 5, 1); // wraps to 0
    expect(tool.getPickerState().index).toBe(0);

    // Scroll up wraps backward
    tool.onWheel!(ctx, 5, 5, -1);
    expect(tool.getPickerState().index).toBe(2);
  });

  it('scroll immediately selects the highlighted entity', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const e3 = makeEntity(3, 'Table', 5, 5);
    const { ctx, dispatched } = makeToolContext([e1, e2, e3], [1]);

    // Scroll opens picker and immediately selects
    tool.onWheel!(ctx, 5, 5, 1);
    const pickerEntities = tool.getPickerState().entities;
    const expectedEntity = pickerEntities[1];

    const selectAction = dispatched.filter(a => a.type === 'SELECT_ENTITY').pop();
    expect(selectAction).toBeDefined();
    expect(selectAction.uids).toEqual([expectedEntity.uid]);
  });

  it('click after scroll starts drag (entity already selected)', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const { ctx, dispatched } = makeToolContext([e1, e2], [1]);

    // Scroll to select e2 (or whichever is at index 1)
    tool.onWheel!(ctx, 5, 5, 1);
    const pickedUid = tool.getPickerState().entities[1].uid;

    // Click should close picker and start move drag (not re-select)
    tool.onMouseDown(ctx, 5, 5, 0);
    expect(tool.getPickerState().open).toBe(false);

    // Drag to move
    tool.onMouseMove(ctx, 7, 7);
    tool.onMouseUp(ctx, 7, 7);

    const moveCmd = dispatched.find(a =>
      a.type === 'APPLY_COMMAND' && a.command.label.includes('Move'),
    );
    expect(moveCmd).toBeDefined();
  });

  it('closes picker when cursor moves to different tile', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const { ctx } = makeToolContext([e1, e2], [1]);

    tool.onWheel!(ctx, 5, 5, 1);
    expect(tool.getPickerState().open).toBe(true);

    tool.onMouseMove(ctx, 6, 6);
    expect(tool.getPickerState().open).toBe(false);
  });

  it('closes picker on right-click', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const { ctx } = makeToolContext([e1, e2], [1]);

    tool.onWheel!(ctx, 5, 5, 1);
    expect(tool.getPickerState().open).toBe(true);

    tool.onMouseDown(ctx, 5, 5, 2);
    expect(tool.getPickerState().open).toBe(false);
  });

  it('closes picker on deactivate', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'WallSolid', 5, 5);
    const e2 = makeEntity(2, 'APC', 5, 5);
    const { ctx } = makeToolContext([e1, e2], [1]);

    tool.onWheel!(ctx, 5, 5, 1);
    expect(tool.getPickerState().open).toBe(true);

    tool.deactivate!();
    expect(tool.getPickerState().open).toBe(false);
  });

  it('rotate preserves UID and undo restores original rotation', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 5, 5);

    rebuildSpatialIndex([e1]);
    let state: EditorState = {
      ...createInitialState(),
      entities: [e1],
      selectedEntityUids: [1],
      nextEntityId: 2,
      registry: makeMockRegistry(),
    };

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

    tool.rotateSelected(ctx);

    // After CW rotate: entity should have 3π/2 rotation, same UID
    expect(state.entities).toHaveLength(1);
    expect(state.entities[0].rotation).toBeCloseTo(3 * Math.PI / 2);
    expect(state.entities[0].uid).toBe(1);

    // Undo
    state = editorReducer(state, { type: 'UNDO' });

    // Original entity restored with rotation 0
    expect(state.entities).toHaveLength(1);
    expect(state.entities[0].uid).toBe(1);
    expect(state.entities[0].rotation).toBeCloseTo(0);
  });

  it('4 rotations cycle CW through 3π/2, π, π/2, 0 (no accumulation past 2π)', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 5, 5);

    rebuildSpatialIndex([e1]);
    let state: EditorState = {
      ...createInitialState(),
      entities: [e1],
      selectedEntityUids: [1],
      nextEntityId: 2,
      registry: makeMockRegistry(),
    };

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

    // Rotate 1: 0 → 3π/2 (CW subtracts π/2, normalized)
    tool.rotateSelected(ctx);
    expect(state.entities[0].rotation).toBeCloseTo(3 * Math.PI / 2);
    expect(state.entities[0].uid).toBe(1);

    // Rotate 2: 3π/2 → π
    tool.rotateSelected(ctx);
    expect(state.entities[0].rotation).toBeCloseTo(Math.PI);
    expect(state.entities[0].uid).toBe(1);

    // Rotate 3: π → π/2
    tool.rotateSelected(ctx);
    expect(state.entities[0].rotation).toBeCloseTo(Math.PI / 2);
    expect(state.entities[0].uid).toBe(1);

    // Rotate 4: π/2 → 0 (full cycle back)
    tool.rotateSelected(ctx);
    expect(state.entities[0].rotation).toBeCloseTo(0);
    expect(state.entities[0].uid).toBe(1);
  });

  it('preserves spriteStateOverride when moving entity', () => {
    const entity: ImportedEntity = {
      ...makeEntity(1, 'ClosetBase', 5, 5),
      spriteStateOverride: 'generic_open',
    };
    // Verify spread preserves the field (simulating move)
    const moved: ImportedEntity = {
      ...entity,
      uid: 2,
      position: { x: 6.5, y: 6.5 },
    };
    expect(moved.spriteStateOverride).toBe('generic_open');
  });

  describe('free movement (fractional coords)', () => {
    it('move drag with fractional coords produces fractional position delta', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 5, 10);
      const { ctx, dispatched } = makeToolContext([e1], [1]);

      // Start drag at fractional position
      tool.onMouseDown(ctx, 5.3, 10.2, 0);
      tool.onMouseMove(ctx, 5.8, 10.7);
      tool.onMouseUp(ctx, 5.8, 10.7);

      const cmd = dispatched.find(a => a.type === 'APPLY_COMMAND' && a.command.label.includes('Move'));
      expect(cmd).toBeDefined();
      // Delta: (5.8 - 5.3, 10.7 - 10.2) = (0.5, 0.5)
      // New position: (5.5 + 0.5, 10.5 + 0.5) = (6.0, 11.0)
      const addChange = cmd.command.entityChanges.find((c: any) => c.action === 'add');
      expect(addChange.entity.position.x).toBeCloseTo(6.0);
      expect(addChange.entity.position.y).toBeCloseTo(11.0);
    });

    it('shift+click toggle select still works with fractional coords', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 5, 10);
      const e2 = makeEntity(2, 'Table', 5, 10);
      const { ctx, dispatched } = makeToolContext([e1, e2], [1]);

      // Shift+click should toggle entity (deselect since already selected)
      tool.onMouseDownWithShift(ctx, 5.3, 10.7, 0);
      tool.onMouseUp(ctx, 5.3, 10.7);

      const toggleAction = dispatched.find(a => a.type === 'TOGGLE_SELECT_ENTITY');
      expect(toggleAction).toBeDefined();
    });
  });

  it('preserves spriteStateOverride when rotating entity', () => {
    const entity: ImportedEntity = {
      ...makeEntity(1, 'ClosetBase', 5, 5),
      spriteStateOverride: 'generic_open',
    };
    const rotated: ImportedEntity = {
      ...entity,
      uid: 2,
      rotation: entity.rotation + Math.PI / 2,
    };
    expect(rotated.spriteStateOverride).toBe('generic_open');
  });

  // --- Ctrl+box subtract tests ---

  it('ctrl+box select removes entities from selection', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 3, 3);
    const e2 = makeEntity(2, 'Table', 5, 5);
    const e3 = makeEntity(3, 'Chair', 7, 7);
    const { ctx, dispatched } = makeToolContext([e1, e2, e3], [1, 2, 3]);

    tool.onMouseDownWithCtrl(ctx, 4, 4, 0);
    tool.onMouseMove(ctx, 6, 6);
    tool.onMouseUp(ctx, 6, 6);

    const removeAction = dispatched.find(a => a.type === 'REMOVE_SELECT_ENTITIES');
    expect(removeAction).toBeDefined();
    expect(removeAction.uids).toContain(2);
    expect(removeAction.uids).not.toContain(1);
    expect(removeAction.uids).not.toContain(3);
  });

  it('ctrl+box does not affect entities outside the box', () => {
    const tool = new EntitySelectTool();
    const e1 = makeEntity(1, 'APC', 3, 3);
    const e2 = makeEntity(2, 'Table', 20, 20);
    const { ctx, dispatched } = makeToolContext([e1, e2], [1, 2]);

    tool.onMouseDownWithCtrl(ctx, 2, 2, 0);
    tool.onMouseMove(ctx, 4, 4);
    tool.onMouseUp(ctx, 4, 4);

    const removeAction = dispatched.find(a => a.type === 'REMOVE_SELECT_ENTITIES');
    expect(removeAction).toBeDefined();
    expect(removeAction.uids).toContain(1);
    expect(removeAction.uids).not.toContain(2);
  });

  // --- Copy / Paste tests ---

  describe('copy and paste', () => {
    beforeEach(() => {
      setClipboard(null as any);
    });

    it('copies selected entities to clipboard with relative offsets', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 3, 5);
      const e2 = makeEntity(2, 'Table', 6, 8);
      const e3 = makeEntity(3, 'Chair', 20, 20); // not selected
      const { ctx } = makeToolContext([e1, e2, e3], [1, 2]);

      tool.copy(ctx);
      const clip = getClipboard();
      expect(clip).not.toBeNull();
      expect(clip!.entities).toHaveLength(2);

      // Bounding box: x 3-6, y 5-8 → width=4, height=4
      expect(clip!.width).toBe(4);
      expect(clip!.height).toBe(4);

      // Relative offsets from min corner (3, 5)
      const apc = clip!.entities.find(e => e.prototype === 'APC')!;
      expect(apc.dx).toBeCloseTo(0.5);  // 3.5 - 3
      expect(apc.dy).toBeCloseTo(0.5);  // 5.5 - 5

      const table = clip!.entities.find(e => e.prototype === 'Table')!;
      expect(table.dx).toBeCloseTo(3.5); // 6.5 - 3
      expect(table.dy).toBeCloseTo(3.5); // 8.5 - 5

      // Tiles should be all null (entity-only copy)
      expect(clip!.tiles.every(t => t === null)).toBe(true);
    });

    it('does not copy when no entities selected', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 3, 5);
      const { ctx } = makeToolContext([e1], []);

      tool.copy(ctx);
      expect(getClipboard()).toBeNull();
    });

    it('pastes entities at cursor position with new UIDs', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 3, 5);
      const { ctx, dispatched } = makeToolContext([e1], [1]);

      // Copy, then paste
      tool.copy(ctx);
      tool.paste(ctx);
      expect(tool.isPasting()).toBe(true);

      // Move cursor and commit
      tool.onMouseMove(ctx, 10, 10);
      tool.onMouseDown(ctx, 10, 10, 0);

      expect(dispatched).toHaveLength(1);
      const adds = dispatched[0].command.entityChanges.filter(
        (ec: EntityChange) => ec.action === 'add',
      );
      expect(adds).toHaveLength(1);
      expect(adds[0].entity.prototype).toBe('APC');
      expect(adds[0].entity.position.x).toBeCloseTo(10.5);
      expect(adds[0].entity.position.y).toBeCloseTo(10.5);
      expect(adds[0].entity.uid).toBe(ctx.state.nextEntityId); // new UID
    });

    it('pastes multiple entities preserving relative positions', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 3, 5);
      const e2 = makeEntity(2, 'Table', 5, 7);
      const { ctx, dispatched } = makeToolContext([e1, e2], [1, 2]);

      tool.copy(ctx);
      tool.paste(ctx);
      tool.onMouseMove(ctx, 10, 10);
      tool.onMouseDown(ctx, 10, 10, 0);

      const adds = dispatched[0].command.entityChanges.filter(
        (ec: EntityChange) => ec.action === 'add',
      );
      expect(adds).toHaveLength(2);

      // APC offset (0.5, 0.5) → (10.5, 10.5)
      const apc = adds.find((ec: EntityChange) => ec.entity.prototype === 'APC')!;
      expect(apc.entity.position.x).toBeCloseTo(10.5);
      expect(apc.entity.position.y).toBeCloseTo(10.5);

      // Table offset (2.5, 2.5) → (12.5, 12.5)
      const table = adds.find((ec: EntityChange) => ec.entity.prototype === 'Table')!;
      expect(table.entity.position.x).toBeCloseTo(12.5);
      expect(table.entity.position.y).toBeCloseTo(12.5);
    });

    it('cut copies then deletes selected entities', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 3, 5);
      const { ctx, dispatched } = makeToolContext([e1], [1]);

      tool.cut(ctx);

      // Should have clipboard data
      const clip = getClipboard();
      expect(clip!.entities).toHaveLength(1);

      // Should have delete command
      const deleteCmd = dispatched.find(a =>
        a.type === 'APPLY_COMMAND' && a.command.label.includes('Delete'),
      );
      expect(deleteCmd).toBeDefined();
    });

    it('right-click cancels paste mode', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 3, 5);
      const { ctx } = makeToolContext([e1], [1]);

      tool.copy(ctx);
      tool.paste(ctx);
      expect(tool.isPasting()).toBe(true);

      tool.onMouseDown(ctx, 0, 0, 2);
      expect(tool.isPasting()).toBe(false);
    });

    it('stays in paste mode after committing (for repeated stamps)', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 3, 5);
      const { ctx, dispatched } = makeToolContext([e1], [1]);

      tool.copy(ctx);
      tool.paste(ctx);
      tool.onMouseMove(ctx, 10, 10);
      tool.onMouseDown(ctx, 10, 10, 0);

      // Should have committed but still be in paste mode
      expect(dispatched).toHaveLength(1);
      expect(tool.isPasting()).toBe(true);
    });

    it('preserves spriteStateOverride through copy and paste', () => {
      const tool = new EntitySelectTool();
      const entity: ImportedEntity = {
        ...makeEntity(1, 'ClosetBase', 5, 5),
        spriteStateOverride: 'generic_open',
      };
      const { ctx, dispatched } = makeToolContext([entity], [1]);

      tool.copy(ctx);
      const clip = getClipboard();
      expect(clip!.entities[0].spriteStateOverride).toBe('generic_open');

      tool.paste(ctx);
      tool.onMouseMove(ctx, 10, 10);
      tool.onMouseDown(ctx, 10, 10, 0);

      const adds = dispatched[0].command.entityChanges.filter(
        (ec: EntityChange) => ec.action === 'add',
      );
      expect(adds[0].entity.spriteStateOverride).toBe('generic_open');
    });

    it('rotates paste preview and places at correct positions', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 0, 0);   // (0.5, 0.5)
      const e2 = makeEntity(2, 'Table', 2, 0);  // (2.5, 0.5)
      const { ctx, dispatched } = makeToolContext([e1, e2], [1, 2]);

      tool.copy(ctx);
      // Clipboard: width=3, height=1. APC at (0.5, 0.5), Table at (2.5, 0.5)

      tool.paste(ctx);
      tool.rotatePaste('cw');

      // After CW: width=1, height=3. newDx=dy, newDy=W-dx (W=3)
      // APC (0.5, 0.5) → (0.5, 2.5)
      // Table (2.5, 0.5) → (0.5, 0.5)

      tool.onMouseMove(ctx, 5, 5);
      tool.onMouseDown(ctx, 5, 5, 0);

      const adds = dispatched[0].command.entityChanges.filter(
        (ec: EntityChange) => ec.action === 'add',
      );
      expect(adds).toHaveLength(2);

      const apc = adds.find((ec: EntityChange) => ec.entity.prototype === 'APC')!;
      expect(apc.entity.position.x).toBeCloseTo(5.5);
      expect(apc.entity.position.y).toBeCloseTo(7.5);
      expect(apc.entity.rotation).toBeCloseTo(3 * Math.PI / 2);

      const table = adds.find((ec: EntityChange) => ec.entity.prototype === 'Table')!;
      expect(table.entity.position.x).toBeCloseTo(5.5);
      expect(table.entity.position.y).toBeCloseTo(5.5);
      expect(table.entity.rotation).toBeCloseTo(3 * Math.PI / 2);
    });

    it('does not enter paste mode when clipboard has no entities', () => {
      const tool = new EntitySelectTool();
      const { ctx } = makeToolContext([], []);

      // Set clipboard with tiles only, no entities
      setClipboard({
        width: 2, height: 2,
        tiles: [{ tileId: 'FloorSteel' }, null, null, null],
        entities: [],
        originX: 0, originY: 0,
      });

      tool.paste(ctx);
      expect(tool.isPasting()).toBe(false);
    });
  });

  // --- Additive/subtractive box selection tests ---

  describe('additive/subtractive box selection', () => {
    it('shift+box adds entities to existing selection', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 3, 3);
      const e2 = makeEntity(2, 'Table', 5, 5);
      const { ctx, dispatched } = makeToolContext([e1, e2], [1]);

      // Shift+box over e2
      tool.onMouseDownWithShift(ctx, 4, 4, 0);
      tool.onMouseMove(ctx, 6, 6);
      tool.onMouseUp(ctx, 6, 6);

      const addAction = dispatched.find(a => a.type === 'ADD_SELECT_ENTITIES');
      expect(addAction).toBeDefined();
      expect(addAction.uids).toContain(2);
    });

    it('shift+click on entity toggles it in selection', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 5, 5);
      const { ctx, dispatched } = makeToolContext([e1], []);

      // Shift+click (no drag) on e1
      tool.onMouseDownWithShift(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      const toggleAction = dispatched.find(a => a.type === 'TOGGLE_SELECT_ENTITY');
      expect(toggleAction).toBeDefined();
      expect(toggleAction.uid).toBe(1);
    });

    it('ctrl+click on entity removes it from selection', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 5, 5);
      const { ctx, dispatched } = makeToolContext([e1], [1]);

      // Ctrl+click (no drag) on e1
      tool.onMouseDownWithCtrl(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      const removeAction = dispatched.find(a => a.type === 'REMOVE_SELECT_ENTITIES');
      expect(removeAction).toBeDefined();
      expect(removeAction.uids).toContain(1);
    });

    it('shift+drag starting on selected entity starts free move', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 5, 5);
      const { ctx, dispatched } = makeToolContext([e1], [1]);

      // Shift+drag starting on e1 (selected), free movement
      tool.onMouseDownWithShift(ctx, 5.3, 5.2, 0);
      tool.onMouseMove(ctx, 5.8, 5.7);
      tool.onMouseUp(ctx, 5.8, 5.7);

      // Should have a move command with fractional delta
      const moveCmd = dispatched.find(a =>
        a.type === 'APPLY_COMMAND' && a.command?.label?.includes('Move'),
      );
      expect(moveCmd).toBeDefined();
    });
  });

  // --- Decal selection tests ---

  describe('decal selection', () => {
    it('click on decal selects it', () => {
      const tool = new EntitySelectTool();
      const d1 = makeDecal(100, 'BotGreeting', 5, 5);
      const { ctx, dispatched } = makeToolContext([], [], { decals: [d1] });

      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      // Last SELECT_DECAL should be the one with the decal id (first one clears)
      const selectAction = dispatched.filter(a => a.type === 'SELECT_DECAL').pop();
      expect(selectAction).toBeDefined();
      expect(selectAction.ids).toEqual([100]);
    });

    it('click on entity takes priority over decal at same tile', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 5, 5);
      const d1 = makeDecal(100, 'BotGreeting', 5, 5);
      const { ctx, dispatched } = makeToolContext([e1], [], { decals: [d1] });

      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      // Should select entity, not decal
      const entitySelect = dispatched.filter(a => a.type === 'SELECT_ENTITY').pop();
      expect(entitySelect).toBeDefined();
      expect(entitySelect.uids).toEqual([1]);

      // Should not have a separate decal select with the decal id
      const decalSelect = dispatched.filter(a => a.type === 'SELECT_DECAL' && a.ids.length > 0);
      expect(decalSelect).toHaveLength(0);
    });

    it('shift+click on decal toggles selection', () => {
      const tool = new EntitySelectTool();
      const d1 = makeDecal(100, 'BotGreeting', 5, 5);
      const { ctx, dispatched } = makeToolContext([], [], { decals: [d1] });

      tool.onMouseDownWithShift(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      const toggleAction = dispatched.find(a => a.type === 'TOGGLE_SELECT_DECAL');
      expect(toggleAction).toBeDefined();
      expect(toggleAction.id).toBe(100);
    });

    it('ctrl+click on decal removes it from selection', () => {
      const tool = new EntitySelectTool();
      const d1 = makeDecal(100, 'BotGreeting', 5, 5);
      const { ctx, dispatched } = makeToolContext([], [], { decals: [d1], selectedDecalIds: [100] });

      tool.onMouseDownWithCtrl(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      const removeAction = dispatched.find(a => a.type === 'REMOVE_SELECT_DECALS');
      expect(removeAction).toBeDefined();
      expect(removeAction.ids).toContain(100);
    });

    it('box select captures decals', () => {
      const tool = new EntitySelectTool();
      const d1 = makeDecal(100, 'BotGreeting', 3, 3);
      const d2 = makeDecal(101, 'WarnLine', 5, 5);
      const d3 = makeDecal(102, 'BotGreeting', 20, 20); // outside box
      const { ctx, dispatched } = makeToolContext([], [], { decals: [d1, d2, d3] });

      tool.onMouseDown(ctx, 2, 2, 0);
      tool.onMouseMove(ctx, 6, 6);
      tool.onMouseUp(ctx, 6, 6);

      const decalSelect = dispatched.filter(a => a.type === 'SELECT_DECAL').pop();
      expect(decalSelect).toBeDefined();
      expect(decalSelect.ids).toContain(100);
      expect(decalSelect.ids).toContain(101);
      expect(decalSelect.ids).not.toContain(102);
    });

    it('box select captures both entities and decals', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 4, 4);
      const d1 = makeDecal(100, 'BotGreeting', 3, 3);
      const { ctx, dispatched } = makeToolContext([e1], [], { decals: [d1] });

      tool.onMouseDown(ctx, 2, 2, 0);
      tool.onMouseMove(ctx, 6, 6);
      tool.onMouseUp(ctx, 6, 6);

      const entitySelect = dispatched.filter(a => a.type === 'SELECT_ENTITY').pop();
      expect(entitySelect.uids).toContain(1);

      const decalSelect = dispatched.filter(a => a.type === 'SELECT_DECAL').pop();
      expect(decalSelect.ids).toContain(100);
    });

    it('delete removes selected decals', () => {
      const tool = new EntitySelectTool();
      const d1 = makeDecal(100, 'BotGreeting', 5, 5);
      const d2 = makeDecal(101, 'WarnLine', 7, 7);
      const { ctx, dispatched } = makeToolContext([], [], { decals: [d1, d2], selectedDecalIds: [100] });

      tool.deleteSelected(ctx);

      const deleteCmd = dispatched.find(a =>
        a.type === 'APPLY_COMMAND' && a.command.label.includes('Delete'),
      );
      expect(deleteCmd).toBeDefined();
      expect(deleteCmd.command.decalChanges).toHaveLength(1);
      expect(deleteCmd.command.decalChanges[0].action).toBe('remove');
      expect(deleteCmd.command.decalChanges[0].decal.id).toBe(100);

      // Should clear selection
      const clearDecals = dispatched.find(a => a.type === 'SELECT_DECAL' && a.ids.length === 0);
      expect(clearDecals).toBeDefined();
    });

    it('delete removes both entities and decals', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 5, 5);
      const d1 = makeDecal(100, 'BotGreeting', 7, 7);
      const { ctx, dispatched } = makeToolContext([e1], [1], { decals: [d1], selectedDecalIds: [100] });

      tool.deleteSelected(ctx);

      const deleteCmd = dispatched.find(a =>
        a.type === 'APPLY_COMMAND' && a.command.label.includes('Delete'),
      );
      expect(deleteCmd).toBeDefined();
      expect(deleteCmd.command.entityChanges).toHaveLength(1);
      expect(deleteCmd.command.entityChanges[0].action).toBe('remove');
      expect(deleteCmd.command.decalChanges).toHaveLength(1);
      expect(deleteCmd.command.decalChanges[0].action).toBe('remove');
    });

    it('drag moves selected decals', () => {
      const tool = new EntitySelectTool();
      const d1 = makeDecal(100, 'BotGreeting', 5, 5);
      const { ctx, dispatched } = makeToolContext([], [], { decals: [d1], selectedDecalIds: [100] });

      // Click on selected decal to start move drag
      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseMove(ctx, 8, 8);
      tool.onMouseUp(ctx, 8, 8);

      const moveCmd = dispatched.find(a =>
        a.type === 'APPLY_COMMAND' && a.command.label.includes('Move'),
      );
      expect(moveCmd).toBeDefined();
      expect(moveCmd.command.decalChanges).toHaveLength(1);

      const updateChange = moveCmd.command.decalChanges[0];
      expect(updateChange.action).toBe('update');
      expect(updateChange.decal.position.x).toBeCloseTo(8.5);
      expect(updateChange.decal.position.y).toBeCloseTo(8.5);
      expect(updateChange.previousDecal.position.x).toBeCloseTo(5.5);
      expect(updateChange.previousDecal.position.y).toBeCloseTo(5.5);
    });

    it('drag moves entities and decals together', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APC', 5, 5);
      const d1 = makeDecal(100, 'BotGreeting', 6, 6);
      const { ctx, dispatched } = makeToolContext([e1], [1], { decals: [d1], selectedDecalIds: [100] });

      // Click on selected entity to start move
      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseMove(ctx, 8, 8);
      tool.onMouseUp(ctx, 8, 8);

      const moveCmd = dispatched.find(a =>
        a.type === 'APPLY_COMMAND' && a.command.label.includes('Move'),
      );
      expect(moveCmd).toBeDefined();
      // Entity changes: remove + add
      expect(moveCmd.command.entityChanges).toHaveLength(2);
      // Decal changes: update
      expect(moveCmd.command.decalChanges).toHaveLength(1);
      expect(moveCmd.command.decalChanges[0].decal.position.x).toBeCloseTo(9.5);
      expect(moveCmd.command.decalChanges[0].decal.position.y).toBeCloseTo(9.5);
    });

    it('right-click clears decal selection', () => {
      const tool = new EntitySelectTool();
      const d1 = makeDecal(100, 'BotGreeting', 5, 5);
      const { ctx, dispatched } = makeToolContext([], [], { decals: [d1], selectedDecalIds: [100] });

      tool.onMouseDown(ctx, 5, 5, 2);

      const clearDecals = dispatched.find(a => a.type === 'SELECT_DECAL' && a.ids.length === 0);
      expect(clearDecals).toBeDefined();
    });
  });

  describe('layer visibility filtering', () => {
    beforeEach(() => {
      clearDrawDepthCache();
    });

    it('click does not select entities on hidden layers', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APCBasic', 5, 5); // objects layer (DrawDepth 0-7)
      const layers: LayerVisibility = { ...DEFAULT_LAYER_VISIBILITY, objects: false };
      const { ctx, dispatched } = makeToolContext([e1], [], { layerVisibility: layers });

      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      // Should not have selected the entity
      const selectAction = dispatched.find(a => a.type === 'SELECT_ENTITY' && a.uids.length > 0);
      expect(selectAction).toBeUndefined();
    });

    it('click selects entities on visible layers', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APCBasic', 5, 5);
      const layers: LayerVisibility = { ...DEFAULT_LAYER_VISIBILITY, objects: true };
      const { ctx, dispatched } = makeToolContext([e1], [], { layerVisibility: layers });

      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      const selectAction = dispatched.find(a => a.type === 'SELECT_ENTITY' && a.uids.includes(1));
      expect(selectAction).toBeDefined();
    });

    it('box select excludes entities on hidden layers', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APCBasic', 5, 5);
      const e2 = makeEntity(2, 'WallSolid', 6, 5); // structures layer (WallTops = -1)
      const layers: LayerVisibility = { ...DEFAULT_LAYER_VISIBILITY, objects: false, structures: true };
      const { ctx, dispatched } = makeToolContext([e1, e2], [], { layerVisibility: layers });

      // Box select around both entities
      tool.onMouseDown(ctx, 4, 4, 0);
      tool.onMouseMove(ctx, 7, 6);
      tool.onMouseUp(ctx, 7, 6);

      // Last SELECT_ENTITY is from finishBoxSelect (first one is the clear on mouseDown)
      const selectActions = dispatched.filter(a => a.type === 'SELECT_ENTITY');
      const boxSelectAction = selectActions[selectActions.length - 1];
      expect(boxSelectAction).toBeDefined();
      // e1 (objects, hidden) should be excluded, e2 (structures, visible) should be included
      expect(boxSelectAction.uids).not.toContain(1);
      expect(boxSelectAction.uids).toContain(2);
    });

    it('hidden decal layer prevents decal selection on click', () => {
      const tool = new EntitySelectTool();
      const d1 = makeDecal(100, 'BotGreeting', 5, 5);
      const layers: LayerVisibility = { ...DEFAULT_LAYER_VISIBILITY, decals: false };
      const { ctx, dispatched } = makeToolContext([], [], { decals: [d1], layerVisibility: layers });

      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      // Should not select the decal
      const selectDecal = dispatched.find(a => a.type === 'SELECT_DECAL' && a.ids.length > 0);
      expect(selectDecal).toBeUndefined();
    });

    it('hidden decal layer prevents decal selection in box select', () => {
      const tool = new EntitySelectTool();
      const d1 = makeDecal(100, 'BotGreeting', 5, 5);
      const layers: LayerVisibility = { ...DEFAULT_LAYER_VISIBILITY, decals: false };
      const { ctx, dispatched } = makeToolContext([], [], { decals: [d1], layerVisibility: layers });

      tool.onMouseDown(ctx, 4, 4, 0);
      tool.onMouseMove(ctx, 7, 7);
      tool.onMouseUp(ctx, 7, 7);

      const selectDecal = dispatched.find(a => a.type === 'SELECT_DECAL' && a.ids.length > 0);
      expect(selectDecal).toBeUndefined();
    });

    it('works without layerVisibility set (selects everything)', () => {
      const tool = new EntitySelectTool();
      const e1 = makeEntity(1, 'APCBasic', 5, 5);
      const { ctx, dispatched } = makeToolContext([e1]); // no layerVisibility

      tool.onMouseDown(ctx, 5, 5, 0);
      tool.onMouseUp(ctx, 5, 5);

      const selectAction = dispatched.find(a => a.type === 'SELECT_ENTITY' && a.uids.includes(1));
      expect(selectAction).toBeDefined();
    });
  });
});
