'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/bindings');

test('default table covers every action with unique keys', () => {
  const codes = B.ACTION_IDS.map((id) => B.DEFAULT_BINDINGS[id]);
  assert.equal(new Set(codes).size, codes.length);
  for (const id of B.ACTION_IDS) assert.ok(B.DEFAULT_BINDINGS[id], id);
});

test('pressing a bound key sets its button bit; release clears it', () => {
  const pad = new B.PadInput();
  assert.equal(pad.press('KeyX'), true);
  assert.equal(pad.press('KeyX'), false, 'auto-repeat does not change the state');
  assert.equal(pad.state().buttons, B.BITS.cross);
  assert.equal(pad.release('KeyX'), true);
  assert.equal(pad.state().buttons, 0);
  assert.equal(pad.press('KeyP'), false, 'unbound keys do nothing');
});

test('arrow keys drive the D-pad and two buttons can be held together', () => {
  const pad = new B.PadInput();
  pad.press('ArrowUp');
  pad.press('KeyX');
  assert.equal(pad.state().buttons, B.BITS.up | B.BITS.cross);
  pad.press('ArrowRight');
  assert.equal(pad.state().buttons, B.BITS.up | B.BITS.right | B.BITS.cross);
});

test('left stick: WASD give full deflection, opposite keys cancel', () => {
  const pad = new B.PadInput();
  assert.deepEqual([pad.state().lx, pad.state().ly], [128, 128]);
  pad.press('KeyD');
  assert.equal(pad.state().lx, 255);
  pad.press('KeyA');
  assert.equal(pad.state().lx, 128, 'left and right together centre the stick');
  pad.release('KeyD');
  assert.equal(pad.state().lx, 1);
  pad.press('KeyS');
  assert.equal(pad.state().ly, 255, 'down is positive, as on the console');
});

test('right stick uses its own keys; triggers set analog and digital', () => {
  const pad = new B.PadInput();
  pad.press('KeyI');
  assert.equal(pad.state().ry, 1, 'up is 0..127');
  pad.press('Digit3');
  const s = pad.state();
  assert.equal(s.r2, 255);
  assert.equal(s.buttons & B.BITS.r2, B.BITS.r2);
  assert.equal(s.l2, 0);
});

test('releaseAll reports whether anything was held', () => {
  const pad = new B.PadInput();
  assert.equal(pad.releaseAll(), false);
  pad.press('KeyC');
  pad.press('KeyW');
  assert.equal(pad.releaseAll(), true);
  assert.equal(pad.anyHeld(), false);
  assert.equal(pad.state().buttons, 0);
});

test('withBinding swaps keys so no key drives two actions', () => {
  const b = B.withBinding(B.DEFAULT_BINDINGS, 'cross', 'KeyC'); // C is circle by default
  assert.equal(b.cross, 'KeyC');
  assert.equal(b.circle, 'KeyX', 'circle takes the key cross had');
  const codes = B.ACTION_IDS.map((id) => b[id]).filter(Boolean);
  assert.equal(new Set(codes).size, codes.length);
});

test('withBinding can unbind and rejects unknown actions', () => {
  const b = B.withBinding(B.DEFAULT_BINDINGS, 'touchpad', null);
  assert.equal(b.touchpad, null);
  assert.throws(() => B.withBinding(B.DEFAULT_BINDINGS, 'nope', 'KeyQ'), /acao desconhecida/);
});

test('sanitize fills gaps, drops junk and removes duplicates', () => {
  const s = B.sanitize({ cross: 'KeyQ', circle: 'KeyQ', square: 12, triangle: '', extra: 'KeyZ' });
  assert.equal(s.cross, 'KeyQ');
  assert.equal(s.circle, null, 'second use of the same key is removed');
  assert.equal(s.square, null, 'non-string is removed');
  assert.equal(s.triangle, null);
  assert.equal(s.up, 'ArrowUp', 'missing actions take their default');
  assert.equal('extra' in s, false);
});

test('key labels are friendly', () => {
  assert.equal(B.keyLabel('KeyX'), 'X');
  assert.equal(B.keyLabel('Digit1'), '1');
  assert.equal(B.keyLabel('ArrowLeft'), 'Seta ←');
  assert.equal(B.keyLabel(null), '(sem tecla)');
});

test('changing bindings keeps held state consistent', () => {
  const pad = new B.PadInput();
  pad.press('KeyX');
  pad.setBindings(B.DEFAULT_BINDINGS);
  assert.equal(pad.anyHeld(), false, 'rebinding releases held keys');
});
