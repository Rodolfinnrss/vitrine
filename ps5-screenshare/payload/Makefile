# PS5 Screen Share - payload build
#
#   export PS5_PAYLOAD_SDK=/opt/ps5-payload-sdk     (ps5-payload-dev/sdk)
#   make                    -> build/ps5-screenshare.elf (send this one)
#                              build/ps5-screenshare-service.elf (standalone)
#   make APK=path/app.apk   -> also serve the Android app at http://PS5:9700/app.apk
#   make host               -> build/host/ps5ss-service (Linux, mock capture)
#   make deploy PS5_HOST=192.168.0.10

VERSION   ?= 1.0.0
PS5_HOST  ?= ps5
PS5_PORT  ?= 9021
SRCDIR    := src
BUILD     := build

SERVICE_SRCS := main.c avcap.c audio.c fwprofiles.c fwprofiles_data.c stream.c \
                server.c status.c settings.c config.c control.c platform.c log.c
SUPERVISOR_SRCS := supervisor.c control.c config.c settings.c platform.c log.c
HOST_SRCS := main.c mock_capture.c fwprofiles.c fwprofiles_data.c stream.c \
             server.c status.c settings.c config.c control.c platform.c log.c
HEADERS := $(wildcard $(SRCDIR)/*.h)

SERVICE_ELF    := $(BUILD)/ps5-screenshare-service.elf
SUPERVISOR_ELF := $(BUILD)/ps5-screenshare.elf

CFLAGS_COMMON := -Wall -Wextra -Werror -O2 -pthread -I$(SRCDIR) \
                 -DPS5SS_VERSION=\"$(VERSION)\"
ifneq ($(APK),)
APK_ABS := $(abspath $(APK))
APK_FLAG := -DPS5SS_APK_PATH=\"$(APK_ABS)\"
endif

.PHONY: all host clean deploy test

all: $(SUPERVISOR_ELF)

ifneq ($(filter-out host clean test,$(if $(MAKECMDGOALS),$(MAKECMDGOALS),all)),)
ifndef PS5_PAYLOAD_SDK
$(error PS5_PAYLOAD_SDK is undefined; export it to point at the ps5-payload-sdk root)
endif
include $(PS5_PAYLOAD_SDK)/toolchain/prospero.mk
endif

$(SERVICE_ELF): $(addprefix $(SRCDIR)/,$(SERVICE_SRCS)) $(HEADERS) $(APK)
	@mkdir -p $(BUILD)
	$(CC) $(CFLAGS_COMMON) $(APK_FLAG) -o $@ $(addprefix $(SRCDIR)/,$(SERVICE_SRCS))
	$(STRIP) $@

$(SUPERVISOR_ELF): $(SERVICE_ELF) $(addprefix $(SRCDIR)/,$(SUPERVISOR_SRCS)) $(HEADERS)
	$(CC) $(CFLAGS_COMMON) -DPS5SS_SERVICE_PATH=\"$(abspath $(SERVICE_ELF))\" \
	  -o $@ $(addprefix $(SRCDIR)/,$(SUPERVISOR_SRCS))
	$(STRIP) $@

host: $(BUILD)/host/ps5ss-service $(BUILD)/host/ps5ss-supervisor

$(BUILD)/host/ps5ss-service: $(addprefix $(SRCDIR)/,$(HOST_SRCS)) $(HEADERS) $(APK)
	@mkdir -p $(BUILD)/host
	cc $(CFLAGS_COMMON) -g -fsanitize=address,undefined -DPS5SS_HOST \
	  -DPS5SS_DATA_DIR=\"$(abspath $(BUILD)/host/data)\" $(APK_FLAG) \
	  -o $@ $(addprefix $(SRCDIR)/,$(HOST_SRCS)) -lm
	@mkdir -p $(BUILD)/host/data

$(BUILD)/host/ps5ss-supervisor: $(BUILD)/host/ps5ss-service $(addprefix $(SRCDIR)/,$(SUPERVISOR_SRCS)) $(HEADERS)
	cc $(CFLAGS_COMMON) -g -fsanitize=address,undefined -DPS5SS_HOST -DELFLDR_PORT=19021 \
	  -DPS5SS_DATA_DIR=\"$(abspath $(BUILD)/host/data)\" \
	  -DPS5SS_SERVICE_PATH=\"$(abspath $(BUILD)/host/ps5ss-service)\" \
	  -o $@ $(addprefix $(SRCDIR)/,$(SUPERVISOR_SRCS))

test: host
	cc $(CFLAGS_COMMON) -g -fsanitize=address,undefined -o $(BUILD)/host/test_fwprofiles \
	  tests/test_fwprofiles.c $(SRCDIR)/fwprofiles.c $(SRCDIR)/fwprofiles_data.c
	$(BUILD)/host/test_fwprofiles
	python3 -I tools/host_test.py $(BUILD)/host/ps5ss-service
	python3 -I tools/supervisor_test.py $(BUILD)/host/ps5ss-supervisor

deploy: $(SUPERVISOR_ELF)
	python3 -I tools/deploy.py $(PS5_HOST) $(PS5_PORT) $(SUPERVISOR_ELF)

clean:
	rm -rf $(BUILD)
