/**
 * A small map for tests of device links and container contents, with helpers to
 * load it into editor state and to check the room in the file the editor saves.
 */
import { expect } from 'vitest';
import type { ToolContext } from '../tools/toolTypes';
import { importMap } from '../import/mapImporter';
import type { ImportedEntity, ImportedMap } from '../import/mapImporter';
import { exportMap } from '../export/mapExporter';
import { createInitialState } from '../state/editorState';
import type { EditorState } from '../state/editorState';
import { editorReducer } from '../state/editorReducer';
import type { IPrototypeRegistry } from '../loaders/registryTypes';

function makeChunkBase64(): string {
  const BYTES_PER_TILE = 6;
  const buf = new Uint8Array(256 * BYTES_PER_TILE);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < 256; i++) view.setInt32(i * BYTES_PER_TILE, 1, true);
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

const MAP_HEADER = `meta:
  format: 6
  postmapinit: false
tilemap:
  0: Space
  1: FloorSteel
entities:
- proto: ""
  entities:
  - uid: 1
    components:
    - type: MetaData
      name: Map Entity
    - type: Transform
    - type: Map
      mapPaused: True
  - uid: 2
    components:
    - type: MetaData
      name: Station
    - type: Transform
      parent: 1
    - type: MapGrid
      chunks:
        0,0:
          ind: 0,0
          tiles: ${makeChunkBase64()}
          version: 6
`;

// The room covers tiles (2..4, 2..3). It has an air alarm with two devices, a button wired
// to a door, and a locker holding a crowbar. The APC and cable sit outside it.
export const ROOM_MAP = `${MAP_HEADER}- proto: AirAlarm
  entities:
  - uid: 10
    components:
    - type: Transform
      pos: 2.5,2.5
      parent: 2
    - type: DeviceList
      devices:
      - 11
      - 12
- proto: GasVentPump
  entities:
  - uid: 11
    components:
    - type: Transform
      pos: 3.5,2.5
      parent: 2
    - type: DeviceNetwork
      deviceLists:
      - 10
- proto: GasVentScrubber
  entities:
  - uid: 12
    components:
    - type: Transform
      pos: 3.5,3.5
      parent: 2
    - type: DeviceNetwork
      deviceLists:
      - 10
- proto: SignalButton
  entities:
  - uid: 13
    components:
    - type: Transform
      pos: 2.5,3.5
      parent: 2
    - type: DeviceLinkSource
      linkedPorts:
        14:
        - - Pressed
          - Toggle
- proto: AirlockGlass
  entities:
  - uid: 14
    components:
    - type: Transform
      pos: 4.5,3.5
      parent: 2
- proto: LockerBotanist
  entities:
  - uid: 15
    components:
    - type: Transform
      pos: 4.5,2.5
      parent: 2
    - type: ContainerContainer
      containers:
        entity_storage: !type:Container
          showEnts: False
          occludes: True
          ents:
          - 16
- proto: Crowbar
  entities:
  - uid: 16
    components:
    - type: Transform
      parent: 15
    - type: Physics
      canCollide: False
- proto: APCBasic
  entities:
  - uid: 17
    components:
    - type: Transform
      pos: 12.5,12.5
      parent: 2
- proto: CableApcExtension
  entities:
  - uid: 18
    components:
    - type: Transform
      pos: 13.5,12.5
      parent: 2
`;

// Another map whose entities happen to use the room's UIDs.
export const OTHER_MAP = `${MAP_HEADER}- proto: CableApcExtension
  entities:
${[10, 11, 12, 13, 14, 15, 16].map((uid, i) => `  - uid: ${uid}
    components:
    - type: Transform
      pos: ${i}.5,14.5
      parent: 2
`).join('')}`;

export const ROOM = { minX: 2, minY: 2, maxX: 4, maxY: 3 };

