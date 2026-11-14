import type { ITool, ToolContext } from './toolTypes';
import type { TileChange, EntityChange, DecalChange } from '../types';
import type { ImportedEntity } from '../import/mapImporter';
import type { DecalInstance } from '../import/decalParser';
import { getCell, setCell, ensureGridContainsBounds } from '../state/editorState';
import { getClipboard, setClipboard } from '../state/clipboard';
import type { ClipboardData, ClipboardEntity, ClipboardDecal } from '../state/clipboard';
import type { ContextMenuItem } from '../components/ContextMenu';
import { serializePrefab } from '../prefab/prefabSerializer';
import { downloadPrefab } from '../prefab/prefabIO';
import { updateTransformPos, updateTransformRot, normalizeRotation, cloneComponentsWithPos, cloneComponentsWithPosRot, collectContained, instantiateCopies } from './entityHelpers';
import { markOverlayDirty } from '../rendering/dirtyFlags';
import { spatialGetInRect, tileKey } from '../rendering/spatialIndex';

type SelectPhase = 'idle' | 'selecting' | 'selected' | 'moving' | 'pasting';

export class SelectTool implements ITool {
  name = 'select';
  cursor = 'crosshair';

  private phase: SelectPhase = 'idle';
  // Selection rectangle (world coords, inclusive), derived from selectedTiles via computeBounds()
  private selMinX = 0;
  private selMinY = 0;
  private selMaxX = 0;
  private selMaxY = 0;
  // Tile-level selection set (keys are "x,y")
  private selectedTiles: Set<string> = new Set();
  private selectMode: 'replace' | 'add' | 'subtract' = 'replace';
  // Drag start (for marquee)
  private dragStartX = 0;
  private dragStartY = 0;
  // Move state
  private moveOriginX = 0;
  private moveOriginY = 0;
  private moveOffsetX = 0;
  private moveOffsetY = 0;
  private moveSnapshotTiles: TileChange[] = [];
  private moveSnapshotEntities: ImportedEntity[] = [];
  private moveSnapshotDecals: DecalInstance[] = [];
  // Paste offset
  private pasteX = 0;
  private pasteY = 0;
  private pasteData: ClipboardData | null = null;

