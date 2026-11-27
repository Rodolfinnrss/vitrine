/* PS5 Screen Share - wire protocol shared by the payload and the Android app.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * TCP (default port 9700)
 *   client -> server : text lines, '\n' terminated, first line must be HELLO
 *     HELLO 1 [audio=0|1] [res=720p|1080p|1440p|2160p] [fps=30|60] [bitrate=kbps]
 *     SET [res=..] [fps=..] [bitrate=..]   change the shared capture settings
 *     KEY                                  ask for an IDR frame
 *     AUDIO 0|1                            stop/start audio for this client
 *     PING <token>                         answered by a PONG packet
 *   server -> client : 8-byte stream header then packets
 *     header  "PS5S" u16 version u16 reserved              (big endian)
 *     packet  u8 type, u8 flags, u16 reserved, u32 length, u64 pts_us, payload
 *       INFO   JSON (capture geometry, audio format, console details)
 *       VIDEO  one H.264 Annex-B access unit; SPS/PPS precede every IDR
 *       AUDIO  PCM s16le, interleaved stereo, 48 kHz
 *       STATUS UTF-8 human readable state / error text
 *       PONG   the PING token
 *       KEEPALIVE empty, sent when the connection is otherwise idle
 *   A plain HTTP GET on the same port serves /, /status, /log and /app.apk.
 *
 * UDP discovery (same port number)
 *   client broadcasts "PS5SS?"  ->  server answers "PS5SS! " + JSON
 */
#ifndef PS5SS_PROTOCOL_H
#define PS5SS_PROTOCOL_H

#define PS5SS_PROTO_VERSION 1
#define PS5SS_DEFAULT_PORT 9700
#define PS5SS_STREAM_MAGIC "PS5S"
#define PS5SS_HEADER_LEN 16

enum {
  PKT_KEEPALIVE = 0,
  PKT_INFO = 1,
  PKT_VIDEO = 2,
  PKT_AUDIO = 3,
  PKT_STATUS = 4,
  PKT_PONG = 5,
};

#define PKT_FLAG_KEYFRAME 0x01

#define PS5SS_DISCOVERY_QUERY "PS5SS?"
#define PS5SS_DISCOVERY_REPLY "PS5SS! "

#endif
