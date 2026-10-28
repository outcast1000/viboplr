#!/usr/bin/env bash
# Builds the trimmed, self-contained libmpv the app vendors, from pinned sources
# (sources.txt). One recipe for both platforms:
#   macOS arm64  — clang + Xcode/CLT, run natively
#   Windows x64  — MSYS2 UCRT64 (run from its bash; see build-libmpv.yml for the
#                  pacman packages it expects)
#
#   build.sh pin     refresh the sha256 column of sources.txt from the urls
#   build.sh build   fetch (sha256-checked) + build + package into $WORK/out
#
# The output archive has the layout scripts/fetch-libmpv.mjs already unpacks:
#   macOS:   libmpv/libmpv.2.dylib + libmpv/include/mpv/*.h
#   Windows: libmpv-2.dll + libmpv.dll.a + include/mpv/*.h
# Everything links statically into the one library; the build fails if it
# depends on anything but the OS (otool / objdump check at the end).
#
# What is trimmed, and why it is safe for the app: every decoder, demuxer,
# parser and filter stays; encoders, muxers and capture devices go (mpv never
# encodes for us), as do Vulkan, Blu-ray/DVD/CD, JavaScript and the external
# codec libraries (FFmpeg's native decoders + dav1d cover playback). Lua stays:
# without it mpv has no `ytdl` option, which the engine sets at creation.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCES="$HERE/sources.txt"
WORK="${LIBMPV_WORK:-${RUNNER_TEMP:-/tmp}/libmpv-build}"
DL="$WORK/dl"
SRC="$WORK/src"
P="$WORK/prefix"
OUT="$WORK/out"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

case "$(uname -s)" in
  Darwin) OS=macos; ARCH=aarch64 ;;
  MINGW*|MSYS*) OS=windows; ARCH=x86_64 ;;
  *) echo "unsupported host: $(uname -s)" >&2; exit 1 ;;
esac

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
sources() { grep -vE '^\s*(#|$)' "$SOURCES"; }

download() { # url dest
  [ -f "$2" ] && return 0
  curl -fsSL --retry 5 --retry-all-errors -o "$2.part" "$1"
  mv "$2.part" "$2"
}

