/**
 * Full SS14 map YAML importer with component preservation.
 *
 * Parses an SS14 map file (format 6) and extracts:
 * - meta (format version, postmapinit)
 * - tilemap (index -> tile ID)
 * - tile grid (decoded 16x16 chunks into flat array with world-coordinate offsets)
 * - entities (all entity groups with verbatim component data)
 */

import yaml from 'js-yaml';
import { SS14_SCHEMA } from './ss14Schema';
import type { GridData } from '../state/gridData';
import { parseDecalGrid } from './decalParser';

// ---- Public types ----

export interface MapMeta {
  format: number;
  postmapinit?: boolean;
  category?: string;
  engineVersion?: string;
  forkId?: string;
  forkVersion?: string;
  time?: string;
  entityCount?: number;
}

export interface ImportedMap {
  meta: MapMeta;
  tilemap: Record<number, string>;
  grid: {
    width: number;
    height: number;
    offsetX: number;
    offsetY: number;
    cells: import('../types').TileCell[];
  };
  entities: ImportedEntity[];
  /** Entities contained inside other entities (e.g., items in lockers), keyed by parent UID */
  containedEntities?: Record<number, ImportedEntity[]>;
  /** The uid of the grid entity (usually 2) */
  gridUid: number;
  /** The uid of the map entity (usually 1) */
  mapUid: number;
  /** Top-level maps array (format 7+) */
  maps?: number[];
  /** Top-level grids array (format 7+) */
  grids?: number[];
  /** Top-level orphans array (format 7+), e.g. the root grid of a standalone grid file */
  orphans?: number[];
  /** Top-level nullspace array (format 7+), e.g. decal ChunkEntity holders */
  nullspace?: number[];
  /** Structural entity components preserved verbatim for roundtrip */
  structuralEntityData?: Record<number, Record<string, unknown>[]>;
  /** Original chunk key ordering for roundtrip fidelity */
  chunkKeyOrder?: string[];
  /** Line ending style detected from the original file ('\r\n' or '\n') */
  lineEnding?: string;
  /** Raw YAML lines for each entity's components (for verbatim export) */
  entityRawComponents?: Record<number, string[]>;
  /** Raw YAML lines for entity-level fields between uid: and components: (e.g., mapInit, paused) */
  entityRawPreamble?: Record<number, string[]>;
  /** Whether the original file had a YAML document terminator `...` at the end */
  hasDocumentTerminator?: boolean;
  /** Original encounter order of non-structural entity UIDs (for byte-exact roundtrip) */
  entityOrder?: number[];
  /** Per-grid data for multi-grid support */
  gridDataList?: GridData[];
}

export interface ImportedEntity {
  uid: number;
  prototype: string;
  position: { x: number; y: number };
  rotation: number; // radians
  /** All components stored verbatim as raw objects */
  components: Record<string, unknown>[];
  /** Optional RSI state override for visual rendering in the editor */
  spriteStateOverride?: string;
}

// ---- Constants ----

const CHUNK_SIZE = 16;
const TILES_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE; // 256

// ---- Main entry point ----

