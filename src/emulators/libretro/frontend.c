/* A minimal libretro frontend, compiled together with a libretro core (as a static
   library) into one Emscripten module. JavaScript drives it (see ../libretro.js):

     emu_load(path, data, size)   load a game; the file is also at `path` in the
                                   module's filesystem, for cores that need a path
     emu_run()                     run one frame; afterwards the frame (RGBA, in wasm
                                   memory) and that frame's audio can be read
     emu_set_buttons(port, mask)   joypad state, as a RETRO_DEVICE_ID_JOYPAD_* bitmask
     emu_set_variable(key, value)  a core option

   plus getters for timing, geometry, save RAM and save states. Everything the core
   asks of the frontend through the environment callback is answered here. */

#include <emscripten.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "libretro.h"

#define MAX_PORTS 4
#define MAX_VARIABLES 128

static struct retro_system_info system_info;
static struct retro_system_av_info av_info;
static enum retro_pixel_format pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;

static uint32_t *frame;          /* RGBA, frame_width * frame_height */
static size_t frame_capacity;
static unsigned frame_width, frame_height;
static int frame_ready;

static int16_t *audio;           /* interleaved stereo */
static size_t audio_frames, audio_capacity;

static uint16_t buttons[MAX_PORTS];

static struct { char *key, *value; } variables[MAX_VARIABLES];
static int variable_count, variables_changed;

/* ----- Core options ----- */

static int find_variable(const char *key) {
  for (int i = 0; i < variable_count; i++) if (!strcmp(variables[i].key, key)) return i;
  return -1;
}
static void store_variable(const char *key, const char *value, int overwrite) {
  int i = find_variable(key);
  if (i >= 0) {
    if (!overwrite) return;
    free(variables[i].value);
  } else {
    if (variable_count == MAX_VARIABLES) return;
    i = variable_count++;
    variables[i].key = strdup(key);
  }
  variables[i].value = strdup(value);
}
/* The core declares its options as "Description; first|second|...": the first value
   is the default */
static void declare_variables(const struct retro_variable *vars) {
  for (; vars && vars->key; vars++) {
    const char *values = strstr(vars->value, "; ");
    if (!values) continue;
    values += 2;
    const char *bar = strchr(values, '|');
    size_t len = bar ? (size_t)(bar - values) : strlen(values);
    char *def = strndup(values, len);
    store_variable(vars->key, def, 0);
    free(def);
  }
}
EMSCRIPTEN_KEEPALIVE void emu_set_variable(const char *key, const char *value) {
  store_variable(key, value, 1);
  variables_changed = 1;
}

/* ----- Callbacks from the core ----- */

static void log_printf(enum retro_log_level level, const char *fmt, ...) {
  va_list args;
  va_start(args, fmt);
  vfprintf(level >= RETRO_LOG_WARN ? stderr : stdout, fmt, args);
  va_end(args);
}

static bool environment(unsigned cmd, void *data) {
  switch (cmd) {
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      pixel_format = *(const enum retro_pixel_format *)data;
      return pixel_format <= RETRO_PIXEL_FORMAT_RGB565;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
      *(const char **)data = "/system";
      return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
      *(const char **)data = "/save";
      return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
      ((struct retro_log_callback *)data)->log = log_printf;
      return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      if (data) *(bool *)data = true;
      return true;
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
      *(unsigned *)data = 0; /* the classic SET_VARIABLES interface, which every core supports */
      return true;
    case RETRO_ENVIRONMENT_SET_VARIABLES:
      declare_variables((const struct retro_variable *)data);
      return true;
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      struct retro_variable *var = data;
      int i = find_variable(var->key);
      var->value = i >= 0 ? variables[i].value : NULL;
      return i >= 0;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
      *(bool *)data = variables_changed;
      variables_changed = 0;
      return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
      av_info.geometry = *(const struct retro_game_geometry *)data;
      return true;
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
      av_info = *(const struct retro_system_av_info *)data;
      return true;
    case RETRO_ENVIRONMENT_GET_LANGUAGE:
      *(unsigned *)data = RETRO_LANGUAGE_ENGLISH;
      return true;
    /* Information we accept but have no use for */
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
    case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
      return true;
    default:
      return false;
  }
}

static void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch) {
  if (!data) return; /* a duplicate of the last frame */
  if ((size_t)width * height > frame_capacity) {
    frame_capacity = (size_t)width * height;
    frame = realloc(frame, frame_capacity * 4);
  }
  frame_width = width;
  frame_height = height;
  frame_ready = 1;
  uint32_t *out = frame;
  for (unsigned y = 0; y < height; y++) {
    const uint8_t *row = (const uint8_t *)data + y * pitch;
    if (pixel_format == RETRO_PIXEL_FORMAT_XRGB8888) {
      const uint32_t *px = (const uint32_t *)row;
      for (unsigned x = 0; x < width; x++) {
        uint32_t p = px[x];
        *out++ = 0xff000000 | ((p & 0xff) << 16) | (p & 0xff00) | ((p >> 16) & 0xff);
      }
    } else {
      const uint16_t *px = (const uint16_t *)row;
      for (unsigned x = 0; x < width; x++) {
        uint32_t p = px[x], r, g, b;
        if (pixel_format == RETRO_PIXEL_FORMAT_RGB565) {
          r = (p >> 11) & 0x1f; g = (p >> 5) & 0x3f; b = p & 0x1f;
          r = (r << 3) | (r >> 2); g = (g << 2) | (g >> 4); b = (b << 3) | (b >> 2);
        } else { /* 0RGB1555 */
          r = (p >> 10) & 0x1f; g = (p >> 5) & 0x1f; b = p & 0x1f;
          r = (r << 3) | (r >> 2); g = (g << 3) | (g >> 2); b = (b << 3) | (b >> 2);
        }
        *out++ = 0xff000000 | (b << 16) | (g << 8) | r;
      }
    }
  }
}

