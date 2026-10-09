#!/bin/bash
# Build a libretro core for <emularity-libretro>: the core as a static library, linked
# with our frontend (src/emulators/libretro/frontend.c) into an ES module plus wasm in
# emulators/libretro/<core>_libretro.{js,wasm}.
#
# Usage: tools/build-libretro-core.sh <core> [more cores...]
#   LIBRETRO_SRC  where core sources are checked out (default ~/src/libretro); missing
#                 ones are cloned
#   EMSDK         the Emscripten SDK (default ~/src/emsdk)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${LIBRETRO_SRC:-$HOME/src/libretro}
OUT=$ROOT/emulators/libretro
FRONTEND=$ROOT/src/emulators/libretro
source "${EMSDK:-$HOME/src/emsdk}/emsdk_env.sh" > /dev/null 2>&1

# Per core: git URL, checkout directory, the make invocation (run in that directory),
# and the static library it produces. Statically linked cores expect the frontend to
# provide libretro-common (RetroArch does); EXTRA lists the core's own copies of the
# parts it needs, compiled here, with include dirs EXTRA_INC. MEMORY is the wasm's
# initial memory, which must hold the core's static data. (Every core gets a 4MB stack:
# Emscripten's default 64KB is far smaller than native, and emulators overflow it.)
core_info() {
  EXTRA=(); EXTRA_INC=(); MEMORY=64MB
  case $1 in
    mesen)
      URL=https://github.com/SourMesen/Mesen.git; DIR=Mesen
      MAKE_ARGS=(-C Libretro platform=emscripten STATIC_LINKING=1)
      LIB=Libretro/mesen_libretro_emscripten.bc
      MEMORY=128MB ;; # ~65MB of static tables
    fceumm)
      URL=https://github.com/libretro/libretro-fceumm.git; DIR=libretro-fceumm
      MAKE_ARGS=(-f Makefile.libretro platform=emscripten)
      LIB=fceumm_libretro_emscripten.bc
      local common=src/drivers/libretro/libretro-common
      EXTRA_INC=($common/include)
      EXTRA=($common/compat/{compat_posix_string,compat_snprintf,compat_strcasestr,compat_strl,fopen_utf8}.c
             $common/encodings/encoding_utf.c $common/file/{file_path,file_path_io}.c
             $common/streams/{file_stream,file_stream_transforms}.c $common/string/stdstring.c
             $common/time/rtime.c $common/vfs/vfs_implementation.c) ;;
    *)
      echo "unknown core: $1 (add it to core_info in $0)" >&2; exit 1 ;;
  esac
}

mkdir -p "$SRC" "$OUT"
for core in "$@"; do
  core_info "$core"
  [ -d "$SRC/$DIR" ] || git clone --depth 1 "$URL" "$SRC/$DIR"
  echo "== building $core core (log: $SRC/$DIR/emularity-build.log)"
  (cd "$SRC/$DIR" && emmake make "${MAKE_ARGS[@]}" -j"$(nproc)") > "$SRC/$DIR/emularity-build.log" 2>&1 \
    || { tail -30 "$SRC/$DIR/emularity-build.log"; exit 1; }
  # The makefiles name the static archive .bc, which em++ would take for LLVM bitcode
  cp "$SRC/$DIR/$LIB" "$SRC/$DIR/emularity_core.a"

  echo "== linking $core with the frontend"
  objects=("$SRC/$DIR/emularity_frontend.o")
  emcc -O3 -c "$FRONTEND/frontend.c" -I"$FRONTEND" -o "${objects[0]}"
  for src in "${EXTRA[@]}"; do
    obj="$SRC/$DIR/emularity_extra_$(basename "${src%.c}").o"
    emcc -O2 -c "$SRC/$DIR/$src" "${EXTRA_INC[@]/#/-I$SRC/$DIR/}" -o "$obj"
    objects+=("$obj")
  done
  em++ -O3 "${objects[@]}" "$SRC/$DIR/emularity_core.a" \
    -o "$OUT/${core}_libretro.js" \
    -sMODULARIZE -sEXPORT_ES6 -sEXPORT_NAME=createCore \
    -sENVIRONMENT=web,worker \
    -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=$MEMORY -sSTACK_SIZE=4MB \
    -sFORCE_FILESYSTEM -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAP16,UTF8ToString,stringToNewUTF8 \
    -sEXPORTED_FUNCTIONS=_malloc,_free
  ls -la "$OUT/${core}_libretro".*
done
