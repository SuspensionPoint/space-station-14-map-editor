/**
 * Export an ImportedMap back to SS14 map YAML (format 6 or 7).
 *
 * This is the counterpart to mapImporter, it takes the in-memory ImportedMap
 * representation and produces a valid YAML string that SS14 can load.
 *
 * Key steps:
 *  1. Build tilemap (index <-> tileId mappings)
 *  2. Encode 16x16 tile chunks to base64 (6 or 7 bytes/tile)
 *  3. Emit structural entities (map + grid) with preserved components
 *  4. Group non-structural entities by prototype and emit verbatim components
 */

import type { ImportedMap, ImportedEntity } from '../import/mapImporter';
import type { TileGrid } from '../types';
import type { DecalInstance } from '../import/decalParser';
import { serializeDecalGrid } from './decalExporter';

// ---- Constants ----

const CHUNK_SIZE = 16;
const TILES_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

// ---- Main entry point ----

export function exportMap(map: ImportedMap, decalsDirty?: Set<number>): string {
  const format = map.meta.format;
  const { tilemap, reverseTilemap } = buildTilemap(map);
  const gridChunksMap = buildGridChunksMap(map, reverseTilemap);
  const gridDecalsMap = buildGridDecalsMap(map, decalsDirty);
  const entityGroupsYaml = buildEntityGroupsYaml(map);

  const lines: string[] = [];

  // Meta
  lines.push('meta:');
  lines.push(`  format: ${format}`);
  if (map.meta.category) lines.push(`  category: ${map.meta.category}`);
  if (map.meta.engineVersion) lines.push(`  engineVersion: ${map.meta.engineVersion}`);
  if (map.meta.forkId !== undefined) lines.push(`  forkId: ${formatPrimitive(map.meta.forkId)}`);
  if (map.meta.forkVersion !== undefined) lines.push(`  forkVersion: ${formatPrimitive(map.meta.forkVersion)}`);
  if (map.meta.time) lines.push(`  time: ${map.meta.time}`);
  if (map.meta.entityCount !== undefined) {
    // Count entities across all grids
    const allEntities = getAllEntities(map);
    const allContained = getAllContainedEntities(map);
    const containedCount = Object.values(allContained).reduce((sum, arr) => sum + arr.length, 0);
    lines.push(`  entityCount: ${allEntities.length + containedCount + Object.keys(map.structuralEntityData ?? {}).length}`);
  }
  // Only emit postmapinit if it was present in the original file.
  // SS14 treats absence as "not yet initialized", adding false when absent can change behavior.
  if (map.meta.postmapinit !== undefined) {
    lines.push(`  postmapinit: ${map.meta.postmapinit ? 'true' : 'false'}`);
  }

  // Format 7+ top-level keys
  if (format >= 7) {
    // orphans/nullspace must be preserved: SS14 uses orphans to find the root grid of a
    // standalone grid file, and nullspace to place entities such as decal ChunkEntity holders.
    // Drop UIDs whose entities were deleted in the editor.
    const exportedUids = collectExportedUids(map);
    pushUidList(lines, 'maps', map.maps ?? [map.mapUid]);
    pushUidList(lines, 'grids', map.grids ?? [map.gridUid]);
    pushUidList(lines, 'orphans', (map.orphans ?? []).filter(uid => exportedUids.has(uid)));
    pushUidList(lines, 'nullspace', (map.nullspace ?? []).filter(uid => exportedUids.has(uid)));
  }

  // Tilemap, Space first (index 0), then remaining sorted by name (matching SS14 engine)
  lines.push('tilemap:');
  const tilemapEntries = Object.entries(tilemap).map(([k, v]) => [Number(k), v] as [number, string]);
  // Space always first, rest alphabetical by name
  tilemapEntries.sort((a, b) => {
    if (a[1] === 'Space') return -1;
    if (b[1] === 'Space') return 1;
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  });
  for (const [idx, name] of tilemapEntries) {
    lines.push(`  ${idx}: ${name}`);
  }

  // Entities section
  lines.push('entities:');

  // Structural entity group (proto: "")
  lines.push('- proto: ""');
  lines.push('  entities:');

  if (map.structuralEntityData) {
    // Emit structural entities with preserved components
    for (const [uidStr, components] of Object.entries(map.structuralEntityData)) {
      const uid = Number(uidStr);
      lines.push(`  - uid: ${uid}`);
      // Emit entity-level preamble lines if present
      const structPreamble = map.entityRawPreamble?.[uid];
      if (structPreamble) {
        for (const pl of structPreamble) lines.push(pl);
      }
      lines.push('    components:');

      // Look up per-grid chunks for this entity (if it's a grid entity)
      const thisGridChunks = gridChunksMap.get(uid) ?? [];

      const rawLines = map.entityRawComponents?.[uid];
      const decalLines = gridDecalsMap.get(uid);
      if (rawLines) {
        // Use raw YAML lines for verbatim roundtrip, replacing MapGrid chunks
        // and optionally replacing DecalGrid section
        emitStructuralEntityRawWithReplacements(lines, rawLines, thisGridChunks, decalLines);
      } else {
        // Fall back to re-serialization
        let hasDecalGrid = false;
        for (const comp of components) {
          const stripped = stripInternalTags(comp) as Record<string, unknown>;
          if (stripped.type === 'MapGrid') {
            // Re-emit MapGrid with rebuilt chunks
            lines.push('    - type: MapGrid');
            // Emit any extra MapGrid properties (not chunks)
            for (const [k, v] of Object.entries(stripped)) {
              if (k === 'type') continue;
              emitValue(lines, k, v, 6);
            }
            if (thisGridChunks.length > 0) {
              lines.push('      chunks:');
              for (const cl of thisGridChunks) lines.push(cl);
            }
          } else if (stripped.type === 'DecalGrid' && decalLines) {
            // Replace DecalGrid with freshly serialized content
            hasDecalGrid = true;
            for (const dl of decalLines) lines.push(dl);
          } else {
            emitComponent(lines, stripped);
          }
        }
        // Append DecalGrid if not already present but we have dirty decals
        if (!hasDecalGrid && decalLines) {
          for (const dl of decalLines) lines.push(dl);
        }
      }
    }
  } else {
    // Fallback: generate minimal structural entities
    const fallbackChunks = gridChunksMap.get(map.gridUid) ?? [];

    lines.push(`  - uid: ${map.mapUid}`);
    lines.push('    components:');
    lines.push('    - type: MetaData');
    lines.push('    - type: Transform');
    lines.push('    - type: Map');
    lines.push('      mapPaused: True');
    lines.push('    - type: Broadphase');
    lines.push('    - type: OccluderTree');

    lines.push(`  - uid: ${map.gridUid}`);
    lines.push('    components:');
    lines.push('    - type: MetaData');
    lines.push('      name: Station');
    lines.push('    - type: Transform');
    lines.push(`      parent: ${map.mapUid}`);
    lines.push('    - type: MapGrid');
    if (fallbackChunks.length > 0) {
      lines.push('      chunks:');
      for (const cl of fallbackChunks) lines.push(cl);
    }
    // Append DecalGrid if we have dirty decals for this grid
    const fallbackDecalLines = gridDecalsMap.get(map.gridUid);
    if (fallbackDecalLines) {
      for (const dl of fallbackDecalLines) lines.push(dl);
    }
  }

  // Entity groups, use concat to avoid stack overflow with large arrays
  for (const line of entityGroupsYaml) {
    lines.push(line);
  }

  // Re-emit YAML document terminator if the original file had one
  if (map.hasDocumentTerminator) {
    lines.push('...');
  }

  const eol = map.lineEnding === '\r\n' ? '\r\n' : '\n';
  return lines.join(eol) + eol;
}

