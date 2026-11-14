import type { ITool, ToolContext } from './toolTypes';
import type { ImportedEntity } from '../import/mapImporter';
import type { CardinalDirection, DecalChange } from '../types';
import type { DecalInstance } from '../import/decalParser';
import { getEntitiesAtTile, getEntitySprite, isNoRot, isLayerVisible, getCachedDrawDepth } from '../rendering/entityRenderer';
import type { LayerVisibility } from '../rendering/entityRenderer';
import type { SpriteDrawInfo } from '../loaders/rsiLoader';
import { markOverlayDirty } from '../rendering/dirtyFlags';
import { spatialGetAt, spatialGetInRect, spatialGetByUid } from '../rendering/spatialIndex';
import { getDecalSprite } from '../rendering/decalRenderer';
import { updateTransformPos, updateTransformRot, normalizeRotation, cloneComponentsWithPosRot, collectContained, instantiateCopies } from './entityHelpers';
import { getClipboard, setClipboard } from '../state/clipboard';
import type { ClipboardData, ClipboardEntity, ClipboardDecal } from '../state/clipboard';

function selectedSet(uids: number[]): Set<number> {
  return new Set(uids);
}

/** Filter entities to only those on visible layers. */
function filterVisibleEntities(
  entities: ImportedEntity[],
  layers: LayerVisibility | undefined,
  registry: import('../loaders/registryTypes').IPrototypeRegistry,
): ImportedEntity[] {
  if (!layers) return entities;
  return entities.filter(e => {
    const depth = getCachedDrawDepth(e.prototype, registry);
    return isLayerVisible(depth, e.prototype, layers);
  });
}

/** Check if decal layer is visible. */
function areDecalsVisible(layers: LayerVisibility | undefined): boolean {
  return !layers || layers.decals;
}

type Mode = 'idle' | 'boxSelect' | 'moveDrag' | 'pasting';

/**
 * Build a canvas containing only the pixel-perfect outline of a sprite.
 * The outline is `thickness` px wide around the sprite contour.
 * Cached per sprite region + color + thickness.
 */
/** When more than this many entities are selected, use simple rect highlights instead of sprite outlines */
const LOD_RECT_THRESHOLD = 100;

const OUTLINE_CACHE_MAX = 128;
const outlineCache = new Map<string, HTMLCanvasElement>();
const outlineLruOrder: string[] = [];
const OUTLINE_THICKNESS = 2;

function getSpriteOutline(sprite: SpriteDrawInfo, color: string): HTMLCanvasElement | null {
  const t = OUTLINE_THICKNESS;
  const key = `${sprite.image.src}:${sprite.sx},${sprite.sy},${sprite.sw},${sprite.sh}:${color}:${t}`;
  const cached = outlineCache.get(key);
  if (cached) {
    // LRU: move to end
    const idx = outlineLruOrder.indexOf(key);
    if (idx >= 0) {
      outlineLruOrder.splice(idx, 1);
      outlineLruOrder.push(key);
    }
    return cached;
  }

  if (typeof document === 'undefined') return null;

  const w = sprite.sw;
  const h = sprite.sh;
  if (w <= 0 || h <= 0) return null;

  const pad = t;
  const ow = w + pad * 2;
  const oh = h + pad * 2;
  const canvas = document.createElement('canvas');
  canvas.width = ow;
  canvas.height = oh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Draw the sprite silhouette at every offset within the thickness radius
  for (let dy = -t; dy <= t; dy++) {
    for (let dx = -t; dx <= t; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (dx * dx + dy * dy > t * t + t) continue;
      ctx.drawImage(sprite.image, sprite.sx, sprite.sy, w, h, pad + dx, pad + dy, w, h);
    }
  }

  // Color the silhouette
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, ow, oh);

  // Punch out the original sprite shape so only the outline ring remains
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(sprite.image, sprite.sx, sprite.sy, w, h, pad, pad, w, h);

  ctx.globalCompositeOperation = 'source-over';

  // Evict oldest if at capacity
  if (outlineCache.size >= OUTLINE_CACHE_MAX && outlineLruOrder.length > 0) {
    const evictKey = outlineLruOrder.shift()!;
    outlineCache.delete(evictKey);
  }
  outlineCache.set(key, canvas);
  outlineLruOrder.push(key);
  return canvas;
}

/** Exported for testing */
export function _getOutlineCacheSize(): number {
  return outlineCache.size;
}

export function _clearOutlineCache(): void {
  outlineCache.clear();
  outlineLruOrder.length = 0;
}

export class EntitySelectTool implements ITool {
  name = 'entitySelect';
  cursor = 'default';

  private mode: Mode = 'idle';
  private shiftHeld = false;
  private ctrlHeld = false;

  // Box selection
  private boxStartX = 0;
  private boxStartY = 0;
  private boxCurrentX = 0;
  private boxCurrentY = 0;

  // Move drag
  private dragStartX = 0;
  private dragStartY = 0;
  private dragCurrentX = 0;
  private dragCurrentY = 0;

  // Click cycling
  private stackIndex = 0;
  private lastClickTile = { x: -9999, y: -9999 };

  // Pending entity select (click on unselected entity, resolved on mouse up)
  private pendingSelectUid: number | null = null;

  // Stack picker state (entities + decals)
  private pickerOpen = false;
  private pickerEntities: ImportedEntity[] = [];
  private pickerDecals: DecalInstance[] = [];
  private pickerIndex = 0;
  private pickerTileX = 0;
  private pickerTileY = 0;

  // Paste state
  private pasteData: ClipboardData | null = null;
  private pasteX = 0;
  private pasteY = 0;

  // Decal move snapshot
  private moveSnapshotDecals: DecalInstance[] = [];
  // Pending decal select (click on decal, resolved on mouse up)
  private pendingSelectDecalId: number | null = null;