  /** Compute bounding box from the tile set. Returns null if empty. */
  private computeBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (this.selectedTiles.size === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const key of this.selectedTiles) {
      const comma = key.indexOf(',');
      const x = parseInt(key.substring(0, comma), 10);
      const y = parseInt(key.substring(comma + 1), 10);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  /** Update selMin/Max from the tile set bounds. */
  private syncBoundsFromTiles(): void {
    const bounds = this.computeBounds();
    if (bounds) {
      this.selMinX = bounds.minX;
      this.selMinY = bounds.minY;
      this.selMaxX = bounds.maxX;
      this.selMaxY = bounds.maxY;
    }
  }

  onMouseDown(ctx: ToolContext, tileX: number, tileY: number, button: number) {
    if (button !== 0) return;

    // Capture selection mode from modifier keys
    this.selectMode = ctx.ctrlHeld ? 'subtract' : ctx.shiftHeld ? 'add' : 'replace';

    if (this.phase === 'pasting') {
      this.commitPaste(ctx);
      return;
    }

    if (this.phase === 'selected' || this.phase === 'moving') {
      // Click inside selection = start move (only in replace mode)
      if (this.selectMode === 'replace' && this.isInsideSelection(tileX, tileY)) {
        this.startMove(ctx, tileX, tileY);
        return;
      }
      // Click outside with replace mode = clear and start fresh
      if (this.selectMode === 'replace') {
        this.selectedTiles.clear();
        this.phase = 'idle';
      }
      // For add/subtract modes, keep existing selection and start new marquee
    }

    // Start new selection marquee
    this.phase = 'selecting';
    this.dragStartX = tileX;
    this.dragStartY = tileY;
    this.selMinX = tileX;
    this.selMinY = tileY;
    this.selMaxX = tileX;
    this.selMaxY = tileY;
  }

  onMouseMove(_ctx: ToolContext, tileX: number, tileY: number) {
    if (this.phase === 'selecting') {
      this.selMinX = Math.min(this.dragStartX, tileX);
      this.selMinY = Math.min(this.dragStartY, tileY);
      this.selMaxX = Math.max(this.dragStartX, tileX);
      this.selMaxY = Math.max(this.dragStartY, tileY);
    } else if (this.phase === 'moving') {
      this.moveOffsetX = tileX - this.moveOriginX;
      this.moveOffsetY = tileY - this.moveOriginY;
    } else if (this.phase === 'pasting') {
      this.pasteX = tileX;
      this.pasteY = tileY;
    }
  }

  onMouseUp(ctx: ToolContext) {
    if (this.phase === 'selecting') {
      // Build tile set from the marquee box
      const boxTiles = new Set<string>();
      for (let y = this.selMinY; y <= this.selMaxY; y++) {
        for (let x = this.selMinX; x <= this.selMaxX; x++) {
          boxTiles.add(`${x},${y}`);
        }
      }

      // Apply set operation based on mode
      if (this.selectMode === 'add') {
        for (const key of boxTiles) this.selectedTiles.add(key);
      } else if (this.selectMode === 'subtract') {
        for (const key of boxTiles) this.selectedTiles.delete(key);
      } else {
        this.selectedTiles = boxTiles;
      }

      // Update bounding rect from tile set for backward compat
      const bounds = this.computeBounds();
      if (bounds) {
        this.selMinX = bounds.minX;
        this.selMinY = bounds.minY;
        this.selMaxX = bounds.maxX;
        this.selMaxY = bounds.maxY;
        this.phase = 'selected';
      } else {
        this.phase = 'idle';
      }
    } else if (this.phase === 'moving') {
      this.commitMove(ctx);
    }
  }

  /** Check if a tile is inside the current selection. */
  private isInsideSelection(tileX: number, tileY: number): boolean {
    return this.selectedTiles.has(`${tileX},${tileY}`);
  }

  /** Get all entities within the selection bounds, filtered to selected tiles only. */
  private getEntitiesInSelection(_entities: ImportedEntity[]): ImportedEntity[] {
    const bounds = this.computeBounds();
    if (!bounds) return [];
    const candidates = spatialGetInRect(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
    return candidates.filter(e => {
      const tx = Math.floor(e.position.x);
      const ty = Math.floor(e.position.y);
      return this.selectedTiles.has(`${tx},${ty}`);
    });
  }

  /** Get all decals within the selected tiles. */
  private getDecalsInSelection(ctx: ToolContext): DecalInstance[] {
    if (this.selectedTiles.size === 0) return [];
    const activeGrid = ctx.state.grids[ctx.state.activeGridIndex];
    return activeGrid.decals.decals.filter(d => {
      const tx = Math.floor(d.position.x);
      const ty = Math.floor(d.position.y);
      return this.selectedTiles.has(`${tx},${ty}`);
    });
  }

  /** Copy selection to clipboard */
  copy(ctx: ToolContext) {
    if (this.phase !== 'selected') return;
    const bounds = this.computeBounds();
    if (!bounds) return;
    const w = bounds.maxX - bounds.minX + 1;
    const h = bounds.maxY - bounds.minY + 1;

    // Copy tiles, only include tiles in selectedTiles, null for gaps
    const tiles: (import('../types').TileCell | null)[] = [];
    for (let y = bounds.minY; y <= bounds.maxY; y++) {
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        if (this.selectedTiles.has(`${x},${y}`)) {
          const cell = getCell(ctx.state.grid, x, y);
          tiles.push(cell ? { ...cell } : null);
        } else {
          tiles.push(null);
        }
      }
    }

    // Copy entities (store as relative offsets)
    const clipEntities: ClipboardEntity[] = [];
    const selEntities = this.getEntitiesInSelection(ctx.state.entities);
    for (const e of selEntities) {
      clipEntities.push({
        uid: e.uid,
        dx: e.position.x - bounds.minX,
        dy: e.position.y - bounds.minY,
        prototype: e.prototype,
        rotation: e.rotation,
        components: e.components.map(c => ({ ...c })),
        ...(e.spriteStateOverride ? { spriteStateOverride: e.spriteStateOverride } : {}),
      });
    }

    // Copy decals (store as relative offsets)
    const clipDecals: ClipboardDecal[] = [];
    const selDecals = this.getDecalsInSelection(ctx);
    for (const d of selDecals) {
      clipDecals.push({
        dx: d.position.x - bounds.minX,
        dy: d.position.y - bounds.minY,
        prototypeId: d.prototypeId,
        color: d.color,
        angle: d.angle,
        zIndex: d.zIndex,
        cleanable: d.cleanable,
      });
    }

    setClipboard({
      width: w, height: h, tiles, entities: clipEntities, decals: clipDecals,
      contained: collectContained(ctx.state.containedEntities, selEntities.map(e => e.uid)),
      originX: bounds.minX, originY: bounds.minY,
    });
  }

  /** Cut = copy + clear */
  cut(ctx: ToolContext) {
    this.copy(ctx);
    this.deleteSelection(ctx);
  }

  /** Delete selection (set tiles to Space, remove entities) */
  deleteSelection(ctx: ToolContext) {
    if (this.phase !== 'selected') return;

    const tileChanges: TileChange[] = [];
    for (const key of this.selectedTiles) {
      const comma = key.indexOf(',');
      const x = parseInt(key.substring(0, comma), 10);
      const y = parseInt(key.substring(comma + 1), 10);
      const cell = getCell(ctx.state.grid, x, y);
      if (!cell || cell.tileId === 'Space') continue;
      const before = { ...cell };
      const after = { tileId: 'Space' };
      setCell(ctx.state.grid, x, y, after);
      tileChanges.push({ x, y, before, after });
    }

    const entityChanges: EntityChange[] = [];
    const selEntities = this.getEntitiesInSelection(ctx.state.entities);
    for (const e of selEntities) {
      entityChanges.push({ action: 'remove', entity: e });
    }

    const decalChanges: DecalChange[] = [];
    const selDecals = this.getDecalsInSelection(ctx);
    for (const d of selDecals) {
      decalChanges.push({ action: 'remove', decal: d });
    }

    if (tileChanges.length > 0 || entityChanges.length > 0 || decalChanges.length > 0) {
      ctx.dispatch({
        type: 'APPLY_COMMAND',
        command: {
          label: 'Delete selection',
          tileChanges,
          entityChanges,
          decalChanges: decalChanges.length > 0 ? decalChanges : undefined,
        },
      });
    }
    this.phase = 'idle';
    this.selectedTiles.clear();
  }

  /** Rotate the selection or paste preview 90 degrees (tiles + entities positionally). */
  rotateSelection(ctx: ToolContext, direction: 'cw' | 'ccw') {
    // Paste mode: rotate the clipboard data in place
    if (this.phase === 'pasting' && this.pasteData) {
      const rotated = this.rotateRegion(this.pasteData, direction);
      this.pasteData = { ...this.pasteData, ...rotated };
      markOverlayDirty();
      return;
    }

    if (this.phase !== 'selected') return;

    const W = this.selMaxX - this.selMinX + 1;
    const H = this.selMaxY - this.selMinY + 1;

    // Capture tiles
    const tiles: (import('../types').TileCell | null)[] = [];
    for (let y = this.selMinY; y <= this.selMaxY; y++) {
      for (let x = this.selMinX; x <= this.selMaxX; x++) {
        const cell = getCell(ctx.state.grid, x, y);
        tiles.push(cell ? { ...cell } : null);
      }
    }

    // Capture entities as relative offsets
    const selEntities = this.getEntitiesInSelection(ctx.state.entities);
    const clipEntities: ClipboardEntity[] = selEntities.map(e => ({
      uid: e.uid,
      dx: e.position.x - this.selMinX,
      dy: e.position.y - this.selMinY,
      prototype: e.prototype,
      rotation: e.rotation,
      components: e.components.map(c => ({ ...c })),
      ...(e.spriteStateOverride ? { spriteStateOverride: e.spriteStateOverride } : {}),
    }));

    // Rotate
    const rotated = this.rotateRegion({ width: W, height: H, tiles, entities: clipEntities }, direction);
    const newW = rotated.width;
    const newH = rotated.height;

    // New selection bounds centered on original center
    const centerX = (this.selMinX + this.selMaxX) / 2;
    const centerY = (this.selMinY + this.selMaxY) / 2;
    const newMinX = Math.round(centerX - (newW - 1) / 2);
    const newMinY = Math.round(centerY - (newH - 1) / 2);
    const newMaxX = newMinX + newW - 1;
    const newMaxY = newMinY + newH - 1;

    // Ensure grid covers both old and new bounds
    const allMinX = Math.min(this.selMinX, newMinX);
    const allMinY = Math.min(this.selMinY, newMinY);
    const allMaxX = Math.max(this.selMaxX, newMaxX);
    const allMaxY = Math.max(this.selMaxY, newMaxY);
    const expanded = ensureGridContainsBounds(ctx.state.grid, allMinX, allMinY, allMaxX, allMaxY, 0);
    if (expanded !== ctx.state.grid) {
      ctx.state.grid = expanded;
    }

    const tileChanges: TileChange[] = [];
    const entityChanges: EntityChange[] = [];

    // Clear original tiles
    for (let y = this.selMinY; y <= this.selMaxY; y++) {
      for (let x = this.selMinX; x <= this.selMaxX; x++) {
        const cell = getCell(ctx.state.grid, x, y);
        if (cell && cell.tileId !== 'Space') {
          tileChanges.push({ x, y, before: { ...cell }, after: { tileId: 'Space' } });
          setCell(ctx.state.grid, x, y, { tileId: 'Space' });
        }
      }
    }

    // Place rotated tiles
    // Build index for O(1) lookup of existing tile changes
    const tileChangeIndex = new Map<number, number>();
    for (let i = 0; i < tileChanges.length; i++) {
      tileChangeIndex.set(tileKey(tileChanges[i].x, tileChanges[i].y), i);
    }

    for (let dy = 0; dy < newH; dy++) {
      for (let dx = 0; dx < newW; dx++) {
        const tile = rotated.tiles[dy * newW + dx];
        if (!tile || tile.tileId === 'Space') continue;
        const wx = newMinX + dx;
        const wy = newMinY + dy;
        const cell = getCell(ctx.state.grid, wx, wy);
        if (!cell) continue;
        const key = tileKey(wx, wy);
        const existingIdx = tileChangeIndex.get(key);
        if (existingIdx !== undefined) {
          tileChanges[existingIdx].after = { ...tile };
        } else {
          const newIdx = tileChanges.length;
          tileChanges.push({ x: wx, y: wy, before: { ...cell }, after: { ...tile } });
          tileChangeIndex.set(key, newIdx);
        }
        setCell(ctx.state.grid, wx, wy, { ...tile });
      }
    }

    // Remove original entities
    for (const e of selEntities) {
      entityChanges.push({ action: 'remove', entity: e });
    }

    // Add rotated entities under the same UIDs
    for (const ce of rotated.entities) {
      const newPos = { x: newMinX + ce.dx, y: newMinY + ce.dy };
      const comps = cloneComponentsWithPosRot(ce.components, newPos, ce.rotation);
      const entity: ImportedEntity = {
        uid: ce.uid!,
        prototype: ce.prototype,
        position: newPos,
        rotation: ce.rotation,
        components: comps,
        ...(ce.spriteStateOverride ? { spriteStateOverride: ce.spriteStateOverride } : {}),
      };
      entityChanges.push({ action: 'add', entity });
    }

    // Rotate decals, use tile-index transform (W-1, H-1) since decal positions
    // are integer tile-origin, not tile-center like entities
    const decalChanges: DecalChange[] = [];
    const selDecals = this.getDecalsInSelection(ctx);
    const delta = direction === 'cw' ? -Math.PI / 2 : Math.PI / 2;
    for (const d of selDecals) {
      const relX = d.position.x - this.selMinX;
      const relY = d.position.y - this.selMinY;
      let newRelX: number, newRelY: number;
      if (direction === 'cw') {
        newRelX = relY;
        newRelY = W - 1 - relX;
      } else {
        newRelX = H - 1 - relY;
        newRelY = relX;
      }
      const rotatedDecal: DecalInstance = {
        ...d,
        position: { x: newMinX + newRelX, y: newMinY + newRelY },
        angle: d.angle + delta,
      };
      decalChanges.push({ action: 'update', decal: rotatedDecal, previousDecal: d });
    }

    if (tileChanges.length > 0 || entityChanges.length > 0 || decalChanges.length > 0) {
      const dirLabel = direction === 'cw' ? 'CW' : 'CCW';
      ctx.dispatch({
        type: 'APPLY_COMMAND',
        command: {
          label: `Rotate selection ${dirLabel}`,
          tileChanges,
          entityChanges,
          decalChanges: decalChanges.length > 0 ? decalChanges : undefined,
        },
      });
    }

    // Rebuild selectedTiles for the new rotated bounds
    this.selectedTiles.clear();
    for (let y = newMinY; y <= newMaxY; y++) {
      for (let x = newMinX; x <= newMaxX; x++) {
        this.selectedTiles.add(`${x},${y}`);
      }
    }

    // Update selection bounds
    this.selMinX = newMinX;
    this.selMinY = newMinY;
    this.selMaxX = newMaxX;
    this.selMaxY = newMaxY;
    markOverlayDirty();
  }

  /** Rotate a region of tiles + entities + decals 90 degrees. */
  private rotateRegion(
    data: { width: number; height: number; tiles: (import('../types').TileCell | null)[]; entities: ClipboardEntity[]; decals?: ClipboardDecal[] },
    direction: 'cw' | 'ccw',
  ): { width: number; height: number; tiles: (import('../types').TileCell | null)[]; entities: ClipboardEntity[]; decals?: ClipboardDecal[] } {
    const { width: W, height: H, tiles, entities } = data;
    const newW = H;
    const newH = W;
    const newTiles: (import('../types').TileCell | null)[] = new Array(newW * newH).fill(null);

    // In Y-up coordinates: CW maps (x,y) → (y, W-1-x), CCW maps (x,y) → (H-1-y, x)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const src = tiles[y * W + x];
        if (!src) continue;
        let nx: number, ny: number;
        if (direction === 'cw') {
          nx = y;
          ny = W - 1 - x;
        } else {
          nx = H - 1 - y;
          ny = x;
        }
        newTiles[ny * newW + nx] = src;
      }
    }

