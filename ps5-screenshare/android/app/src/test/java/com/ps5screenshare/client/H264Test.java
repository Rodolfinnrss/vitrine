package com.ps5screenshare.client;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class H264Test {
    private static byte[] b(int... v) {
        byte[] out = new byte[v.length];
        for (int i = 0; i < v.length; i++) out[i] = (byte) v[i];
        return out;
    }

    @Test
    public void extractsSpsAndPpsWithMixedStartCodes() {
        byte[] au = b(0, 0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac,
                0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80,
                0, 0, 1, 0x65, 0x88, 0x84, 0x00);
        byte[][] ps = H264.parameterSets(au);
        assertNotNull(ps);
        assertArrayEquals(b(0x67, 0x64, 0x00, 0x28, 0xac), ps[0]);
        assertArrayEquals(b(0x68, 0xee, 0x3c, 0x80), ps[1]);
        assertArrayEquals(b(0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80), H264.withStartCode(ps[1]));
    }

    @Test
    public void sliceOnlyFrameHasNoParameterSets() {
        assertNull(H264.parameterSets(b(0, 0, 1, 0x41, 0x9a, 0x02)));
        assertNull(H264.parameterSets(b()));
    }
}