export function importMap(yamlContent: string): ImportedMap {
  const doc = yaml.load(yamlContent, { schema: SS14_SCHEMA }) as any;

  const meta = parseMeta(doc.meta);
  const tilemap = parseTilemap(doc.tilemap);
  const { mapUid, gridUid, chunks, chunkKeyOrder, structuralEntities, structuralEntityData, gridParseDataMap, gridOrder } = parseStructuralEntities(doc.entities);

  // Build the set of all grid UIDs for entity assignment
  const gridUidSet = new Set(gridOrder);

  // Parse entities with per-grid assignment
  const { entities, containedEntities, entityOrder, perGridEntities, perGridContainedEntities } = parseNonStructuralEntities(doc.entities, structuralEntities, gridUidSet, mapUid, gridUid);

  // Build grid for legacy compat (first grid)
  const grid = buildGrid(chunks, tilemap, meta.format);

  // Build gridDataList, one GridData per grid
  const gridDataList: GridData[] = gridOrder.map(gUid => {
    const parseData = gridParseDataMap.get(gUid)!;
    const gridTiles = buildGrid(parseData.chunks, tilemap, meta.format);
    const decalGridComp = parseData.structuralComponents.find(
      (c: any) => c.type === 'DecalGrid'
    ) as Record<string, unknown> | undefined;
    const decalData = decalGridComp ? parseDecalGrid(decalGridComp) : { decals: [], nextDecalId: 0 };
    return {
      gridUid: gUid,
      name: parseData.name,
      grid: gridTiles,
      entities: perGridEntities.get(gUid) ?? [],
      containedEntities: perGridContainedEntities.get(gUid) ?? {},
      worldPosition: parseData.worldPosition,
      structuralComponents: parseData.structuralComponents,
      chunkKeyOrder: parseData.chunkKeyOrder,
      decals: decalData,
    };
  });

  // Preserve format 7+ top-level keys
  const maps: number[] | undefined = Array.isArray(doc.maps) ? doc.maps : undefined;
  const grids: number[] | undefined = Array.isArray(doc.grids) ? doc.grids : undefined;
  const orphans: number[] | undefined = Array.isArray(doc.orphans) ? doc.orphans : undefined;
  const nullspace: number[] | undefined = Array.isArray(doc.nullspace) ? doc.nullspace : undefined;

  // Detect line ending style
  const lineEnding = yamlContent.includes('\r\n') ? '\r\n' : '\n';

  // Extract raw YAML lines for all entity components (preserves integer key ordering, null formatting, etc.)
  const { components: entityRawComponents, preambles: entityRawPreamble } = extractAllEntityRawComponents(yamlContent);

  // Detect YAML document terminator `...` at end of file
  const hasDocumentTerminator = /^\.\.\.\s*$/m.test(yamlContent.split(/\r?\n/).slice(-3).join('\n'));

  return { meta, tilemap, grid, entities, containedEntities, gridUid, mapUid, maps, grids, orphans, nullspace, structuralEntityData, chunkKeyOrder, lineEnding, entityRawComponents, entityRawPreamble, hasDocumentTerminator, entityOrder, gridDataList };
}

// ---- Meta ----

function parseMeta(raw: any): MapMeta {
  return {
    format: raw?.format ?? 6,
    postmapinit: raw?.postmapinit != null
      ? (raw.postmapinit === true || raw.postmapinit === 'True')
      : undefined,
    category: raw?.category ?? undefined,
    engineVersion: raw?.engineVersion ?? undefined,
    forkId: raw?.forkId ?? undefined,
    forkVersion: raw?.forkVersion ?? undefined,
    time: raw?.time ?? undefined,
    entityCount: raw?.entityCount ?? undefined,
  };
}

// ---- Tilemap ----

function parseTilemap(raw: any): Record<number, string> {
  const result: Record<number, string> = {};
  if (!raw) return result;
  for (const [key, value] of Object.entries(raw)) {
    result[Number(key)] = String(value);
  }
  return result;
}

// ---- Structural entities (map + grid) ----

interface ChunkData {
  cx: number;
  cy: number;
  base64: string;
  version: number;
}

/** Per-grid parse data collected from structural entities */
interface GridParseData {
  gridUid: number;
  name: string;
  worldPosition: { x: number; y: number };
  chunks: ChunkData[];
  chunkKeyOrder: string[];
  structuralComponents: Record<string, unknown>[];
}

function parseStructuralEntities(entityGroups: any[]): {
  mapUid: number;
  gridUid: number;
  chunks: ChunkData[];
  chunkKeyOrder: string[];
  structuralEntities: Set<number>;
  structuralEntityData: Record<number, Record<string, unknown>[]>;
  gridParseDataMap: Map<number, GridParseData>;
  gridOrder: number[];
} {
  let mapUid = 0;
  let gridUid = 1;
  const structuralEntities = new Set<number>();
  const structuralEntityData: Record<number, Record<string, unknown>[]> = {};
  const gridParseDataMap = new Map<number, GridParseData>();
  const gridOrder: number[] = [];

  for (const group of entityGroups) {
    if (group.proto !== '' && group.proto != null) continue;

    for (const entity of group.entities ?? []) {
      structuralEntities.add(entity.uid);
      const components: any[] = entity.components ?? [];

      // Preserve all components verbatim (excluding MapGrid chunks which we rebuild)
      structuralEntityData[entity.uid] = components.map((c: any) => {
        if (c.type === 'MapGrid') {
          // Strip chunks (we rebuild them), keep other MapGrid properties
          const { chunks: _chunks, ...rest } = c;
          return rest;
        }
        return c;
      });

      // Check for Map component -> map entity
      if (components.some((c: any) => c.type === 'Map')) {
        mapUid = entity.uid;
      }

      // Check for MapGrid component -> grid entity
      const mapGridComp = components.find((c: any) => c.type === 'MapGrid');
      if (mapGridComp) {
        gridUid = entity.uid;

        // Extract name from MetaData component
        const metaComp = components.find((c: any) => c.type === 'MetaData') as any;
        const name = metaComp?.name ?? '';

        // Extract world position from Transform component
        const transformComp = components.find((c: any) => c.type === 'Transform') as any;
        const worldPosition = parsePosition(transformComp?.pos);

        const chunks: ChunkData[] = [];
        const chunkKeyOrder: string[] = [];
        const rawChunks = mapGridComp.chunks ?? {};
        for (const [key, chunkObj] of Object.entries(rawChunks) as [string, any][]) {
          chunkKeyOrder.push(key);
          const [cxStr, cyStr] = key.split(',');
          chunks.push({
            cx: parseInt(cxStr, 10),
            cy: parseInt(cyStr, 10),
            base64: String(chunkObj.tiles),
            version: chunkObj.version ?? 6,
          });
        }

        const structuralComps = structuralEntityData[entity.uid];

        gridParseDataMap.set(entity.uid, {
          gridUid: entity.uid,
          name,
          worldPosition,
          chunks,
          chunkKeyOrder,
          structuralComponents: structuralComps,
        });
        gridOrder.push(entity.uid);
      }
    }
  }

  // Build merged chunks/chunkKeyOrder for legacy compatibility (first grid)
  const firstGridUid = gridOrder[0] ?? gridUid;
  const firstGrid = gridParseDataMap.get(firstGridUid);
  const chunks = firstGrid?.chunks ?? [];
  const chunkKeyOrder = firstGrid?.chunkKeyOrder ?? [];

  return { mapUid, gridUid: firstGridUid, chunks, chunkKeyOrder, structuralEntities, structuralEntityData, gridParseDataMap, gridOrder };
}