export interface Region {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function makeMockRegistry(): IPrototypeRegistry {
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

/** Build an ImportedMap from EditorState for export. Mirrors App.tsx handleExport. */
export function stateToImportedMap(state: EditorState): ImportedMap {
  return {
    meta: state.meta,
    tilemap: state.tilemap ?? {},
    grid: state.grid,
    entities: state.entities,
    containedEntities: state.containedEntities,
    gridUid: state.gridUid,
    mapUid: state.mapUid,
    maps: state.maps,
    grids: state.gridUidList,
    gridDataList: state.grids,
    structuralEntityData: state.structuralEntityData,
    entityRawComponents: state.entityRawComponents,
    entityRawPreamble: state.entityRawPreamble,
    chunkKeyOrder: state.chunkKeyOrder,
    lineEnding: state.lineEnding,
    hasDocumentTerminator: state.hasDocumentTerminator,
    entityOrder: state.entityOrder,
  };
}

/** A tool context over a freshly loaded map, dispatching through the real reducer. */
export function loadMap(yaml: string = ROOM_MAP): ToolContext {
  let state = editorReducer(createInitialState(), { type: 'LOAD_MAP', map: importMap(yaml) });
  state = editorReducer(state, { type: 'SET_REGISTRY', registry: makeMockRegistry() });
  const ctx: ToolContext = {
    state,
    dispatch: (action: any) => {
      ctx.state = editorReducer(ctx.state, action);
    },
    camera: { tileScreenSize: 32 } as any,
    canvasW: 800,
    canvasH: 600,
    paletteItem: null,
    shiftHeld: false,
    ctrlHeld: false,
  };
  return ctx;
}

/** Load another map into a context, as opening a file does. The clipboard survives it. */
export function openMap(ctx: ToolContext, yaml: string): void {
  ctx.dispatch({ type: 'LOAD_MAP', map: importMap(yaml) });
  ctx.dispatch({ type: 'SET_REGISTRY', registry: makeMockRegistry() });
}

const component = (e: ImportedEntity, type: string) => e.components.find(c => c.type === type) as any;
const sorted = (uids: number[]) => [...uids].sort((a, b) => a - b);

/** The map as the saved file gives it back. */
export function readBack(state: EditorState): ImportedMap {
  return importMap(exportMap(stateToImportedMap(state)));
}

/** The room's entities within a region of the saved file, one of each prototype. */
export function roomIn(map: ImportedMap, region: Region) {
  const one = (proto: string) => {
    const found = map.entities.filter(e =>
      e.prototype === proto
      && Math.floor(e.position.x) >= region.minX && Math.floor(e.position.x) <= region.maxX
      && Math.floor(e.position.y) >= region.minY && Math.floor(e.position.y) <= region.maxY);
    expect(found.map(e => e.prototype)).toEqual([proto]);
    return found[0];
  };
  return {
    alarm: one('AirAlarm'),
    vent: one('GasVentPump'),
    scrubber: one('GasVentScrubber'),
    button: one('SignalButton'),
    door: one('AirlockGlass'),
    locker: one('LockerBotanist'),
  };
}

/**
 * Check that the room found in a region of the saved file is whole: the alarm lists its
 * own two devices and they list it, the button is wired to its door, and the locker
 * holds its crowbar.
 */
export function expectRoomIntact(state: EditorState, region: Region) {
  const map = readBack(state);
  const room = roomIn(map, region);
  const held = map.containedEntities?.[room.locker.uid] ?? [];

  expect(sorted(component(room.alarm, 'DeviceList')?.devices ?? [])).toEqual(sorted([room.vent.uid, room.scrubber.uid]));
  expect(component(room.vent, 'DeviceNetwork')?.deviceLists).toEqual([room.alarm.uid]);
  expect(component(room.scrubber, 'DeviceNetwork')?.deviceLists).toEqual([room.alarm.uid]);
  expect(Object.keys(component(room.button, 'DeviceLinkSource')?.linkedPorts ?? {}).map(Number)).toEqual([room.door.uid]);
  expect(held.map(e => e.prototype)).toEqual(['Crowbar']);
  expect(component(room.locker, 'ContainerContainer')?.containers?.entity_storage?.ents).toEqual(held.map(e => e.uid));
  expect(held.map(e => component(e, 'Transform')?.parent)).toEqual([room.locker.uid]);
  return { map, room };
}
