/* PS5 Screen Share - on-screen controller: layout, touch tracking and state.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Pure Java (no Android classes) so the touch logic can be unit tested.
 * Button bits match payload/src/pad.h.
 */
package com.ps5screenshare.client;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class PadModel {
    static final int L3 = 0x2, R3 = 0x4, OPTIONS = 0x8, UP = 0x10, RIGHT = 0x20, DOWN = 0x40,
            LEFT = 0x80, L2 = 0x100, R2 = 0x200, L1 = 0x400, R1 = 0x800, TRIANGLE = 0x1000,
            CIRCLE = 0x2000, CROSS = 0x4000, SQUARE = 0x8000, PS = 0x10000, TOUCHPAD = 0x100000;

    enum Kind { BUTTON, TRIGGER, LEFT_STICK, RIGHT_STICK }

    /** One control. Circles use cx/cy/r; rectangles use left/top/right/bottom. */
    static final class Control {
        final Kind kind;
        final int bits;
        final String label;
        final boolean round;
        final float cx, cy, r;
        final float left, top, right, bottom;

        private Control(Kind kind, int bits, String label, float cx, float cy, float r) {
            this.kind = kind;
            this.bits = bits;
            this.label = label;
            this.round = true;
            this.cx = cx;
            this.cy = cy;
            this.r = r;
            this.left = this.top = this.right = this.bottom = 0;
        }

        private Control(Kind kind, int bits, String label, float left, float top, float right, float bottom) {
            this.kind = kind;
            this.bits = bits;
            this.label = label;
            this.round = false;
            this.cx = (left + right) / 2;
            this.cy = (top + bottom) / 2;
            this.r = 0;
            this.left = left;
            this.top = top;
            this.right = right;
            this.bottom = bottom;
        }

        boolean contains(float x, float y, float slop) {
            if (round) {
                float dx = x - cx, dy = y - cy;
                return dx * dx + dy * dy <= (r + slop) * (r + slop);
            }
            return x >= left - slop && x <= right + slop && y >= top - slop && y <= bottom + slop;
        }

        boolean isButton() {
            return kind == Kind.BUTTON || kind == Kind.TRIGGER;
        }
    }

    /** Controller state as sent to the console. Sticks are 0..255, centre 128. */
    static final class State {
        int buttons;
        int lx = 128, ly = 128, rx = 128, ry = 128, l2, r2;

        State copy() {
            State s = new State();
            s.buttons = buttons;
            s.lx = lx;
            s.ly = ly;
            s.rx = rx;
            s.ry = ry;
            s.l2 = l2;
            s.r2 = r2;
            return s;
        }

        boolean sameAs(State o) {
            return o != null && buttons == o.buttons && lx == o.lx && ly == o.ly && rx == o.rx
                    && ry == o.ry && l2 == o.l2 && r2 == o.r2;
        }

        /** "seq,buttons,lx,ly,rx,ry,l2,r2" for the PAD command. */
        String toLine(long seq) {
            return "PAD " + (seq & 0xffffffffL) + "," + buttons + "," + lx + "," + ly + "," + rx + ","
                    + ry + "," + l2 + "," + r2;
        }

        boolean isNeutral() {
            return buttons == 0 && lx == 128 && ly == 128 && rx == 128 && ry == 128 && l2 == 0 && r2 == 0;
        }
    }

    private static final class Track {
        Control control;
        float x, y;

        Track(Control c, float x, float y) {
            this.control = c;
            this.x = x;
            this.y = y;
        }
    }

    /** Hit slop in pixels for buttons (touch targets a bit larger than the art). */
    private static final float BUTTON_SLOP_FRACTION = 0.02f;
    private static final float STICK_SLOP_FRACTION = 0.02f;
    private static final float STICK_DEADZONE = 0.08f;

    final List<Control> controls = new ArrayList<>();
    private final Map<Integer, Track> tracks = new HashMap<>();
    private float unit = 1;

    /** Places all controls for a w x h area. Everything is relative to the height. */
    void layout(float w, float h) {
        controls.clear();
        unit = Math.min(w, h);
        float u = unit;
        float x0 = 0.04f * u;               // left margin
        float x1 = w - 0.04f * u;           // right margin
        float leftCx = x0 + 0.375f * u;
        float rightCx = x1 - 0.375f * u;
        float dpadCy = 0.50f * u;
        float stickCy = 0.86f * u;
        float arm = 0.15f * u;
        float btn = 0.07f * u;

        // Shoulders and triggers (rectangles), L1/R1 above L2/R2.
        controls.add(new Control(Kind.TRIGGER, L1, "L1", x0, 0.06f * u, x0 + 0.30f * u, 0.18f * u));
        controls.add(new Control(Kind.TRIGGER, L2, "L2", x0, 0.20f * u, x0 + 0.30f * u, 0.32f * u));
        controls.add(new Control(Kind.TRIGGER, R1, "R1", x1 - 0.30f * u, 0.06f * u, x1, 0.18f * u));
        controls.add(new Control(Kind.TRIGGER, R2, "R2", x1 - 0.30f * u, 0.20f * u, x1, 0.32f * u));

        // D-pad on the left, face buttons on the right.
        controls.add(new Control(Kind.BUTTON, UP, "up", leftCx, dpadCy - arm, btn));
        controls.add(new Control(Kind.BUTTON, DOWN, "down", leftCx, dpadCy + arm, btn));
        controls.add(new Control(Kind.BUTTON, LEFT, "left", leftCx - arm, dpadCy, btn));
        controls.add(new Control(Kind.BUTTON, RIGHT, "right", leftCx + arm, dpadCy, btn));
        controls.add(new Control(Kind.BUTTON, TRIANGLE, "triangle", rightCx, dpadCy - arm, btn));
        controls.add(new Control(Kind.BUTTON, CROSS, "cross", rightCx, dpadCy + arm, btn));
        controls.add(new Control(Kind.BUTTON, SQUARE, "square", rightCx - arm, dpadCy, btn));
        controls.add(new Control(Kind.BUTTON, CIRCLE, "circle", rightCx + arm, dpadCy, btn));

        // Sticks.
        controls.add(new Control(Kind.LEFT_STICK, 0, "L3", leftCx, stickCy, 0.10f * u));
        controls.add(new Control(Kind.RIGHT_STICK, 0, "R3", rightCx, stickCy, 0.10f * u));

        // Centre: PS, Options and the touchpad.
        float cx = w / 2;
        controls.add(new Control(Kind.BUTTON, PS, "PS", cx - 0.13f * u, 0.13f * u, 0.05f * u));
        controls.add(new Control(Kind.BUTTON, OPTIONS, "OPTIONS", cx + 0.13f * u, 0.13f * u, 0.05f * u));
        controls.add(new Control(Kind.BUTTON, TOUCHPAD, "TOUCH", cx - 0.12f * u, 0.25f * u,
                cx + 0.12f * u, 0.35f * u));
    }

    /** Buttons win over sticks where they overlap (the D-pad sits above the left stick). */
    Control hit(float x, float y) {
        Control b = hitButton(x, y);
        if (b != null) return b;
        for (Control c : controls) {
            if (c.kind == Kind.LEFT_STICK || c.kind == Kind.RIGHT_STICK) {
                if (c.contains(x, y, STICK_SLOP_FRACTION * unit)) return c;
            }
        }
        return null;
    }

    Control hitButton(float x, float y) {
        for (Control c : controls) {
            if (c.isButton() && c.contains(x, y, BUTTON_SLOP_FRACTION * unit)) return c;
        }
        return null;
    }

    /** A finger went down. Returns the control it started on, or null. */
    Control down(int pointerId, float x, float y) {
        Control c = hit(x, y);
        if (c != null) tracks.put(pointerId, new Track(c, x, y));
        return c;
    }

    /** A finger moved. Buttons slide to a neighbour or release; sticks follow. */
    void move(int pointerId, float x, float y) {
        Track t = tracks.get(pointerId);
        if (t == null) return;
        t.x = x;
        t.y = y;
        if (t.control.isButton() && !t.control.contains(x, y, BUTTON_SLOP_FRACTION * unit)) {
            Control next = hitButton(x, y);
            if (next == null) tracks.remove(pointerId);
            else t.control = next;
        }
    }

    void up(int pointerId) {
        tracks.remove(pointerId);
    }

    void cancel() {
        tracks.clear();
    }

    boolean isHeld(int pointerId) {
        return tracks.containsKey(pointerId);
    }

    boolean anyHeld() {
        return !tracks.isEmpty();
    }

    /** Current state from every held finger. */
    State state() {
        State s = new State();
        for (Track t : tracks.values()) {
            switch (t.control.kind) {
                case BUTTON:
                    s.buttons |= t.control.bits;
                    break;
                case TRIGGER:
                    s.buttons |= t.control.bits;
                    if (t.control.bits == L2) s.l2 = 255;
                    else if (t.control.bits == R2) s.r2 = 255;
                    break;
                case LEFT_STICK:
                    s.lx = axis(t.x, t.control.cx, t.control.r);
                    s.ly = axis(t.y, t.control.cy, t.control.r);
                    break;
                case RIGHT_STICK:
                    s.rx = axis(t.x, t.control.cx, t.control.r);
                    s.ry = axis(t.y, t.control.cy, t.control.r);
                    break;
                default:
                    break;
            }
        }
        return s;
    }

    /** Maps one touch coordinate to a stick byte (down / right are positive). */
    static int axis(float p, float centre, float radius) {
        float v = (p - centre) / radius;
        if (v > 1) v = 1;
        if (v < -1) v = -1;
        if (Math.abs(v) < STICK_DEADZONE) return 128;
        return Math.round(128 + v * 127);
    }
}