// ---- Tilemap building ----

/** Collect all grid cells across all grids (or fall back to legacy single grid). */
function getAllGridCells(map: ImportedMap): import('../types').TileCell[] {
  if (map.gridDataList && map.gridDataList.length > 0) {
    const allCells: import('../types').TileCell[] = [];
    for (const gd of map.gridDataList) {
      for (const cell of gd.grid.cells) {
        allCells.push(cell);
      }
    }
    return allCells;
  }
  return map.grid.cells;
}

/** Emit a top-level UID list. Empty lists must be written as `[]`, since a bare key is read as null. */
function pushUidList(lines: string[], key: string, uids: number[]): void {
  if (uids.length === 0) {
    lines.push(`${key}: []`);
    return;
  }
  lines.push(`${key}:`);
  for (const uid of uids) {
    lines.push(`- ${uid}`);
  }
}

/** Collect the UIDs of every entity that will be written to the file. */
function collectExportedUids(map: ImportedMap): Set<number> {
  const uids = new Set<number>(getAllEntities(map).map(e => e.uid));
  for (const children of Object.values(getAllContainedEntities(map))) {
    for (const child of children) uids.add(child.uid);
  }
  if (map.structuralEntityData) {
    for (const uidStr of Object.keys(map.structuralEntityData)) uids.add(Number(uidStr));
  } else {
    // Fallback path emits a default map and grid entity
    uids.add(map.mapUid);
    uids.add(map.gridUid);
  }
  return uids;
}

/** Collect all non-structural entities across all grids (or fall back to legacy). */
function getAllEntities(map: ImportedMap): ImportedEntity[] {
  if (map.gridDataList && map.gridDataList.length > 0) {
    const all: ImportedEntity[] = [];
    for (const gd of map.gridDataList) {
      all.push(...gd.entities);
    }
    return all;
  }
  return map.entities;
}

