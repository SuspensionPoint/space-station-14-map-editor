import type { EditorState } from './editorState';
import { createEmptyGrid, ensureGridContainsBounds, setCell } from './editorState';
import type { EditorAction } from './actions';
import type { Command, TileChange, EntityChange, ContainedEntityChange, GridCommand, UndoableCommand } from '../types';
import type { ImportedEntity } from '../import/mapImporter';
import type { GridData } from './gridData';
import { createEmptyGridData, getActiveGrid } from './gridData';
import { markSceneDirty, markAllDirty, markOverlayDirty, markConnectionsDirty } from '../rendering/dirtyFlags';
import { rebuildSpatialIndex } from '../rendering/spatialIndex';

const MAX_UNDO = 200;

function isGridCommand(cmd: UndoableCommand): cmd is GridCommand {
  return 'type' in cmd && ['ADD_GRID', 'REMOVE_GRID', 'RENAME_GRID'].includes((cmd as GridCommand).type);
}

/** Remove raw YAML lines for any entity touched by entity changes. */
function invalidateRawComponents(
  raw: Record<number, string[]> | undefined,
  changes: EntityChange[],
): Record<number, string[]> | undefined {
  if (!raw || changes.length === 0) return raw;
  const result = { ...raw };
  for (const ec of changes) {
    delete result[ec.entity.uid];
  }
  return result;
}

/** Expand grid to contain all tile change world coordinates, then apply changes. */
function applyTileChanges(grid: ReturnType<typeof Object.assign>, changes: TileChange[], key: 'after' | 'before') {
  if (changes.length === 0) return grid;

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const tc of changes) {
    if (tc.x < minX) minX = tc.x;
    if (tc.x > maxX) maxX = tc.x;
    if (tc.y < minY) minY = tc.y;
    if (tc.y > maxY) maxY = tc.y;
  }

  // Expand grid to fit
  const expanded = ensureGridContainsBounds(grid, minX, minY, maxX, maxY, 0);
  // If expanded, use the new grid; if not, shallow-copy cells for immutability
  const result = expanded !== grid
    ? expanded
    : { ...grid, cells: [...grid.cells] };

  // Apply changes using world coordinates
  for (const tc of changes) {
    setCell(result, tc.x, tc.y, { ...tc[key] });
  }

  return result;
}

function applyContainedEntityChanges(
  containedEntities: Record<number, ImportedEntity[]>,
  changes: ContainedEntityChange[],
): Record<number, ImportedEntity[]> {
  if (changes.length === 0) return containedEntities;
  const result = { ...containedEntities };
  for (const change of changes) {
    const list = result[change.parentUid] ? [...result[change.parentUid]] : [];
    if (change.action === 'add') {
      list.push(change.entity);
      result[change.parentUid] = list;
    } else {
      result[change.parentUid] = list.filter(e => e.uid !== change.entity.uid);
      if (result[change.parentUid].length === 0) {
        delete result[change.parentUid];
      }
    }
  }
  return result;
}

/** Sync legacy alias fields from the active grid. */
function syncLegacyFields(state: EditorState): EditorState {
  const active = getActiveGrid(state.grids, state.activeGridIndex);
  return {
    ...state,
    grid: active.grid,
    entities: active.entities,
    containedEntities: active.containedEntities,
    gridUid: active.gridUid,
  };
}