    const delta = direction === 'cw' ? -Math.PI / 2 : Math.PI / 2;
    const newEntities: ClipboardEntity[] = entities.map(e => {
      let newDx: number, newDy: number;
      // Entity positions are fractional (tile centers at x+0.5), so the mapping
      // uses W/H (not W-1/H-1) to correctly place entities at the center of the
      // destination tile. Tile index mapping: CW (x,y)→(y, W-1-x). An entity at
      // center (x+0.5) of tile x maps to center (W-1-x)+0.5 = W - (x+0.5) = W - dx.
      if (direction === 'cw') {
        newDx = e.dy;
        newDy = W - e.dx;
      } else {
        newDx = H - e.dy;
        newDy = e.dx;
      }
      return {
        ...e,
        dx: newDx,
        dy: newDy,
        rotation: normalizeRotation(e.rotation + delta),
      };
    });

    // Rotate decals, use tile-index transform (W-1, H-1) since decal positions are
    // integer tile-origin, not tile-center like entities
    const newDecals: ClipboardDecal[] | undefined = data.decals?.map(d => {
      let newDx: number, newDy: number;
      if (direction === 'cw') {
        newDx = d.dy;
        newDy = W - 1 - d.dx;
      } else {
        newDx = H - 1 - d.dy;
        newDy = d.dx;
      }
      return { ...d, dx: newDx, dy: newDy, angle: d.angle + delta };
    });

