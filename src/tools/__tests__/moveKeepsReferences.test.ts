import { describe, it, expect } from 'vitest';
import { SelectTool } from '../selectTool';
import { EntitySelectTool } from '../entitySelectTool';
import type { ToolContext } from '../toolTypes';
import { importMap } from '../../import/mapImporter';
import type { ImportedEntity, ImportedMap } from '../../import/mapImporter';
import { exportMap } from '../../export/mapExporter';
import { createInitialState } from '../../state/editorState';
import type { EditorState } from '../../state/editorState';
import { editorReducer } from '../../state/editorReducer';
import type { IPrototypeRegistry } from '../../loaders/registryTypes';

function makeChunkBase64(): string {
  const BYTES_PER_TILE = 6;
  const buf = new Uint8Array(256 * BYTES_PER_TILE);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < 256; i++) view.setInt32(i * BYTES_PER_TILE, 1, true);
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  return btoa(binary);
}

// A room at tiles (2..4, 2..3): an air alarm with two devices, a button wired to a door,
// and a locker holding a crowbar. The APC and cable sit outside it.
const ROOM_MAP = `meta:
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
- proto: AirAlarm
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
    getSpriteInfo: () => null,
    tileCount: 0,
    entityCount: 0,
    getDecal: () => null,
    getAllDecals: () => [],
    decalCount: 0,
  };
}

/** Build an ImportedMap from EditorState for export. Mirrors App.tsx handleExport. */
function stateToImportedMap(state: EditorState): ImportedMap {
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

function loadRoom() {
  let state = editorReducer(createInitialState(), { type: 'LOAD_MAP', map: importMap(ROOM_MAP) });
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

/** What the saved file says once it is read back. */
function saved(state: EditorState) {
  const map = importMap(exportMap(stateToImportedMap(state)));
  const all: ImportedEntity[] = [...map.entities, ...Object.values(map.containedEntities ?? {}).flat()];
  const byProto = (proto: string) => all.filter(e => e.prototype === proto);
  const one = (proto: string) => {
    const found = byProto(proto);
    expect(found).toHaveLength(1);
    return found[0];
  };
  const protos = (uids: number[]) => uids.map(uid => all.find(e => e.uid === uid)?.prototype ?? `missing ${uid}`).sort();
  const component = (e: ImportedEntity, type: string) => e.components.find(c => c.type === type) as any;

  return {
    map,
    one,
    alarmDevices: () => protos(component(one('AirAlarm'), 'DeviceList')?.devices ?? []),
    deviceAlarms: (proto: string) => protos(component(one(proto), 'DeviceNetwork')?.deviceLists ?? []),
    buttonTargets: () => protos(Object.keys(component(one('SignalButton'), 'DeviceLinkSource')?.linkedPorts ?? {}).map(Number)),
    lockerListed: () => protos(component(one('LockerBotanist'), 'ContainerContainer')?.containers?.entity_storage?.ents ?? []),
    lockerHolds: () => (map.containedEntities?.[one('LockerBotanist').uid] ?? []).map(e => e.prototype),
    crowbarParent: () => protos([component(one('Crowbar'), 'Transform')?.parent]),
  };
}

function expectRoomIntact(state: EditorState) {
  const file = saved(state);
  expect(file.alarmDevices()).toEqual(['GasVentPump', 'GasVentScrubber']);
  expect(file.deviceAlarms('GasVentPump')).toEqual(['AirAlarm']);
  expect(file.deviceAlarms('GasVentScrubber')).toEqual(['AirAlarm']);
  expect(file.buttonTargets()).toEqual(['AirlockGlass']);
  expect(file.lockerListed()).toEqual(['Crowbar']);
  expect(file.lockerHolds()).toEqual(['Crowbar']);
  expect(file.crowbarParent()).toEqual(['LockerBotanist']);
  return file;
}

function selectRoom(ctx: ToolContext): SelectTool {
  const tool = new SelectTool();
  tool.onMouseDown(ctx, 2, 2, 0);
  tool.onMouseMove(ctx, 4, 3);
  tool.onMouseUp(ctx);
  return tool;
}

describe('moving keeps device links and container contents', () => {
  it('the fixture is intact before any edit', () => {
    expectRoomIntact(loadRoom().state);
  });

  it('area move', () => {
    const ctx = loadRoom();
    const tool = selectRoom(ctx);
    tool.onMouseDown(ctx, 3, 3, 0);
    tool.onMouseMove(ctx, 9, 9);
    tool.onMouseUp(ctx);

    const file = expectRoomIntact(ctx.state);
    expect(file.one('AirAlarm').position).toEqual({ x: 8.5, y: 8.5 });
    expect(file.one('LockerBotanist').position).toEqual({ x: 10.5, y: 8.5 });
  });

  it('area move, then undo', () => {
    const ctx = loadRoom();
    const tool = selectRoom(ctx);
    tool.onMouseDown(ctx, 3, 3, 0);
    tool.onMouseMove(ctx, 9, 9);
    tool.onMouseUp(ctx);
    ctx.dispatch({ type: 'UNDO' });

    const file = expectRoomIntact(ctx.state);
    expect(file.one('AirAlarm').position).toEqual({ x: 2.5, y: 2.5 });
  });

  it('area rotate', () => {
    const ctx = loadRoom();
    const tool = selectRoom(ctx);
    tool.rotateSelection(ctx, 'cw');

    expectRoomIntact(ctx.state);
  });

  it('entity drag', () => {
    const ctx = loadRoom();
    ctx.dispatch({ type: 'SELECT_ENTITY', uids: [10, 11, 12, 13, 14, 15] });
    const tool = new EntitySelectTool();
    tool.onMouseDown(ctx, 2, 2, 0);
    tool.onMouseMove(ctx, 8, 8);
    tool.onMouseUp(ctx, 8, 8);

    const file = expectRoomIntact(ctx.state);
    expect(file.one('AirAlarm').position).toEqual({ x: 8.5, y: 8.5 });
    expect(ctx.state.selectedEntityUids.slice().sort()).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('rotating a container in place', () => {
    const ctx = loadRoom();
    ctx.dispatch({ type: 'SELECT_ENTITY', uids: [15] });
    new EntitySelectTool().rotateSelected(ctx, 'cw');

    expectRoomIntact(ctx.state);
  });
});
