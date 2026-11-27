/* PS5 Screen Share - saved choices.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
package com.ps5screenshare.client;

import android.content.Context;
import android.content.SharedPreferences;

final class Prefs {
    static final String HOST = "host";
    static final String PORT = "port";
    static final String RES = "res_index";
    static final String FPS = "fps_index";
    static final String RATE = "rate_index";
    static final String AUDIO = "audio";
    static final String FILL = "fill";
    static final String PAD_VISIBLE = "pad_visible";
    static final String MODE_RELAY = "mode_relay";
    static final String RELAY_HOST = "relay_host";
    static final String RELAY_PORT = "relay_port";
    static final String PAIR = "pair";

    private Prefs() {}

    static SharedPreferences get(Context c) {
        return c.getSharedPreferences("ps5ss", Context.MODE_PRIVATE);
    }
}