function applyCommand(state: EditorState, command: Command): EditorState {
  // Determine target grid
  const activeGrid = getActiveGrid(state.grids, state.activeGridIndex);
  const targetGridUid = command.gridUid ?? activeGrid.gridUid;
  const targetIndex = state.grids.findIndex(g => g.gridUid === targetGridUid);
  if (targetIndex < 0) return state; // grid not found

  const targetGrid = state.grids[targetIndex];

  const grid = applyTileChanges(targetGrid.grid, command.tileChanges, 'after');
  let nextEntityId = state.nextEntityId;

  // Track cascade-deleted contained entities so we can augment the command for undo
  const cascadeChanges: ContainedEntityChange[] = [];

  // Batch: collect all remove UIDs into a Set and all adds into an array
  const removeUids = new Set<number>();
  const addEntities: ImportedEntity[] = [];

  for (const ec of command.entityChanges) {
    if (ec.action === 'add') {
      addEntities.push(ec.entity);
      if (ec.entity.uid >= nextEntityId) {
        nextEntityId = ec.entity.uid + 1;
      }
    } else {
      removeUids.add(ec.entity.uid);
      // Cascade: if removing a container entity, record its contained entities for undo
      const contained = targetGrid.containedEntities[ec.entity.uid];
      if (contained && contained.length > 0) {
        for (const child of contained) {
          cascadeChanges.push({ action: 'remove', parentUid: ec.entity.uid, entity: child });
        }
      }
    }
  }

  // Single-pass filter for removals, then append adds
  let entities: ImportedEntity[];
  if (removeUids.size > 0) {
    entities = targetGrid.entities.filter(e => !removeUids.has(e.uid));
  } else {
    entities = [...targetGrid.entities];
  }
  if (addEntities.length > 0) {
    entities = entities.concat(addEntities);
  }

  // Rebuild spatial index if this is the active grid
  if (command.entityChanges.length > 0 && targetIndex === state.activeGridIndex) {
    rebuildSpatialIndex(entities);
  }

  // Invalidate raw YAML for any modified entities so the exporter re-serializes them
  const entityRawComponents = invalidateRawComponents(state.entityRawComponents, command.entityChanges);

  // Apply contained entity changes (both explicit and cascade)
  const allContainedChanges = [...(command.containedEntityChanges ?? []), ...cascadeChanges];
  const containedEntities = applyContainedEntityChanges(targetGrid.containedEntities, allContainedChanges);

  // Update parent entity ContainerContainer ents for contained entity changes
  for (const cec of command.containedEntityChanges ?? []) {
    const pIdx = entities.findIndex(e => e.uid === cec.parentUid);
    if (pIdx < 0) continue;
    const parent = entities[pIdx];
    const newComponents = parent.components.map(c => ({ ...c }));
    let ccIdx = newComponents.findIndex((c: any) => c.type === 'ContainerContainer');
    if (cec.action === 'add') {
      if (ccIdx < 0) {
        newComponents.push({ type: 'ContainerContainer', containers: { entity_storage: { ents: [] } } });
        ccIdx = newComponents.length - 1;
      }
      const cc = { ...newComponents[ccIdx] } as any;
      const containers = { ...cc.containers };
      const storage = { ...(containers.entity_storage ?? { ents: [] }) };
      storage.ents = [...(storage.ents ?? []), cec.entity.uid];
      containers.entity_storage = storage;
      cc.containers = containers;
      newComponents[ccIdx] = cc;
    } else if (ccIdx >= 0) {
      const cc = { ...newComponents[ccIdx] } as any;
      const containers = { ...cc.containers };
      const storage = { ...(containers.entity_storage ?? { ents: [] }) };
      storage.ents = (storage.ents ?? []).filter((uid: number) => uid !== cec.entity.uid);
      containers.entity_storage = storage;
      cc.containers = containers;
      newComponents[ccIdx] = cc;
    }
    entities[pIdx] = { ...parent, components: newComponents };
    if (cec.entity.uid >= nextEntityId) nextEntityId = cec.entity.uid + 1;
  }

  // Process decal changes
  let decals = targetGrid.decals.decals;
  let nextDecalId = targetGrid.decals.nextDecalId;
  if (command.decalChanges && command.decalChanges.length > 0) {
    decals = [...decals]; // immutable copy
    for (const dc of command.decalChanges) {
      if (dc.action === 'add') {
        decals.push(dc.decal);
        if (dc.decal.id >= nextDecalId) nextDecalId = dc.decal.id + 1;
      } else if (dc.action === 'remove') {
        decals = decals.filter(d => d.id !== dc.decal.id);
      } else if (dc.action === 'update') {
        decals = decals.map(d => d.id === dc.decal.id ? dc.decal : d);
      }
    }
  }

  // Build updated grid
  const updatedGrid: GridData = {
    ...targetGrid,
    grid,
    entities,
    containedEntities,
    decals: { decals, nextDecalId },
  };

  // Replace in grids array
  const newGrids = [...state.grids];
  newGrids[targetIndex] = updatedGrid;

  // Store gridUid on command for undo targeting
  const storedCommand: Command = cascadeChanges.length > 0
    ? { ...command, containedEntityChanges: allContainedChanges, gridUid: targetGridUid }
    : { ...command, gridUid: targetGridUid };

  const undoStack = [...state.undoStack, storedCommand];
  if (undoStack.length > MAX_UNDO) {
    undoStack.shift();
  }

  let decalsDirty = state.decalsDirty;
  if (command.decalChanges && command.decalChanges.length > 0) {
    decalsDirty = new Set(state.decalsDirty);
    decalsDirty.add(targetGridUid);
  }

  const result: EditorState = {
    ...state,
    grids: newGrids,
    entityRawComponents,
    nextEntityId,
    undoStack,
    redoStack: [],
    decalsDirty,
    dirty: true,
  };

  return syncLegacyFields(result);
}