  onWheel(ctx: ToolContext, tileX: number, tileY: number, deltaY: number): boolean {
    const { state } = ctx;
    if (!state.registry) return false;

    // Check if there's a selected entity or decal at this tile
    const selectedUidSet = selectedSet(state.selectedEntityUids);
    const selectedDecalSet = new Set(state.selectedDecalIds);
    const atTile = spatialGetAt(tileX, tileY);
    const visibleAtTile = state.registry
      ? filterVisibleEntities(atTile, ctx.layerVisibility, state.registry)
      : atTile;
    const hasSelectedEntityAtTile = visibleAtTile.some(e => selectedUidSet.has(e.uid));

    const activeGrid = state.grids[state.activeGridIndex];
    const decalsAtTile = areDecalsVisible(ctx.layerVisibility)
      ? activeGrid.decals.decals.filter(d =>
        Math.floor(d.position.x) === tileX && Math.floor(d.position.y) === tileY
      )
      : [];
    const hasSelectedDecalAtTile = decalsAtTile.some(d => selectedDecalSet.has(d.id));

    if (!hasSelectedEntityAtTile && !hasSelectedDecalAtTile) {
      this.closePicker();
      return false;
    }

    // Build combined picker items: entities first, then decals (respecting layer visibility)
    const allEntitiesAtTile = getEntitiesAtTile(tileX, tileY, state.entities, state.registry);
    const entitiesAtTile = filterVisibleEntities(allEntitiesAtTile, ctx.layerVisibility, state.registry);
    const totalItems = entitiesAtTile.length + decalsAtTile.length;
    if (totalItems < 2) {
      this.closePicker();
      return false;
    }

    // Open or update picker
    if (!this.pickerOpen || tileX !== this.pickerTileX || tileY !== this.pickerTileY) {
      this.pickerEntities = entitiesAtTile;
      this.pickerDecals = decalsAtTile;
      this.pickerIndex = 0;
      this.pickerTileX = tileX;
      this.pickerTileY = tileY;
      this.pickerOpen = true;
    } else {
      this.pickerEntities = entitiesAtTile;
      this.pickerDecals = decalsAtTile;
    }

    // Cycle through combined list
    if (deltaY > 0) {
      this.pickerIndex = (this.pickerIndex + 1) % totalItems;
    } else {
      this.pickerIndex = (this.pickerIndex - 1 + totalItems) % totalItems;
    }

    // Immediately select the highlighted item
    if (this.pickerIndex < entitiesAtTile.length) {
      const picked = entitiesAtTile[this.pickerIndex];
      ctx.dispatch({ type: 'SELECT_ENTITY', uids: [picked.uid] });
      ctx.dispatch({ type: 'SELECT_DECAL', ids: [] });
    } else {
      const decalIdx = this.pickerIndex - entitiesAtTile.length;
      const picked = decalsAtTile[decalIdx];
      ctx.dispatch({ type: 'SELECT_DECAL', ids: [picked.id] });
      ctx.dispatch({ type: 'SELECT_ENTITY', uids: [] });
    }

    markOverlayDirty();
    return true; // suppress zoom
  }

  private closePicker() {
    this.pickerOpen = false;
    this.pickerEntities = [];
    this.pickerDecals = [];
    this.pickerIndex = 0;
  }

  /** Expose picker state for testing. */
  getPickerState() {
    return {
      open: this.pickerOpen,
      entities: this.pickerEntities,
      decals: this.pickerDecals,
      index: this.pickerIndex,
      tileX: this.pickerTileX,
      tileY: this.pickerTileY,
    };
  }

  onMouseDown(ctx: ToolContext, tileX: number, tileY: number, button: number) {
    this.shiftHeld = false;
    this.ctrlHeld = false;
    this.handleMouseDown(ctx, tileX, tileY, button);
  }

  /** Called from EditorCanvas when shift is held during mouse down */
  onMouseDownWithShift(ctx: ToolContext, tileX: number, tileY: number, button: number) {
    this.shiftHeld = true;
    this.ctrlHeld = false;
    this.handleMouseDown(ctx, tileX, tileY, button);
  }

  /** Called from EditorCanvas when ctrl is held during mouse down */
  onMouseDownWithCtrl(ctx: ToolContext, tileX: number, tileY: number, button: number) {
    this.ctrlHeld = true;
    this.shiftHeld = false;
    this.handleMouseDown(ctx, tileX, tileY, button);
  }

  private handleMouseDown(ctx: ToolContext, tileX: number, tileY: number, button: number) {
    if (button === 2) {
      this.closePicker();
      if (this.mode === 'pasting') {
        this.mode = 'idle';
        this.pasteData = null;
        return;
      }
      ctx.dispatch({ type: 'SELECT_ENTITY', uids: [] });
      ctx.dispatch({ type: 'SELECT_DECAL', ids: [] });
      return;
    }
    if (button !== 0) return;

    if (this.mode === 'pasting') {
      this.commitPaste(ctx);
      return;
    }

    // Close picker if open, entity is already selected via scroll, fall through to normal logic
    if (this.pickerOpen) {
      this.closePicker();
    }

    const { state } = ctx;
    if (!state.registry) return;

    // Floor for spatial lookup (spatial index uses integer tile keys)
    const lookupX = Math.floor(tileX);
    const lookupY = Math.floor(tileY);
    const allEntitiesAtTile = getEntitiesAtTile(lookupX, lookupY, state.entities, state.registry);
    const entitiesAtTile = filterVisibleEntities(allEntitiesAtTile, ctx.layerVisibility, state.registry);

    // Check for decals at tile (only if decal layer visible)
    const activeGrid = state.grids[state.activeGridIndex];
    const decalsAtTile = areDecalsVisible(ctx.layerVisibility)
      ? activeGrid.decals.decals.filter(d =>
        Math.floor(d.position.x) === lookupX && Math.floor(d.position.y) === lookupY
      )
      : [];

    // Click on an already-selected entity or decal, start move drag
    // Priority: selected entity > selected decal
    // Shift+drag = free fractional movement; Ctrl reserved for subtractive box select
    if (!this.ctrlHeld) {
      // Check selected entities first
      if (entitiesAtTile.length > 0) {
        const selectedUidSet = selectedSet(state.selectedEntityUids);
        const clickedSelected = entitiesAtTile.find(e => selectedUidSet.has(e.uid));
        if (clickedSelected) {
          this.startMoveDrag(ctx, tileX, tileY);
          return;
        }
      }
      // Then check selected decals (even if entities exist at tile)
      if (decalsAtTile.length > 0) {
        const selectedDecalSet = new Set(state.selectedDecalIds);
        const clickedSelectedDecal = decalsAtTile.find(d => selectedDecalSet.has(d.id));
        if (clickedSelectedDecal) {
          this.startMoveDrag(ctx, tileX, tileY);
          return;
        }
      }
    }

    // Click on empty space OR unselected entity/decal, start box select.
    // If it's a click (no drag), we'll select the entity/decal under cursor on mouse-up.
    if (!this.shiftHeld && !this.ctrlHeld) {
      ctx.dispatch({ type: 'SELECT_ENTITY', uids: [] });
      ctx.dispatch({ type: 'SELECT_DECAL', ids: [] });
    }

    // Remember which entity was under cursor for click-select on mouse-up
    if (entitiesAtTile.length > 0) {
      if (tileX === this.lastClickTile.x && tileY === this.lastClickTile.y) {
        this.stackIndex = (this.stackIndex + 1) % entitiesAtTile.length;
      } else {
        this.stackIndex = 0;
        this.lastClickTile = { x: tileX, y: tileY };
      }
      this.pendingSelectUid = entitiesAtTile[this.stackIndex].uid;
      this.pendingSelectDecalId = null;
    } else if (decalsAtTile.length > 0) {
      // No entity at tile but decal exists, select decal
      this.pendingSelectUid = null;
      this.pendingSelectDecalId = decalsAtTile[0].id;
    } else {
      this.pendingSelectUid = null;
      this.pendingSelectDecalId = null;
    }

    this.mode = 'boxSelect';
    this.boxStartX = tileX;
    this.boxStartY = tileY;
    this.boxCurrentX = tileX;
    this.boxCurrentY = tileY;
  }

