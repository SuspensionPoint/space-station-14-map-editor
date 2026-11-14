import { describe, it, expect } from 'vitest';
import { serializePrefab } from '../prefabSerializer';
import { placePrefab } from '../prefabPlacer';
import type { PrefabData } from '../prefabTypes';
import type { ToolContext } from '../../tools/toolTypes';
import { OTHER_MAP, ROOM, expectRoomIntact, loadMap, openMap, readBack, roomIn } from '../../test-utils/roomFixture';

const PLACED = { minX: 8, minY: 8, maxX: 10, maxY: 9 };

/** The room as a prefab, as it comes back from a `.prefab.json` file. */
function roomPrefab(ctx: ToolContext): PrefabData {
  const prefab = serializePrefab({
    name: 'room',
    ...ROOM,
    grid: ctx.state.grid,
    entities: ctx.state.entities,
    containedEntities: ctx.state.containedEntities,
    entityRawComponents: ctx.state.entityRawComponents ?? {},
  });
  return JSON.parse(JSON.stringify(prefab));
}

function place(ctx: ToolContext, prefab: PrefabData) {
  const result = placePrefab({
    prefab,
    placeX: PLACED.minX,
    placeY: PLACED.minY,
    grid: ctx.state.grid,
    entities: ctx.state.entities,
    nextEntityId: ctx.state.nextEntityId,
  });
  ctx.dispatch({ type: 'APPLY_COMMAND', command: result.command });
}

describe('placed prefabs link to themselves and carry their contents', () => {
  it('in the map the prefab was saved from', () => {
    const ctx = loadMap();
    place(ctx, roomPrefab(ctx));

    expectRoomIntact(ctx.state, ROOM);
    expectRoomIntact(ctx.state, PLACED);
  });

  it('in another map', () => {
    const ctx = loadMap();
    const prefab = roomPrefab(ctx);
    openMap(ctx, OTHER_MAP);
    place(ctx, prefab);

    expectRoomIntact(ctx.state, PLACED);
  });

  it('placed twice', () => {
    const ctx = loadMap();
    const prefab = roomPrefab(ctx);
    place(ctx, prefab);
    place(ctx, prefab);

    expectRoomIntact(ctx.state, PLACED);
    const uids = [...ctx.state.entities, ...Object.values(ctx.state.containedEntities).flat()].map(e => e.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it('a prefab file without UIDs links to nothing', () => {
    const ctx = loadMap();
    const prefab = roomPrefab(ctx);
    delete prefab.contained;
    for (const entity of prefab.entities) delete entity.uid;
    openMap(ctx, OTHER_MAP);
    place(ctx, prefab);

    const room = roomIn(readBack(ctx.state), PLACED);
    const component = (e: typeof room.alarm, type: string) => e.components.find(c => c.type === type) as any;
    expect(component(room.alarm, 'DeviceList').devices).toEqual([]);
    expect(component(room.vent, 'DeviceNetwork').deviceLists).toEqual([]);
    expect(component(room.button, 'DeviceLinkSource').linkedPorts).toEqual({});
    expect(component(room.locker, 'ContainerContainer').containers.entity_storage.ents).toEqual([]);
  });
});
