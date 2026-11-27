package com.ps5screenshare.client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assume.assumeFalse;
import static org.robolectric.Shadows.shadowOf;

import android.content.Context;
import android.os.Looper;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.Spinner;
import android.widget.TextView;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;
import org.robolectric.shadows.ShadowMediaCodec;
import org.robolectric.shadows.ShadowSurfaceView;

import java.time.Duration;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
@LooperMode(LooperMode.Mode.PAUSED)
public class ActivitySmokeTest {
    @Test
    public void mainActivityShowsOptions() {
        ActivityController<MainActivity> c = Robolectric.buildActivity(MainActivity.class).setup();
        MainActivity a = c.get();
        Spinner res = a.findViewById(R.id.resolution);
        assertNotNull(res);
        assertEquals(5, res.getAdapter().getCount());
        assertEquals(7, ((Spinner) a.findViewById(R.id.bitrate)).getAdapter().getCount());
        c.pause().stop().destroy();
    }

    @Test
    public void streamActivityDecodesLiveStream() throws Exception {
        String host = System.getProperty("ps5ss.host", "");
        assumeFalse("set PS5SS_TEST_HOST to run", host.isEmpty());
        int port = Integer.parseInt(System.getProperty("ps5ss.port", "9700"));
        // A fake H.264 decoder that just passes buffers through.
        ShadowMediaCodec.addDecoder("video/avc", new ShadowMediaCodec.CodecConfig(
                4 * 1024 * 1024, 64 * 1024, (in, out) -> {
                    out.clear();
                    out.put((byte) 1);
                }));
        Context ctx = RuntimeEnvironment.getApplication();
        ActivityController<StreamActivity> c = Robolectric.buildActivity(StreamActivity.class,
                StreamActivity.intent(ctx, host, port, "720p", 60, 0, true)).setup();
        StreamActivity a = c.get();
        SurfaceView sv = a.findViewById(R.id.surface);
        ShadowSurfaceView.FakeSurfaceHolder holder = shadowOf(sv).getFakeSurfaceHolder();
        for (SurfaceHolder.Callback cb : holder.getCallbacks()) cb.surfaceCreated(holder);

        TextView message = a.findViewById(R.id.message);
        TextView stats = a.findViewById(R.id.stats);
        long end = System.currentTimeMillis() + 8000;
        while (System.currentTimeMillis() < end && message.getVisibility() == View.VISIBLE) {
            Thread.sleep(50);
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50));
        }
        assertEquals("video started (message: " + message.getText() + ")", View.GONE, message.getVisibility());
        for (int i = 0; i < 40; i++) {
            Thread.sleep(50);
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50));
        }
        a.findViewById(R.id.root).performClick();
        String s = stats.getText().toString();
        System.out.println("stats: " + s.replace('\n', '|'));
        assertTrue(s, s.contains("1280x720@60"));
        assertTrue(s, s.contains("ping"));
        assertEquals(View.VISIBLE, a.findViewById(R.id.controls).getVisibility());
        c.pause().stop().destroy();
    }
}