  private startMoveDrag(_ctx: ToolContext, tileX: number, tileY: number) {
    this.mode = 'moveDrag';
    this.dragStartX = tileX;
    this.dragStartY = tileY;
    this.dragCurrentX = tileX;
    this.dragCurrentY = tileY;

    // Snapshot selected decals for move
    const activeGrid = _ctx.state.grids[_ctx.state.activeGridIndex];
    const selectedDecalSet = new Set(_ctx.state.selectedDecalIds);
    this.moveSnapshotDecals = activeGrid.decals.decals.filter(d => selectedDecalSet.has(d.id));
  }

  onMouseMove(_ctx: ToolContext, tileX: number, tileY: number) {
    // Close picker if cursor leaves the picker tile
    if (this.pickerOpen && (tileX !== this.pickerTileX || tileY !== this.pickerTileY)) {
      this.closePicker();
    }

    if (this.mode === 'boxSelect') {
      this.boxCurrentX = tileX;
      this.boxCurrentY = tileY;
    } else if (this.mode === 'moveDrag') {
      this.dragCurrentX = tileX;
      this.dragCurrentY = tileY;
    } else if (this.mode === 'pasting') {
      this.pasteX = tileX;
      this.pasteY = tileY;
    }
  }

  onMouseUp(ctx: ToolContext, tileX: number, tileY: number) {
    if (this.mode === 'boxSelect') {
      // If no drag happened and there was an entity/decal under cursor, select it
      const isClick = tileX === this.boxStartX && tileY === this.boxStartY;
      if (this.pendingSelectUid !== null && isClick) {
        if (this.shiftHeld) {
          ctx.dispatch({ type: 'TOGGLE_SELECT_ENTITY', uid: this.pendingSelectUid });
        } else if (this.ctrlHeld) {
          ctx.dispatch({ type: 'REMOVE_SELECT_ENTITIES', uids: [this.pendingSelectUid] });
        } else {
          ctx.dispatch({ type: 'SELECT_ENTITY', uids: [this.pendingSelectUid] });
        }
      } else if (this.pendingSelectDecalId !== null && isClick) {
        if (this.shiftHeld) {
          ctx.dispatch({ type: 'TOGGLE_SELECT_DECAL', id: this.pendingSelectDecalId });
        } else if (this.ctrlHeld) {
          ctx.dispatch({ type: 'REMOVE_SELECT_DECALS', ids: [this.pendingSelectDecalId] });
        } else {
          ctx.dispatch({ type: 'SELECT_DECAL', ids: [this.pendingSelectDecalId] });
        }
      } else {
        this.finishBoxSelect(ctx, tileX, tileY);
      }
      this.pendingSelectUid = null;
      this.pendingSelectDecalId = null;
    } else if (this.mode === 'moveDrag') {
      this.finishMoveDrag(ctx, tileX, tileY);
    }
    this.mode = 'idle';
  }

  private finishBoxSelect(ctx: ToolContext, tileX: number, tileY: number) {
    const minX = Math.floor(Math.min(this.boxStartX, tileX));
    const maxX = Math.floor(Math.max(this.boxStartX, tileX));
    const minY = Math.floor(Math.min(this.boxStartY, tileY));
    const maxY = Math.floor(Math.max(this.boxStartY, tileY));

    // Find all entities within the box via spatial index (respecting layer visibility)
    const allInRect = spatialGetInRect(minX, minY, maxX, maxY);
    const registry = ctx.state.registry;
    const visibleInRect = registry
      ? filterVisibleEntities(allInRect, ctx.layerVisibility, registry)
      : allInRect;
    const uids: number[] = visibleInRect.map(e => e.uid);

    // Find all decals within the box (only if decal layer visible)
    const activeGrid = ctx.state.grids[ctx.state.activeGridIndex];
    const decalIds = areDecalsVisible(ctx.layerVisibility)
      ? activeGrid.decals.decals
        .filter(d => {
          const dx = Math.floor(d.position.x);
          const dy = Math.floor(d.position.y);
          return dx >= minX && dx <= maxX && dy >= minY && dy <= maxY;
        })
        .map(d => d.id)
      : [];

    if (this.shiftHeld) {
      ctx.dispatch({ type: 'ADD_SELECT_ENTITIES', uids });
      ctx.dispatch({ type: 'ADD_SELECT_DECALS', ids: decalIds });
    } else if (this.ctrlHeld) {
      ctx.dispatch({ type: 'REMOVE_SELECT_ENTITIES', uids });
      ctx.dispatch({ type: 'REMOVE_SELECT_DECALS', ids: decalIds });
    } else {
      ctx.dispatch({ type: 'SELECT_ENTITY', uids });
      ctx.dispatch({ type: 'SELECT_DECAL', ids: decalIds });
    }
  }

