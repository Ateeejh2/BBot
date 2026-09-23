import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldJumpTowardWaypoint } from '../src/bot/forge.js';

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