// ---- Grid building ----

function buildGrid(
  chunks: ChunkData[],
  tilemap: Record<number, string>,
  format: number,
): ImportedMap['grid'] {
  if (chunks.length === 0) {
    return { width: 0, height: 0, offsetX: 0, offsetY: 0, cells: [] };
  }

  let minCX = Infinity, maxCX = -Infinity;
  let minCY = Infinity, maxCY = -Infinity;
  for (const c of chunks) {
    if (c.cx < minCX) minCX = c.cx;
    if (c.cx > maxCX) maxCX = c.cx;
    if (c.cy < minCY) minCY = c.cy;
    if (c.cy > maxCY) maxCY = c.cy;
  }

  const width = (maxCX - minCX + 1) * CHUNK_SIZE;
  const height = (maxCY - minCY + 1) * CHUNK_SIZE;
  const offsetX = minCX * CHUNK_SIZE;
  const offsetY = minCY * CHUNK_SIZE;

  const cells: import('../types').TileCell[] = new Array(width * height);
  for (let i = 0; i < cells.length; i++) {
    cells[i] = { tileId: 'Space' };
  }

  for (const chunk of chunks) {
    const decoded = decodeChunkTiles(chunk.base64, chunk.version);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const localIdx = ly * CHUNK_SIZE + lx;
        const tile = decoded[localIdx];
        const tileId = tilemap[tile.typeId] ?? 'Space';

        const worldX = chunk.cx * CHUNK_SIZE + lx;
        const worldY = chunk.cy * CHUNK_SIZE + ly;
        const gridCol = worldX - offsetX;
        const gridRow = worldY - offsetY;

        if (gridCol >= 0 && gridCol < width && gridRow >= 0 && gridRow < height) {
          const cell: import('../types').TileCell = { tileId };
          if (tile.flags) cell.flags = tile.flags;
          if (tile.variant) cell.variant = tile.variant;
          if (tile.rotationMirroring) cell.rotationMirroring = tile.rotationMirroring;
          cells[gridRow * width + gridCol] = cell;
        }
      }
    }
  }

  return { width, height, offsetX, offsetY, cells };
}

interface DecodedTile {
  typeId: number;
  flags: number;
  variant: number;
  rotationMirroring: number;
}

/**
 * Decode a base64-encoded chunk into 256 tile structs.
 * Format 4: 4 bytes/tile (int32 typeId only)
 * Format 6: 6 bytes/tile (int32 typeId + flags byte + variant byte)
 * Format 7: 7 bytes/tile (int32 typeId + flags byte + variant byte + rotationMirroring byte)
 */