/** Collect all contained entities across all grids (or fall back to legacy). */
function getAllContainedEntities(map: ImportedMap): Record<number, ImportedEntity[]> {
  if (map.gridDataList && map.gridDataList.length > 0) {
    const all: Record<number, ImportedEntity[]> = {};
    for (const gd of map.gridDataList) {
      for (const [parentUid, children] of Object.entries(gd.containedEntities)) {
        all[Number(parentUid)] = children;
      }
    }
    return all;
  }
  return map.containedEntities ?? {};
}

function buildTilemap(map: ImportedMap): {
  tilemap: Record<number, string>;
  reverseTilemap: Record<string, number>;
} {
  // Preserve the original tilemap indices for roundtrip fidelity.
  // This ensures chunk base64 data is identical to the original.
  if (map.tilemap && Object.keys(map.tilemap).length > 0) {
    const tilemap: Record<number, string> = { ...map.tilemap };
    const reverseTilemap: Record<string, number> = {};
    for (const [idx, name] of Object.entries(tilemap)) {
      reverseTilemap[name] = Number(idx);
    }

    // Add any NEW tile types not in the original tilemap (from user edits)
    // Scan ALL grids' cells for new tile types
    let maxIndex = Math.max(...Object.keys(tilemap).map(Number));
    for (const cell of getAllGridCells(map)) {
      if (!(cell.tileId in reverseTilemap)) {
        maxIndex++;
        tilemap[maxIndex] = cell.tileId;
        reverseTilemap[cell.tileId] = maxIndex;
      }
    }

    return { tilemap, reverseTilemap };
  }

  // Fallback for maps without a tilemap (e.g. programmatically created)
  const tileIds = new Set<string>();
  for (const cell of getAllGridCells(map)) {
    tileIds.add(cell.tileId);
  }

  const tilemap: Record<number, string> = { 0: 'Space' };
  const reverseTilemap: Record<string, number> = { Space: 0 };
  tileIds.delete('Space');

  let nextIndex = 1;
  for (const tileId of [...tileIds].sort()) {
    tilemap[nextIndex] = tileId;
    reverseTilemap[tileId] = nextIndex;
    nextIndex++;
  }

  return { tilemap, reverseTilemap };
}

// ---- Chunk encoding ----

interface ChunkTile {
  typeId: number;
  flags: number;
  variant: number;
  rotationMirroring: number;
}

/**
 * Build chunk YAML lines for a single grid.
 */