function reverseCommand(command: Command): Command {
  return {
    label: `Undo ${command.label}`,
    tileChanges: command.tileChanges.map(tc => ({
      x: tc.x,
      y: tc.y,
      before: tc.after,
      after: tc.before,
    })),
    entityChanges: command.entityChanges.map(ec => ({
      action: ec.action === 'add' ? 'remove' as const : 'add' as const,
      entity: ec.entity,
    })).reverse(),
    decalChanges: command.decalChanges?.map(dc => {
      if (dc.action === 'add') return { action: 'remove' as const, decal: dc.decal };
      if (dc.action === 'remove') return { action: 'add' as const, decal: dc.decal };
      // update: swap decal and previousDecal
      return { action: 'update' as const, decal: dc.previousDecal!, previousDecal: dc.decal };
    }).reverse(),
    gridUid: command.gridUid,
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'APPLY_COMMAND':
      markSceneDirty();
      return applyCommand(state, action.command);

    case 'UNDO': {
      if (state.undoStack.length === 0) return state;
      markSceneDirty();
      const undoCmd = state.undoStack[state.undoStack.length - 1];

      if (isGridCommand(undoCmd)) {
        markAllDirty();
        const newUndoStack = state.undoStack.slice(0, -1);
        const newRedoStack = [...state.redoStack, undoCmd];

        if (undoCmd.type === 'ADD_GRID') {
          // Undo add = remove the grid
          const newGrids = state.grids.filter(g => g.gridUid !== undoCmd.gridData.gridUid);
          let newActiveIndex = state.activeGridIndex;
          const removedIdx = state.grids.findIndex(g => g.gridUid === undoCmd.gridData.gridUid);
          if (removedIdx >= 0) {
            if (removedIdx === state.activeGridIndex) {
              newActiveIndex = Math.min(newActiveIndex, newGrids.length - 1);
              rebuildSpatialIndex(newGrids[newActiveIndex].entities);
            } else if (removedIdx < state.activeGridIndex) {
              newActiveIndex--;
            }
          }
          return syncLegacyFields({
            ...state, grids: newGrids, activeGridIndex: newActiveIndex,
            undoStack: newUndoStack, redoStack: newRedoStack, dirty: true,
          });
        } else if (undoCmd.type === 'REMOVE_GRID') {
          // Undo remove = re-insert the grid at its original index
          const newGrids = [...state.grids];
          const insertIdx = undoCmd.insertIndex ?? newGrids.length;
          newGrids.splice(insertIdx, 0, undoCmd.gridData);
          let newActiveIndex = state.activeGridIndex;
          if (insertIdx <= state.activeGridIndex) {
            newActiveIndex++;
          }
          return syncLegacyFields({
            ...state, grids: newGrids, activeGridIndex: newActiveIndex,
            undoStack: newUndoStack, redoStack: newRedoStack, dirty: true,
          });
        } else {
          // RENAME_GRID, restore previousName
          const gridIdx = state.grids.findIndex(g => g.gridUid === undoCmd.gridData.gridUid);
          if (gridIdx < 0) return state;
          const newGrids = [...state.grids];
          newGrids[gridIdx] = { ...newGrids[gridIdx], name: undoCmd.previousName! };
          return { ...state, grids: newGrids, undoStack: newUndoStack, redoStack: newRedoStack, dirty: true };
        }
      }

      const command = undoCmd as Command;
      const reversed = reverseCommand(command);

      // Determine target grid by the stored gridUid on the command
      const targetGridUid = command.gridUid;
      const targetIndex = targetGridUid != null
        ? state.grids.findIndex(g => g.gridUid === targetGridUid)
        : state.activeGridIndex;
      if (targetIndex < 0) return state;

      const targetGrid = state.grids[targetIndex];

      const grid = applyTileChanges(targetGrid.grid, reversed.tileChanges, 'after');

      // Batch: collect all remove UIDs and adds from reversed changes
      const undoRemoveUids = new Set<number>();
      const undoAddEntities: ImportedEntity[] = [];
      for (const ec of reversed.entityChanges) {
        if (ec.action === 'add') {
          undoAddEntities.push(ec.entity);
        } else {
          undoRemoveUids.add(ec.entity.uid);
        }
      }

      // Single-pass filter for removals, then append adds
      let entities: ImportedEntity[];
      if (undoRemoveUids.size > 0) {
        entities = targetGrid.entities.filter(e => !undoRemoveUids.has(e.uid));
      } else {
        entities = [...targetGrid.entities];
      }
      if (undoAddEntities.length > 0) {
        entities = entities.concat(undoAddEntities);
      }

      // Rebuild spatial index if this is the active grid
      if (reversed.entityChanges.length > 0 && targetIndex === state.activeGridIndex) {
        rebuildSpatialIndex(entities);
      }

      // Invalidate raw YAML for undone entities
      const entityRawComponents = invalidateRawComponents(state.entityRawComponents, reversed.entityChanges);

      // Reverse contained entity changes: add→remove, remove→add
      let containedEntities = targetGrid.containedEntities;
      const cec = command.containedEntityChanges;
      if (cec && cec.length > 0) {
        const reversedContained: ContainedEntityChange[] = cec.map(c => ({
          ...c,
          action: c.action === 'add' ? 'remove' as const : 'add' as const,
        })).reverse();
        containedEntities = applyContainedEntityChanges(containedEntities, reversedContained);

        // Restore parent components if previousParentComponents was saved
        for (const c of cec) {
          if (c.previousParentComponents) {
            const idx = entities.findIndex(e => e.uid === c.parentUid);
            if (idx >= 0) {
              entities = [...entities];
              entities[idx] = { ...entities[idx], components: c.previousParentComponents };
            }
          }
        }
      }

      // Process reversed decal changes
      let undoDecals = targetGrid.decals.decals;
      let undoNextDecalId = targetGrid.decals.nextDecalId;
      if (reversed.decalChanges && reversed.decalChanges.length > 0) {
        undoDecals = [...undoDecals];
        for (const dc of reversed.decalChanges) {
          if (dc.action === 'add') {
            undoDecals.push(dc.decal);
            if (dc.decal.id >= undoNextDecalId) undoNextDecalId = dc.decal.id + 1;
          } else if (dc.action === 'remove') {
            undoDecals = undoDecals.filter(d => d.id !== dc.decal.id);
          } else if (dc.action === 'update') {
            undoDecals = undoDecals.map(d => d.id === dc.decal.id ? dc.decal : d);
          }
        }
      }

      // Build updated grid
      const updatedGrid: GridData = {
        ...targetGrid,
        grid,
        entities,
        containedEntities,
        decals: { decals: undoDecals, nextDecalId: undoNextDecalId },
      };

      const newGrids = [...state.grids];
      newGrids[targetIndex] = updatedGrid;

      let undoDecalsDirty = state.decalsDirty;
      if (reversed.decalChanges && reversed.decalChanges.length > 0) {
        undoDecalsDirty = new Set(state.decalsDirty);
        undoDecalsDirty.add(targetGridUid!);
      }

      const result: EditorState = {
        ...state,
        grids: newGrids,
        entityRawComponents,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, command],
        decalsDirty: undoDecalsDirty,
        dirty: true,
      };

      return syncLegacyFields(result);
    }

    case 'REDO': {
      if (state.redoStack.length === 0) return state;
      markSceneDirty();
      const redoCmd = state.redoStack[state.redoStack.length - 1];

      if (isGridCommand(redoCmd)) {
        markAllDirty();
        const newRedoStack = state.redoStack.slice(0, -1);
        const newUndoStack = [...state.undoStack, redoCmd];
        if (newUndoStack.length > MAX_UNDO) newUndoStack.shift();

        if (redoCmd.type === 'ADD_GRID') {
          // Redo add = add the grid back
          return syncLegacyFields({
            ...state,
            grids: [...state.grids, redoCmd.gridData],
            undoStack: newUndoStack, redoStack: newRedoStack, dirty: true,
          });
        } else if (redoCmd.type === 'REMOVE_GRID') {
          // Redo remove = remove the grid again
          const removeIdx = state.grids.findIndex(g => g.gridUid === redoCmd.gridData.gridUid);
          if (removeIdx < 0) return state;
          const newGrids = state.grids.filter(g => g.gridUid !== redoCmd.gridData.gridUid);
          let newActiveIndex = state.activeGridIndex;
          if (removeIdx === state.activeGridIndex) {
            newActiveIndex = Math.min(newActiveIndex, newGrids.length - 1);
            rebuildSpatialIndex(newGrids[newActiveIndex].entities);
          } else if (removeIdx < state.activeGridIndex) {
            newActiveIndex--;
          }
          return syncLegacyFields({
            ...state, grids: newGrids, activeGridIndex: newActiveIndex,
            undoStack: newUndoStack, redoStack: newRedoStack, dirty: true,
          });
        } else {
          // RENAME_GRID, apply the new name from gridData
          const gridIdx = state.grids.findIndex(g => g.gridUid === redoCmd.gridData.gridUid);
          if (gridIdx < 0) return state;
          const newGrids = [...state.grids];
          newGrids[gridIdx] = { ...newGrids[gridIdx], name: redoCmd.gridData.name };
          return { ...state, grids: newGrids, undoStack: newUndoStack, redoStack: newRedoStack, dirty: true };
        }
      }

      const command = redoCmd as Command;
      const result = applyCommand(state, command);
      return {
        ...result,
        redoStack: state.redoStack.slice(0, -1),
      };
    }

    case 'SET_TOOL':
      return { ...state, activeTool: action.tool };

    case 'SET_PALETTE_ITEM':
      return { ...state, selectedPaletteItem: action.item };

    case 'LOAD_MAP': {
      markAllDirty();
      const { map } = action;

      // Build grids array from gridDataList if available, else fallback to legacy single-grid
      const grids: GridData[] = map.gridDataList && map.gridDataList.length > 0
        ? map.gridDataList
        : [{
          gridUid: map.gridUid,
          name: 'Grid 1',
          grid: map.grid,
          entities: map.entities,
          containedEntities: map.containedEntities ?? {},
          worldPosition: { x: 0, y: 0 },
          structuralComponents: [],
          chunkKeyOrder: map.chunkKeyOrder ?? [],
          decals: { decals: [], nextDecalId: 0 },
        }];

      // Rebuild spatial index from first grid
      rebuildSpatialIndex(grids[0]?.entities ?? []);

      // Compute nextEntityId across all grids (min 2 to reserve UIDs 0/1 for structural entities)
      let nextEntityId = 2;
      for (const gd of grids) {
        for (const e of gd.entities) {
          if (e.uid >= nextEntityId) nextEntityId = e.uid + 1;
        }
        for (const children of Object.values(gd.containedEntities)) {
          for (const child of children) {
            if (child.uid >= nextEntityId) nextEntityId = child.uid + 1;
          }
        }
      }

      const result: EditorState = {
        ...state,
        grids,
        activeGridIndex: 0,
        // Legacy aliases
        grid: grids[0]?.grid ?? createEmptyGrid(),
        entities: grids[0]?.entities ?? [],
        containedEntities: grids[0]?.containedEntities ?? {},
        mapUid: map.mapUid,
        gridUid: grids[0]?.gridUid ?? map.gridUid,
        meta: map.meta,
        maps: map.maps,
        gridUidList: map.grids,
        orphans: map.orphans,
        nullspace: map.nullspace,
        structuralEntityData: map.structuralEntityData,
        entityRawComponents: map.entityRawComponents,
        entityRawPreamble: map.entityRawPreamble,
        tilemap: map.tilemap,
        chunkKeyOrder: map.chunkKeyOrder,
        lineEnding: map.lineEnding,
        hasDocumentTerminator: map.hasDocumentTerminator,
        entityOrder: map.entityOrder,
        nextEntityId,
        undoStack: [],
        redoStack: [],
        selectedEntityUids: [],
        selectedDecalIds: [],
        decalsDirty: new Set(),
        dirty: false,
      };

      return result;
    }

    case 'NEW_MAP': {
      markAllDirty();
      rebuildSpatialIndex([]);
      const emptyGrid = createEmptyGridData(1, 'Grid 1');
      return {
        ...state,
        grids: [emptyGrid],
        activeGridIndex: 0,
        // Legacy aliases
        grid: emptyGrid.grid,
        entities: emptyGrid.entities,
        containedEntities: emptyGrid.containedEntities,
        mapUid: 0,
        gridUid: 1,
        meta: { format: 6, postmapinit: false },
        maps: undefined,
        gridUidList: undefined,
        orphans: undefined,
        nullspace: undefined,
        structuralEntityData: undefined,
        entityRawComponents: undefined,
        entityRawPreamble: undefined,
        tilemap: undefined,
        chunkKeyOrder: undefined,
        lineEnding: undefined,
        hasDocumentTerminator: undefined,
        entityOrder: undefined,
        nextEntityId: 2,  // UIDs 0 (map) and 1 (grid) reserved for structural entities
        undoStack: [],
        redoStack: [],
        selectedDecalIds: [],
        decalsDirty: new Set(),
        dirty: false,
      };
    }

    case 'SET_REGISTRY':
      return {
        ...state,
        registry: action.registry,
      };

    case 'SELECT_ENTITY':
      markOverlayDirty();
      markConnectionsDirty();
      return {
        ...state,
        selectedEntityUids: action.uids,
      };

    case 'TOGGLE_SELECT_ENTITY': {
      markOverlayDirty();
      markConnectionsDirty();
      const uids = state.selectedEntityUids;
      const idx = uids.indexOf(action.uid);
      return {
        ...state,
        selectedEntityUids: idx >= 0
          ? uids.filter(u => u !== action.uid)
          : [...uids, action.uid],
      };
    }

    case 'ADD_SELECT_ENTITIES': {
      markOverlayDirty();
      markConnectionsDirty();
      const existing = new Set(state.selectedEntityUids);
      const newUids = action.uids.filter(u => !existing.has(u));
      return {
        ...state,
        selectedEntityUids: [...state.selectedEntityUids, ...newUids],
      };
    }

    case 'REMOVE_SELECT_ENTITIES': {
      markOverlayDirty();
      markConnectionsDirty();
      const removeSet = new Set(action.uids);
      return {
        ...state,
        selectedEntityUids: state.selectedEntityUids.filter(uid => !removeSet.has(uid)),
      };
    }

    case 'SELECT_DECAL': {
      markOverlayDirty();
      return { ...state, selectedDecalIds: action.ids };
    }

    case 'TOGGLE_SELECT_DECAL': {
      markOverlayDirty();
      const idx = state.selectedDecalIds.indexOf(action.id);
      if (idx >= 0) {
        return { ...state, selectedDecalIds: state.selectedDecalIds.filter(id => id !== action.id) };
      }
      return { ...state, selectedDecalIds: [...state.selectedDecalIds, action.id] };
    }

    case 'ADD_SELECT_DECALS': {
      markOverlayDirty();
      const existing = new Set(state.selectedDecalIds);
      const newIds = action.ids.filter(id => !existing.has(id));
      if (newIds.length === 0) return state;
      return { ...state, selectedDecalIds: [...state.selectedDecalIds, ...newIds] };
    }

    case 'REMOVE_SELECT_DECALS': {
      markOverlayDirty();
      const removeSet = new Set(action.ids);
      return { ...state, selectedDecalIds: state.selectedDecalIds.filter(id => !removeSet.has(id)) };
    }

    case 'SET_LIGHTING_ENABLED':
      return { ...state, lightingEnabled: action.enabled };

    case 'SET_ACTIVE_GRID': {
      const newIndex = Math.max(0, Math.min(action.index, state.grids.length - 1));
      if (newIndex === state.activeGridIndex) return state;
      const newActive = getActiveGrid(state.grids, newIndex);
      rebuildSpatialIndex(newActive.entities);
      markAllDirty();
      return {
        ...state,
        activeGridIndex: newIndex,
        // Legacy aliases
        grid: newActive.grid,
        entities: newActive.entities,
        containedEntities: newActive.containedEntities,
        gridUid: newActive.gridUid,
        selectedEntityUids: [],
      };
    }

    case 'ADD_GRID': {
      markAllDirty();
      // Find next available grid UID
      let maxUid = 0;
      for (const g of state.grids) {
        if (g.gridUid > maxUid) maxUid = g.gridUid;
      }
      const newGridUid = maxUid + 1;
      const newGrid = createEmptyGridData(newGridUid, action.name);
      if (action.worldPosition) {
        newGrid.worldPosition = action.worldPosition;
      }
      const gridCmd: GridCommand = { type: 'ADD_GRID', gridData: newGrid };
      const addUndoStack = [...state.undoStack, gridCmd];
      if (addUndoStack.length > MAX_UNDO) addUndoStack.shift();
      return {
        ...state,
        grids: [...state.grids, newGrid],
        undoStack: addUndoStack,
        redoStack: [],
        dirty: true,
      };
    }

    case 'REMOVE_GRID': {
      if (state.grids.length <= 1) return state; // Can't remove last grid
      markAllDirty();
      const removeIndex = state.grids.findIndex(g => g.gridUid === action.gridUid);
      if (removeIndex < 0) return state;

      const removedGrid = state.grids[removeIndex];
      const gridCmd: GridCommand = { type: 'REMOVE_GRID', gridData: removedGrid, insertIndex: removeIndex };
      const removeUndoStack = [...state.undoStack, gridCmd];
      if (removeUndoStack.length > MAX_UNDO) removeUndoStack.shift();

      const newGrids = state.grids.filter(g => g.gridUid !== action.gridUid);
      let newActiveIndex = state.activeGridIndex;
      if (removeIndex === state.activeGridIndex) {
        newActiveIndex = Math.min(newActiveIndex, newGrids.length - 1);
        rebuildSpatialIndex(newGrids[newActiveIndex].entities);
      } else if (removeIndex < state.activeGridIndex) {
        newActiveIndex--;
      }

      const result: EditorState = {
        ...state,
        grids: newGrids,
        activeGridIndex: newActiveIndex,
        undoStack: removeUndoStack,
        redoStack: [],
        dirty: true,
      };
      return syncLegacyFields(result);
    }

    case 'RENAME_GRID': {
      const renameIdx = state.grids.findIndex(g => g.gridUid === action.gridUid);
      if (renameIdx < 0) return state;
      const previousName = state.grids[renameIdx].name;
      const renamedGrid = { ...state.grids[renameIdx], name: action.name };
      const gridCmd: GridCommand = { type: 'RENAME_GRID', gridData: renamedGrid, previousName };
      const renameUndoStack = [...state.undoStack, gridCmd];
      if (renameUndoStack.length > MAX_UNDO) renameUndoStack.shift();
      const newGrids = [...state.grids];
      newGrids[renameIdx] = renamedGrid;
      return { ...state, grids: newGrids, undoStack: renameUndoStack, redoStack: [], dirty: true };
    }

    case 'ADD_CONTAINED_ENTITY': {
      markSceneDirty();
      const activeGrid = getActiveGrid(state.grids, state.activeGridIndex);
      const parentIdx = activeGrid.entities.findIndex(e => e.uid === action.parentUid);
      if (parentIdx < 0) return state;

      const childUid = state.nextEntityId;
      const childEntity: ImportedEntity = {
        uid: childUid,
        prototype: action.prototypeId,
        position: { x: 0, y: 0 },
        rotation: 0,
        components: [
          { type: 'Transform', parent: action.parentUid },
          { type: 'Physics', canCollide: false },
        ],
      };

      // Deep clone parent entity and update ContainerContainer
      const parent = activeGrid.entities[parentIdx];
      const previousParentComponents = parent.components.map(c => ({ ...c }));
      const newComponents = parent.components.map(c => ({ ...c }));
      let ccIdx = newComponents.findIndex((c: any) => c.type === 'ContainerContainer');
      if (ccIdx < 0) {
        newComponents.push({
          type: 'ContainerContainer',
          containers: { entity_storage: { ents: [] } },
        });
        ccIdx = newComponents.length - 1;
      }
      const cc = { ...newComponents[ccIdx] } as any;
      const containers = { ...cc.containers };
      const storage = { ...(containers.entity_storage ?? { ents: [] }) };
      storage.ents = [...(storage.ents ?? []), childUid];
      containers.entity_storage = storage;
      cc.containers = containers;
      newComponents[ccIdx] = cc;

      const newParent = { ...parent, components: newComponents };
      const entities = [...activeGrid.entities];
      entities[parentIdx] = newParent;

      // Add to containedEntities
      const containedEntities = { ...activeGrid.containedEntities };
      containedEntities[action.parentUid] = [
        ...(containedEntities[action.parentUid] ?? []),
        childEntity,
      ];

      // Build command for undo
      const command: Command = {
        label: `Add ${action.prototypeId} to container`,
        tileChanges: [],
        entityChanges: [],
        containedEntityChanges: [{
          action: 'add',
          parentUid: action.parentUid,
          entity: childEntity,
          previousParentComponents,
        }],
        gridUid: activeGrid.gridUid,
      };

      const undoStack = [...state.undoStack, command];
      if (undoStack.length > MAX_UNDO) undoStack.shift();

      // Invalidate raw YAML for parent
      let entityRawComponents = state.entityRawComponents;
      if (entityRawComponents) {
        entityRawComponents = { ...entityRawComponents };
        delete entityRawComponents[action.parentUid];
      }

      // Build updated grid
      const updatedGrid: GridData = {
        ...activeGrid,
        entities,
        containedEntities,
      };

      const newGrids = [...state.grids];
      newGrids[state.activeGridIndex] = updatedGrid;

      const result: EditorState = {
        ...state,
        grids: newGrids,
        entityRawComponents,
        nextEntityId: childUid + 1,
        undoStack,
        redoStack: [],
        dirty: true,
      };

      return syncLegacyFields(result);
    }

    case 'REMOVE_CONTAINED_ENTITY': {
      markSceneDirty();
      const activeGrid = getActiveGrid(state.grids, state.activeGridIndex);
      const parentList = activeGrid.containedEntities[action.parentUid];
      if (!parentList) return state;
      const childIdx = parentList.findIndex(e => e.uid === action.entityUid);
      if (childIdx < 0) return state;

      const removedEntity = parentList[childIdx];

      // Update containedEntities
      const containedEntities = { ...activeGrid.containedEntities };
      const newList = parentList.filter(e => e.uid !== action.entityUid);
      if (newList.length === 0) {
        delete containedEntities[action.parentUid];
      } else {
        containedEntities[action.parentUid] = newList;
      }

      // Update parent entity's ContainerContainer ents
      const parentIdx = activeGrid.entities.findIndex(e => e.uid === action.parentUid);
      let entities = activeGrid.entities;
      let previousParentComponents: Record<string, unknown>[] | undefined;
      if (parentIdx >= 0) {
        const parent = activeGrid.entities[parentIdx];
        previousParentComponents = parent.components.map(c => ({ ...c }));
        const newComponents = parent.components.map(c => ({ ...c }));
        const ccCompIdx = newComponents.findIndex((c: any) => c.type === 'ContainerContainer');
        if (ccCompIdx >= 0) {
          const cc2 = { ...newComponents[ccCompIdx] } as any;
          const containers2 = { ...cc2.containers };
          const storage2 = { ...(containers2.entity_storage ?? { ents: [] }) };
          storage2.ents = (storage2.ents ?? []).filter((uid: number) => uid !== action.entityUid);
          containers2.entity_storage = storage2;
          cc2.containers = containers2;
          newComponents[ccCompIdx] = cc2;
        }
        const newParent = { ...parent, components: newComponents };
        entities = [...activeGrid.entities];
        entities[parentIdx] = newParent;
      }

      // Build command for undo
      const command: Command = {
        label: `Remove ${removedEntity.prototype} from container`,
        tileChanges: [],
        entityChanges: [],
        containedEntityChanges: [{
          action: 'remove',
          parentUid: action.parentUid,
          entity: removedEntity,
          previousParentComponents,
        }],
        gridUid: activeGrid.gridUid,
      };

      const undoStack = [...state.undoStack, command];
      if (undoStack.length > MAX_UNDO) undoStack.shift();

      // Invalidate raw YAML for parent and removed child
      let entityRawComponents = state.entityRawComponents;
      if (entityRawComponents) {
        entityRawComponents = { ...entityRawComponents };
        delete entityRawComponents[action.parentUid];
        delete entityRawComponents[action.entityUid];
      }

      // Build updated grid
      const updatedGrid: GridData = {
        ...activeGrid,
        entities,
        containedEntities,
      };

      const newGrids = [...state.grids];
      newGrids[state.activeGridIndex] = updatedGrid;

      const result: EditorState = {
        ...state,
        grids: newGrids,
        entityRawComponents,
        undoStack,
        redoStack: [],
        dirty: true,
      };

      return syncLegacyFields(result);
    }

    default:
      return state;
  }
}
