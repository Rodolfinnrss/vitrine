package com.ps5screenshare.client;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.io.IOException;
import java.security.MessageDigest;
import java.util.Arrays;

/** The shared vectors from relay/test/vectors.json, through SecureVectors.java. */
public class SecureTest {

    @Test
    public void sha256MatchesTheVectors() throws Exception {
        for (String[] v : SecureVectors.SHA) {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(Secure.hexToBytes(v[0]));
            assertEquals(v[1], Secure.bytesToHex(digest));
        }
    }

    @Test
    public void pairingIdAndKeyMatch() {
        for (String[] v : SecureVectors.PAIRING) {
            byte[] secret = Secure.hexToBytes(v[0]);
            assertEquals(v[1], Secure.pairingId(secret));
            assertEquals(v[2], Secure.bytesToHex(Secure.pairingKey(secret)));
        }
    }

    @Test
    public void sessionKeysMatch() {
        for (String[] v : SecureVectors.SESSION) {
            byte[] key = Secure.hexToBytes(v[0]);
            byte[] salt = Secure.hexToBytes(v[1]);
            assertEquals(v[2], Secure.bytesToHex(Secure.sessionKey(key, salt)));
        }
    }

    @Test
    public void framesSealToTheVectorsAndOpenBack() throws Exception {
        for (String[] v : SecureVectors.FRAMES) {
            byte[] key = Secure.hexToBytes(v[0]);
            int dir = Integer.parseInt(v[1], 16);
            long seq = Long.parseLong(v[2]);
            byte[] plain = Secure.hexToBytes(v[4]);
            byte[] frame = Secure.seal(key, dir, seq, plain);
            byte[] body = Secure.hexToBytes(v[5]);
            assertEquals(body.length, ((frame[0] & 0xff) << 24 | (frame[1] & 0xff) << 16 | (frame[2] & 0xff) << 8 | (frame[3] & 0xff)));
            assertArrayEquals(body, Arrays.copyOfRange(frame, 4, frame.length));
            assertArrayEquals(plain, Secure.open(key, dir, seq, body));
        }
    }

    @Test
    public void tamperingIsRefused() throws Exception {
        String[] v = SecureVectors.FRAMES[5];
        byte[] key = Secure.hexToBytes(v[0]);
        int dir = Integer.parseInt(v[1], 16);
        long seq = Long.parseLong(v[2]);
        byte[] body = Secure.hexToBytes(v[5]);
        byte[] bad = body.clone();
        bad[bad.length / 2] ^= 1;
        expectRefused(() -> Secure.open(key, dir, seq, bad));
        expectRefused(() -> Secure.open(key, dir, seq + 1, body));
        expectRefused(() -> Secure.open(key, dir == Secure.DIR_CLIENT ? Secure.DIR_SERVER : Secure.DIR_CLIENT, seq, body));
    }

    @Test
    public void pairingCodesAcceptGroupsAndCase() {
        assertArrayEquals(Secure.hexToBytes("00112233445566778899aabbccddeeff"),
                Secure.pairingSecret("0011-2233-4455-6677-8899-AABB-CCDD-EEFF"));
        try {
            Secure.pairingSecret("0011");
            fail("short code accepted");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("32"));
        }
    }

    private interface Action {
        void run() throws Exception;
    }

    private static void expectRefused(Action a) {
        try {
            a.run();
            fail("accepted a frame that must be refused");
        } catch (IOException expected) {
            // refused, as required
        } catch (Exception other) {
            fail("unexpected " + other);
        }
    }
}