function buildChunksYamlForGrid(
  grid: TileGrid,
  format: number,
  reverseTilemap: Record<string, number>,
  chunkKeyOrder?: string[],
): string[] {
  const { width, height, offsetX, offsetY, cells } = grid;
  if (width === 0 || height === 0) return [];

  // Space tile index, may not be 0 in format 7 maps
  const spaceTileIndex = reverseTilemap['Space'] ?? 0;

  // Build chunks from grid cells
  const chunks = new Map<string, ChunkTile[]>();

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const cell = cells[row * width + col];
      const tileIndex = reverseTilemap[cell.tileId] ?? spaceTileIndex;

      // World coordinates
      const worldX = offsetX + col;
      const worldY = offsetY + row;

      // Chunk coordinates
      const cx = Math.floor(worldX / CHUNK_SIZE);
      const cy = Math.floor(worldY / CHUNK_SIZE);
      const key = `${cx},${cy}`;

      if (!chunks.has(key)) {
        const empty: ChunkTile[] = new Array(TILES_PER_CHUNK);
        for (let i = 0; i < TILES_PER_CHUNK; i++) {
          empty[i] = { typeId: spaceTileIndex, flags: 0, variant: 0, rotationMirroring: 0 };
        }
        chunks.set(key, empty);
      }

      // Local tile position within the chunk
      const lx = ((worldX % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      const ly = ((worldY % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      const localIdx = ly * CHUNK_SIZE + lx;

      // Always export variant as 0. The editor has no variant editing capability,
      // and preserving imported variants is dangerous: the paint tool bug (now fixed)
      // could leave stale variants from old tile types that exceed the new tile's
      // variant count, crashing SS14's MapRenderer. The game engine re-randomizes
      // tile variants at map load time for tiles that support visual variety.
      chunks.get(key)![localIdx] = {
        typeId: tileIndex,
        flags: cell.flags ?? 0,
        variant: 0,
        rotationMirroring: cell.rotationMirroring ?? 0,
      };
    }
  }

  // Remove all-Space chunks (where every tile is the Space tile type with no flags/variant)
  for (const [key, tiles] of chunks) {
    if (tiles.every(t => t.typeId === spaceTileIndex && t.flags === 0 && t.variant === 0 && t.rotationMirroring === 0)) {
      chunks.delete(key);
    }
  }

  if (chunks.size === 0) return [];

  // Preserve original chunk order if available, append new chunks sorted
  const originalOrder = chunkKeyOrder ?? [];
  const chunkKeySet = new Set(chunks.keys());
  const orderedKeys: string[] = [];
  for (const key of originalOrder) {
    if (chunkKeySet.has(key)) {
      orderedKeys.push(key);
      chunkKeySet.delete(key);
    }
  }
  // Append any new chunks not in original order (sorted for determinism)
  const newKeys = [...chunkKeySet].sort((a, b) => {
    const [ax, ay] = a.split(',').map(Number);
    const [bx, by] = b.split(',').map(Number);
    return ay - by || ax - bx;
  });
  orderedKeys.push(...newKeys);
  const sortedKeys = orderedKeys;

  const chunkVersion = format >= 7 ? 7 : 6;
  const lines: string[] = [];
  for (const key of sortedKeys) {
    const b64 = encodeChunk(chunks.get(key)!, format);
    lines.push(`        ${key}:`);
    lines.push(`          ind: ${key}`);
    lines.push(`          tiles: ${b64}`);
    lines.push(`          version: ${chunkVersion}`);
  }

  return lines;
}

/**
 * Build a map of gridUid -> chunk YAML lines for all grids.
 */
function buildGridChunksMap(
  map: ImportedMap,
  reverseTilemap: Record<string, number>,
): Map<number, string[]> {
  const result = new Map<number, string[]>();
  const format = map.meta.format;

  if (map.gridDataList && map.gridDataList.length > 0) {
    for (const gd of map.gridDataList) {
      const chunks = buildChunksYamlForGrid(gd.grid, format, reverseTilemap, gd.chunkKeyOrder);
      result.set(gd.gridUid, chunks);
    }
  } else {
    // Legacy single-grid fallback
    const chunks = buildChunksYamlForGrid(map.grid, format, reverseTilemap, map.chunkKeyOrder);
    result.set(map.gridUid, chunks);
  }

  return result;
}

/**
 * Build a map of gridUid -> serialized DecalGrid YAML lines for dirty grids.
 * Only includes grids that are in the decalsDirty set and have decal data.
 */
function buildGridDecalsMap(
  map: ImportedMap,
  decalsDirty?: Set<number>,
): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (!decalsDirty || decalsDirty.size === 0) return result;

  if (map.gridDataList && map.gridDataList.length > 0) {
    for (const gd of map.gridDataList) {
      if (decalsDirty.has(gd.gridUid)) {
        result.set(gd.gridUid, serializeDecalGrid(gd.decals.decals));
      }
    }
  }

  return result;
}

function encodeChunk(tiles: ChunkTile[], format: number): string {
  const bytesPerTile = format >= 7 ? 7 : 6;
  const buf = new ArrayBuffer(TILES_PER_CHUNK * bytesPerTile);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  for (let i = 0; i < TILES_PER_CHUNK; i++) {
    const off = i * bytesPerTile;
    const tile = tiles[i];
    view.setInt32(off, tile.typeId, true);
    bytes[off + 4] = tile.flags;
    bytes[off + 5] = tile.variant;
    if (bytesPerTile >= 7) {
      bytes[off + 6] = tile.rotationMirroring;
    }
  }

  return uint8ArrayToBase64(bytes);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// ---- Dangling reference cleanup ----

/**
 * Remove device UID references that point to non-existent entities.
 * Mutates entities in place for efficiency (called right before export serialization).
 *
 * Cleans up:
 * - DeviceList.devices: number[], filter out UIDs not in validUids
 * - DeviceLinkSource.linkedPorts: Record<uid, ...>, delete keys for UIDs not in validUids
 * - DeviceNetwork.deviceLists: number[], filter out UIDs not in validUids
 */
function stripDanglingDeviceRefs(
  entities: ImportedEntity[],
  validUids: Set<number>,
  entityRawComponents?: Record<number, string[]>,
): void {
  for (const entity of entities) {
    let modified = false;
    for (let i = 0; i < entity.components.length; i++) {
      const comp = entity.components[i] as Record<string, unknown>;

      if (comp.type === 'DeviceList' && Array.isArray(comp.devices)) {
        const filtered = (comp.devices as number[]).filter(uid => validUids.has(uid));
        if (filtered.length !== (comp.devices as number[]).length) {
          entity.components[i] = { ...comp, devices: filtered };
          modified = true;
        }
      }

      if (comp.type === 'DeviceLinkSource' && comp.linkedPorts && typeof comp.linkedPorts === 'object') {
        const ports = comp.linkedPorts as Record<string, unknown>;
        let changed = false;
        const cleaned: Record<string, unknown> = {};
        for (const [uidStr, value] of Object.entries(ports)) {
          const uid = parseInt(uidStr, 10);
          if (!isNaN(uid) && validUids.has(uid)) {
            cleaned[uidStr] = value;
          } else {
            changed = true;
          }
        }
        if (changed) {
          entity.components[i] = { ...comp, linkedPorts: cleaned };
          modified = true;
        }
      }

      if (comp.type === 'DeviceNetwork' && Array.isArray(comp.deviceLists)) {
        const filtered = (comp.deviceLists as number[]).filter(uid => validUids.has(uid));
        if (filtered.length !== (comp.deviceLists as number[]).length) {
          entity.components[i] = { ...comp, deviceLists: filtered };
          modified = true;
        }
      }
    }

    // If components were modified, invalidate raw YAML so the exporter
    // uses component-based serialization instead of the stale raw lines
    if (modified && entityRawComponents && entityRawComponents[entity.uid]) {
      delete entityRawComponents[entity.uid];
    }
  }
}

// ---- Entity group building ----

function buildEntityGroupsYaml(map: ImportedMap): string[] {
  // Build entity-to-grid mapping for synthesized Transform parent field
  const entityGridMap = new Map<number, number>();
  if (map.gridDataList && map.gridDataList.length > 0) {
    for (const gd of map.gridDataList) {
      for (const e of gd.entities) {
        entityGridMap.set(e.uid, gd.gridUid);
      }
    }
  }

  // Combine grid entities with contained entities for export (from all grids)
  const gridEntities = getAllEntities(map);
  const allContained = getAllContainedEntities(map);
  const allEntities: ImportedEntity[] = [...gridEntities];

  if (Object.keys(allContained).length > 0) {
    // Build set of valid parent UIDs, grid entities are always valid
    const validUids = new Set(gridEntities.map(e => e.uid));
    // Iteratively resolve transitive containment (entity inside entity inside entity...)
    let changed = true;
    while (changed) {
      changed = false;
      for (const [parentUidStr, children] of Object.entries(allContained)) {
        if (validUids.has(Number(parentUidStr))) {
          for (const child of children) {
            if (!validUids.has(child.uid)) {
              validUids.add(child.uid);
              changed = true;
            }
          }
        }
      }
    }
    for (const [parentUidStr, children] of Object.entries(allContained)) {
      if (validUids.has(Number(parentUidStr))) {
        allEntities.push(...children);
      }
    }
  }

  // Restore original file order using entityOrder (preserves YAML encounter order)
  if (map.entityOrder) {
    const orderMap = new Map<number, number>();
    for (let i = 0; i < map.entityOrder.length; i++) {
      orderMap.set(map.entityOrder[i], i);
    }
    allEntities.sort((a, b) => {
      const oa = orderMap.get(a.uid) ?? Number.MAX_SAFE_INTEGER;
      const ob = orderMap.get(b.uid) ?? Number.MAX_SAFE_INTEGER;
      return oa - ob;
    });
  }

  if (allEntities.length === 0) return [];

  // Strip dangling device references (UIDs pointing to entities that don't exist).
  // This can happen when a linked entity is deleted but the DeviceList/DeviceLinkSource
  // on the other entity isn't cleaned up, or when DeviceNetwork.deviceLists references
  // a deleted alarm entity.
  const validUidSet = new Set(allEntities.map(e => e.uid));
  // Also include structural UIDs (map entity, grid entities) that aren't in allEntities
  validUidSet.add(map.mapUid);
  validUidSet.add(map.gridUid);
  if (map.gridDataList) {
    for (const gd of map.gridDataList) validUidSet.add(gd.gridUid);
  }
  stripDanglingDeviceRefs(allEntities, validUidSet, map.entityRawComponents);

  // Group entities by prototype
  const groups = new Map<string, ImportedEntity[]>();
  for (const entity of allEntities) {
    const proto = entity.prototype;
    if (!groups.has(proto)) {
      groups.set(proto, []);
    }
    groups.get(proto)!.push(entity);
  }

  const lines: string[] = [];

  // Preserve original group ordering (Map insertion order matches import order)
  for (const proto of groups.keys()) {
    const entities = groups.get(proto)!;
    lines.push(`- proto: ${proto}`);
    lines.push('  entities:');

    for (const entity of entities) {
      lines.push(`  - uid: ${entity.uid}`);
      // Emit entity-level preamble lines (e.g., mapInit, paused) if present
      const preambleLines = map.entityRawPreamble?.[entity.uid];
      if (preambleLines) {
        for (const pl of preambleLines) lines.push(pl);
      }
      lines.push('    components:');

      const rawLines = map.entityRawComponents?.[entity.uid];
      if (rawLines) {
        // Emit raw YAML lines verbatim for byte-exact roundtrip
        for (const rl of rawLines) lines.push(rl);
      } else {
        // Check if entity already has a Transform component in its components array
        const hasTransform = entity.components.some(
          (c: Record<string, unknown>) => c.type === 'Transform',
        );

        if (!hasTransform) {
          // Synthesize Transform from entity position/rotation for editor-placed entities
          // Use the correct grid UID for this entity's grid
          const parentUid = entityGridMap.get(entity.uid) ?? map.gridUid;
          const transformComp: Record<string, unknown> = {
            type: 'Transform',
            pos: `${entity.position.x},${entity.position.y}`,
            parent: parentUid,
          };
          if (entity.rotation !== 0) {
            transformComp.rot = `${entity.rotation} rad`;
          }
          emitComponent(lines, transformComp);
        }

        for (const comp of entity.components) {
          emitComponent(lines, stripInternalTags(comp) as Record<string, unknown>);
        }
      }
    }
  }

  return lines;
}

/**
 * Emit raw component lines for a structural entity verbatim,
 * but replace the MapGrid chunks section with rebuilt chunk data,
 * and optionally replace the DecalGrid section with freshly serialized decals.
 */
function emitStructuralEntityRawWithReplacements(
  lines: string[],
  rawComponentLines: string[],
  chunksYaml: string[],
  decalLines?: string[],
): void {
  let inMapGridChunks = false;
  let inDecalGrid = false;
  let decalGridFound = false;

  for (const line of rawComponentLines) {
    // Detect the `      chunks:` line under MapGrid
    if (!inMapGridChunks && !inDecalGrid && /^\s{6}chunks:\s*$/.test(line)) {
      inMapGridChunks = true;
      lines.push(line);
      // Emit rebuilt chunks in place of original
      for (const cl of chunksYaml) lines.push(cl);
      continue;
    }

    if (inMapGridChunks) {
      // Skip original chunk data lines (indent >= 8 or blank within chunk block)
      if (/^\s{8}/.test(line) || line === '') {
        continue;
      }
      // Exited chunks section, emit this line normally
      inMapGridChunks = false;
    }

    // Detect DecalGrid component start: "    - type: DecalGrid"
    if (!inDecalGrid && decalLines && /^\s{4}- type: DecalGrid\s*$/.test(line)) {
      inDecalGrid = true;
      decalGridFound = true;
      // Emit replacement DecalGrid lines instead
      for (const dl of decalLines) lines.push(dl);
      continue;
    }

    if (inDecalGrid) {
      // Skip lines belonging to the original DecalGrid component.
      // A new component starts with "    - type:" at indent 4.
      if (/^\s{4}- type:/.test(line)) {
        // This is the start of the next component, stop skipping
        inDecalGrid = false;
        lines.push(line);
        continue;
      }
      // Still inside DecalGrid, skip this line
      continue;
    }

    lines.push(line);
  }

  // Append DecalGrid if it wasn't present in the raw lines but we have dirty decals
  if (!decalGridFound && decalLines) {
    for (const dl of decalLines) lines.push(dl);
  }
}

/**
 * Emit a single component as YAML lines.
 * Components are Record<string, unknown> objects with a `type` field.
 * We write them verbatim, preserving all keys.
 */
function emitComponent(lines: string[], comp: Record<string, unknown>): void {
  const keys = Object.keys(comp);

  // `type` always comes first
  lines.push(`    - type: ${comp.type}`);

  for (const key of keys) {
    if (key === 'type') continue;
    const value = comp[key];
    emitValue(lines, key, value, 6);
  }
}

/**
 * Emit a key-value pair at a given indentation level (in spaces).
 */
function emitValue(
  lines: string[],
  key: string,
  value: unknown,
  indent: number,
): void {
  const prefix = ' '.repeat(indent);

  if (value === null || value === undefined) {
    lines.push(`${prefix}${key}:`);
  } else if (typeof value === 'object' && !Array.isArray(value)) {
    // Nested object, check for SS14 YAML type tag
    const record = value as Record<string, unknown>;
    const tag = record._ss14Tag as string | undefined;
    const entries = Object.entries(record).filter(([k]) => k !== '_ss14Tag');

    if (entries.length === 0 && !tag) {
      // Empty object, emit as {} to preserve the mapping type
      lines.push(`${prefix}${key}: {}`);
    } else {
      if (tag) {
        lines.push(`${prefix}${key}: ${tag}`);
      } else {
        lines.push(`${prefix}${key}:`);
      }
      for (const [k, v] of entries) {
        emitValue(lines, k, v, indent + 2);
      }
    }
  } else if (Array.isArray(value)) {
    lines.push(`${prefix}${key}:`);
    if (value.length === 0) {
      // Replace last line to show empty array
      lines[lines.length - 1] = `${prefix}${key}: []`;
    } else {
      for (const item of value) {
        if (Array.isArray(item)) {
          // Nested sequence: emit as "- - val1\n  - val2"
          emitNestedSequence(lines, item, indent);
        } else if (typeof item === 'object' && item !== null) {
          // First key of the object gets the "- " prefix; skip _ss14Tag
          const entries = Object.entries(item as Record<string, unknown>)
            .filter(([k]) => k !== '_ss14Tag');
          if (entries.length > 0) {
            const [firstKey, firstVal] = entries[0];
            const itemPrefix = prefix + '- ';
            if (isPrimitive(firstVal)) {
              lines.push(`${itemPrefix}${firstKey}: ${formatPrimitive(firstVal)}`);
            } else if (Array.isArray(firstVal)) {
              // First value is an array
              if (firstVal.length === 0) {
                lines.push(`${itemPrefix}${firstKey}: []`);
              } else {
                lines.push(`${itemPrefix}${firstKey}:`);
                emitArrayItems(lines, firstVal, indent + 2);
              }
            } else if (typeof firstVal === 'object' && firstVal !== null) {
              const objEntries = Object.entries(firstVal as Record<string, unknown>)
                .filter(([k]) => k !== '_ss14Tag');
              if (objEntries.length === 0) {
                lines.push(`${itemPrefix}${firstKey}: {}`);
              } else {
                const tag = (firstVal as Record<string, unknown>)._ss14Tag as string | undefined;
                if (tag) {
                  lines.push(`${itemPrefix}${firstKey}: ${tag}`);
                } else {
                  lines.push(`${itemPrefix}${firstKey}:`);
                }
                for (const [k, v] of objEntries) {
                  emitValue(lines, k, v, indent + 4);
                }
              }
            } else {
              lines.push(`${itemPrefix}${firstKey}:`);
            }
            for (let i = 1; i < entries.length; i++) {
              emitValue(lines, entries[i][0], entries[i][1], indent + 2);
            }
          }
        } else if (typeof item === 'string' && item.includes('\n')) {
          // Multiline string in array, use block scalar with "- " prefix
          emitBlockScalar(lines, '-', item, indent, true);
        } else {
          lines.push(`${prefix}- ${formatPrimitive(item)}`);
        }
      }
    }
  } else if (typeof value === 'string' && value.includes('\n')) {
    // Multiline string, use YAML literal block scalar
    emitBlockScalar(lines, key, value, indent);
  } else {
    lines.push(`${prefix}${key}: ${formatPrimitive(value)}`);
  }
}

/** Process internal _ss14Tag metadata added during import.
 * Tagged scalars are unwrapped: { _ss14Tag, value } -> value
 * Tagged sequences are unwrapped: { _ss14Tag, items } -> items
 * Tagged mappings preserve _ss14Tag so emitValue can emit the YAML tag
 */
function stripInternalTags(obj: unknown): unknown {
  if (obj === null || obj === undefined || typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(stripInternalTags);
  }

  const record = obj as Record<string, unknown>;

  // Tagged scalar: { _ss14Tag, value } -> unwrap to value
  if ('_ss14Tag' in record && 'value' in record && Object.keys(record).length === 2) {
    return record.value;
  }

  // Tagged sequence: { _ss14Tag, items } -> unwrap to items array
  if ('_ss14Tag' in record && 'items' in record && Object.keys(record).length === 2) {
    return stripInternalTags(record.items);
  }

  // Tagged mapping or normal object: preserve _ss14Tag for emitValue to use
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === '_ss14Tag') {
      result[k] = v; // preserve tag so emitValue can emit it
    } else {
      result[k] = stripInternalTags(v);
    }
  }
  return result;
}

