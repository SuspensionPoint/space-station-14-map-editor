import type { TileGrid } from '../types';
import type { ImportedEntity } from '../import/mapImporter';
import type { PrefabData, PrefabTile, PrefabEntity, PrefabDeviceLink } from './prefabTypes';
import { getCell } from '../state/editorState';
import { collectContained } from '../tools/entityHelpers';

export interface SerializePrefabInput {
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  grid: TileGrid;
  entities: ImportedEntity[];
  containedEntities?: Record<number, ImportedEntity[]>;
  entityRawComponents: Record<number, string[]>;
}

export function serializePrefab(input: SerializePrefabInput): PrefabData {
  const { name, minX, minY, maxX, maxY, grid, entities, entityRawComponents } = input;
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;

  // 1. Sparse tile capture: iterate (minX..maxX, minY..maxY), skip Space tiles
  const tiles: PrefabTile[] = [];
  for (let wy = minY; wy <= maxY; wy++) {
    for (let wx = minX; wx <= maxX; wx++) {
      const cell = getCell(grid, wx, wy);
      if (cell && cell.tileId !== 'Space') {
        tiles.push({ dx: wx - minX, dy: wy - minY, tileId: cell.tileId });
      }
    }
  }

  // 2. Entity capture: filter entities where floor(position) is within bounds
  const insideEntities: ImportedEntity[] = [];
  for (const ent of entities) {
    const tileX = Math.floor(ent.position.x);
    const tileY = Math.floor(ent.position.y);
    if (tileX >= minX && tileX <= maxX && tileY >= minY && tileY <= maxY) {
      insideEntities.push(ent);
    }
  }

  // 3. Build UID → index map for device link resolution
  const uidToIndex = new Map<number, number>();
  for (let i = 0; i < insideEntities.length; i++) {
    uidToIndex.set(insideEntities[i].uid, i);
  }

  // 4. For each entity, store relative dx/dy, copy components, copy rawYamlLines
  const prefabEntities: PrefabEntity[] = insideEntities.map(ent => {
    const tileX = Math.floor(ent.position.x);
    const tileY = Math.floor(ent.position.y);
    const pe: PrefabEntity = {
      uid: ent.uid,
      dx: tileX - minX,
      dy: tileY - minY,
      prototype: ent.prototype,
      rotation: ent.rotation,
      components: ent.components.map(c => ({ ...c })),  // Clone to avoid shared references
    };
    if (ent.spriteStateOverride) {
      pe.spriteStateOverride = ent.spriteStateOverride;
    }
    const rawLines = entityRawComponents[ent.uid];
    if (rawLines && rawLines.length > 0) {
      pe.rawYamlLines = rawLines;
    }
    return pe;
  });

  // 5. Capture device links: DeviceLinkSource linkedPorts (only if both source and target inside)
  const deviceLinks: PrefabDeviceLink[] = [];
  for (let i = 0; i < insideEntities.length; i++) {
    const ent = insideEntities[i];
    for (const comp of ent.components) {
      const c = comp as Record<string, unknown>;
      if (c.type === 'DeviceLinkSource' && c.linkedPorts && typeof c.linkedPorts === 'object') {
        const ports = c.linkedPorts as Record<string, [string, string][]>;
        for (const [targetUidStr, pairs] of Object.entries(ports)) {
          const targetUid = Number(targetUidStr);
          const targetIdx = uidToIndex.get(targetUid);
          if (targetIdx !== undefined) {
            for (const [port, sink] of pairs) {
              deviceLinks.push({ sourceIdx: i, targetIdx, port, sink });
            }
          }
        }
      }
    }
  }

  const contained = collectContained(input.containedEntities ?? {}, insideEntities.map(e => e.uid));

  return { name, width, height, tiles, entities: prefabEntities, contained, deviceLinks };
}
