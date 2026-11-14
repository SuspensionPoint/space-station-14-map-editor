import { describe, it, expect } from 'vitest';
import { SelectTool } from '../selectTool';
import { EntitySelectTool } from '../entitySelectTool';
import type { ToolContext } from '../toolTypes';
import { OTHER_MAP, ROOM, expectRoomIntact, loadMap, openMap, readBack } from '../../test-utils/roomFixture';

const PASTED = { minX: 8, minY: 8, maxX: 10, maxY: 9 };
const ROOM_UIDS = [10, 11, 12, 13, 14, 15];

function areaCopy(ctx: ToolContext): SelectTool {
  const tool = new SelectTool();
  tool.onMouseDown(ctx, 2, 2, 0);
  tool.onMouseMove(ctx, 4, 3);
  tool.onMouseUp(ctx);
  tool.copy(ctx);
  return tool;
}

function areaPaste(ctx: ToolContext, tool: SelectTool) {
  tool.paste(ctx);
  tool.onMouseMove(ctx, 8, 8);
  tool.onMouseDown(ctx, 8, 8, 0);
}

function entityCopy(ctx: ToolContext, uids: number[]): EntitySelectTool {
  ctx.dispatch({ type: 'SELECT_ENTITY', uids });
  const tool = new EntitySelectTool();
  tool.copy(ctx);
  return tool;
}

function entityPaste(ctx: ToolContext, tool: EntitySelectTool) {
  tool.paste(ctx);
  tool.onMouseMove(ctx, 8, 8);
  tool.onMouseDown(ctx, 8, 8, 0);
}

describe('copies link to each other and carry their contents', () => {
  it('area copy and paste', () => {
    const ctx = loadMap();
    areaPaste(ctx, areaCopy(ctx));

    expectRoomIntact(ctx.state, ROOM);
    expectRoomIntact(ctx.state, PASTED);
  });

  it('area cut and paste', () => {
    const ctx = loadMap();
    const tool = areaCopy(ctx);
    tool.deleteSelection(ctx);
    areaPaste(ctx, tool);

    const { map } = expectRoomIntact(ctx.state, PASTED);
    expect(map.entities.filter(e => e.prototype === 'AirAlarm')).toHaveLength(1);
  });

  it('entity copy and paste', () => {
    const ctx = loadMap();
    entityPaste(ctx, entityCopy(ctx, ROOM_UIDS));

    expectRoomIntact(ctx.state, ROOM);
    expectRoomIntact(ctx.state, PASTED);
  });

  it('area paste into another map', () => {
    const ctx = loadMap();
    const tool = areaCopy(ctx);
    openMap(ctx, OTHER_MAP);
    areaPaste(ctx, tool);

    expectRoomIntact(ctx.state, PASTED);
  });

  it('entity paste into another map', () => {
    const ctx = loadMap();
    const tool = entityCopy(ctx, ROOM_UIDS);
    openMap(ctx, OTHER_MAP);
    entityPaste(ctx, tool);

    expectRoomIntact(ctx.state, PASTED);
  });

  it('a copy without its devices links to nothing', () => {
    const ctx = loadMap();
    entityPaste(ctx, entityCopy(ctx, [10]));

    const map = readBack(ctx.state);
    const pasted = map.entities.find(e => e.prototype === 'AirAlarm' && e.uid !== 10)!;
    expect((pasted.components.find(c => c.type === 'DeviceList') as any).devices).toEqual([]);
    expectRoomIntact(ctx.state, ROOM);
  });

  it('undoing a paste takes the copied contents with it', () => {
    const ctx = loadMap();
    areaPaste(ctx, areaCopy(ctx));
    ctx.dispatch({ type: 'UNDO' });

    const map = readBack(ctx.state);
    expect(Object.values(map.containedEntities ?? {}).flat().map(e => e.prototype)).toEqual(['Crowbar']);
    expectRoomIntact(ctx.state, ROOM);
  });

  it('pasting twice gives every copy its own contents', () => {
    const ctx = loadMap();
    const tool = areaCopy(ctx);
    areaPaste(ctx, tool);
    tool.paste(ctx);
    tool.onMouseMove(ctx, 8, 12);
    tool.onMouseDown(ctx, 8, 12, 0);

    expectRoomIntact(ctx.state, PASTED);
    expectRoomIntact(ctx.state, { minX: 8, minY: 12, maxX: 10, maxY: 13 });
    const uids = [...ctx.state.entities, ...Object.values(ctx.state.containedEntities).flat()].map(e => e.uid);
    expect(new Set(uids).size).toBe(uids.length);
  });
});
