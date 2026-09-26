import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldJumpTowardWaypoint, updateCollisionWindow } from '../src/bot/forge.js';

test('Forge movement only jumps for an upward waypoint when the step is close', () => {
  const grounded = { onGround: true, collidedH: false, y: 64 };

  assert.equal(shouldJumpTowardWaypoint(grounded, 65, 6), false,
    'a distant elevated waypoint must not cause repeated bunny-hopping');
  assert.equal(shouldJumpTowardWaypoint(grounded, 65, 1.5), true,
    'an adjacent upward step should still trigger a jump');
  assert.equal(shouldJumpTowardWaypoint(grounded, 64, 1), false,
    'flat movement should not jump without a collision');
  assert.equal(shouldJumpTowardWaypoint({ ...grounded, collidedH: true }, 64, 6), true,
    'a horizontal collision may still trigger an obstacle jump');
  assert.equal(shouldJumpTowardWaypoint({ ...grounded, onGround: false }, 65, 1), false,
    'airborne movement must not repeatedly request jump');
});


test('Forge collision detection survives brief airborne gaps while jumping at a wall', () => {
  let window = updateCollisionWindow(undefined, undefined, 1_000, true);
  assert.deepEqual(window, { collisionSince: 1_000, lastCollisionAt: 1_000 });

  window = updateCollisionWindow(window.collisionSince, window.lastCollisionAt, 1_500, false);
  assert.deepEqual(window, { collisionSince: 1_000, lastCollisionAt: 1_000 },
    'an airborne frame must not reset an active wall collision');

  window = updateCollisionWindow(window.collisionSince, window.lastCollisionAt, 1_600, true);
  assert.deepEqual(window, { collisionSince: 1_000, lastCollisionAt: 1_600 },
    'landing back on the same wall keeps the original collision start');

  window = updateCollisionWindow(window.collisionSince, window.lastCollisionAt, 2_351, false);
  assert.deepEqual(window, { collisionSince: undefined, lastCollisionAt: undefined },
    'clear movement for longer than the grace period ends the collision episode');
});