  private finishMoveDrag(ctx: ToolContext, tileX: number, tileY: number) {
    const dx = tileX - this.dragStartX;
    const dy = tileY - this.dragStartY;

    if (dx === 0 && dy === 0) {
      // No movement, if shift was held, toggle the entity/decal under cursor
      if (this.shiftHeld) {
        const lookupX = Math.floor(tileX);
        const lookupY = Math.floor(tileY);
        const { state } = ctx;
        if (state.registry) {
          const allEntitiesAtTile = getEntitiesAtTile(lookupX, lookupY, state.entities, state.registry);
          const entitiesAtTile = filterVisibleEntities(allEntitiesAtTile, ctx.layerVisibility, state.registry);
          if (entitiesAtTile.length > 0) {
            ctx.dispatch({ type: 'TOGGLE_SELECT_ENTITY', uid: entitiesAtTile[0].uid });
          } else {
            const activeGrid = state.grids[state.activeGridIndex];
            const decalsAtTile = areDecalsVisible(ctx.layerVisibility)
              ? activeGrid.decals.decals.filter(d =>
                Math.floor(d.position.x) === lookupX && Math.floor(d.position.y) === lookupY
              )
              : [];
            if (decalsAtTile.length > 0) {
              ctx.dispatch({ type: 'TOGGLE_SELECT_DECAL', id: decalsAtTile[0].id });
            }
          }
        }
      }
      return;
    }

    const { state } = ctx;
    const selectedUidSet = selectedSet(state.selectedEntityUids);
    const selectedEntities = state.entities.filter(e => selectedUidSet.has(e.uid));

    // Build decal changes from snapshot
    const decalChanges: DecalChange[] = [];
    for (const decal of this.moveSnapshotDecals) {
      const movedDecal: DecalInstance = {
        ...decal,
        position: { x: decal.position.x + dx, y: decal.position.y + dy },
      };
      decalChanges.push({ action: 'update', decal: movedDecal, previousDecal: decal });
    }

    if (selectedEntities.length === 0 && decalChanges.length === 0) return;

    const entityChanges: { action: 'add' | 'remove'; entity: ImportedEntity }[] = [];

    // Moved entities keep their UIDs so links and contents still point at them
    for (const entity of selectedEntities) {
      const newPos = {
        x: entity.position.x + dx,
        y: entity.position.y + dy,
      };
      const moved: ImportedEntity = {
        ...entity,
        position: newPos,
        components: updateTransformPos(entity.components, newPos),
      };
      entityChanges.push({ action: 'remove', entity });
      entityChanges.push({ action: 'add', entity: moved });
    }

    const hasDecalMoves = this.moveSnapshotDecals.length > 0;
    const totalCount = selectedEntities.length + this.moveSnapshotDecals.length;
    let label: string;
    if (totalCount === 1) {
      label = selectedEntities.length === 1 ? `Move ${selectedEntities[0].prototype}` : 'Move decal';
    } else if (hasDecalMoves && selectedEntities.length > 0) {
      label = `Move ${totalCount} items`;
    } else if (hasDecalMoves) {
      label = `Move ${this.moveSnapshotDecals.length} decals`;
    } else {
      label = `Move ${selectedEntities.length} entities`;
    }

    ctx.dispatch({
      type: 'APPLY_COMMAND',
      command: { label, tileChanges: [], entityChanges, decalChanges: decalChanges.length > 0 ? decalChanges : undefined },
    });

    this.moveSnapshotDecals = [];
    this.lastClickTile = { x: tileX, y: tileY };
  }

  /** Check if currently in paste mode. */
  isPasting(): boolean {
    return this.mode === 'pasting' && this.pasteData !== null;
  }

  /** Copy selected entities to clipboard. */
  copy(ctx: ToolContext) {
    const { state } = ctx;
    if (state.selectedEntityUids.length === 0) return;

    const selectedUidSet = selectedSet(state.selectedEntityUids);
    const selected = state.entities.filter(e => selectedUidSet.has(e.uid));
    if (selected.length === 0) return;

    // Compute bounding box of selected entities
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const e of selected) {
      const tx = Math.floor(e.position.x);
      const ty = Math.floor(e.position.y);
      if (tx < minX) minX = tx;
      if (tx > maxX) maxX = tx;
      if (ty < minY) minY = ty;
      if (ty > maxY) maxY = ty;
    }

    const w = maxX - minX + 1;
    const h = maxY - minY + 1;

    const clipEntities: ClipboardEntity[] = selected.map(e => ({
      uid: e.uid,
      dx: e.position.x - minX,
      dy: e.position.y - minY,
      prototype: e.prototype,
      rotation: e.rotation,
      components: e.components.map(c => ({ ...c })),
      ...(e.spriteStateOverride ? { spriteStateOverride: e.spriteStateOverride } : {}),
    }));

    // Copy selected decals too
    const activeGrid = ctx.state.grids[ctx.state.activeGridIndex];
    const selectedDecalSet = new Set(ctx.state.selectedDecalIds);
    const selectedDecals = activeGrid.decals.decals.filter(d => selectedDecalSet.has(d.id));

    const clipDecals: ClipboardDecal[] = selectedDecals.map(d => ({
      dx: d.position.x - minX,
      dy: d.position.y - minY,
      prototypeId: d.prototypeId,
      color: d.color,
      angle: d.angle,
      zIndex: d.zIndex,
      cleanable: d.cleanable,
    }));

    // Include decal bounding box in width/height if decals extend beyond entities
    let clipMinX = minX, clipMinY = minY, clipMaxX = maxX, clipMaxY = maxY;
    for (const d of selectedDecals) {
      const dx = Math.floor(d.position.x);
      const dy = Math.floor(d.position.y);
      if (dx < clipMinX) clipMinX = dx;
      if (dx > clipMaxX) clipMaxX = dx;
      if (dy < clipMinY) clipMinY = dy;
      if (dy > clipMaxY) clipMaxY = dy;
    }
    const clipW = clipMaxX - clipMinX + 1;
    const clipH = clipMaxY - clipMinY + 1;