    return { width: newW, height: newH, tiles: newTiles, entities: newEntities, decals: newDecals };
  }

  /** Enter paste mode */
  paste(ctx: ToolContext) {
    const clip = getClipboard();
    if (!clip) return;
    this.pasteData = clip;
    this.pasteX = clip.originX;
    this.pasteY = clip.originY;
    this.phase = 'pasting';
  }

  private commitPaste(ctx: ToolContext) {
    if (!this.pasteData) return;
    const { width, height, tiles, entities } = this.pasteData;

    const expanded = ensureGridContainsBounds(
      ctx.state.grid,
      this.pasteX, this.pasteY,
      this.pasteX + width - 1, this.pasteY + height - 1,
      0,
    );
    if (expanded !== ctx.state.grid) {
      ctx.state.grid = expanded;
    }

    // Tile changes
    const tileChanges: TileChange[] = [];
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const srcTile = tiles[dy * width + dx];
        if (!srcTile || srcTile.tileId === 'Space') continue;
        const wx = this.pasteX + dx;
        const wy = this.pasteY + dy;
        const cell = getCell(ctx.state.grid, wx, wy);
        if (!cell) continue;
        if (cell.tileId === srcTile.tileId) continue;
        const before = { ...cell };
        const after = { ...srcTile };
        setCell(ctx.state.grid, wx, wy, after);
        tileChanges.push({ x: wx, y: wy, before, after });
      }
    }

    // Entity changes, assign new UIDs and link the copies to each other
    const copies = instantiateCopies(entities.map(ce => {
      const newPos = { x: this.pasteX + ce.dx, y: this.pasteY + ce.dy };
      return {
        sourceUid: ce.uid,
        entity: {
          prototype: ce.prototype,
          position: newPos,
          rotation: ce.rotation,
          components: cloneComponentsWithPos(ce.components, newPos),
          ...(ce.spriteStateOverride ? { spriteStateOverride: ce.spriteStateOverride } : {}),
        },
      };
    }), this.pasteData.contained, ctx.state.nextEntityId);
    const entityChanges: EntityChange[] = copies.entities.map(entity => ({ action: 'add', entity }));

    // Decal changes, assign new IDs
    const decalChanges: DecalChange[] = [];
    const pasteDecals = this.pasteData.decals ?? [];
    if (pasteDecals.length > 0) {
      const activeGrid = ctx.state.grids[ctx.state.activeGridIndex];
      let nextDecalId = activeGrid.decals.nextDecalId;
      for (const cd of pasteDecals) {
        const decal: DecalInstance = {
          id: nextDecalId++,
          prototypeId: cd.prototypeId,
          position: { x: this.pasteX + cd.dx, y: this.pasteY + cd.dy },
          color: cd.color,
          angle: cd.angle,
          zIndex: cd.zIndex,
          cleanable: cd.cleanable,
        };
        decalChanges.push({ action: 'add', decal });
      }
    }

    if (tileChanges.length > 0 || entityChanges.length > 0 || decalChanges.length > 0) {
      ctx.dispatch({
        type: 'APPLY_COMMAND',
        command: {
          label: 'Paste',
          tileChanges,
          entityChanges,
          containedEntityChanges: copies.containedChanges.length > 0 ? copies.containedChanges : undefined,
          decalChanges: decalChanges.length > 0 ? decalChanges : undefined,
        },
      });
    }
    this.phase = 'idle';
    this.pasteData = null;
    this.selectedTiles.clear();
  }

  /** Start moving the selected region. */
  private startMove(ctx: ToolContext, tileX: number, tileY: number) {
    this.phase = 'moving';
    this.moveOriginX = tileX;
    this.moveOriginY = tileY;
    this.moveOffsetX = 0;
    this.moveOffsetY = 0;

    // Snapshot tiles in the selection (only selected tiles)
    this.moveSnapshotTiles = [];
    for (const key of this.selectedTiles) {
      const comma = key.indexOf(',');
      const x = parseInt(key.substring(0, comma), 10);
      const y = parseInt(key.substring(comma + 1), 10);
      const cell = getCell(ctx.state.grid, x, y);
      if (cell && cell.tileId !== 'Space') {
        this.moveSnapshotTiles.push({ x, y, before: { ...cell }, after: { tileId: 'Space' } });
      }
    }

    // Snapshot entities and decals in the selection
    this.moveSnapshotEntities = this.getEntitiesInSelection(ctx.state.entities);
    this.moveSnapshotDecals = this.getDecalsInSelection(ctx);
  }

  /** Commit the move operation as a single undoable command. */
  private commitMove(ctx: ToolContext) {
    const dx = this.moveOffsetX;
    const dy = this.moveOffsetY;

    if (dx === 0 && dy === 0) {
      // No movement, just go back to selected
      this.phase = 'selected';
      return;
    }

    // Expand grid to contain destination
    const destMinX = this.selMinX + dx;
    const destMinY = this.selMinY + dy;
    const destMaxX = this.selMaxX + dx;
    const destMaxY = this.selMaxY + dy;
    const expanded = ensureGridContainsBounds(ctx.state.grid, destMinX, destMinY, destMaxX, destMaxY, 0);
    if (expanded !== ctx.state.grid) {
      ctx.state.grid = expanded;
    }

    const tileChanges: TileChange[] = [];
    const entityChanges: EntityChange[] = [];

    // 1. Clear source tiles (only those not overlapping destination)
    for (const snap of this.moveSnapshotTiles) {
      const cell = getCell(ctx.state.grid, snap.x, snap.y);
      if (cell) {
        tileChanges.push({ x: snap.x, y: snap.y, before: { ...cell }, after: { tileId: 'Space' } });
        setCell(ctx.state.grid, snap.x, snap.y, { tileId: 'Space' });
      }
    }

    // 2. Place tiles at destination
    // Build index for O(1) lookup of existing tile changes
    const tileChangeIndex = new Map<number, number>();
    for (let i = 0; i < tileChanges.length; i++) {
      tileChangeIndex.set(tileKey(tileChanges[i].x, tileChanges[i].y), i);
    }

    for (const snap of this.moveSnapshotTiles) {
      const nx = snap.x + dx;
      const ny = snap.y + dy;
      const cell = getCell(ctx.state.grid, nx, ny);
      if (!cell) continue;
      // Check if we already recorded a clear for this destination tile
      const key = tileKey(nx, ny);
      const existingChangeIdx = tileChangeIndex.get(key);
      if (existingChangeIdx !== undefined) {
        // Update the existing change's after to the moved tile
        tileChanges[existingChangeIdx].after = { ...snap.before };
      } else {
        const newIdx = tileChanges.length;
        tileChanges.push({ x: nx, y: ny, before: { ...cell }, after: { ...snap.before } });
        tileChangeIndex.set(key, newIdx);
      }
      setCell(ctx.state.grid, nx, ny, { ...snap.before });
    }

    // 3. Remove source entities
    for (const e of this.moveSnapshotEntities) {
      entityChanges.push({ action: 'remove', entity: e });
    }

    // 4. Add entities at new positions, keeping their UIDs so links and contents still point at them
    for (const e of this.moveSnapshotEntities) {
      const newPos = { x: e.position.x + dx, y: e.position.y + dy };
      const moved: ImportedEntity = {
        uid: e.uid,
        prototype: e.prototype,
        position: newPos,
        rotation: e.rotation,
        components: cloneComponentsWithPos(e.components, newPos),
        ...(e.spriteStateOverride ? { spriteStateOverride: e.spriteStateOverride } : {}),
      };
      entityChanges.push({ action: 'add', entity: moved });
    }

    // 5. Move decals
    const decalChanges: DecalChange[] = [];
    for (const d of this.moveSnapshotDecals) {
      const movedDecal: DecalInstance = {
        ...d,
        position: { x: d.position.x + dx, y: d.position.y + dy },
      };
      decalChanges.push({ action: 'update', decal: movedDecal, previousDecal: d });
    }

    if (tileChanges.length > 0 || entityChanges.length > 0 || decalChanges.length > 0) {
      ctx.dispatch({
        type: 'APPLY_COMMAND',
        command: {
          label: 'Move selection',
          tileChanges,
          entityChanges,
          decalChanges: decalChanges.length > 0 ? decalChanges : undefined,
        },
      });
    }

    // Update selected tiles to new positions
    const newSelectedTiles = new Set<string>();
    for (const key of this.selectedTiles) {
      const comma = key.indexOf(',');
      const x = parseInt(key.substring(0, comma), 10);
      const y = parseInt(key.substring(comma + 1), 10);
      newSelectedTiles.add(`${x + dx},${y + dy}`);
    }
    this.selectedTiles = newSelectedTiles;

    // Update selection rectangle to new position
    this.selMinX += dx;
    this.selMinY += dy;
    this.selMaxX += dx;
    this.selMaxY += dy;
    this.phase = 'selected';
    this.moveSnapshotTiles = [];
    this.moveSnapshotEntities = [];
    this.moveSnapshotDecals = [];
  }

  getContextMenuItems(ctx: ToolContext, _tileX: number, _tileY: number): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];

    if (this.phase === 'selected') {
      items.push({ label: 'Copy', shortcut: 'Ctrl+C', action: () => this.copy(ctx) });
      items.push({ label: 'Cut', shortcut: 'Ctrl+X', action: () => this.cut(ctx) });
      items.push({ label: 'Delete', shortcut: 'Del', action: () => this.deleteSelection(ctx) });
      items.push({
        label: 'Save as Prefab...',
        action: () => {
          const name = window.prompt('Prefab name:');
          if (!name) return;
          const prefab = serializePrefab({
            name,
            minX: this.selMinX,
            minY: this.selMinY,
            maxX: this.selMaxX,
            maxY: this.selMaxY,
            grid: ctx.state.grid,
            entities: ctx.state.entities,
            containedEntities: ctx.state.containedEntities,
            entityRawComponents: ctx.state.entityRawComponents ?? {},
          });
          downloadPrefab(prefab, name);
        },
      });
    }

    const clip = getClipboard();
    if (clip) {
      items.push({ label: 'Paste', shortcut: 'Ctrl+V', action: () => this.paste(ctx) });
    }

    return items;
  }

  renderPreview(
    canvasCtx: CanvasRenderingContext2D,
    toolCtx: ToolContext,
    cursorTileX: number,
    cursorTileY: number,
  ) {
    const { camera, canvasW, canvasH } = toolCtx;
    const tileScreenSize = camera.tileScreenSize;

    if (this.phase === 'selecting') {
      // Show existing selection (if any) while dragging a new box in add/subtract mode
      if ((this.selectMode === 'add' || this.selectMode === 'subtract') && this.selectedTiles.size > 0) {
        canvasCtx.fillStyle = 'rgba(50, 130, 255, 0.25)';
        for (const key of this.selectedTiles) {
          const comma = key.indexOf(',');
          const x = parseInt(key.substring(0, comma), 10);
          const y = parseInt(key.substring(comma + 1), 10);
          const sx = camera.worldToScreenX(x, canvasW);
          const sy = camera.worldToScreenY(y, canvasH);
          if (sx > canvasW + tileScreenSize || sx < -tileScreenSize) continue;
          if (sy > canvasH + tileScreenSize || sy < -tileScreenSize) continue;
          canvasCtx.fillRect(sx, sy, tileScreenSize, tileScreenSize);
        }
        this.renderSelectionContour(canvasCtx, camera, canvasW, canvasH, tileScreenSize, 0, 0);
      }

      // Color-code the new marquee based on selection mode
      const fill = this.selectMode === 'subtract' ? 'rgba(255, 40, 40, 0.4)'
        : this.selectMode === 'add' ? 'rgba(60, 255, 60, 0.25)'
          : 'rgba(50, 130, 255, 0.25)';
      const stroke = this.selectMode === 'subtract' ? 'rgba(255, 30, 30, 1)'
        : this.selectMode === 'add' ? 'rgba(50, 255, 50, 0.9)'
          : '#ffffff';

      const screenX = camera.worldToScreenX(this.selMinX, canvasW);
      const screenY = camera.worldToScreenY(this.selMaxY, canvasH);
      const w = (this.selMaxX - this.selMinX + 1) * tileScreenSize;
      const h = (this.selMaxY - this.selMinY + 1) * tileScreenSize;

      canvasCtx.fillStyle = fill;
      canvasCtx.fillRect(screenX, screenY, w, h);

      canvasCtx.strokeStyle = stroke;
      canvasCtx.lineWidth = 1;
      canvasCtx.setLineDash([6, 6]);
      canvasCtx.strokeRect(screenX, screenY, w, h);
      canvasCtx.setLineDash([]);

      // Dimension label
      const dimW = this.selMaxX - this.selMinX + 1;
      const dimH = this.selMaxY - this.selMinY + 1;
      canvasCtx.fillStyle = '#ffffff';
      canvasCtx.font = '11px monospace';
      canvasCtx.textAlign = 'center';
      canvasCtx.fillText(`${dimW}x${dimH}`, screenX + w / 2, screenY - 4);
    }

    if (this.phase === 'selected' && this.selectedTiles.size > 0) {
      // Per-tile highlights for selected tiles (viewport-culled)
      canvasCtx.fillStyle = 'rgba(50, 130, 255, 0.25)';
      for (const key of this.selectedTiles) {
        const comma = key.indexOf(',');
        const x = parseInt(key.substring(0, comma), 10);
        const y = parseInt(key.substring(comma + 1), 10);
        const sx = camera.worldToScreenX(x, canvasW);
        const sy = camera.worldToScreenY(y, canvasH);
        if (sx > canvasW + tileScreenSize || sx < -tileScreenSize) continue;
        if (sy > canvasH + tileScreenSize || sy < -tileScreenSize) continue;
        canvasCtx.fillRect(sx, sy, tileScreenSize, tileScreenSize);
      }
      // Draw contour outline around the exact shape of the selection
      this.renderSelectionContour(canvasCtx, camera, canvasW, canvasH, tileScreenSize, 0, 0);
    }

    if (this.phase === 'moving') {
      // Draw contour at moved position
      this.renderSelectionContour(
        canvasCtx, camera, canvasW, canvasH, tileScreenSize,
        this.moveOffsetX, this.moveOffsetY,
      );

      // Ghost tiles
      canvasCtx.globalAlpha = 0.4;
      for (const snap of this.moveSnapshotTiles) {
        const sx = camera.worldToScreenX(snap.x + this.moveOffsetX, canvasW);
        const sy = camera.worldToScreenY(snap.y + this.moveOffsetY, canvasH);
        canvasCtx.fillStyle = '#4488ff';
        canvasCtx.fillRect(sx, sy, tileScreenSize, tileScreenSize);
      }

      // Ghost entities
      for (const e of this.moveSnapshotEntities) {
        const ex = Math.floor(e.position.x) + this.moveOffsetX;
        const ey = Math.floor(e.position.y) + this.moveOffsetY;
        const sx = camera.worldToScreenX(ex, canvasW);
        const sy = camera.worldToScreenY(ey, canvasH);
        canvasCtx.fillStyle = '#44ff88';
        canvasCtx.fillRect(sx + 2, sy + 2, tileScreenSize - 4, tileScreenSize - 4);
      }
      canvasCtx.globalAlpha = 1.0;
    }

    if (this.phase === 'pasting' && this.pasteData) {
      const { width, height, tiles, entities } = this.pasteData;
      // Ghost preview of paste tiles
      canvasCtx.globalAlpha = 0.5;
      for (let dy = 0; dy < height; dy++) {
        for (let dx = 0; dx < width; dx++) {
          const tile = tiles[dy * width + dx];
          if (!tile || tile.tileId === 'Space') continue;
          const sx = camera.worldToScreenX(this.pasteX + dx, canvasW);
          const sy = camera.worldToScreenY(this.pasteY + dy, canvasH);
          canvasCtx.fillStyle = '#4488ff';
          canvasCtx.fillRect(sx, sy, tileScreenSize, tileScreenSize);
        }
      }

      // Ghost preview of paste entities
      for (const ce of entities) {
        const ex = Math.floor(this.pasteX + ce.dx);
        const ey = Math.floor(this.pasteY + ce.dy);
        const sx = camera.worldToScreenX(ex, canvasW);
        const sy = camera.worldToScreenY(ey, canvasH);
        canvasCtx.fillStyle = '#44ff88';
        canvasCtx.fillRect(sx + 2, sy + 2, tileScreenSize - 4, tileScreenSize - 4);
      }
      canvasCtx.globalAlpha = 1.0;

      // Border
      const screenX = camera.worldToScreenX(this.pasteX, canvasW);
      const screenY = camera.worldToScreenY(this.pasteY + height - 1, canvasH);
      const w = width * tileScreenSize;
      const h = height * tileScreenSize;
      canvasCtx.strokeStyle = '#44ff88';
      canvasCtx.lineWidth = 2;
      canvasCtx.setLineDash([4, 4]);
      canvasCtx.strokeRect(screenX, screenY, w, h);
      canvasCtx.setLineDash([]);
    }

    if (this.phase === 'idle') {
      const drawX = camera.worldToScreenX(cursorTileX, canvasW);
      const drawY = camera.worldToScreenY(cursorTileY, canvasH);
      canvasCtx.strokeStyle = '#ffffff';
      canvasCtx.lineWidth = 1;
      canvasCtx.setLineDash([4, 4]);
      canvasCtx.strokeRect(drawX, drawY, tileScreenSize, tileScreenSize);
      canvasCtx.setLineDash([]);
    }
  }

  private renderSelectionRect(
    canvasCtx: CanvasRenderingContext2D,
    camera: import('../rendering/camera').Camera,
    canvasW: number,
    canvasH: number,
    tileScreenSize: number,
    offsetX: number,
    offsetY: number,
  ) {
    const screenX = camera.worldToScreenX(this.selMinX + offsetX, canvasW);
    const screenY = camera.worldToScreenY(this.selMaxY + offsetY, canvasH);
    const w = (this.selMaxX - this.selMinX + 1) * tileScreenSize;
    const h = (this.selMaxY - this.selMinY + 1) * tileScreenSize;

    // Marching ants
    const dashOffset = (Date.now() / 50) % 12;
    canvasCtx.strokeStyle = '#ffffff';
    canvasCtx.lineWidth = 1;
    canvasCtx.setLineDash([6, 6]);
    canvasCtx.lineDashOffset = dashOffset;
    canvasCtx.strokeRect(screenX, screenY, w, h);
    canvasCtx.strokeStyle = '#000000';
    canvasCtx.lineDashOffset = dashOffset + 6;
    canvasCtx.strokeRect(screenX, screenY, w, h);
    canvasCtx.setLineDash([]);

    // Dimension label
    const dimW = this.selMaxX - this.selMinX + 1;
    const dimH = this.selMaxY - this.selMinY + 1;
    canvasCtx.fillStyle = '#ffffff';
    canvasCtx.font = '11px monospace';
    canvasCtx.textAlign = 'center';
    canvasCtx.fillText(`${dimW}x${dimH}`, screenX + w / 2, screenY - 4);
  }

  /**
   * Draw marching ants contour around the exact shape of the selected tile set.
   * Only draws edges where a selected tile meets an unselected tile (or the void).
   */
  private renderSelectionContour(
    canvasCtx: CanvasRenderingContext2D,
    camera: import('../rendering/camera').Camera,
    canvasW: number,
    canvasH: number,
    tileScreenSize: number,
    offsetX: number,
    offsetY: number,
  ) {
    if (this.selectedTiles.size === 0) return;

    const dashOffset = (Date.now() / 50) % 12;

    // Collect all edge segments: for each selected tile, check 4 cardinal neighbors.
    // If a neighbor is NOT selected, draw an edge on that side.
    canvasCtx.lineWidth = 1.5;
    canvasCtx.setLineDash([6, 6]);

    // First pass: white
    canvasCtx.strokeStyle = '#ffffff';
    canvasCtx.lineDashOffset = dashOffset;
    canvasCtx.beginPath();
    this.traceContourPath(canvasCtx, camera, canvasW, canvasH, tileScreenSize, offsetX, offsetY);
    canvasCtx.stroke();

    // Second pass: black (offset dashes for marching ants effect)
    canvasCtx.strokeStyle = '#000000';
    canvasCtx.lineDashOffset = dashOffset + 6;
    canvasCtx.beginPath();
    this.traceContourPath(canvasCtx, camera, canvasW, canvasH, tileScreenSize, offsetX, offsetY);
    canvasCtx.stroke();

    canvasCtx.setLineDash([]);

    // Dimension label
    const bounds = this.computeBounds();
    if (bounds) {
      const sx = camera.worldToScreenX(bounds.minX + offsetX, canvasW);
      const sy = camera.worldToScreenY(bounds.maxY + offsetY, canvasH);
      const w = (bounds.maxX - bounds.minX + 1) * tileScreenSize;
      canvasCtx.fillStyle = '#ffffff';
      canvasCtx.font = '11px monospace';
      canvasCtx.textAlign = 'center';
      canvasCtx.fillText(
        `${this.selectedTiles.size} tiles`,
        sx + w / 2,
        sy - 4,
      );
    }
  }

  /** Trace edge segments of the selected tile set onto the current canvas path. */
  private traceContourPath(
    canvasCtx: CanvasRenderingContext2D,
    camera: import('../rendering/camera').Camera,
    canvasW: number,
    canvasH: number,
    tileScreenSize: number,
    offsetX: number,
    offsetY: number,
  ) {
    for (const key of this.selectedTiles) {
      const comma = key.indexOf(',');
      const x = parseInt(key.substring(0, comma), 10);
      const y = parseInt(key.substring(comma + 1), 10);

      const sx = camera.worldToScreenX(x + offsetX, canvasW);
      const sy = camera.worldToScreenY(y + offsetY, canvasH);

      // Viewport cull (with margin)
      if (sx > canvasW + tileScreenSize || sx < -tileScreenSize * 2) continue;
      if (sy > canvasH + tileScreenSize || sy < -tileScreenSize * 2) continue;

      // Top edge (neighbor above = y+1 in world = y-tileSize on screen)
      if (!this.selectedTiles.has(`${x},${y + 1}`)) {
        canvasCtx.moveTo(sx, sy);
        canvasCtx.lineTo(sx + tileScreenSize, sy);
      }
      // Bottom edge (neighbor below = y-1 in world)
      if (!this.selectedTiles.has(`${x},${y - 1}`)) {
        canvasCtx.moveTo(sx, sy + tileScreenSize);
        canvasCtx.lineTo(sx + tileScreenSize, sy + tileScreenSize);
      }
      // Left edge (neighbor left = x-1)
      if (!this.selectedTiles.has(`${x - 1},${y}`)) {
        canvasCtx.moveTo(sx, sy);
        canvasCtx.lineTo(sx, sy + tileScreenSize);
      }
      // Right edge (neighbor right = x+1)
      if (!this.selectedTiles.has(`${x + 1},${y}`)) {
        canvasCtx.moveTo(sx + tileScreenSize, sy);
        canvasCtx.lineTo(sx + tileScreenSize, sy + tileScreenSize);
      }
    }
  }

  /** Expose selected tile count for testing. */
  getSelectedTileCount(): number {
    return this.selectedTiles.size;
  }

  deactivate() {
    this.phase = 'idle';
    this.pasteData = null;
    this.moveSnapshotTiles = [];
    this.moveSnapshotEntities = [];
    this.selectedTiles.clear();
    this.selectMode = 'replace';
  }
}
