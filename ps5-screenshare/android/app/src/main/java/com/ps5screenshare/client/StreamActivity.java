/* PS5 Screen Share - full-screen viewer.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
package com.ps5screenshare.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.IOException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

public final class StreamActivity extends Activity implements SurfaceHolder.Callback,
        VideoDecoder.Callback, StreamClient.Listener {
    static final String EXTRA_HOST = "host";
    static final String EXTRA_PORT = "port";
    static final String EXTRA_RES = "res";
    static final String EXTRA_FPS = "fps";
    static final String EXTRA_KBPS = "kbps";
    static final String EXTRA_AUDIO = "audio";

    private static final String[] QUALITY_LABELS = {
            "720p · 60 fps · 5 Mbps", "1080p · 60 fps · 8 Mbps", "1080p · 60 fps · 15 Mbps",
            "1080p · 30 fps · 6 Mbps", "1440p · 60 fps · 16 Mbps", "4K · 60 fps · 32 Mbps"};
    private static final String[] QUALITY_COMMANDS = {
            "SET res=720p fps=60 bitrate=5000", "SET res=1080p fps=60 bitrate=8000",
            "SET res=1080p fps=60 bitrate=15000", "SET res=1080p fps=30 bitrate=6000",
            "SET res=1440p fps=60 bitrate=16000", "SET res=2160p fps=60 bitrate=32000"};

    static Intent intent(Context c, String host, int port, String res, int fps, int kbps, boolean audio) {
        return new Intent(c, StreamActivity.class)
                .putExtra(EXTRA_HOST, host).putExtra(EXTRA_PORT, port).putExtra(EXTRA_RES, res)
                .putExtra(EXTRA_FPS, fps).putExtra(EXTRA_KBPS, kbps).putExtra(EXTRA_AUDIO, audio);
    }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService sender = Executors.newSingleThreadExecutor();
    private final AtomicInteger rendered = new AtomicInteger();

    private String host, res;
    private int port, fps, kbps;
    private volatile boolean audioOn;

    private AspectFrame aspect;
    private TextView stats, message;
    private View controls;
    private Button audioButton, fitButton, padButton;
    private PadView pad;
    private boolean padVisible = true;
    /** -1 until the console has said whether a controller is available. */
    private volatile int padState = -1;
    private volatile PadModel.State padLatest = new PadModel.State();
    private long padSeq;
    private boolean padTicking;

    private volatile boolean running;
    private volatile StreamClient client;
    private Thread network;
    private volatile VideoDecoder decoder;
    private AudioPlayer audio;
    private volatile boolean gotVideo;
    private volatile long rttMs = -1;
    private volatile String info = "";
    private volatile int streamW, streamH;
    private long lastKeyRequest, lastBytes, lastStatsAt;
    private int lastRendered;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Intent i = getIntent();
        host = i.getStringExtra(EXTRA_HOST);
        port = i.getIntExtra(EXTRA_PORT, StreamClient.DEFAULT_PORT);
        res = i.getStringExtra(EXTRA_RES);
        fps = i.getIntExtra(EXTRA_FPS, 60);
        kbps = i.getIntExtra(EXTRA_KBPS, 0);
        audioOn = i.getBooleanExtra(EXTRA_AUDIO, true);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
        setContentView(R.layout.activity_stream);
        aspect = findViewById(R.id.aspect);
        stats = findViewById(R.id.stats);
        message = findViewById(R.id.message);
        controls = findViewById(R.id.controls);
        audioButton = findViewById(R.id.btn_audio);
        fitButton = findViewById(R.id.btn_fit);
        SurfaceView surface = findViewById(R.id.surface);
        surface.getHolder().addCallback(this);

        View.OnClickListener toggle = v -> toggleControls();
        surface.setOnClickListener(toggle);
        findViewById(R.id.root).setOnClickListener(toggle);
        findViewById(R.id.btn_close).setOnClickListener(v -> finish());
        audioButton.setOnClickListener(v -> toggleAudio());
        fitButton.setOnClickListener(v -> {
            aspect.setFill(!aspect.isFill());
            updateButtons();
        });
        findViewById(R.id.btn_quality).setOnClickListener(v -> chooseQuality());
        pad = findViewById(R.id.pad);
        pad.setListener(this::onPadTouch);
        padButton = findViewById(R.id.btn_pad);
        padButton.setOnClickListener(v -> togglePad());
        padVisible = Prefs.get(this).getBoolean(Prefs.PAD_VISIBLE, true);
        aspect.setFill(Prefs.get(this).getBoolean(Prefs.FILL, false));
        updateButtons();
        applyPadVisibility();
        showMessage(getString(R.string.connecting_to, host));
    }

    @Override
    protected void onResume() {
        super.onResume();
        hideSystemUi();
        running = true;
        gotVideo = false;
        padState = -1;
        padLatest = new PadModel.State();
        applyPadVisibility();
        audio = new AudioPlayer();
        audio.setMuted(!audioOn);
        audio.start();
        network = new Thread(this::networkLoop, "ps5ss-network");
        network.start();
        lastStatsAt = SystemClock.elapsedRealtime();
        ui.post(tick);
    }

    @Override
    protected void onPause() {
        super.onPause();
        running = false;
        ui.removeCallbacks(tick);
        ui.removeCallbacks(padTick);
        padTicking = false;
        StreamClient c = client;
        if (c != null) c.close();
        if (network != null) {
            network.interrupt();
            network = null;
        }
        if (audio != null) {
            audio.stop();
            audio = null;
        }
        Prefs.get(this).edit().putBoolean(Prefs.FILL, aspect.isFill()).apply();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        stopDecoder();
        sender.shutdownNow();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }

    // ------------------------------------------------------------ network --

    private void networkLoop() {
        String hello = StreamClient.hello(audioOn, res, fps, kbps);
        boolean first = true;
        while (running) {
            if (!first) showMessage(getString(R.string.reconnecting, host));
            first = false;
            try (StreamClient c = new StreamClient(host, port, hello, 5000)) {
                client = c;
                padState = -1;
                ui.post(this::applyPadVisibility);
                if (!running) break; // paused while connecting
                if (!gotVideo) showMessage(getString(R.string.waiting_video));
                requestKeyframe();
                c.run(this);
            } catch (IOException e) {
                if (!running) break;
                String why = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                showMessage(getString(R.string.connection_lost, why));
            } finally {
                client = null;
            }
            gotVideo = false;
            // Reconnect without re-applying settings another viewer may have changed.
            hello = StreamClient.hello(audioOn, null, 0, 0);
            try {
                Thread.sleep(2000);
            } catch (InterruptedException e) {
                break;
            }
        }
    }

    private void sendAsync(String line) {
        StreamClient c = client;
        if (c == null) return;
        try {
            sender.execute(() -> {
                try {
                    c.send(line);
                } catch (IOException ignored) {
                    // the reader notices the broken connection
                }
            });
        } catch (RuntimeException ignored) {
            // executor shut down
        }
    }

    private void requestKeyframe() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastKeyRequest < 500) return;
        lastKeyRequest = now;
        sendAsync("KEY");
    }

    @Override
    public void onInfo(String json) {
        try {
            JSONObject o = new JSONObject(json);
            streamW = o.optInt("width");
            streamH = o.optInt("height");
            int f = o.optInt("fps");
            VideoDecoder d = decoder;
            if (d != null) d.setStreamHint(streamW, streamH, f);
            info = String.format(Locale.ROOT, "%dx%d@%d · %d kbps · FW %s", streamW, streamH, f,
                    o.optInt("kbps"), o.optString("firmware", "?"));
            ui.post(() -> aspect.setAspect(streamW, streamH));
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onVideo(byte[] data, long ptsUs, boolean keyframe) {
        VideoDecoder d = decoder;
        if (d != null) d.submit(data, ptsUs, keyframe);
    }

    @Override
    public void onAudio(byte[] data, long ptsUs) {
        AudioPlayer a = audio;
        if (a != null && audioOn) a.submit(data);
    }

    @Override
    public void onStatus(String text) {
        // While video is playing, server notices are shown briefly over it.
        if (gotVideo) showMessage(text, 3000);
        else showMessage(text);
    }

    @Override
    public void onPad(int state) {
        int previous = padState;
        padState = state;
        ui.post(this::applyPadVisibility);
        if (state == StreamClient.PAD_UNAVAILABLE && previous != StreamClient.PAD_UNAVAILABLE) {
            showMessage(getString(R.string.pad_unavailable), 5000);
        } else if (state == StreamClient.PAD_BUSY && previous != StreamClient.PAD_BUSY) {
            showMessage(getString(R.string.pad_busy), 3000);
        }
    }

    @Override
    public void onPong(String token) {
        try {
            rttMs = SystemClock.elapsedRealtime() - Long.parseLong(token.trim());
        } catch (NumberFormatException ignored) {
        }
    }

    // ------------------------------------------------------------ decoder --

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        stopDecoder();
        VideoDecoder d = new VideoDecoder(holder.getSurface(), this);
        d.setStreamHint(streamW, streamH, fps);
        d.start();
        decoder = d;
        requestKeyframe();
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {}

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        stopDecoder();
    }

    private void stopDecoder() {
        VideoDecoder d = decoder;
        decoder = null;
        if (d != null) d.stop();
    }

    @Override
    public void onVideoSize(int width, int height) {
        ui.post(() -> aspect.setAspect(width, height));
    }

    @Override
    public void onFrameRendered() {
        rendered.incrementAndGet();
        if (!gotVideo) {
            gotVideo = true;
            showMessage(null);
        }
    }

    @Override
    public void onNeedKeyframe() {
        requestKeyframe();
    }

    @Override
    public void onDecoderError(String msg) {
        showMessage(getString(R.string.decoder_error, msg));
        requestKeyframe();
    }

    // ------------------------------------------------------- controller --

    /** The overlay reports a new state (a touch went down, moved or lifted). */
    private void onPadTouch(PadModel.State s) {
        // Inactive pad (hidden, unavailable, or being switched off): never send,
        // a PAD line would take the controller back.
        if (!pad.isActive()) return;
        padLatest = s;
        if (padState == StreamClient.PAD_BUSY && pad.isHeld()) {
            showMessage(getString(R.string.pad_busy), 2000);
        }
        sendPadNow(s);
        if (pad.isHeld() && !padTicking) {
            padTicking = true;
            ui.postDelayed(padTick, 50);
        }
    }

    private void sendPadNow(PadModel.State s) {
        if (padState < 0 || padState == StreamClient.PAD_UNAVAILABLE) return;
        padSeq++;
        sendAsync(s.toLine(padSeq));
    }

    /** While a finger is on the controller, repeat its state every 50 ms (the console
     * neutralises the pad after 250 ms without input). */
    private final Runnable padTick = new Runnable() {
        @Override
        public void run() {
            if (!running || !pad.isHeld()) {
                padTicking = false;
                return;
            }
            sendPadNow(padLatest);
            ui.postDelayed(this, 50);
        }
    };

    private void applyPadVisibility() {
        boolean usable = padState == StreamClient.PAD_FREE || padState == StreamClient.PAD_YOURS
                || padState == StreamClient.PAD_BUSY;
        pad.setVisibility(padVisible ? View.VISIBLE : View.GONE);
        pad.setActive(padVisible && usable);
        padButton.setText(padVisible ? R.string.pad_on : R.string.pad_off);
    }

    private void togglePad() {
        padVisible = !padVisible;
        Prefs.get(this).edit().putBoolean(Prefs.PAD_VISIBLE, padVisible).apply();
        if (!padVisible) sendAsync("PADRELEASE");
        applyPadVisibility();
    }

    private String padLabel() {
        if (!padVisible) return getString(R.string.pad_label_hidden);
        switch (padState) {
            case StreamClient.PAD_FREE: return getString(R.string.pad_label_free);
            case StreamClient.PAD_YOURS: return getString(R.string.pad_label_yours);
            case StreamClient.PAD_BUSY: return getString(R.string.pad_label_busy);
            case StreamClient.PAD_UNAVAILABLE: return getString(R.string.pad_label_unavailable);
            default: return getString(R.string.pad_label_unknown);
        }
    }

    // ----------------------------------------------------------------- UI --

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            long now = SystemClock.elapsedRealtime();
            sendAsync("PING " + now);
            StreamClient c = client;
            long bytes = c != null ? c.bytesReceived() : 0;
            double secs = Math.max(1, now - lastStatsAt) / 1000.0;
            int frames = rendered.get();
            double fpsNow = (frames - lastRendered) / secs;
            double mbps = bytes >= lastBytes ? (bytes - lastBytes) * 8 / secs / 1e6 : 0;
            lastRendered = frames;
            lastBytes = bytes;
            lastStatsAt = now;
            VideoDecoder d = decoder;
            stats.setText(String.format(Locale.ROOT, "%s\n%.0f fps · %.1f Mbps · ping %s · descartes %d\n%s",
                    info.isEmpty() ? host : info, fpsNow, mbps,
                    rttMs >= 0 ? rttMs + " ms" : "-", d != null ? d.droppedFrames() : 0, padLabel()));
            ui.postDelayed(this, 1000);
        }
    };

    private int messageSerial;

    private void showMessage(String text) {
        showMessage(text, 0);
    }

    /** Shows text (null hides); a positive timeout hides it again later. */
    private void showMessage(String text, long timeoutMs) {
        ui.post(() -> {
            int serial = ++messageSerial;
            if (text == null || text.isEmpty()) {
                message.setVisibility(View.GONE);
                return;
            }
            message.setText(text);
            message.setVisibility(View.VISIBLE);
            if (timeoutMs > 0) {
                ui.postDelayed(() -> {
                    if (serial == messageSerial) message.setVisibility(View.GONE);
                }, timeoutMs);
            }
        });
    }

    private void toggleControls() {
        boolean show = controls.getVisibility() != View.VISIBLE;
        controls.setVisibility(show ? View.VISIBLE : View.GONE);
        stats.setVisibility(show ? View.VISIBLE : View.GONE);
        hideSystemUi();
    }

    private void toggleAudio() {
        audioOn = !audioOn;
        AudioPlayer a = audio;
        if (a != null) a.setMuted(!audioOn);
        sendAsync(audioOn ? "AUDIO 1" : "AUDIO 0");
        Prefs.get(this).edit().putBoolean(Prefs.AUDIO, audioOn).apply();
        updateButtons();
    }

    private void updateButtons() {
        audioButton.setText(audioOn ? R.string.audio_on : R.string.audio_off);
        fitButton.setText(aspect.isFill() ? R.string.fit_fill : R.string.fit_letterbox);
    }

    private void chooseQuality() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.quality_title)
                .setItems(QUALITY_LABELS, (dlg, which) -> {
                    sendAsync(QUALITY_COMMANDS[which]);
                    showMessage(getString(R.string.applying_quality));
                })
                .setOnDismissListener(dlg -> hideSystemUi())
                .show();
    }
}
