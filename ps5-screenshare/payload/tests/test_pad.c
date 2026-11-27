/* Host test for the virtual controller's parser and ownership rules.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
#include "pad.h"

#include <stdio.h>
#include <string.h>
#include <unistd.h>

static int failures;
#define CHECK(c, ...) do { if (!(c)) { failures++; printf("FAIL: " __VA_ARGS__); printf("\n"); } } while (0)

static void settle(void) { usleep(30000); }

int main(void) {
  uint32_t seq;
  pad_state s;

  /* Parser: accepted input. */
  CHECK(!pad_parse("5,16384,128,128,128,128,0,255", &seq, &s), "valid line");
  CHECK(seq == 5 && s.buttons == PAD_CROSS && s.lx == 128 && s.r2 == 255, "valid line fields");
  CHECK(!pad_parse("4294967295,0,0,0,0,0,0,0", &seq, &s) && seq == 4294967295u, "seq is 32-bit");
  CHECK(!pad_parse("1,1310718,0,0,0,0,0,0", &seq, &s), "all valid bits accepted (0x13fffe)");
  CHECK(!pad_parse("1,1310718,0,0,0,0,0,0", &seq, &s) && s.buttons == PAD_VALID_BITS, "mask fields");

  /* Parser: rejected input. */
  CHECK(pad_parse("", &seq, &s) != 0, "empty");
  CHECK(pad_parse("1,0,128,128,128,128,0", &seq, &s) != 0, "too few fields");
  CHECK(pad_parse("1,0,128,128,128,128,0,0,0", &seq, &s) != 0, "too many fields");
  CHECK(pad_parse("1,0,128,128,128,128,0,256", &seq, &s) != 0, "trigger above 255");
  CHECK(pad_parse("1,0,256,128,128,128,0,0", &seq, &s) != 0, "stick above 255");
  CHECK(pad_parse("1,1,128,128,128,128,0,0", &seq, &s) != 0, "undefined button bit");
  CHECK(pad_parse("1,-1,128,128,128,128,0,0", &seq, &s) != 0, "negative value");
  CHECK(pad_parse("4294967296,0,0,0,0,0,0,0", &seq, &s) != 0, "seq overflow");
  CHECK(pad_parse("1,0,128,128,128,128,0,0x10", &seq, &s) != 0, "hex is not accepted");
  CHECK(pad_parse("1,0,128,128,128,128,0,0 ", &seq, &s) != 0, "trailing space");

  /* Ownership. The host backend is available unless PS5SS_MOCK_PAD=0. */
  CHECK(pad_init(1) == 0, "host pad backend initialises");
  int a = 1, b = 2;
  CHECK(pad_state_for(&a) == PAD_FREE, "free before anyone claims");
  pad_state press = {PAD_CROSS, 128, 128, 128, 128, 0, 0};
  CHECK(pad_submit(&a, 1, &press) == PAD_YOURS, "first viewer takes control");
  CHECK(pad_submit(&b, 1, &press) == PAD_BUSY, "second viewer is refused");
  CHECK(pad_state_for(&a) == PAD_YOURS && pad_state_for(&b) == PAD_BUSY, "states from each side");
  settle();
  pad_info info;
  pad_get_info(&info);
  CHECK(info.owned && info.available && info.buttons == PAD_CROSS, "state reached the backend");

  /* Sequence numbers: an older packet must not move the pad back. */
  pad_state circle = {PAD_CIRCLE, 128, 128, 128, 128, 0, 0};
  CHECK(pad_submit(&a, 3, &circle) == PAD_YOURS, "newer state accepted");
  CHECK(pad_submit(&a, 2, &press) == PAD_YOURS, "older state still answered");
  settle();
  pad_get_info(&info);
  CHECK(info.buttons == PAD_CIRCLE, "older sequence ignored (got 0x%x)", info.buttons);

  /* Non-owner release does nothing. */
  pad_release(&b);
  CHECK(pad_state_for(&a) == PAD_YOURS, "stranger cannot release");

  /* Owner release frees the pad and neutralises it. */
  pad_release(&a);
  settle();
  pad_get_info(&info);
  CHECK(!info.owned && info.buttons == 0, "release neutralises the pad");
  CHECK(pad_state_for(&b) == PAD_FREE, "pad is free after release");
  CHECK(pad_submit(&b, 1, &press) == PAD_YOURS, "the other viewer can take it now");

  /* Silence: the owner is released after 2 s. A keepalive keeps it. */
  usleep(1200000);
  CHECK(pad_submit(&b, 2, &press) == PAD_YOURS, "keepalive keeps control");
  usleep(1200000);
  CHECK(pad_state_for(&b) == PAD_YOURS, "still owner after 1.2 s of keepalive gap");
  usleep(1200000);
  CHECK(pad_state_for(&b) == PAD_FREE, "released after 2 s of silence");

  pad_shutdown();
  CHECK(pad_state_for(&a) == PAD_UNAVAILABLE, "unavailable after shutdown");

  if (failures) { printf("test_pad: %d failures\n", failures); return 1; }
  printf("test_pad: all checks passed\n");
  return 0;
}