static size_t audio_batch(const int16_t *data, size_t frames) {
  if (audio_frames + frames > audio_capacity) {
    audio_capacity = (audio_frames + frames) * 2;
    audio = realloc(audio, audio_capacity * 4);
  }
  memcpy(audio + audio_frames * 2, data, frames * 4);
  audio_frames += frames;
  return frames;
}
static void audio_sample(int16_t left, int16_t right) {
  int16_t pair[2] = { left, right };
  audio_batch(pair, 1);
}

static void input_poll(void) {}
static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  if (port >= MAX_PORTS || (device & RETRO_DEVICE_MASK) != RETRO_DEVICE_JOYPAD) return 0;
  if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return buttons[port];
  return (buttons[port] >> id) & 1;
}

/* ----- API for JavaScript ----- */

EMSCRIPTEN_KEEPALIVE int emu_load(const char *path, const void *data, size_t size) {
  /* The environment comes first and the other callbacks after retro_init, as
     RetroArch does: some cores (e.g. Mesen) only create what they hand callbacks to
     in retro_init */
  retro_set_environment(environment);
  retro_init();
  retro_set_video_refresh(video_refresh);
  retro_set_audio_sample(audio_sample);
  retro_set_audio_sample_batch(audio_batch);
  retro_set_input_poll(input_poll);
  retro_set_input_state(input_state);
  retro_get_system_info(&system_info);
  struct retro_game_info game = { path, NULL, 0, NULL };
  if (!system_info.need_fullpath) { game.data = data; game.size = size; }
  if (!retro_load_game(&game)) return 0;
  retro_get_system_av_info(&av_info);
  for (unsigned port = 0; port < 2; port++) retro_set_controller_port_device(port, RETRO_DEVICE_JOYPAD);
  return 1;
}
EMSCRIPTEN_KEEPALIVE void emu_run(void) {
  frame_ready = 0;
  audio_frames = 0;
  retro_run();
}
EMSCRIPTEN_KEEPALIVE void emu_reset(void) { retro_reset(); }
EMSCRIPTEN_KEEPALIVE void emu_set_buttons(unsigned port, unsigned mask) { if (port < MAX_PORTS) buttons[port] = mask; }

EMSCRIPTEN_KEEPALIVE int emu_frame_ready(void) { return frame_ready; }
EMSCRIPTEN_KEEPALIVE uint32_t *emu_frame(void) { return frame; }
EMSCRIPTEN_KEEPALIVE unsigned emu_frame_width(void) { return frame_width; }
EMSCRIPTEN_KEEPALIVE unsigned emu_frame_height(void) { return frame_height; }
EMSCRIPTEN_KEEPALIVE int16_t *emu_audio(void) { return audio; }
EMSCRIPTEN_KEEPALIVE size_t emu_audio_frames(void) { return audio_frames; }

EMSCRIPTEN_KEEPALIVE double emu_fps(void) { return av_info.timing.fps; }
EMSCRIPTEN_KEEPALIVE double emu_sample_rate(void) { return av_info.timing.sample_rate; }
EMSCRIPTEN_KEEPALIVE double emu_aspect_ratio(void) {
  struct retro_game_geometry *g = &av_info.geometry;
  return g->aspect_ratio > 0 ? g->aspect_ratio : (double)g->base_width / g->base_height;
}
EMSCRIPTEN_KEEPALIVE const char *emu_library_name(void) { return system_info.library_name; }
EMSCRIPTEN_KEEPALIVE const char *emu_library_version(void) { return system_info.library_version; }
EMSCRIPTEN_KEEPALIVE const char *emu_valid_extensions(void) {
  /* available before a game is loaded too */
  retro_get_system_info(&system_info);
  return system_info.valid_extensions;
}

EMSCRIPTEN_KEEPALIVE void *emu_save_ram(void) { return retro_get_memory_data(RETRO_MEMORY_SAVE_RAM); }
EMSCRIPTEN_KEEPALIVE size_t emu_save_ram_size(void) { return retro_get_memory_size(RETRO_MEMORY_SAVE_RAM); }

EMSCRIPTEN_KEEPALIVE size_t emu_state_size(void) { return retro_serialize_size(); }
EMSCRIPTEN_KEEPALIVE int emu_save_state(void *data, size_t size) { return retro_serialize(data, size); }
EMSCRIPTEN_KEEPALIVE int emu_load_state(const void *data, size_t size) { return retro_unserialize(data, size); }
