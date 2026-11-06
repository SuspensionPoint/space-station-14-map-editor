import type {
  TileGrid, TileCell, ToolType, PaletteItem, UndoableCommand,
} from '../types';
import type { ImportedEntity, MapMeta } from '../import/mapImporter';
import type { IPrototypeRegistry } from '../loaders/registryTypes';
import type { GridData } from './gridData';
import { createEmptyGridData, getActiveGrid } from './gridData';

export interface EditorState {
  // Multi-grid map data (the document)
  grids: GridData[];
  activeGridIndex: number;

  // Legacy single-grid aliases (DEPRECATED, kept temporarily for consumers not yet migrated)
  /** @deprecated Use grids[activeGridIndex].grid, will be removed in Task 6 */
  grid: TileGrid;
  /** @deprecated Use grids[activeGridIndex].entities, will be removed in Task 6 */
  entities: ImportedEntity[];
  /** @deprecated Use grids[activeGridIndex].containedEntities, will be removed in Task 6 */
  containedEntities: Record<number, ImportedEntity[]>;

  // Editor UI state
  activeTool: ToolType;
  selectedPaletteItem: PaletteItem | null;
  nextEntityId: number;

  // History
  undoStack: UndoableCommand[];
  redoStack: UndoableCommand[];

  // Resources (loaded once)
  registry: IPrototypeRegistry | null;

  // Import/Export metadata (preserved for roundtrip fidelity)
  mapUid: number;
  /** @deprecated Use grids[0].gridUid, will be removed when all consumers migrate */
  gridUid: number;
  meta: MapMeta;
  maps?: number[];
  /** Grid UID list from the YAML file's top-level `grids:` key */
  gridUidList?: number[];
  /** UIDs from the YAML file's top-level `orphans:` key */
  orphans?: number[];
  /** UIDs from the YAML file's top-level `nullspace:` key */
  nullspace?: number[];
  structuralEntityData?: Record<number, Record<string, unknown>[]>;
  entityRawComponents?: Record<number, string[]>;
  entityRawPreamble?: Record<number, string[]>;
  tilemap?: Record<number, string>;
  /** @deprecated Now per-grid in GridData.chunkKeyOrder */
  chunkKeyOrder?: string[];
  lineEnding?: string;
  hasDocumentTerminator?: boolean;
  entityOrder?: number[];

  // Entity selection (supports multi-select)
  selectedEntityUids: number[];
  selectedDecalIds: number[];
  decalsDirty: Set<number>;  // grid UIDs with modified decals

  // Lighting preview
  lightingEnabled: boolean;

  // Metadata
  dirty: boolean;
}

// ---- Grid helpers (world coordinates) ----

/** Expand grid to contain the given world-coordinate bounding box. */
export function ensureGridContainsBounds(
  grid: TileGrid, minWX: number, minWY: number, maxWX: number, maxWY: number, padding = 16,
): TileGrid {
  if (grid.width === 0) {
    // Empty grid, create new one centered around the bounds
    const newOffsetX = minWX - padding;
    const newOffsetY = minWY - padding;
    const newWidth = (maxWX - minWX + 1) + padding * 2;
    const newHeight = (maxWY - minWY + 1) + padding * 2;
    const cells: TileCell[] = new Array(newWidth * newHeight);
    for (let i = 0; i < cells.length; i++) cells[i] = { tileId: 'Space' };
    return { width: newWidth, height: newHeight, offsetX: newOffsetX, offsetY: newOffsetY, cells };
  }

  let newOffsetX = grid.offsetX;
  let newOffsetY = grid.offsetY;
  let newMaxX = grid.offsetX + grid.width;
  let newMaxY = grid.offsetY + grid.height;
  let changed = false;

  if (minWX < grid.offsetX) { newOffsetX = minWX - padding; changed = true; }
  if (minWY < grid.offsetY) { newOffsetY = minWY - padding; changed = true; }
  if (maxWX >= grid.offsetX + grid.width) { newMaxX = maxWX + 1 + padding; changed = true; }
  if (maxWY >= grid.offsetY + grid.height) { newMaxY = maxWY + 1 + padding; changed = true; }

  if (!changed) return grid;

  const newWidth = newMaxX - newOffsetX;
  const newHeight = newMaxY - newOffsetY;
  const cells: TileCell[] = new Array(newWidth * newHeight);
  for (let i = 0; i < cells.length; i++) cells[i] = { tileId: 'Space' };

  // Copy old cells
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const nx = (grid.offsetX + x) - newOffsetX;
      const ny = (grid.offsetY + y) - newOffsetY;
      cells[ny * newWidth + nx] = grid.cells[y * grid.width + x];
    }
  }

  return { width: newWidth, height: newHeight, offsetX: newOffsetX, offsetY: newOffsetY, cells };
}

/** Expand grid to contain a single world coordinate. */
export function ensureGridContains(grid: TileGrid, worldX: number, worldY: number, padding = 16): TileGrid {
  return ensureGridContainsBounds(grid, worldX, worldY, worldX, worldY, padding);
}

/** Get a cell by world coordinate. Returns null if outside grid. */
export function getCell(grid: TileGrid, worldX: number, worldY: number): TileCell | null {
  const lx = worldX - grid.offsetX;
  const ly = worldY - grid.offsetY;
  if (lx < 0 || lx >= grid.width || ly < 0 || ly >= grid.height) return null;
  return grid.cells[ly * grid.width + lx];
}

/** Set a cell by world coordinate. No-op if outside grid. */
export function setCell(grid: TileGrid, worldX: number, worldY: number, cell: TileCell): void {
  const lx = worldX - grid.offsetX;
  const ly = worldY - grid.offsetY;
  if (lx < 0 || lx >= grid.width || ly < 0 || ly >= grid.height) return;
  grid.cells[ly * grid.width + lx] = cell;
}

export function createEmptyGrid(): TileGrid {
  return { width: 0, height: 0, offsetX: 0, offsetY: 0, cells: [] };
}

export function createInitialState(): EditorState {
  const emptyGrid = createEmptyGridData(1, 'Grid 1');
  return {
    grids: [emptyGrid],
    activeGridIndex: 0,
    // Legacy aliases
    grid: emptyGrid.grid,
    entities: emptyGrid.entities,
    containedEntities: emptyGrid.containedEntities,
    activeTool: 'pan',
    selectedPaletteItem: { type: 'tile', id: 'Plating' },
    nextEntityId: 2,  // UIDs 0 (map) and 1 (grid) are reserved for structural entities
    selectedEntityUids: [],
    selectedDecalIds: [],
    decalsDirty: new Set(),
    undoStack: [],
    redoStack: [],
    registry: null,
    mapUid: 0,
    gridUid: 1,
    meta: { format: 6 },
    lightingEnabled: false,
    dirty: false,
  };
}