pin() {
  mkdir -p "$DL"
  local tmp="$SOURCES.tmp" line name dest url old new
  : > "$tmp"
  while IFS= read -r line; do
    if [[ "$line" =~ ^[[:space:]]*(#|$) ]]; then echo "$line" >> "$tmp"; continue; fi
    read -r name dest url old <<< "$line"
    download "$url" "$DL/$name.tar"
    new=$(sha256 "$DL/$name.tar")
    printf '%-12s %-32s %s  %s\n' "$name" "$dest" "$url" "$new" >> "$tmp"
    [ "$old" = "$new" ] || echo "pinned $name $new"
  done < "$SOURCES"
  mv "$tmp" "$SOURCES"
}

fetch() {
  mkdir -p "$DL"
  rm -rf "$SRC"; mkdir -p "$SRC"
  local name dest url want got
  # Parents before children: libplacebo/3rdparty/* unpack into libplacebo.
  while read -r name dest url want; do
    download "$url" "$DL/$name.tar"
    got=$(sha256 "$DL/$name.tar")
    if [ "$got" != "$want" ]; then
      echo "sha256 mismatch for $name: want $want, got $got" >&2
      exit 1
    fi
    mkdir -p "$SRC/$dest"
    tar -xf "$DL/$name.tar" -C "$SRC/$dest" --strip-components=1
  done < <(sources)
}

# ---------------------------------------------------------------------------

setup_env() { # [keep] — keep an earlier run's prefix (resume)
  [ "${1:-}" = keep ] || rm -rf "$P" "$OUT"
  mkdir -p "$P/lib/pkgconfig" "$P/include" "$OUT"
  if [ "$OS" = macos ]; then
    export MACOSX_DEPLOYMENT_TARGET=11.0
    export CFLAGS="-mmacosx-version-min=11.0" CXXFLAGS="-mmacosx-version-min=11.0" LDFLAGS="-mmacosx-version-min=11.0"
    # Only our prefix: Homebrew's libass/dav1d/... must never be picked up.
    export PKG_CONFIG_LIBDIR="$P/lib/pkgconfig"
    if ! command -v meson >/dev/null; then
      python3 -m venv "$WORK/venv"
      "$WORK/venv/bin/pip" install -q meson==1.12.1 ninja==1.13.2
      export PATH="$WORK/venv/bin:$PATH"
    fi
  else
    export CFLAGS="-O2" CXXFLAGS="-O2" LDFLAGS=""
    # Our prefix first; UCRT64's own for the few system pieces taken from
    # pacman (zlib, iconv, shaderc, spirv-cross) — no other media library is
    # installed there, so nothing else can be picked up.
    export PKG_CONFIG_LIBDIR="$P/lib/pkgconfig:${MINGW_PREFIX:-/ucrt64}/lib/pkgconfig"
  fi
  export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
}

meson_static() { # srcdir args...
  local d="$SRC/$1"; shift
  rm -rf "$d/_b"
  meson setup "$d/_b" "$d" --prefix="$P" --libdir=lib --buildtype=release -Db_ndebug=true \
    --default-library=static "$@"
  meson install -C "$d/_b" --quiet
}

build_openssl() { # macOS only — Windows uses schannel
  cd "$SRC/openssl"
  ./Configure darwin64-arm64-cc no-shared no-tests no-docs no-apps --prefix="$P" --libdir=lib > configure.log
  make -j"$JOBS" build_libs > make.log
  make install_dev > /dev/null
}

build_luajit() {
  cd "$SRC/luajit"
  local mk=(BUILDMODE=static)
  [ "$OS" = macos ] && mk+=(MACOSX_DEPLOYMENT_TARGET=11.0)
  make -j"$JOBS" "${mk[@]}" > make.log
  # Installed by hand: LuaJIT's install target assumes a Unix layout.
  local inc="$P/include/luajit-2.1"
  mkdir -p "$inc"
  cp src/lua.h src/lualib.h src/lauxlib.h src/luaconf.h src/lua.hpp src/luajit.h "$inc/"
  cp src/libluajit.a "$P/lib/libluajit-5.1.a"
  cat > "$P/lib/pkgconfig/luajit.pc" <<EOF
prefix=$P
Name: LuaJIT
Description: Just-in-time compiler for Lua
Version: 2.1.$(cat .relver)
Libs: -L\${prefix}/lib -lluajit-5.1
Libs.private: -lm
Cflags: -I\${prefix}/include/luajit-2.1
EOF
}

build_deps() {
  meson_static freetype -Dharfbuzz=disabled -Dpng=disabled -Dbrotli=disabled -Dbzip2=disabled \
    -Dzlib=system -Dtests=disabled
  meson_static fribidi -Ddocs=false -Dtests=false -Dbin=false
  meson_static harfbuzz -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled \
    -Dicu=disabled -Dgraphite2=disabled -Dchafa=disabled -Dtests=disabled -Ddocs=disabled \
    -Dintrospection=disabled -Dutilities=disabled -Dcoretext=disabled -Dbenchmark=disabled -Dsubset=disabled
  local ass=(-Dfontconfig=disabled -Dlibunibreak=disabled -Dtest=disabled -Dcompare=disabled
    -Dprofile=disabled -Dfuzz=disabled -Dcheckasm=disabled)
  if [ "$OS" = macos ]; then ass+=(-Dcoretext=enabled -Ddirectwrite=disabled)
  else ass+=(-Dcoretext=disabled -Ddirectwrite=enabled); fi
  meson_static libass "${ass[@]}"
  meson_static dav1d -Denable_tools=false -Denable_tests=false -Denable_examples=false
  local pl=(-Dvulkan=disabled -Dopengl=enabled -Dglslang=disabled -Dlcms=disabled -Dlibdovi=disabled
    -Dxxhash=disabled -Ddemos=false -Dtests=false -Dunwind=disabled)
  if [ "$OS" = macos ]; then pl+=(-Dd3d11=disabled -Dshaderc=disabled)
  else pl+=(-Dd3d11=enabled -Dshaderc=enabled); fi
  meson_static libplacebo "${pl[@]}"
  build_luajit
  if [ "$OS" = macos ]; then build_openssl; fi
}

# mpv and libplacebo look for shaderc / spirv-cross under their SHARED names.
# Point those names at UCRT64's static archives so the DLL carries them.
#
# Both are C++, and the DLL is linked by the C driver, so libstdc++ has to be
# named — as the ARCHIVE (-l:libstdc++.a). A plain -lstdc++ resolved to
# libstdc++.dll.a even under -static and every C++ symbol came out twice.
windows_static_shims() {
  local sys="${MINGW_PREFIX:-/ucrt64}/lib/pkgconfig"
  shim() { # name source-module
    local libs
    libs=$(PKG_CONFIG_LIBDIR="$sys" pkg-config --static --libs "$2" | tr ' ' '\n' | grep -vxE -- '-lstdc\+\+' | tr '\n' ' ')
    cat > "$P/lib/pkgconfig/$1.pc" <<EOF
Name: $1
Description: static $2 (shim)
Version: $(PKG_CONFIG_LIBDIR="$sys" pkg-config --modversion "$2")
Cflags: $(PKG_CONFIG_LIBDIR="$sys" pkg-config --cflags "$2")
Libs: $libs -l:libstdc++.a
EOF
  }
  shim shaderc shaderc_combined
  shim spirv-cross-c-shared spirv-cross-c
}

build_ffmpeg() {
  local b="$SRC/ffmpeg/_b"
  rm -rf "$b"; mkdir -p "$b"; cd "$b"
  local cfg=(--prefix="$P" --enable-static --disable-shared --enable-pic --pkg-config-flags=--static
    --disable-programs --disable-doc --disable-debug --disable-autodetect
    --disable-encoders --disable-muxers --disable-devices
    --enable-zlib --enable-iconv --enable-libdav1d --enable-version3)
  if [ "$OS" = macos ]; then
    cfg+=(--cc=clang --arch=arm64 --enable-pthreads --enable-videotoolbox --enable-audiotoolbox --enable-openssl
      --extra-cflags="$CFLAGS" --extra-ldflags="$LDFLAGS")
  else
    cfg+=(--arch=x86_64 --target-os=mingw32 --enable-w32threads --enable-schannel --enable-d3d11va --enable-dxva2)
  fi
  ../configure "${cfg[@]}" > configure.log || { tail -40 ffbuild/config.log; exit 1; }
  make -j"$JOBS" > make.log
  make install > /dev/null
}

build_mpv() {
  local opts=(-Dlibmpv=true -Dcplayer=false -Dtests=false -Dfuzzers=false -Dcplugins=disabled
    -Dlua=luajit -Djavascript=disabled -Dlibarchive=disabled -Dlibbluray=disabled -Ddvdnav=disabled
    -Dcdda=disabled -Ddvbin=disabled -Duchardet=disabled -Drubberband=disabled -Dzimg=disabled
    -Dlcms2=disabled -Djpeg=disabled -Dvapoursynth=disabled -Dlibavdevice=disabled
    -Dsdl2-audio=disabled -Dsdl2-video=disabled -Dsdl2-gamepad=disabled -Dopenal=disabled -Djack=disabled
    -Dcaca=disabled -Dsixel=disabled -Dvulkan=disabled -Dzlib=enabled -Diconv=enabled -Dgl=enabled
    -Dmanpage-build=disabled -Dhtml-build=disabled -Dpdf-build=disabled)
  local link=()
  if [ "$OS" = macos ]; then
    # 0.41's macOS sources need the Swift build even for libmpv (clipboard-mac.m).
    # swiftc otherwise targets the build host's macOS (14 on CI, 26 locally),
    # which the linker only warns about — the dylib would claim 11.0 and fail
    # to load on anything older than the machine that built it.
    opts+=(-Dswift-build=enabled "-Dswift-flags=-target arm64-apple-macos11.0" -Dcocoa=enabled -Dgl-cocoa=enabled -Dplain-gl=enabled
      -Dvideotoolbox-gl=enabled -Dvideotoolbox-pl=disabled -Dcoreaudio=enabled -Davfoundation=disabled
      -Dmacos-cocoa-cb=disabled -Dmacos-media-player=disabled -Dmacos-touchbar=disabled
      -Dshaderc=disabled -Dspirv-cross=disabled)
  else
    # The app renders Windows video with vo=gpu into a wid child, on d3d11.
    opts+=(-Dd3d11=enabled -Dshaderc=enabled -Dspirv-cross=enabled -Dd3d-hwaccel=enabled
      -Dwasapi=enabled -Dgl-win32=enabled -Ddirect3d=disabled)
    # One self-contained DLL: libgcc, libstdc++ (shaderc/spirv-cross) and
    # winpthread folded in rather than shipped beside it. mpv enables C++ on
    # Windows, so meson links the DLL with the C++ driver — which reads
    # cpp_link_args, not c_link_args, and otherwise adds libstdc++.dll.a.
    local static="-static -static-libgcc -static-libstdc++"
    link=("-Dc_link_args=$static" "-Dcpp_link_args=$static")
  fi
  local b="$SRC/mpv/_b"
  rm -rf "$b"
  meson setup "$b" "$SRC/mpv" --prefix="$P/mpv" --libdir=lib --buildtype=release -Db_ndebug=true \
    --default-library=shared "${opts[@]}" ${link[@]+"${link[@]}"}
  meson compile -C "$b" 2>&1 | tee "$WORK/mpv-link.log"
  [ "${PIPESTATUS[0]}" = 0 ] || exit 1
  meson install -C "$b" --quiet
}

check_self_contained() { # lib
  if [ "$OS" = macos ]; then
    local bad
    bad=$(otool -L "$1" | tail -n +2 | awk '{print $1}' | grep -vE '^(/usr/lib/|/System/Library/|@rpath/libmpv)' || true)
    [ -z "$bad" ] || { echo "non-system dependencies:"; echo "$bad"; exit 1; }
    otool -l "$1" | grep -A4 LC_BUILD_VERSION | grep -q "minos 11.0" || { echo "minos is not 11.0"; exit 1; }
    # minos alone isn't enough: an object built for a newer macOS links with
    # only a warning. Fail on it.
    if grep -q "was built for newer 'macOS' version" "$WORK/mpv-link.log"; then
      grep -m3 "was built for newer 'macOS' version" "$WORK/mpv-link.log"; exit 1
    fi
  else
    # MinGW runtime DLLs and anything from UCRT64 start with lib / zlib.
    local bad
    bad=$(objdump -p "$1" | awk '/DLL Name:/ {print $3}' | grep -iE '^(lib|zlib)' || true)
    [ -z "$bad" ] || { echo "non-system dependencies:"; echo "$bad"; exit 1; }
  fi
}

package() {
  local recipe mpvver name
  recipe=$(cat "$SOURCES" "$HERE/build.sh" | { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; } | cut -c1-8)
  mpvver=$(grep -E '^mpv ' "$SOURCES" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  name="libmpv-vibo-${mpvver#v}-$recipe-$OS-$ARCH"
  local stage="$WORK/stage"
  rm -rf "$stage"
  if [ "$OS" = macos ]; then
    mkdir -p "$stage/libmpv"
    cp "$P/mpv/lib/libmpv.2.dylib" "$stage/libmpv/"
    install_name_tool -id @rpath/libmpv.2.dylib "$stage/libmpv/libmpv.2.dylib"
    strip -x "$stage/libmpv/libmpv.2.dylib"
    codesign -f -s - "$stage/libmpv/libmpv.2.dylib"
    cp -R "$P/mpv/include" "$stage/libmpv/include"
    check_self_contained "$stage/libmpv/libmpv.2.dylib"
    (cd "$stage" && zip -qr -9 "$OUT/$name.zip" libmpv)
  else
    mkdir -p "$stage"
    cp "$P/mpv/bin/libmpv-2.dll" "$P/mpv/lib/libmpv.dll.a" "$stage/"
    strip --strip-unneeded "$stage/libmpv-2.dll"
    cp -R "$P/mpv/include" "$stage/include"
    check_self_contained "$stage/libmpv-2.dll"
    (cd "$stage" && zip -qr -9 "$OUT/$name.zip" .)
  fi
  {
    echo "{"
    echo "  \"name\": \"$name.zip\","
    echo "  \"sha256\": \"$(sha256 "$OUT/$name.zip")\","
    echo "  \"recipe\": \"$recipe\","
    echo "  \"platform\": \"$OS-$ARCH\","
    echo "  \"sources\": {"
    sources | awk '{printf "    \"%s\": \"%s\",\n", $1, $3}' | sed '$ s/,$//'
    echo "  }"
    echo "}"
  } > "$OUT/$name.json"
  echo "built $OUT/$name.zip"
}

build() {
  fetch
  setup_env
  build_deps
  [ "$OS" = windows ] && windows_static_shims
  export PKG_CONFIG_PATH="$P/lib/pkgconfig:$PKG_CONFIG_LIBDIR"
  build_ffmpeg
  build_mpv
  package
}

# Local iteration: redo mpv + packaging on top of a finished deps/FFmpeg build.
resume() {
  setup_env keep
  export PKG_CONFIG_PATH="$P/lib/pkgconfig:$PKG_CONFIG_LIBDIR"
  build_mpv
  package
}

case "${1:-}" in
  pin) pin ;;
  build) build ;;
  resume) resume ;;
  *) echo "usage: $0 pin|build|resume" >&2; exit 2 ;;
esac