/**
 * Emit a nested sequence item: "- - val1\n  - val2" for arrays within arrays.
 */
function emitNestedSequence(lines: string[], arr: unknown[], indent: number): void {
  const prefix = ' '.repeat(indent);
  if (arr.length === 0) {
    lines.push(`${prefix}- []`);
    return;
  }
  // First item gets "- - " prefix
  const firstItem = arr[0];
  if (Array.isArray(firstItem)) {
    lines.push(`${prefix}- - ...`); // Deeply nested, unlikely in SS14 but handle gracefully
  } else if (typeof firstItem === 'object' && firstItem !== null) {
    // Object item in nested sequence
    const entries = Object.entries(firstItem as Record<string, unknown>)
      .filter(([k]) => k !== '_ss14Tag');
    if (entries.length > 0) {
      const [fk, fv] = entries[0];
      lines.push(`${prefix}- - ${fk}: ${formatPrimitive(fv)}`);
      for (let i = 1; i < entries.length; i++) {
        emitValue(lines, entries[i][0], entries[i][1], indent + 4);
      }
    }
  } else {
    lines.push(`${prefix}- - ${formatPrimitive(firstItem)}`);
  }
  // Remaining items get "  - " prefix (aligned with first)
  for (let i = 1; i < arr.length; i++) {
    const item = arr[i];
    if (Array.isArray(item)) {
      emitNestedSequence(lines, item, indent + 2);
    } else if (typeof item === 'object' && item !== null) {
      const entries = Object.entries(item as Record<string, unknown>)
        .filter(([k]) => k !== '_ss14Tag');
      if (entries.length > 0) {
        const [fk, fv] = entries[0];
        lines.push(`${prefix}  - ${fk}: ${formatPrimitive(fv)}`);
        for (let j = 1; j < entries.length; j++) {
          emitValue(lines, entries[j][0], entries[j][1], indent + 4);
        }
      }
    } else {
      lines.push(`${prefix}  - ${formatPrimitive(item)}`);
    }
  }
}

