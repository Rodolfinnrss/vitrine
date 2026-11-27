/* PS5 Screen Share - start screen: find the console and connect.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
package com.ps5screenshare.client;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import java.util.List;
import java.util.regex.Pattern;

public final class MainActivity extends Activity {
    private static final String[] RES_VALUES = {"", "720p", "1080p", "1440p", "2160p"};
    private static final int[] FPS_VALUES = {60, 30};
    private static final int[] RATE_VALUES = {0, 5000, 8000, 12000, 16000, 20000, 32000};
    private static final Pattern HOST_PATTERN = Pattern.compile("^[A-Za-z0-9.\\-:]+$");

    private final Handler ui = new Handler(Looper.getMainLooper());
    private EditText hostField, portField;
    private Spinner resSpinner, fpsSpinner, rateSpinner;
    private CheckBox audioBox;
    private LinearLayout found;
    private TextView foundEmpty;
    private ProgressBar searching;
    private Button searchButton;
    private volatile boolean discovering;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        setContentView(R.layout.activity_main);
        hostField = findViewById(R.id.host);
        portField = findViewById(R.id.port);
        resSpinner = findViewById(R.id.resolution);
        fpsSpinner = findViewById(R.id.fps);
        rateSpinner = findViewById(R.id.bitrate);
        audioBox = findViewById(R.id.audio);
        found = findViewById(R.id.found);
        foundEmpty = findViewById(R.id.found_empty);
        searching = findViewById(R.id.searching);
        searchButton = findViewById(R.id.btn_search);

        resSpinner.setAdapter(adapter(R.array.resolutions));
        fpsSpinner.setAdapter(adapter(R.array.fps_options));
        rateSpinner.setAdapter(adapter(R.array.bitrates));

        SharedPreferences p = Prefs.get(this);
        hostField.setText(p.getString(Prefs.HOST, ""));
        portField.setText(String.valueOf(p.getInt(Prefs.PORT, StreamClient.DEFAULT_PORT)));
        resSpinner.setSelection(clamp(p.getInt(Prefs.RES, 0), RES_VALUES.length));
        fpsSpinner.setSelection(clamp(p.getInt(Prefs.FPS, 0), FPS_VALUES.length));
        rateSpinner.setSelection(clamp(p.getInt(Prefs.RATE, 0), RATE_VALUES.length));
        audioBox.setChecked(p.getBoolean(Prefs.AUDIO, true));

        findViewById(R.id.btn_connect).setOnClickListener(v -> connect(hostField.getText().toString().trim()));
        searchButton.setOnClickListener(v -> discover());
    }

    @Override
    protected void onResume() {
        super.onResume();
        discover();
    }

    private ArrayAdapter<CharSequence> adapter(int array) {
        ArrayAdapter<CharSequence> a = ArrayAdapter.createFromResource(this, array,
                android.R.layout.simple_spinner_item);
        a.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        return a;
    }

    private static int clamp(int v, int n) {
        return v < 0 || v >= n ? 0 : v;
    }

    private int port() {
        try {
            int p = Integer.parseInt(portField.getText().toString().trim());
            return p > 0 && p < 65536 ? p : StreamClient.DEFAULT_PORT;
        } catch (NumberFormatException e) {
            return StreamClient.DEFAULT_PORT;
        }
    }

    private void discover() {
        if (discovering) return;
        discovering = true;
        searching.setVisibility(View.VISIBLE);
        searchButton.setEnabled(false);
        final int port = port();
        new Thread(() -> {
            List<Discovery.Console> list = Discovery.find(port, 1500);
            ui.post(() -> show(list));
        }, "ps5ss-discovery").start();
    }

    private void show(List<Discovery.Console> list) {
        discovering = false;
        if (isFinishing()) return;
        searching.setVisibility(View.GONE);
        searchButton.setEnabled(true);
        found.removeAllViews();
        foundEmpty.setVisibility(list.isEmpty() ? View.VISIBLE : View.GONE);
        for (Discovery.Console c : list) {
            Button b = new Button(this);
            b.setAllCaps(false);
            b.setText(getString(R.string.found_item, c.ip, c.firmware, c.clients));
            b.setOnClickListener(v -> {
                hostField.setText(c.ip);
                portField.setText(String.valueOf(c.port));
                connect(c.ip);
            });
            found.addView(b);
        }
    }

    private void connect(String host) {
        if (TextUtils.isEmpty(host) || !HOST_PATTERN.matcher(host).matches()) {
            Toast.makeText(this, R.string.enter_ip, Toast.LENGTH_SHORT).show();
            return;
        }
        int port = port();
        int resIdx = resSpinner.getSelectedItemPosition();
        int fpsIdx = fpsSpinner.getSelectedItemPosition();
        int rateIdx = rateSpinner.getSelectedItemPosition();
        boolean audio = audioBox.isChecked();
        Prefs.get(this).edit()
                .putString(Prefs.HOST, host).putInt(Prefs.PORT, port)
                .putInt(Prefs.RES, resIdx).putInt(Prefs.FPS, fpsIdx).putInt(Prefs.RATE, rateIdx)
                .putBoolean(Prefs.AUDIO, audio).apply();
        String res = RES_VALUES[clamp(resIdx, RES_VALUES.length)];
        int fps = FPS_VALUES[clamp(fpsIdx, FPS_VALUES.length)];
        int kbps = RATE_VALUES[clamp(rateIdx, RATE_VALUES.length)];
        startActivity(StreamActivity.intent(this, host, port, res, fps, kbps, audio));
    }
}
