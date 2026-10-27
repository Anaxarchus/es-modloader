# A CMake toolchain for building the macOS loader (libesdado.dylib) with zig,
# on Linux or anywhere zig runs:
#   cmake -B build-mac -G Ninja -DCMAKE_TOOLCHAIN_FILE=tools/zig-macos.cmake
# (build-mac.sh does this.) ZIG_TARGET (environment) picks the target:
# aarch64-macos.11.0 (default: Apple Silicon, macOS 11 or later) or
# x86_64-macos.10.15 (Intel).
set(CMAKE_SYSTEM_NAME Darwin)
set(ZIG_TARGET "$ENV{ZIG_TARGET}")
if(NOT ZIG_TARGET)
	set(ZIG_TARGET aarch64-macos.11.0)
endif()
if(ZIG_TARGET MATCHES "^x86_64")
	set(CMAKE_SYSTEM_PROCESSOR x86_64)
	set(ESDADO_TRIPLE x86_64-apple-darwin CACHE STRING "" FORCE)
else()
	set(CMAKE_SYSTEM_PROCESSOR arm64)
	set(ESDADO_TRIPLE aarch64-apple-darwin CACHE STRING "" FORCE)
endif()
include("${CMAKE_CURRENT_LIST_DIR}/zig-toolchain.cmake")
# zig links Mach-O itself (and signs arm64 binaries ad hoc); there is no SDK to find.
set(CMAKE_OSX_SYSROOT "" CACHE PATH "" FORCE)
set(CMAKE_OSX_DEPLOYMENT_TARGET "" CACHE STRING "" FORCE)
set(CMAKE_INSTALL_NAME_TOOL "" CACHE FILEPATH "" FORCE)
