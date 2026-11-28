package com.ps5screenshare.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;

public class PadModelTest {
    private static final float W = 2400, H = 1080;
    private PadModel m;

    @Before
    public void setUp() {
        m = new PadModel();
        m.layout(W, H);
    }

    private PadModel.Control c(String label) {
        for (PadModel.Control c : m.controls) {
            if (c.label.equals(label)) return c;
        }
        throw new AssertionError("no control " + label);
    }


    @Test
    public void crossAndDpadAreHitAtTheirCentres() {
        PadModel.Control cross = c("cross");
        assertEquals(PadModel.CROSS, m.hitButton(cross.cx, cross.cy).bits);
        PadModel.Control up = c("up");
        assertEquals(PadModel.UP, m.hitButton(up.cx, up.cy).bits);
    }

    @Test
    public void emptyScreenCentreIsNotAControl() {
        assertNull(m.hit(W / 2, H * 0.7f));
    }

    @Test
    public void pressingCrossSetsOnlyItsBit() {
        PadModel.Control cross = c("cross");
        assertNotNull(m.down(1, cross.cx, cross.cy));
        PadModel.State s = m.state();
        assertEquals(PadModel.CROSS, s.buttons);
        assertEquals(128, s.lx);
        assertEquals(128, s.ry);
        m.up(1);
        assertTrue(m.state().isNeutral());
    }

    @Test
    public void twoFingersCombineButtons() {
        PadModel.Control cross = c("cross");
        PadModel.Control l1 = c("L1");
        m.down(1, cross.cx, cross.cy);
        m.down(2, l1.cx, l1.cy);
        assertEquals(PadModel.CROSS | PadModel.L1, m.state().buttons);
        m.up(1);
        assertEquals(PadModel.L1, m.state().buttons);
    }

    @Test
    public void triggersSetTheirAnalogValueAndDigitalBit() {
        PadModel.Control l2 = c("L2");
        m.down(1, l2.cx, l2.cy);
        PadModel.State s = m.state();
        assertEquals(255, s.l2);
        assertEquals(PadModel.L2, s.buttons & PadModel.L2);
        assertEquals(0, s.r2);
    }

    @Test
    public void buttonSlidesToNeighbourAndLeavesEmptySpaceReleased() {
        PadModel.Control up = c("up");
        PadModel.Control right = c("right");
        m.down(1, up.cx, up.cy);
        assertEquals(PadModel.UP, m.state().buttons);
        m.move(1, right.cx, right.cy);
        assertEquals(PadModel.RIGHT, m.state().buttons);
        m.move(1, W / 2, H * 0.7f); // empty area: released
        assertTrue(m.state().isNeutral());
        assertFalse(m.isHeld(1));
    }

    @Test
    public void stickMapsTheTouchToAnAxis() {
        PadModel.Control ls = c("L3");
        m.down(1, ls.cx, ls.cy);
        assertEquals(128, m.state().lx);            // centre is neutral
        assertEquals(128, m.state().ly);
        m.move(1, ls.cx + ls.r, ls.cy);             // full right
        assertEquals(255, m.state().lx);
        m.move(1, ls.cx, ls.cy - ls.r);             // full up: Y axis smaller
        assertEquals(1, m.state().ly);
        assertEquals(128, m.state().lx);
        m.move(1, ls.cx - 10 * ls.r, ls.cy + 10 * ls.r); // clamped to full left/down
        assertEquals(1, m.state().lx);
        assertEquals(255, m.state().ly);
    }

    @Test
    public void stickDeadzoneSuppressesDrift() {
        PadModel.Control rs = c("R3");
        m.down(1, rs.cx, rs.cy);
        m.move(1, rs.cx + 0.04f * rs.r, rs.cy);
        assertEquals(128, m.state().rx);
    }

    @Test
    public void stickAndButtonsWorkTogether() {
        PadModel.Control ls = c("L3");
        PadModel.Control cross = c("cross");
        m.down(1, ls.cx, ls.cy);
        m.move(1, ls.cx + ls.r, ls.cy);
        m.down(2, cross.cx, cross.cy);
        PadModel.State s = m.state();
        assertEquals(255, s.lx);
        assertEquals(PadModel.CROSS, s.buttons);
    }

    @Test
    public void wireLineMatchesThePayloadFormat() {
        PadModel.State s = new PadModel.State();
        s.buttons = PadModel.CROSS;
        assertEquals("PAD 7,16384,128,128,128,128,0,0", s.toLine(7));
        assertEquals("PAD 0,16384,128,128,128,128,0,0", s.toLine(0x100000000L));
    }

    @Test
    public void everyButtonHasAUniqueBit() {
        int seen = 0;
        for (PadModel.Control c : m.controls) {
            if (!c.isButton() || c.bits == 0) continue;
            assertEquals("duplicate bit for " + c.label, 0, seen & c.bits);
            seen |= c.bits;
        }
        assertEquals(0x0013fffe & seen, seen);
    }
}
