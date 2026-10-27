# A CMake toolchain for building the Windows loader (esdado.dll) with zig, on
# Linux or macOS:
#   cmake -B build-win -G Ninja -DCMAKE_TOOLCHAIN_FILE=tools/zig-windows.cmake
# It builds and links; the DLL has not been tried in the game on Windows yet.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(ZIG_TARGET x86_64-windows-gnu)
set(ESDADO_TRIPLE x86_64-windows-gnu CACHE STRING "" FORCE)
include("${CMAKE_CURRENT_LIST_DIR}/zig-toolchain.cmake")
set(CMAKE_RC_COMPILER "" CACHE FILEPATH "" FORCE)