/**
 * Emit array items as YAML sequence entries at the given indent.
 */
function emitArrayItems(lines: string[], arr: unknown[], indent: number): void {
  const prefix = ' '.repeat(indent);
  for (const item of arr) {
    if (Array.isArray(item)) {
      emitNestedSequence(lines, item, indent);
    } else if (typeof item === 'object' && item !== null) {
      const entries = Object.entries(item as Record<string, unknown>)
        .filter(([k]) => k !== '_ss14Tag');
      if (entries.length > 0) {
        const [fk, fv] = entries[0];
        if (isPrimitive(fv)) {
          lines.push(`${prefix}- ${fk}: ${formatPrimitive(fv)}`);
        } else {
          lines.push(`${prefix}- ${fk}:`);
        }
        for (let i = 1; i < entries.length; i++) {
          emitValue(lines, entries[i][0], entries[i][1], indent + 2);
        }
      }
    } else {
      lines.push(`${prefix}- ${formatPrimitive(item)}`);
    }
  }
}

/**
 * Emit a multiline string as a YAML literal block scalar (|).
 * Uses |- (strip) if the string doesn't end with newline, | (clip) if it does.
 * The indentation indicator is computed from the content.
 */
function emitBlockScalar(
  lines: string[],
  key: string,
  value: string,
  indent: number,
  isArrayItem = false,
): void {
  const prefix = ' '.repeat(indent);
  const contentIndent = indent + 2;
  const contentPrefix = ' '.repeat(contentIndent);

  // Determine chomping: strip (-) if no trailing newline, clip (default) if ends with \n
  const chomp = value.endsWith('\n') ? '' : '-';

  // Check if any content line starts with spaces, if so, we need an explicit indentation indicator
  const contentLines = value.split('\n');
  // Remove trailing empty string from split if value ends with \n
  if (contentLines.length > 0 && contentLines[contentLines.length - 1] === '' && value.endsWith('\n')) {
    contentLines.pop();
  }

  // Find minimum leading whitespace in non-empty lines to determine if we need indent indicator
  let needsIndicator = false;
  for (const line of contentLines) {
    if (line.length > 0 && (line[0] === ' ' || line[0] === '\t')) {
      needsIndicator = true;
      break;
    }
  }

  const indicator = needsIndicator ? `${contentIndent}` : '';

  if (isArrayItem) {
    lines.push(`${prefix}- |${indicator}${chomp}`);
  } else {
    lines.push(`${prefix}${key}: |${indicator}${chomp}`);
  }

  // Emit each line with proper indentation
  for (const line of contentLines) {
    if (line === '') {
      lines.push('');
    } else {
      lines.push(`${contentPrefix}${line}`);
    }
  }
}

