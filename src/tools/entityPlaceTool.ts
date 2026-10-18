import type { ITool, ToolContext } from './toolTypes';
import type { ImportedEntity } from '../import/mapImporter';
import type { CardinalDirection } from '../types';
import { buildTransformComponent, normalizeRotation } from './entityHelpers';
import { getCenteredSpriteRect, getEntitySprite } from '../rendering/entityRenderer';

function rotToDir(rotation: number): CardinalDirection {
  const TWO_PI = 2 * Math.PI;
  const norm = ((rotation % TWO_PI) + TWO_PI) % TWO_PI;
  if (norm < Math.PI / 4 || norm >= 7 * Math.PI / 4) return 'south';
  if (norm < 3 * Math.PI / 4) return 'east';
  if (norm < 5 * Math.PI / 4) return 'north';
  return 'west';
}

export class EntityPlaceTool implements ITool {
  name = 'entityPlace';
  cursor = 'crosshair';

  private _rotation = 0;

  get currentRotation(): number {
    return this._rotation;
  }

  onMouseDown(ctx: ToolContext, tileX: number, tileY: number, button: number) {
    if (button !== 0) return;

    const { state, dispatch, shiftHeld } = ctx;
    if (!state.selectedPaletteItem || state.selectedPaletteItem.type !== 'entity') return;

    const protoId = state.selectedPaletteItem.id;
    const uid = state.nextEntityId;

    // Free placement: use exact fractional coords; grid-snap: center of tile
    const pos = shiftHeld
      ? { x: tileX, y: tileY }
      : { x: Math.floor(tileX) + 0.5, y: Math.floor(tileY) + 0.5 };
    const rot = this.currentRotation;
    const entity: ImportedEntity = {
      uid,
      prototype: protoId,
      position: pos,
      rotation: rot,
      components: buildTransformComponent(pos, rot, state.gridUid),
    };

    dispatch({
      type: 'APPLY_COMMAND',
      command: {
        label: `Place ${protoId}`,
        tileChanges: [],
        entityChanges: [{ action: 'add', entity }],
      },
    });
  }

  onMouseMove() {}

  onMouseUp() {}

  renderPreview(
    canvasCtx: CanvasRenderingContext2D,
    toolCtx: ToolContext,
    cursorTileX: number,
    cursorTileY: number,
  ) {
    const { state, camera, canvasW, canvasH, shiftHeld } = toolCtx;
    if (!state.selectedPaletteItem || state.selectedPaletteItem.type !== 'entity') return;

    const tileScreenSize = camera.tileScreenSize;
    // In free mode, center sprite on cursor (position is entity center, draw from top-left)
    // In grid mode, draw at tile top-left (entity will be placed at tile center)
    const drawOriginX = shiftHeld ? cursorTileX - 0.5 : Math.floor(cursorTileX);
    const drawOriginY = shiftHeld ? cursorTileY - 0.5 : Math.floor(cursorTileY);
    const drawX = camera.worldToScreenX(drawOriginX, canvasW);
    const drawY = camera.worldToScreenY(drawOriginY, canvasH);

    const protoId = state.selectedPaletteItem.id;
    const direction = rotToDir(this.currentRotation);

    // Try to draw entity sprite as ghost preview
    let drewSprite = false;
    let previewBottom = drawY + tileScreenSize;
    if (state.registry) {
      const sprite = getEntitySprite(protoId, direction, state.registry);
      if (sprite) {
        const spriteRect = getCenteredSpriteRect(
          drawX, drawY, tileScreenSize, sprite.sw, sprite.sh,
        );
        const needsRotation = this.currentRotation !== 0 && sprite.sh === sprite.image.height;
        canvasCtx.save();
        canvasCtx.globalAlpha = 0.5;
        if (needsRotation) {
          const cx = drawX + tileScreenSize / 2;
          const cy = drawY + tileScreenSize / 2;
          canvasCtx.translate(cx, cy);
          canvasCtx.rotate(-this.currentRotation);
          canvasCtx.translate(-cx, -cy);
        }
        canvasCtx.drawImage(
          sprite.image,
          sprite.sx, sprite.sy, sprite.sw, sprite.sh,
          spriteRect.x, spriteRect.y, spriteRect.width, spriteRect.height,
        );
        canvasCtx.restore();
        drewSprite = true;
        previewBottom = Math.max(previewBottom, spriteRect.y + spriteRect.height);
      }
    }

    // Fallback: dashed rectangle when sprite not available
    if (!drewSprite) {
      canvasCtx.strokeStyle = shiftHeld ? 'rgba(100, 200, 255, 0.6)' : 'rgba(0, 255, 100, 0.6)';
      canvasCtx.lineWidth = 2;
      canvasCtx.setLineDash([4, 4]);
      canvasCtx.strokeRect(drawX, drawY, tileScreenSize, tileScreenSize);
      canvasCtx.setLineDash([]);
    }

    // Rotation indicator arrow
    if (this.currentRotation !== 0) {
      const cx = drawX + tileScreenSize / 2;
      const cy = drawY + tileScreenSize / 2;
      const arrowLen = tileScreenSize * 0.3;

      canvasCtx.save();
      canvasCtx.translate(cx, cy);
      canvasCtx.rotate(-this.currentRotation + Math.PI / 2);

      canvasCtx.strokeStyle = shiftHeld ? 'rgba(100, 200, 255, 0.8)' : 'rgba(0, 255, 100, 0.8)';
      canvasCtx.lineWidth = 2;
      canvasCtx.beginPath();
      canvasCtx.moveTo(0, -arrowLen);
      canvasCtx.lineTo(0, arrowLen);
      canvasCtx.moveTo(-arrowLen * 0.4, arrowLen * 0.5);
      canvasCtx.lineTo(0, arrowLen);
      canvasCtx.lineTo(arrowLen * 0.4, arrowLen * 0.5);
      canvasCtx.stroke();

      canvasCtx.restore();
    }

    // Label
    if (tileScreenSize > 16) {
      canvasCtx.font = '10px sans-serif';
      canvasCtx.fillStyle = shiftHeld ? 'rgba(100, 200, 255, 0.8)' : 'rgba(0, 255, 100, 0.8)';
      canvasCtx.textAlign = 'center';
      canvasCtx.textBaseline = 'top';
      const label = shiftHeld ? `${protoId} (free)` : protoId;
      canvasCtx.fillText(label, drawX + tileScreenSize / 2, previewBottom + 2);
    }
  }

  /** Cycle placement rotation by 90° in the given direction (called from keyboard shortcut). */
  cycleRotation(direction: 'cw' | 'ccw' = 'cw') {
    const delta = direction === 'cw' ? -Math.PI / 2 : Math.PI / 2;
    this._rotation = normalizeRotation(this._rotation + delta);
  }

  /** Apply smooth fractional rotation (called from R + scroll). */
  smoothRotate(deltaRadians: number) {
    this._rotation = normalizeRotation(this._rotation + deltaRadians);
  }

  /** Reset rotation to default (0). Called when switching palette entities. */
  resetRotation() {
    this._rotation = 0;
  }

  deactivate() {
    this._rotation = 0;
  }
}
