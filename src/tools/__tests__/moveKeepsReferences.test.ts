import { describe, it, expect } from 'vitest';
import { SelectTool } from '../selectTool';
import { EntitySelectTool } from '../entitySelectTool';
import type { ToolContext } from '../toolTypes';
import { ROOM, expectRoomIntact, loadMap } from '../../test-utils/roomFixture';

const WHOLE_MAP = { minX: 0, minY: 0, maxX: 15, maxY: 15 };
const MOVED = { minX: 8, minY: 8, maxX: 10, maxY: 9 };

function selectRoom(ctx: ToolContext): SelectTool {
  const tool = new SelectTool();
  tool.onMouseDown(ctx, 2, 2, 0);
  tool.onMouseMove(ctx, 4, 3);
  tool.onMouseUp(ctx);
  return tool;
}

describe('moving keeps device links and container contents', () => {
  it('the fixture is intact before any edit', () => {
    expectRoomIntact(loadMap().state, ROOM);
  });

  it('area move', () => {
    const ctx = loadMap();
    const tool = selectRoom(ctx);
    tool.onMouseDown(ctx, 3, 3, 0);
    tool.onMouseMove(ctx, 9, 9);
    tool.onMouseUp(ctx);

    expectRoomIntact(ctx.state, MOVED);
  });

  it('area move, then undo', () => {
    const ctx = loadMap();
    const tool = selectRoom(ctx);
    tool.onMouseDown(ctx, 3, 3, 0);
    tool.onMouseMove(ctx, 9, 9);
    tool.onMouseUp(ctx);
    ctx.dispatch({ type: 'UNDO' });

    expectRoomIntact(ctx.state, ROOM);
  });

  it('area rotate', () => {
    const ctx = loadMap();
    const tool = selectRoom(ctx);
    tool.rotateSelection(ctx, 'cw');

    expectRoomIntact(ctx.state, WHOLE_MAP);
  });

  it('entity drag', () => {
    const ctx = loadMap();
    ctx.dispatch({ type: 'SELECT_ENTITY', uids: [10, 11, 12, 13, 14, 15] });
    const tool = new EntitySelectTool();
    tool.onMouseDown(ctx, 2, 2, 0);
    tool.onMouseMove(ctx, 8, 8);
    tool.onMouseUp(ctx, 8, 8);

    expectRoomIntact(ctx.state, MOVED);
    expect(ctx.state.selectedEntityUids.slice().sort()).toEqual([10, 11, 12, 13, 14, 15]);
  });

  it('rotating a container in place', () => {
    const ctx = loadMap();
    ctx.dispatch({ type: 'SELECT_ENTITY', uids: [15] });
    new EntitySelectTool().rotateSelected(ctx, 'cw');

    expectRoomIntact(ctx.state, ROOM);
  });
});