function isPrimitive(value: unknown): boolean {
  return value === null || value === undefined || typeof value !== 'object';
}

function formatPrimitive(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  const str = String(value);
  if (str.length === 0) return '""';
  // Quote strings that contain YAML-special characters
  if (needsQuoting(str)) {
    // Use single quotes by default (matching SS14 engine convention).
    // Use double quotes only when the string contains single quotes.
    if (str.includes("'")) {
      return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return `'${str}'`;
  }
  return str;
}

/** Check if a string value needs YAML quoting to preserve its meaning. */
function needsQuoting(str: string): boolean {
  if (str.length === 0) return true;
  // Leading/trailing whitespace, YAML parsers strip this from plain scalars
  if (str !== str.trim()) return true;
  // Starts with # (comment), or contains : followed by space, or starts with special chars
  if (str.startsWith('#') || str.startsWith('&') || str.startsWith('*') || str.startsWith('!')) return true;
  if (str.startsWith('{') || str.startsWith('[') || str.startsWith('>') || str.startsWith('|')) return true;
  if (str.startsWith("'") || str.startsWith('"')) return true;
  if (str.includes(': ') || str.includes(' #')) return true;
  // Values that look like booleans or null
  const lower = str.toLowerCase();
  if (['true', 'false', 'yes', 'no', 'null', '~', 'on', 'off'].includes(lower)) return true;
  return false;
}
