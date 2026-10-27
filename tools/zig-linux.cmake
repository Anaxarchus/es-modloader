# A CMake toolchain for building the Linux loader (libesdado.so) with zig, on
# Linux or macOS:
#   ZIG_TARGET=x86_64-linux-gnu.2.28 cmake -B build-linux -G Ninja -DCMAKE_TOOLCHAIN_FILE=tools/zig-linux.cmake
# ZIG_TARGET (environment) picks the target and the oldest glibc the library
# runs on: x86_64-linux-gnu.2.28 (default) or aarch64-linux-gnu.2.28. zig links
# against its own glibc stubs of that version, so the library needs nothing
# newer than it whatever the build machine has. tools/release.sh uses this.
set(CMAKE_SYSTEM_NAME Linux)
set(ZIG_TARGET "$ENV{ZIG_TARGET}")
if(NOT ZIG_TARGET)
	set(ZIG_TARGET x86_64-linux-gnu.2.28)
endif()
if(ZIG_TARGET MATCHES "^aarch64")
	set(CMAKE_SYSTEM_PROCESSOR aarch64)
	set(ESDADO_TRIPLE aarch64-linux-gnu CACHE STRING "" FORCE)
else()
	set(CMAKE_SYSTEM_PROCESSOR x86_64)
	set(ESDADO_TRIPLE x86_64-linux-gnu CACHE STRING "" FORCE)
endif()
include("${CMAKE_CURRENT_LIST_DIR}/zig-toolchain.cmake")