    setClipboard({
      width: Math.max(w, clipW), height: Math.max(h, clipH),
      tiles: new Array(Math.max(w, clipW) * Math.max(h, clipH)).fill(null),
      entities: clipEntities,
      contained: collectContained(ctx.state.containedEntities, selected.map(e => e.uid)),
      decals: clipDecals,
      originX: Math.min(minX, clipMinX), originY: Math.min(minY, clipMinY),
    });
  }

  /** Cut = copy + delete */
  cut(ctx: ToolContext) {
    this.copy(ctx);
    this.deleteSelected(ctx);
  }

  /** Enter paste mode */
  paste(ctx: ToolContext) {
    const clip = getClipboard();
    if (!clip || (clip.entities.length === 0 && (!clip.decals || clip.decals.length === 0))) return;
    this.pasteData = clip;
    this.pasteX = clip.originX;
    this.pasteY = clip.originY;
    this.mode = 'pasting';
  }

  /** Rotate paste preview entities and decals */
  rotatePaste(direction: 'cw' | 'ccw') {
    if (this.mode !== 'pasting' || !this.pasteData) return;

    const { width: W, height: H, entities } = this.pasteData;
    const newW = H;
    const newH = W;
    const delta = direction === 'cw' ? -Math.PI / 2 : Math.PI / 2;

    const newEntities: ClipboardEntity[] = entities.map(e => {
      let newDx: number, newDy: number;
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

    const newDecals: ClipboardDecal[] | undefined = this.pasteData.decals?.map(d => {
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

    this.pasteData = {
      ...this.pasteData,
      width: newW,
      height: newH,
      tiles: new Array(newW * newH).fill(null),
      entities: newEntities,
      decals: newDecals,
    };
    markOverlayDirty();
  }

  private commitPaste(ctx: ToolContext) {
    if (!this.pasteData) return;

    const copies = instantiateCopies(this.pasteData.entities.map(ce => {
      const newPos = { x: this.pasteX + ce.dx, y: this.pasteY + ce.dy };
      return {
        sourceUid: ce.uid,
        entity: {
          prototype: ce.prototype,
          position: newPos,
          rotation: ce.rotation,
          components: cloneComponentsWithPosRot(ce.components, newPos, ce.rotation),
          ...(ce.spriteStateOverride ? { spriteStateOverride: ce.spriteStateOverride } : {}),
        },
      };
    }), this.pasteData.contained, ctx.state.nextEntityId);
    const entityChanges: { action: 'add' | 'remove'; entity: ImportedEntity }[] =
      copies.entities.map(entity => ({ action: 'add', entity }));

    // Paste decals with new IDs
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

    const totalCount = entityChanges.length + decalChanges.length;
    if (totalCount > 0) {
      ctx.dispatch({
        type: 'APPLY_COMMAND',
        command: {
          label: `Paste ${totalCount} items`,
          tileChanges: [],
          entityChanges,
          containedEntityChanges: copies.containedChanges.length > 0 ? copies.containedChanges : undefined,
          decalChanges: decalChanges.length > 0 ? decalChanges : undefined,
        },
      });
    }
    // Stay in paste mode for repeated stamps
  }

  renderPreview(
    canvasCtx: CanvasRenderingContext2D,
    toolCtx: ToolContext,
    _cursorTileX: number,
    _cursorTileY: number,
  ) {
    const { state, camera, canvasW, canvasH } = toolCtx;
    const tileScreenSize = camera.tileScreenSize;

    // Draw selection highlights on all selected entities
    if (state.selectedEntityUids.length > 0) {
      const dx = this.mode === 'moveDrag' ? this.dragCurrentX - this.dragStartX : 0;
      const dy = this.mode === 'moveDrag' ? this.dragCurrentY - this.dragStartY : 0;
      const isMoving = this.mode === 'moveDrag' && (dx !== 0 || dy !== 0);

      // Compute viewport bounds once for frustum culling
      const vpLeft = -tileScreenSize;
      const vpTop = -tileScreenSize;
      const vpRight = canvasW + tileScreenSize;
      const vpBottom = canvasH + tileScreenSize;

      // Single pulse calculation per frame
      const pulse = 0.8 + 0.2 * Math.sin(performance.now() / 300);

      // LOD: use simple rects when selection is large and not moving
      const selCount = state.selectedEntityUids.length;
      const useLodRects = !isMoving && selCount > LOD_RECT_THRESHOLD;

      for (const uid of state.selectedEntityUids) {
        const entity = spatialGetByUid(uid);
        if (!entity) continue;

        // Use position - 0.5 to get top-left draw origin (position is entity center)
        const ex = entity.position.x - 0.5;
        const ey = entity.position.y - 0.5;

        if (isMoving) {
          // Frustum cull: skip if both original and ghost are off-screen
          const ghostScreenX = camera.worldToScreenX(ex + dx, canvasW);
          const ghostScreenY = camera.worldToScreenY(ey + dy, canvasH);
          const origScreenX = camera.worldToScreenX(ex, canvasW);
          const origScreenY = camera.worldToScreenY(ey, canvasH);
          const ghostVisible = ghostScreenX >= vpLeft && ghostScreenX <= vpRight && ghostScreenY >= vpTop && ghostScreenY <= vpBottom;
          const origVisible = origScreenX >= vpLeft && origScreenX <= vpRight && origScreenY >= vpTop && origScreenY <= vpBottom;
          if (!ghostVisible && !origVisible) continue;

          // Translucent sprite ghost at destination
          let drewGhost = false;
          if (ghostVisible && state.registry) {
            const dir = rotToDir(entity.rotation);
            const sprite = getEntitySprite(entity.prototype, dir, state.registry);
            if (sprite) {
              const needsRotation = !isNoRot(entity.prototype, state.registry)
                && entity.rotation !== 0 && sprite.sh === sprite.image.height;
              canvasCtx.save();
              canvasCtx.globalAlpha = 0.5;
              if (needsRotation) {
                const cx = ghostScreenX + tileScreenSize / 2;
                const cy = ghostScreenY + tileScreenSize / 2;
                canvasCtx.translate(cx, cy);
                canvasCtx.rotate(-entity.rotation);
                canvasCtx.translate(-cx, -cy);
              }
              canvasCtx.drawImage(
                sprite.image,
                sprite.sx, sprite.sy, sprite.sw, sprite.sh,
                ghostScreenX, ghostScreenY, tileScreenSize, tileScreenSize,
              );
              canvasCtx.restore();
              drewGhost = true;
            }
          }

          if (ghostVisible && !drewGhost) {
            canvasCtx.strokeStyle = 'rgba(50, 130, 255, 0.9)';
            canvasCtx.lineWidth = 2;
            canvasCtx.setLineDash([4, 4]);
            canvasCtx.strokeRect(ghostScreenX, ghostScreenY, tileScreenSize, tileScreenSize);
            canvasCtx.setLineDash([]);
          }

          // Dim original position
          if (origVisible) {
            canvasCtx.strokeStyle = 'rgba(100, 200, 255, 0.3)';
            canvasCtx.lineWidth = 1;
            canvasCtx.strokeRect(origScreenX, origScreenY, tileScreenSize, tileScreenSize);
          }
        } else {
          // Selection highlight
          const sx = camera.worldToScreenX(ex, canvasW);
          const sy = camera.worldToScreenY(ey, canvasH);

          // Frustum cull: skip entities outside viewport
          if (sx < vpLeft || sx > vpRight || sy < vpTop || sy > vpBottom) continue;

          // LOD: simple colored rect for large selections
          if (useLodRects) {
            canvasCtx.strokeStyle = `rgba(255, 215, 0, ${pulse})`;
            canvasCtx.lineWidth = 2;
            canvasCtx.strokeRect(sx + 1, sy + 1, tileScreenSize - 2, tileScreenSize - 2);
            continue;
          }

          // Pixel-perfect outline around sprite
          let drewOutline = false;
          if (state.registry) {
            const dir = rotToDir(entity.rotation);
            const sprite = getEntitySprite(entity.prototype, dir, state.registry);
            if (sprite) {
              const outline = getSpriteOutline(sprite, '#FFD700');
              if (outline) {
                const pad = OUTLINE_THICKNESS;
                const scale = tileScreenSize / sprite.sw;
                const outlineW = outline.width * scale;
                const outlineH = outline.height * scale;

                // Apply same rotation as entity renderer for single-direction sprites
                const entityNoRot = isNoRot(entity.prototype, state.registry);
                const needsRotation = !entityNoRot && entity.rotation !== 0 && sprite.sh === sprite.image.height;

                if (needsRotation) {
                  const cx = sx + tileScreenSize / 2;
                  const cy = sy + tileScreenSize / 2;
                  canvasCtx.save();
                  canvasCtx.translate(cx, cy);
                  canvasCtx.rotate(-entity.rotation);
                  canvasCtx.translate(-cx, -cy);
                }

                canvasCtx.globalAlpha = pulse;
                canvasCtx.drawImage(outline, sx - pad * scale, sy - pad * scale, outlineW, outlineH);
                canvasCtx.globalAlpha = 1;

                if (needsRotation) {
                  canvasCtx.restore();
                }

                drewOutline = true;
              }
            }
          }

          // Fallback: simple rect if sprite not available
          if (!drewOutline) {
            canvasCtx.strokeStyle = `rgba(0, 255, 255, ${pulse})`;
            canvasCtx.lineWidth = 2;
            canvasCtx.strokeRect(sx + 2, sy + 2, tileScreenSize - 4, tileScreenSize - 4);
          }
        }
      }

      // Keep redrawing for pulse animation
      markOverlayDirty();
    }

    // Draw decal selection highlights (pixel-perfect outline like entities, but cyan)
    if (state.selectedDecalIds.length > 0) {
      const activeGrid = state.grids[state.activeGridIndex];
      const selectedDecalSet = new Set(state.selectedDecalIds);

      const dxOffset = this.mode === 'moveDrag' ? this.dragCurrentX - this.dragStartX : 0;
      const dyOffset = this.mode === 'moveDrag' ? this.dragCurrentY - this.dragStartY : 0;
      const isMoving = this.mode === 'moveDrag' && (dxOffset !== 0 || dyOffset !== 0);
      const pulse = 0.8 + 0.2 * Math.sin(performance.now() / 300);

      for (const decal of activeGrid.decals.decals) {
        if (!selectedDecalSet.has(decal.id)) continue;

        const drawX = decal.position.x + (isMoving ? dxOffset : 0);
        const drawY = decal.position.y + (isMoving ? dyOffset : 0);
        const sx = camera.worldToScreenX(drawX, canvasW);
        const sy = camera.worldToScreenY(drawY, canvasH);

        if (isMoving) {
          // Dim original position
          const origSx = camera.worldToScreenX(decal.position.x, canvasW);
          const origSy = camera.worldToScreenY(decal.position.y, canvasH);
          canvasCtx.strokeStyle = 'rgba(0, 220, 220, 0.3)';
          canvasCtx.lineWidth = 1;
          canvasCtx.setLineDash([4, 4]);
          canvasCtx.strokeRect(origSx + 2, origSy + 2, tileScreenSize - 4, tileScreenSize - 4);
          canvasCtx.setLineDash([]);
        }

        // Try sprite-contour outline (matching entity gold outline but cyan)
        let drewOutline = false;
        if (state.registry) {
          const decalImg = getDecalSprite(decal.prototypeId, state.registry);
          if (decalImg) {
            const spriteInfo: SpriteDrawInfo = {
              image: decalImg, sx: 0, sy: 0, sw: decalImg.width, sh: decalImg.height,
            };
            const outline = getSpriteOutline(spriteInfo, '#00DDDD');
            if (outline) {
              const pad = OUTLINE_THICKNESS;
              const scale = tileScreenSize / spriteInfo.sw;
              const outlineW = outline.width * scale;
              const outlineH = outline.height * scale;

              if (decal.angle !== 0) {
                const cx = sx + tileScreenSize / 2;
                const cy = sy + tileScreenSize / 2;
                canvasCtx.save();
                canvasCtx.translate(cx, cy);
                canvasCtx.rotate(-decal.angle);
                canvasCtx.translate(-cx, -cy);
              }

              canvasCtx.globalAlpha = pulse;
              canvasCtx.drawImage(outline, sx - pad * scale, sy - pad * scale, outlineW, outlineH);
              canvasCtx.globalAlpha = 1;

              if (decal.angle !== 0) {
                canvasCtx.restore();
              }

              drewOutline = true;
            }
          }
        }

        // Fallback: simple rect
        if (!drewOutline) {
          canvasCtx.strokeStyle = `rgba(0, 220, 220, ${pulse})`;
          canvasCtx.lineWidth = 2;
          canvasCtx.strokeRect(sx + 2, sy + 2, tileScreenSize - 4, tileScreenSize - 4);
        }
      }
      markOverlayDirty();
    }

    // Draw box selection rectangle
    if (this.mode === 'boxSelect') {
      const minX = Math.floor(Math.min(this.boxStartX, this.boxCurrentX));
      const maxX = Math.floor(Math.max(this.boxStartX, this.boxCurrentX));
      const minY = Math.floor(Math.min(this.boxStartY, this.boxCurrentY));
      const maxY = Math.floor(Math.max(this.boxStartY, this.boxCurrentY));

      const sx = camera.worldToScreenX(minX, canvasW);
      const sy = camera.worldToScreenY(maxY, canvasH); // maxY because Y-up
      const sw = (maxX - minX + 1) * tileScreenSize;
      const sh = (maxY - minY + 1) * tileScreenSize;

      const marqueeFill = this.ctrlHeld
        ? 'rgba(255, 40, 40, 0.4)'
        : this.shiftHeld
          ? 'rgba(60, 255, 60, 0.25)'
          : 'rgba(50, 130, 255, 0.25)';
      const marqueeStroke = this.ctrlHeld
        ? 'rgba(255, 30, 30, 1)'
        : this.shiftHeld
          ? 'rgba(50, 255, 50, 0.9)'
          : 'rgba(50, 130, 255, 0.9)';
      canvasCtx.fillStyle = marqueeFill;
      canvasCtx.fillRect(sx, sy, sw, sh);
      canvasCtx.strokeStyle = marqueeStroke;
      canvasCtx.lineWidth = 1;
      canvasCtx.setLineDash([4, 4]);
      canvasCtx.strokeRect(sx, sy, sw, sh);
      canvasCtx.setLineDash([]);
    }

    // Draw paste ghost preview
    if (this.mode === 'pasting' && this.pasteData) {
      canvasCtx.globalAlpha = 0.5;
      for (const ce of this.pasteData.entities) {
        const ex = Math.floor(this.pasteX + ce.dx);
        const ey = Math.floor(this.pasteY + ce.dy);
        const sx = camera.worldToScreenX(ex, canvasW);
        const sy = camera.worldToScreenY(ey, canvasH);

        let drewSprite = false;
        if (state.registry) {
          const dir = rotToDir(ce.rotation);
          const sprite = getEntitySprite(ce.prototype, dir, state.registry);
          if (sprite) {
            const needsRotation = !isNoRot(ce.prototype, state.registry)
              && ce.rotation !== 0 && sprite.sh === sprite.image.height;
            canvasCtx.save();
            if (needsRotation) {
              const cx = sx + tileScreenSize / 2;
              const cy = sy + tileScreenSize / 2;
              canvasCtx.translate(cx, cy);
              canvasCtx.rotate(-ce.rotation);
              canvasCtx.translate(-cx, -cy);
            }
            canvasCtx.drawImage(
              sprite.image,
              sprite.sx, sprite.sy, sprite.sw, sprite.sh,
              sx, sy, tileScreenSize, tileScreenSize,
            );
            canvasCtx.restore();
            drewSprite = true;
          }
        }

        if (!drewSprite) {
          canvasCtx.fillStyle = '#44ff88';
          canvasCtx.fillRect(sx + 2, sy + 2, tileScreenSize - 4, tileScreenSize - 4);
        }
      }
      canvasCtx.globalAlpha = 1.0;

      // Border around paste region
      const { width, height } = this.pasteData;
      const borderX = camera.worldToScreenX(this.pasteX, canvasW);
      const borderY = camera.worldToScreenY(this.pasteY + height - 1, canvasH);
      canvasCtx.strokeStyle = '#44ff88';
      canvasCtx.lineWidth = 2;
      canvasCtx.setLineDash([4, 4]);
      canvasCtx.strokeRect(borderX, borderY, width * tileScreenSize, height * tileScreenSize);
      canvasCtx.setLineDash([]);
    }

    // Draw stack picker popup (entities + decals)
    const totalPickerItems = this.pickerEntities.length + this.pickerDecals.length;
    if (this.pickerOpen && totalPickerItems > 0) {
      // Highlight the currently-picked item on the map
      if (this.pickerIndex < this.pickerEntities.length) {
        const pickedEntity = this.pickerEntities[this.pickerIndex];
        if (pickedEntity) {
          const hx = camera.worldToScreenX(pickedEntity.position.x - 0.5, canvasW);
          const hy = camera.worldToScreenY(pickedEntity.position.y - 0.5, canvasH);
          canvasCtx.strokeStyle = 'rgba(255, 200, 50, 0.9)';
          canvasCtx.lineWidth = 3;
          canvasCtx.strokeRect(hx, hy, tileScreenSize, tileScreenSize);
        }
      } else {
        const decalIdx = this.pickerIndex - this.pickerEntities.length;
        const pickedDecal = this.pickerDecals[decalIdx];
        if (pickedDecal) {
          const hx = camera.worldToScreenX(Math.floor(pickedDecal.position.x), canvasW);
          const hy = camera.worldToScreenY(Math.floor(pickedDecal.position.y), canvasH);
          canvasCtx.strokeStyle = 'rgba(0, 220, 220, 0.9)';
          canvasCtx.lineWidth = 3;
          canvasCtx.strokeRect(hx, hy, tileScreenSize, tileScreenSize);
        }
      }

      // Draw popup list anchored to the right of the tile
      const popupX = camera.worldToScreenX(this.pickerTileX + 1, canvasW) + 4;
      const popupY = camera.worldToScreenY(this.pickerTileY, canvasH);

      const rowHeight = 22;
      const padding = 6;
      const fontSize = 12;
      const popupWidth = 220;
      const popupHeight = totalPickerItems * rowHeight + padding * 2;

      // Background
      canvasCtx.fillStyle = 'rgba(26, 26, 46, 0.95)';
      canvasCtx.strokeStyle = 'rgba(42, 42, 74, 1)';
      canvasCtx.lineWidth = 1;
      canvasCtx.setLineDash([]);
      canvasCtx.beginPath();
      canvasCtx.roundRect(popupX, popupY, popupWidth, popupHeight, 4);
      canvasCtx.fill();
      canvasCtx.stroke();

      // Rows
      canvasCtx.font = `${fontSize}px monospace`;
      canvasCtx.textBaseline = 'middle';

      for (let i = 0; i < totalPickerItems; i++) {
        const rowY = popupY + padding + i * rowHeight;
        const isEntity = i < this.pickerEntities.length;
        const itemName = isEntity
          ? this.pickerEntities[i].prototype
          : this.pickerDecals[i - this.pickerEntities.length].prototypeId;
        const typeTag = isEntity ? '[E]' : '[D]';
        const typeColor = isEntity ? '#88aaff' : '#88dddd';

        // Highlight selected row
        if (i === this.pickerIndex) {
          canvasCtx.fillStyle = 'rgba(15, 52, 96, 0.9)';
          canvasCtx.fillRect(popupX + 2, rowY, popupWidth - 4, rowHeight);
        }

        // Index label
        canvasCtx.fillStyle = '#888';
        canvasCtx.textAlign = 'left';
        canvasCtx.fillText(`${i + 1}/${totalPickerItems}`, popupX + padding, rowY + rowHeight / 2);

        // Type tag
        canvasCtx.fillStyle = typeColor;
        canvasCtx.fillText(typeTag, popupX + 42, rowY + rowHeight / 2);

        // Name
        canvasCtx.fillStyle = i === this.pickerIndex ? '#fff' : '#aaa';
        canvasCtx.fillText(String(itemName), popupX + 66, rowY + rowHeight / 2);
      }
    }
  }

  /** Rotate all selected entities by 90 degrees in the given direction. */
  rotateSelected(ctx: ToolContext, direction: 'cw' | 'ccw' = 'cw') {
    const { state } = ctx;
    if (state.selectedEntityUids.length === 0) return;

    const selectedUidSet = selectedSet(state.selectedEntityUids);
    const selected = state.entities.filter(e => selectedUidSet.has(e.uid));
    if (selected.length === 0) return;

    const delta = direction === 'cw' ? -Math.PI / 2 : Math.PI / 2;
    const entityChanges: { action: 'add' | 'remove'; entity: ImportedEntity }[] = [];

    for (const entity of selected) {
      const newRot = normalizeRotation(entity.rotation + delta);
      const rotated: ImportedEntity = {
        ...entity,
        rotation: newRot,
        components: updateTransformRot(entity.components, newRot),
      };
      entityChanges.push({ action: 'remove', entity });
      entityChanges.push({ action: 'add', entity: rotated });
    }

    const dirLabel = direction === 'cw' ? 'CW' : 'CCW';
    const label = selected.length === 1
      ? `Rotate ${selected[0].prototype} ${dirLabel}`
      : `Rotate ${selected.length} entities ${dirLabel}`;

    ctx.dispatch({
      type: 'APPLY_COMMAND',
      command: { label, tileChanges: [], entityChanges },
    });
  }

  /** Smooth-rotate all selected entities by an arbitrary delta (radians). */
  smoothRotateSelected(ctx: ToolContext, deltaRadians: number) {
    const { state } = ctx;
    if (state.selectedEntityUids.length === 0) return;

    const selectedUidSet = selectedSet(state.selectedEntityUids);
    const selected = state.entities.filter(e => selectedUidSet.has(e.uid));
    if (selected.length === 0) return;

    const entityChanges: { action: 'add' | 'remove'; entity: ImportedEntity }[] = [];

    for (const entity of selected) {
      const newRot = normalizeRotation(entity.rotation + deltaRadians);
      const rotated: ImportedEntity = {
        ...entity,
        rotation: newRot,
        components: updateTransformRot(entity.components, newRot),
      };
      entityChanges.push({ action: 'remove', entity });
      entityChanges.push({ action: 'add', entity: rotated });
    }

    const label = selected.length === 1
      ? `Rotate ${selected[0].prototype}`
      : `Rotate ${selected.length} entities`;

    ctx.dispatch({
      type: 'APPLY_COMMAND',
      command: { label, tileChanges: [], entityChanges },
    });
  }

  /** Delete all selected entities and decals. */
  deleteSelected(ctx: ToolContext) {
    const { state } = ctx;
    const hasEntities = state.selectedEntityUids.length > 0;
    const hasDecals = state.selectedDecalIds.length > 0;
    if (!hasEntities && !hasDecals) return;

    const selectedUidSet = selectedSet(state.selectedEntityUids);
    const selectedEntities = state.entities.filter(e => selectedUidSet.has(e.uid));

    const activeGrid = state.grids[state.activeGridIndex];
    const selectedDecalSet = new Set(state.selectedDecalIds);
    const decalChanges: DecalChange[] = activeGrid.decals.decals
      .filter(d => selectedDecalSet.has(d.id))
      .map(d => ({ action: 'remove' as const, decal: d }));

    if (selectedEntities.length === 0 && decalChanges.length === 0) return;

    const totalCount = selectedEntities.length + decalChanges.length;
    const label = totalCount === 1
      ? (selectedEntities.length === 1 ? `Delete ${selectedEntities[0].prototype}` : `Delete decal`)
      : `Delete ${totalCount} items`;

    ctx.dispatch({
      type: 'APPLY_COMMAND',
      command: {
        label,
        tileChanges: [],
        entityChanges: selectedEntities.map(e => ({ action: 'remove' as const, entity: e })),
        decalChanges: decalChanges.length > 0 ? decalChanges : undefined,
      },
    });
    ctx.dispatch({ type: 'SELECT_ENTITY', uids: [] });
    ctx.dispatch({ type: 'SELECT_DECAL', ids: [] });
  }

  deactivate() {
    this.mode = 'idle';
    this.pendingSelectUid = null;
    this.pendingSelectDecalId = null;
    this.pasteData = null;
    this.moveSnapshotDecals = [];
    this.closePicker();
  }
}

/** Convert rotation (radians) to cardinal direction for sprite lookup. */
function rotToDir(rotation: number): CardinalDirection {
  const TWO_PI = 2 * Math.PI;
  const norm = ((rotation % TWO_PI) + TWO_PI) % TWO_PI;
  if (norm < Math.PI / 4 || norm >= 7 * Math.PI / 4) return 'south';
  if (norm < 3 * Math.PI / 4) return 'east';
  if (norm < 5 * Math.PI / 4) return 'north';
  return 'west';
}