function decodeChunkTiles(base64: string, version: number): DecodedTile[] {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);

  const bytesPerTile = bytes.length / TILES_PER_CHUNK;
  const tiles: DecodedTile[] = new Array(TILES_PER_CHUNK);

  if (bytesPerTile === 7) {
    // Format 7: int32 LE + flags + variant + rotationMirroring
    for (let i = 0; i < TILES_PER_CHUNK; i++) {
      const off = i * 7;
      tiles[i] = {
        typeId: view.getInt32(off, true),
        flags: bytes[off + 4],
        variant: bytes[off + 5],
        rotationMirroring: bytes[off + 6],
      };
    }
  } else if (bytesPerTile === 6) {
    // Format 6: int32 LE + flags + variant
    for (let i = 0; i < TILES_PER_CHUNK; i++) {
      const off = i * 6;
      tiles[i] = {
        typeId: view.getInt32(off, true),
        flags: bytes[off + 4],
        variant: bytes[off + 5],
        rotationMirroring: 0,
      };
    }
  } else if (bytesPerTile === 4) {
    // Legacy: int32 LE only
    for (let i = 0; i < TILES_PER_CHUNK; i++) {
      tiles[i] = {
        typeId: view.getUint32(i * 4, true),
        flags: 0,
        variant: 0,
        rotationMirroring: 0,
      };
    }
  } else {
    // Unknown format
    for (let i = 0; i < TILES_PER_CHUNK; i++) {
      tiles[i] = { typeId: 0, flags: 0, variant: 0, rotationMirroring: 0 };
    }
  }

  return tiles;
}

// ---- Entity parsing ----

function parseNonStructuralEntities(
  entityGroups: any[],
  structuralEntities: Set<number>,
  gridUids: Set<number>,
  mapUid: number,
  firstGridUid: number,
): {
  entities: ImportedEntity[];
  containedEntities: Record<number, ImportedEntity[]>;
  entityOrder: number[];
  perGridEntities: Map<number, ImportedEntity[]>;
  perGridContainedEntities: Map<number, Record<number, ImportedEntity[]>>;
} {
  const entities: ImportedEntity[] = [];
  const containedEntities: Record<number, ImportedEntity[]> = {};
  const entityOrder: number[] = [];

  // Initialize per-grid maps
  const perGridEntities = new Map<number, ImportedEntity[]>();
  const perGridContainedEntities = new Map<number, Record<number, ImportedEntity[]>>();
  for (const uid of gridUids) {
    perGridEntities.set(uid, []);
    perGridContainedEntities.set(uid, {});
  }

  for (const group of entityGroups) {
    const proto = group.proto ?? '';
    if (proto === '' || proto == null) continue; // skip structural group

    for (const entity of group.entities ?? []) {
      if (structuralEntities.has(entity.uid)) continue;

      const components: Record<string, unknown>[] = entity.components ?? [];
      const transform = components.find((c: any) => c.type === 'Transform') as any;

      const position = parsePosition(transform?.pos);
      const rotation = parseRotation(transform?.rot);
      const parentUid = transform?.parent;

      const importedEntity: ImportedEntity = {
        uid: entity.uid,
        prototype: proto,
        position,
        rotation,
        components,
      };

      entityOrder.push(entity.uid);

      // Determine which grid this entity belongs to
      const isContained = parentUid != null && !gridUids.has(parentUid) && parentUid !== mapUid && !structuralEntities.has(parentUid);

      if (isContained) {
        // Contained entity, find which grid the container belongs to
        if (!containedEntities[parentUid]) containedEntities[parentUid] = [];
        containedEntities[parentUid].push(importedEntity);

        // Also add to per-grid contained (we'll resolve grid membership below)
      } else {
        entities.push(importedEntity);

        // Assign to per-grid entities
        let targetGridUid = firstGridUid;
        if (parentUid != null && gridUids.has(parentUid)) {
          targetGridUid = parentUid;
        } else if (parentUid === mapUid) {
          targetGridUid = firstGridUid;
        }
        const gridEntities = perGridEntities.get(targetGridUid);
        if (gridEntities) {
          gridEntities.push(importedEntity);
        } else {
          // Fallback: assign to first grid
          perGridEntities.get(firstGridUid)?.push(importedEntity);
        }
      }
    }
  }

  // Now assign contained entities to per-grid contained maps
  // We need to find which grid each container entity belongs to
  for (const [containerUid, contained] of Object.entries(containedEntities)) {
    const containerUidNum = Number(containerUid);
    // Find which grid the container is in
    let ownerGridUid = firstGridUid;
    for (const [gridUid, ents] of perGridEntities) {
      if (ents.some(e => e.uid === containerUidNum)) {
        ownerGridUid = gridUid;
        break;
      }
    }
    const gridContained = perGridContainedEntities.get(ownerGridUid);
    if (gridContained) {
      gridContained[containerUidNum] = contained;
    }
  }

  return { entities, containedEntities, entityOrder, perGridEntities, perGridContainedEntities };
}

