/* PS5 Screen Share - keyboard to PS5 controller mapping.
 *
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Keys are KeyboardEvent.code values (physical key positions, so a Brazilian
 * or US layout works the same). Button bits match payload/src/pad.h.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Ps5Bindings = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BITS = {
    l3: 0x2, r3: 0x4, options: 0x8,
    up: 0x10, right: 0x20, down: 0x40, left: 0x80,
    l2: 0x100, r2: 0x200, l1: 0x400, r1: 0x800,
    triangle: 0x1000, circle: 0x2000, cross: 0x4000, square: 0x8000,
    ps: 0x10000, touchpad: 0x100000,
  };

  /** Every action a key can be bound to, in the order the settings screen shows them. */
  const ACTIONS = [
    { id: 'up', label: 'Direcional ↑', group: 'Direcional' },
    { id: 'down', label: 'Direcional ↓', group: 'Direcional' },
    { id: 'left', label: 'Direcional ←', group: 'Direcional' },
    { id: 'right', label: 'Direcional →', group: 'Direcional' },
    { id: 'cross', label: 'Cruz (×)', group: 'Botões' },
    { id: 'circle', label: 'Círculo (○)', group: 'Botões' },
    { id: 'square', label: 'Quadrado (□)', group: 'Botões' },
    { id: 'triangle', label: 'Triângulo (△)', group: 'Botões' },
    { id: 'l1', label: 'L1', group: 'Ombros' },
    { id: 'r1', label: 'R1', group: 'Ombros' },
    { id: 'l2', label: 'L2', group: 'Ombros' },
    { id: 'r2', label: 'R2', group: 'Ombros' },
    { id: 'options', label: 'Options', group: 'Centro' },
    { id: 'ps', label: 'Botão PS', group: 'Centro' },
    { id: 'touchpad', label: 'Touchpad', group: 'Centro' },
    { id: 'l3', label: 'Apertar analógico esquerdo (L3)', group: 'Analógicos' },
    { id: 'r3', label: 'Apertar analógico direito (R3)', group: 'Analógicos' },
    { id: 'lsUp', label: 'Analógico esquerdo ↑', group: 'Analógicos' },
    { id: 'lsDown', label: 'Analógico esquerdo ↓', group: 'Analógicos' },
    { id: 'lsLeft', label: 'Analógico esquerdo ←', group: 'Analógicos' },
    { id: 'lsRight', label: 'Analógico esquerdo →', group: 'Analógicos' },
    { id: 'rsUp', label: 'Analógico direito ↑', group: 'Analógicos' },
    { id: 'rsDown', label: 'Analógico direito ↓', group: 'Analógicos' },
    { id: 'rsLeft', label: 'Analógico direito ←', group: 'Analógicos' },
    { id: 'rsRight', label: 'Analógico direito →', group: 'Analógicos' },
  ];
  const ACTION_IDS = ACTIONS.map((a) => a.id);

  const DEFAULT_BINDINGS = {
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    cross: 'KeyX', circle: 'KeyC', square: 'KeyZ', triangle: 'KeyV',
    l1: 'KeyQ', r1: 'KeyE', l2: 'Digit1', r2: 'Digit3',
    options: 'Enter', ps: 'Home', touchpad: 'KeyT',
    l3: 'KeyF', r3: 'KeyG',
    lsUp: 'KeyW', lsDown: 'KeyS', lsLeft: 'KeyA', lsRight: 'KeyD',
    rsUp: 'KeyI', rsDown: 'KeyK', rsLeft: 'KeyJ', rsRight: 'KeyL',
  };

  /**
   * Returns a valid binding table: every action present (missing ones take the
   * default), values are key codes or null, and no key is used twice (the
   * first action in ACTIONS order keeps it).
   */
  function sanitize(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    const used = new Set();
    for (const id of ACTION_IDS) {
      let code = Object.prototype.hasOwnProperty.call(src, id) ? src[id] : DEFAULT_BINDINGS[id];
      if (typeof code !== 'string' || code === '' || code.length > 32) code = null;
      if (code !== null && used.has(code)) code = null;
      if (code !== null) used.add(code);
      out[id] = code;
    }
    return out;
  }

  /**
   * Sets one action's key. If the key already belongs to another action, the
   * two swap keys, so no key ever drives two buttons. Returns a new table.
   */
  function withBinding(bindings, action, code) {
    if (!ACTION_IDS.includes(action)) throw new Error('acao desconhecida: ' + action);
    const next = Object.assign({}, sanitize(bindings));
    const clean = typeof code === 'string' && code !== '' ? code : null;
    if (clean !== null) {
      for (const id of ACTION_IDS) {
        if (id !== action && next[id] === clean) next[id] = next[action];
      }
    }
    next[action] = clean;
    return next;
  }

  /** Friendly name of a KeyboardEvent.code, shown in the settings screen. */
  function keyLabel(code) {
    if (!code) return '(sem tecla)';
    const named = {
      ArrowUp: 'Seta ↑', ArrowDown: 'Seta ↓', ArrowLeft: 'Seta ←', ArrowRight: 'Seta →',
      Space: 'Espaço', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Escape: 'Esc',
      ShiftLeft: 'Shift esq.', ShiftRight: 'Shift dir.', ControlLeft: 'Ctrl esq.',
      ControlRight: 'Ctrl dir.', AltLeft: 'Alt esq.', AltRight: 'Alt dir.',
      Home: 'Home', End: 'End', PageUp: 'Page Up', PageDown: 'Page Down', Insert: 'Insert',
      Delete: 'Delete', Numpad0: 'Num 0', Numpad1: 'Num 1', Numpad2: 'Num 2', Numpad3: 'Num 3',
      Numpad4: 'Num 4', Numpad5: 'Num 5', Numpad6: 'Num 6', Numpad7: 'Num 7', Numpad8: 'Num 8',
      Numpad9: 'Num 9', NumpadEnter: 'Num Enter',
    };
    if (named[code]) return named[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^F[0-9]{1,2}$/.test(code)) return code;
    return code;
  }

  /**
   * Turns the set of pressed keys into controller state. press/release return
   * true when the state changed, so the caller only sends real changes.
   */
  class PadInput {
    constructor(bindings) {
      this.setBindings(bindings || DEFAULT_BINDINGS);
    }

    setBindings(bindings) {
      this.bindings = sanitize(bindings);
      this.byCode = new Map();
      for (const id of ACTION_IDS) {
        if (this.bindings[id]) this.byCode.set(this.bindings[id], id);
      }
      this.held = new Set();
    }

    actionFor(code) {
      return this.byCode.get(code) || null;
    }

    press(code) {
      const id = this.actionFor(code);
      if (!id || this.held.has(id)) return false;
      this.held.add(id);
      return true;
    }

    release(code) {
      const id = this.actionFor(code);
      if (!id || !this.held.has(id)) return false;
      this.held.delete(id);
      return true;
    }

    releaseAll() {
      const changed = this.held.size > 0;
      this.held.clear();
      return changed;
    }

    anyHeld() {
      return this.held.size > 0;
    }

    state() {
      let buttons = 0;
      for (const id of this.held) {
        if (BITS[id]) buttons |= BITS[id];
      }
      const axis = (neg, pos) => {
        const v = (this.held.has(pos) ? 1 : 0) - (this.held.has(neg) ? 1 : 0);
        return v === 0 ? 128 : v > 0 ? 255 : 1;
      };
      return {
        buttons,
        lx: axis('lsLeft', 'lsRight'),
        ly: axis('lsUp', 'lsDown'),
        rx: axis('rsLeft', 'rsRight'),
        ry: axis('rsUp', 'rsDown'),
        l2: this.held.has('l2') ? 255 : 0,
        r2: this.held.has('r2') ? 255 : 0,
      };
    }
  }

  return {
    BITS,
    ACTIONS,
    ACTION_IDS,
    DEFAULT_BINDINGS,
    sanitize,
    withBinding,
    keyLabel,
    PadInput,
  };
});