/**
 * Parse a position from the Transform component's `pos` field.
 * Can be a string like "90.5,17.5" or already parsed by js-yaml into a string.
 */
function parsePosition(pos: unknown): { x: number; y: number } {
  if (pos == null) return { x: 0, y: 0 };

  const str = String(pos);
  const parts = str.split(',');
  if (parts.length >= 2) {
    return {
      x: parseFloat(parts[0]) || 0,
      y: parseFloat(parts[1]) || 0,
    };
  }

  return { x: 0, y: 0 };
}

/**
 * Parse rotation from the Transform component's `rot` field.
 * Can be a number, or a string like "3.141592653589793 rad" or "1.5707963267948966".
 */
function parseRotation(rot: unknown): number {
  if (rot == null) return 0;
  if (typeof rot === 'number') return rot;

  const str = String(rot).replace(/\s*rad\s*$/i, '');
  const val = parseFloat(str);
  return isNaN(val) ? 0 : val;
}

// ---- Raw YAML extraction for structural entities ----

/**
 * Extract raw YAML lines for ALL entities' components from the original text.
 * Also extracts entity-level "preamble" lines between `uid:` and `components:`
 * (e.g., `mapInit: true`, `paused: true`).
 * This preserves exact formatting that JavaScript object parsing would alter
 * (e.g., integer key ordering, null vs empty values, quoting styles).
 */
function extractAllEntityRawComponents(
  yamlContent: string,
): { components: Record<number, string[]>; preambles: Record<number, string[]> } {
  const components: Record<number, string[]> = {};
  const preambles: Record<number, string[]> = {};
  const rawLines = yamlContent.split(/\r?\n/);

  let inEntitiesSection = false;
  let currentUid: number | null = null;
  let collecting = false;
  let collectingPreamble = false;
  let componentLines: string[] = [];
  let preambleLines: string[] = [];

  for (const line of rawLines) {
    // Top-level `entities:` key starts the entities section
    if (/^entities:\s*$/.test(line)) {
      inEntitiesSection = true;
      continue;
    }

    if (!inEntitiesSection) continue;

    // Entity group: `- proto: ...`, save any previous entity
    if (/^- proto:/.test(line)) {
      saveRawComponents(components, currentUid, componentLines);
      saveRawPreamble(preambles, currentUid, preambleLines);
      currentUid = null;
      collecting = false;
      collectingPreamble = false;
      componentLines = [];
      preambleLines = [];
      continue;
    }

    // `  entities:` within a group, just skip
    if (/^\s{2}entities:\s*$/.test(line)) continue;

    // New entity: `  - uid: N`
    const uidMatch = line.match(/^\s{2}- uid:\s+(\d+)/);
    if (uidMatch) {
      saveRawComponents(components, currentUid, componentLines);
      saveRawPreamble(preambles, currentUid, preambleLines);
      currentUid = parseInt(uidMatch[1], 10);
      collecting = false;
      collectingPreamble = true;
      componentLines = [];
      preambleLines = [];
      continue;
    }

    // `    components:` line, start collecting components after this
    if (currentUid !== null && /^\s{4}components:\s*$/.test(line)) {
      collecting = true;
      collectingPreamble = false;
      continue;
    }

    // YAML document terminator, stop collecting, don't include it
    if (/^\.\.\.\s*$/.test(line)) {
      break;
    }

    // Collect preamble lines (between uid: and components:)
    if (collectingPreamble && currentUid !== null) {
      preambleLines.push(line);
    }

    // Collect component content lines
    if (collecting && currentUid !== null) {
      componentLines.push(line);
    }
  }

  // Save last entity, trim trailing empty lines since these are just the file ending,
  // not meaningful content like inter-entity block scalar continuations
  trimTrailingEmpty(componentLines);
  saveRawComponents(components, currentUid, componentLines);
  saveRawPreamble(preambles, currentUid, preambleLines);

  return { components, preambles };
}

function trimTrailingEmpty(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
}

function saveRawComponents(
  result: Record<number, string[]>,
  uid: number | null,
  lines: string[],
): void {
  if (uid === null) return;
  // Preserve all lines including trailing empty lines for byte-exact roundtrip
  // (trailing empty lines can be part of block scalars like Paper content)
  if (lines.length > 0) {
    result[uid] = [...lines];
  }
}

function saveRawPreamble(
  result: Record<number, string[]>,
  uid: number | null,
  lines: string[],
): void {
  if (uid === null || lines.length === 0) return;
  // Only save if there are non-empty lines
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length > 0) {
    result[uid] = [...lines];
  }
}
